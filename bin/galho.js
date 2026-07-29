#!/usr/bin/env node
const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const API = `http://127.0.0.1:${process.env.GALHO_API_PORT || 9224}`

async function api(method, route, body) {
  const res = await fetch(API + route, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  })
  const type = res.headers.get('content-type') || ''
  if (type.includes('image/png')) return Buffer.from(await res.arrayBuffer())
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
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
  throw new Error('galho nao subiu em 15s')
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

const HELP = `galho - CLI do browser Galho

Uso:
  galho                          abre (ou foca) o browser
  galho open <url> [-s space] [-f]   abre aba (padrao: space Agentes, sem foco)
  galho tabs                     lista abas (id, space, url)
  galho spaces                   lista spaces
  galho shot <id> [-o out.png]   screenshot da aba
  galho text <id>                innerText da pagina
  galho eval <id> <expr>         roda JS na pagina
  galho click <id> <x> <y>       clica com cursor animado
  galho type <id> <texto>        digita na aba
  galho press <id> <tecla>       pressiona tecla (Return, Tab, Escape...)
  galho close <id>               fecha a aba
  galho folder <space> <nome> <links.json>   cria/atualiza live folder

Env: GALHO_API_PORT (padrao 9224), GALHO_APP (caminho do .app)`

async function main() {
  const [, , cmd, ...argv] = process.argv
  const { flags, rest } = parseFlags(argv)

  if (!cmd || cmd === 'start') {
    await ensureRunning()
    console.log('galho rodando em ' + API)
    return
  }

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP)
    return
  }

  if (cmd === 'open') {
    if (!rest[0]) throw new Error('uso: galho open <url>')
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
      console.log(`${s.id}  ${s.active ? '*' : ' '} ${s.name} (${s.tabCount} abas, ${s.archivedCount} arquivadas)`)
    }
    return
  }

  if (cmd === 'shot') {
    if (!rest[0]) throw new Error('uso: galho shot <id>')
    const png = await api('GET', `/tabs/${rest[0]}/screenshot`)
    const out = flags.out || `galho-${rest[0]}.png`
    fs.writeFileSync(out, png)
    console.log(out)
    return
  }

  if (cmd === 'text') {
    if (!rest[0]) throw new Error('uso: galho text <id>')
    const data = await api('GET', `/tabs/${rest[0]}/text`)
    console.log(data.text)
    return
  }

  if (cmd === 'eval') {
    if (rest.length < 2) throw new Error('uso: galho eval <id> <expr>')
    const data = await api('POST', `/tabs/${rest[0]}/eval`, { expression: rest.slice(1).join(' ') })
    console.log(JSON.stringify(data.result, null, 2))
    return
  }

  if (cmd === 'click') {
    if (rest.length < 3) throw new Error('uso: galho click <id> <x> <y>')
    await api('POST', `/tabs/${rest[0]}/click`, { x: Number(rest[1]), y: Number(rest[2]) })
    console.log('ok')
    return
  }

  if (cmd === 'type') {
    if (rest.length < 2) throw new Error('uso: galho type <id> <texto>')
    await api('POST', `/tabs/${rest[0]}/type`, { text: rest.slice(1).join(' ') })
    console.log('ok')
    return
  }

  if (cmd === 'press') {
    if (rest.length < 2) throw new Error('uso: galho press <id> <tecla>')
    await api('POST', `/tabs/${rest[0]}/press`, { key: rest[1] })
    console.log('ok')
    return
  }

  if (cmd === 'close') {
    if (!rest[0]) throw new Error('uso: galho close <id>')
    await api('DELETE', `/tabs/${rest[0]}`)
    console.log('ok')
    return
  }

  if (cmd === 'folder') {
    if (rest.length < 3) throw new Error('uso: galho folder <space> <nome> <links.json>')
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
  console.error('erro:', err.message)
  process.exit(1)
})
