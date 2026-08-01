#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = name => args.includes(name)
const opt = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}

// ---------------- CLI mode: talk to a running daemon ----------------
const COMMANDS = new Set(['open', 'tabs', 'status', 'close', 'screenshot', 'help'])

if (COMMANDS.has(args[0])) {
  await cli(args[0], args.slice(1))
  process.exit(0)
}

async function cli(cmd, rest) {
  if (cmd === 'help') {
    console.log(`canopy                       start the daemon
canopy --launch-chrome       start the daemon and open a test browser
canopy status                daemon/browser state
canopy open <url> [--label]  open an agent tab
canopy tabs                  list agent tabs
canopy close <tab>           close a tab (e.g. canopy close t1)
canopy screenshot <tab> [f]  save a PNG screenshot of the tab`)
    return
  }
  const port = Number(opt('--port', process.env.CANOPY_PORT || 4664))
  const base = `http://127.0.0.1:${port}`
  let token = ''
  try { token = fs.readFileSync(path.join(os.homedir(), '.canopy', 'token'), 'utf8').trim() } catch {}
  const headers = token ? { Authorization: `Bearer ${token}` } : {}
  const req = async (method, p, body) => {
    let res
    try {
      res = await fetch(base + p, {
        method,
        headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
      })
    } catch {
      console.error(`daemon is not running at ${base} — start it with: canopy`)
      process.exit(1)
    }
    if (p.includes('/screenshot')) {
      if (!res.ok) { console.error(`HTTP ${res.status}`); process.exit(1) }
      return Buffer.from(await res.arrayBuffer())
    }
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { console.error(data.error || `HTTP ${res.status}`); process.exit(1) }
    return data
  }

  if (cmd === 'status') {
    const s = await req('GET', '/status')
    console.log(`browser: ${s.connected ? `${s.browser} (${s.mode})` : 'disconnected'}`)
    console.log(`tabs:    ${s.tabs.length}`)
    for (const t of s.tabs) console.log(`  ${t.id}  ${t.title || t.url}`)
    return
  }
  if (cmd === 'tabs') {
    const tabs = await req('GET', '/tabs')
    if (!tabs.length) return console.log('no agent tabs open')
    for (const t of tabs) {
      const state = t.stopRequested ? 'stopped' : t.takenOver ? 'yours' : 'live'
      console.log(`${t.id}  [${state}]  ${t.title || ''}  ${t.url}`)
    }
    return
  }
  if (cmd === 'open') {
    const url = rest.find(a => !a.startsWith('--') && a !== opt('--label', null))
    if (!url) { console.error('usage: canopy open <url> [--label "task"]'); process.exit(1) }
    const tab = await req('POST', '/tabs', { url, label: opt('--label', undefined) })
    console.log(`${tab.id}  ${tab.url}`)
    return
  }
  if (cmd === 'close') {
    if (!rest[0]) { console.error('usage: canopy close <tab>'); process.exit(1) }
    await req('DELETE', `/tabs/${rest[0]}`)
    console.log('ok')
    return
  }
  if (cmd === 'screenshot') {
    if (!rest[0]) { console.error('usage: canopy screenshot <tab> [out.png]'); process.exit(1) }
    const buf = await req('GET', `/tabs/${rest[0]}/screenshot`)
    const out = rest[1] || `${rest[0]}.png`
    fs.writeFileSync(out, buf)
    console.log(out)
    return
  }
}

// ---------------- daemon mode ----------------
const { startDaemon } = await import('../src/daemon.js')

const port = Number(opt('--port', 4664))
const cdpPort = Number(opt('--cdp-port', 9222))

// Branded Chrome 137+ ignores --load-extension; Chrome for Testing still honors
// it, so the dev browser gets the extension (tab grouping, focus-pause).
// Install once with: pnpm dlx @puppeteer/browsers install chrome@stable --path ~/.canopy/browsers
function findChromeForTesting() {
  const base = path.join(os.homedir(), '.canopy', 'browsers', 'chrome')
  const inner = {
    darwin: p => path.join(p, `chrome-mac-${os.arch() === 'arm64' ? 'arm64' : 'x64'}`, 'Google Chrome for Testing.app'),
    linux: p => path.join(p, 'chrome-linux64', 'chrome'),
    win32: p => path.join(p, 'chrome-win64', 'chrome.exe')
  }[process.platform]
  if (!inner) return null
  try {
    for (const dir of fs.readdirSync(base).sort().reverse()) {
      const bin = inner(path.join(base, dir))
      if (fs.existsSync(bin)) return bin
    }
  } catch {}
  return null
}

function findSystemChrome() {
  if (process.platform === 'darwin') {
    return ['/Applications/Google Chrome.app', '/Applications/Chromium.app'].find(p => fs.existsSync(p)) || 'Google Chrome'
  }
  if (process.platform === 'linux') {
    for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
      try { return execSync(`command -v ${bin}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch {}
    }
    return null
  }
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
    ]
    return candidates.find(p => p && fs.existsSync(p)) || null
  }
  return null
}

await startDaemon({ port, cdpUrl: `http://127.0.0.1:${cdpPort}` })

if (flag('--launch-chrome')) {
  const cft = findChromeForTesting()
  const target = opt('--browser', cft || findSystemChrome())
  const profile = opt('--profile', path.join(os.homedir(), '.canopy', 'chrome-profile'))
  const extDir = path.join(__dirname, '..', 'extension')
  const chromeArgs = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${cdpPort}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    `--load-extension=${extDir}`,
    `http://127.0.0.1:${port}/`
  ]
  if (!target) {
    console.log('[canopy] nenhum Chrome encontrado — instale o Chrome for Testing:')
    console.log('           pnpm dlx @puppeteer/browsers install chrome@stable --path ~/.canopy/browsers')
  } else {
    // macOS .app bundles launch via `open -g` (background, no focus steal);
    // raw binaries (mac CfT bin, Linux, Windows) spawn directly.
    const child = target.endsWith('.app') || target === 'Google Chrome'
      ? spawn('open', ['-g', '-n', '-a', target, '--args', ...chromeArgs], { detached: true, stdio: 'ignore' })
      : spawn(target, chromeArgs, { detached: true, stdio: 'ignore' })
    child.unref()
    console.log(`[canopy] browser lançado em segundo plano: ${path.basename(target)} (perfil ${profile}, CDP ${cdpPort})`)
    if (!cft && !opt('--browser', null)) {
      console.log('[canopy] dica: instale o Chrome for Testing para a extensão carregar no browser de teste:')
      console.log('           pnpm dlx @puppeteer/browsers install chrome@stable --path ~/.canopy/browsers')
    }
  }
}

console.log('[canopy] pronto. Para o Arc: carregue a pasta extension/ em arc://extensions (modo desenvolvedor).')
