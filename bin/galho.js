#!/usr/bin/env node
const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')

const API_PORT = Number(process.env.GALHO_API_PORT || 9224)

function userDataDir() {
  if (process.env.GALHO_PROFILE) return process.env.GALHO_PROFILE
  const home = os.homedir()
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Galho')
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Galho')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Galho')
}

function readToken() {
  if (process.env.GALHO_TOKEN) return process.env.GALHO_TOKEN
  const file = process.env.GALHO_TOKEN_FILE || path.join(userDataDir(), 'agent-token')
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {
    return null
  }
}

function request(options, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function api(method, route, body) {
  const payload = body ? JSON.stringify(body) : null
  const headers = payload ? { 'Content-Type': 'application/json' } : {}
  const socketPath = path.join(userDataDir(), 'agent.sock')
  let res = null
  if (process.platform !== 'win32' && fs.existsSync(socketPath)) {
    try {
      res = await request({ socketPath, method, path: route, headers }, payload)
    } catch {
      res = null
    }
  }
  if (!res) {
    const token = readToken()
    const tcpHeaders = { ...headers }
    if (token) tcpHeaders.Authorization = `Bearer ${token}`
    res = await request({ host: '127.0.0.1', port: API_PORT, method, path: route, headers: tcpHeaders }, payload)
  }
  const type = res.headers['content-type'] || ''
  if (type.includes('image/png')) return res.body
  const data = JSON.parse(res.body.toString() || '{}')
  if (res.status >= 400) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

async function isRunning() {
  try {
    await api('GET', '/')
    return true
  } catch {
    return false
  }
}

function launchApp() {
  if (process.platform === 'darwin') {
    const appPath = process.env.GALHO_APP || '/Applications/Galho.app'
    if (fs.existsSync(appPath)) {
      execSync(`open -a "${appPath}"`)
      return
    }
  }
  const devRoot = path.join(__dirname, '..')
  const electron = path.join(devRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')
  const child = spawn(electron, [devRoot], { detached: true, stdio: 'ignore' })
  child.unref()
}

async function ensureRunning() {
  if (await isRunning()) return
  launchApp()
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500))
    if (await isRunning()) return
  }
  throw new Error('galho did not start within 15s')
}

function parseFlags(args) {
  const flags = {}
  const rest = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-s' || args[i] === '--space') flags.space = args[++i]
    else if (args[i] === '-o' || args[i] === '--out') flags.out = args[++i]
    else if (args[i] === '-f' || args[i] === '--focus') flags.focus = true
    else rest.push(args[i])
  }
  return { flags, rest }
}

const HELP = `galho - Galho browser CLI

Usage:
  galho                          open (or focus) the browser
  galho open <url> [-s space] [-f]   open tab (default: Agentes space, unfocused)
  galho tabs                     list tabs (id, space, url)
  galho spaces                   list spaces
  galho shot <id> [-o out.png]   tab screenshot
  galho text <id>                page innerText
  galho eval <id> <expr>         run JS in the page
  galho click <id> <x> <y>       click with animated cursor
  galho type <id> <text>         type into the tab
  galho press <id> <key>         press a key (Return, Tab, Escape...)
  galho close <id>               close the tab
  galho folder <space> <name> <links.json>   create/update live folder

Transport: unix socket <userData>/agent.sock (default); TCP 127.0.0.1 fallback with Bearer token
Env: GALHO_PROFILE (userData), GALHO_API_PORT (default 9224), GALHO_TOKEN, GALHO_TOKEN_FILE, GALHO_APP (.app path)`

async function main() {
  const [, , cmd, ...argv] = process.argv
  const { flags, rest } = parseFlags(argv)

  if (!cmd || cmd === 'start') {
    await ensureRunning()
    const socketPath = path.join(userDataDir(), 'agent.sock')
    const via = process.platform !== 'win32' && fs.existsSync(socketPath) ? socketPath : `http://127.0.0.1:${API_PORT}`
    console.log('galho running at ' + via)
    return
  }

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP)
    return
  }

  if (cmd === 'open') {
    if (!rest[0]) throw new Error('usage: galho open <url>')
    await ensureRunning()
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(rest[0]) ? rest[0] : 'https://' + rest[0]
    const tab = await api('POST', '/tabs', { url, space: flags.space, activate: !!flags.focus })
    console.log(JSON.stringify(tab, null, 2))
    return
  }

  await ensureRunning()

  if (cmd === 'tabs') {
    const tabs = await api('GET', '/tabs')
    for (const t of tabs) {
      console.log(`${t.id}  ${t.active ? '*' : ' '} [${t.space}] ${t.title} - ${t.url}`)
    }
    return
  }

  if (cmd === 'spaces') {
    const spaces = await api('GET', '/spaces')
    for (const s of spaces) {
      console.log(`${s.id}  ${s.active ? '*' : ' '} ${s.name} (${s.tabCount} tabs, ${s.archivedCount} archived)`)
    }
    return
  }

  if (cmd === 'shot') {
    if (!rest[0]) throw new Error('usage: galho shot <id>')
    const png = await api('GET', `/tabs/${rest[0]}/screenshot`)
    const out = flags.out || `galho-${rest[0]}.png`
    fs.writeFileSync(out, png)
    console.log(out)
    return
  }

  if (cmd === 'text') {
    if (!rest[0]) throw new Error('usage: galho text <id>')
    const data = await api('GET', `/tabs/${rest[0]}/text`)
    console.log(data.text)
    return
  }

  if (cmd === 'eval') {
    if (rest.length < 2) throw new Error('usage: galho eval <id> <expr>')
    const data = await api('POST', `/tabs/${rest[0]}/eval`, { expression: rest.slice(1).join(' ') })
    console.log(JSON.stringify(data.result, null, 2))
    return
  }

  if (cmd === 'click') {
    if (rest.length < 3) throw new Error('usage: galho click <id> <x> <y>')
    await api('POST', `/tabs/${rest[0]}/click`, { x: Number(rest[1]), y: Number(rest[2]) })
    console.log('ok')
    return
  }

  if (cmd === 'type') {
    if (rest.length < 2) throw new Error('usage: galho type <id> <text>')
    await api('POST', `/tabs/${rest[0]}/type`, { text: rest.slice(1).join(' ') })
    console.log('ok')
    return
  }

  if (cmd === 'press') {
    if (rest.length < 2) throw new Error('usage: galho press <id> <key>')
    await api('POST', `/tabs/${rest[0]}/press`, { key: rest[1] })
    console.log('ok')
    return
  }

  if (cmd === 'close') {
    if (!rest[0]) throw new Error('usage: galho close <id>')
    await api('DELETE', `/tabs/${rest[0]}`)
    console.log('ok')
    return
  }

  if (cmd === 'folder') {
    if (rest.length < 3) throw new Error('usage: galho folder <space> <name> <links.json>')
    const links = JSON.parse(fs.readFileSync(rest[2], 'utf8'))
    const existing = (await api('GET', '/folders')).find(f => f.name === rest[1] && f.space.toLowerCase() === rest[0].toLowerCase())
    if (existing) {
      await api('PUT', `/folders/${existing.id}`, { links })
      console.log(existing.id)
    } else {
      const folder = await api('POST', '/folders', { space: rest[0], name: rest[1], links })
      console.log(folder.id)
    }
    return
  }

  console.log(HELP)
  process.exitCode = 1
}

main().catch(err => {
  console.error('error:', err.message)
  process.exit(1)
})
