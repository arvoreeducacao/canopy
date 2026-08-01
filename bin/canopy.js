#!/usr/bin/env node
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
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
const COMMANDS = new Set(['setup', 'open', 'tabs', 'status', 'close', 'screenshot', 'help'])

if (COMMANDS.has(args[0])) {
  await cli(args[0], args.slice(1))
  process.exit(0)
}

// One-shot install: mint the token, register the MCP server in Claude Code,
// install the Claude Code skill, and (optionally, macOS) a launchd agent so
// the daemon starts at login. Idempotent — safe to re-run.
function setup() {
  const home = os.homedir()
  const base = path.join(home, '.canopy')
  const port = Number(opt('--port', process.env.CANOPY_PORT || 4664))
  fs.mkdirSync(base, { recursive: true })

  // Same token the daemon mints on first run — creating it here lets the MCP
  // registration happen before the daemon has ever started.
  const tokenPath = path.join(base, 'token')
  let token = ''
  try { token = fs.readFileSync(tokenPath, 'utf8').trim() } catch {}
  if (!token) {
    token = crypto.randomBytes(24).toString('hex')
    fs.writeFileSync(tokenPath, token + '\n', { mode: 0o600 })
    console.log(`[setup] token minted at ${tokenPath}`)
  } else {
    console.log(`[setup] token already at ${tokenPath}`)
  }

  const mcpAdd = `claude mcp add --scope user --transport http canopy http://127.0.0.1:${port}/mcp --header "Authorization: Bearer ${token}"`
  try {
    execSync('claude mcp remove --scope user canopy', { stdio: 'ignore' })
  } catch {}
  try {
    execSync(mcpAdd, { stdio: 'ignore' })
    console.log('[setup] MCP server "canopy" registered in Claude Code (user scope)')
  } catch {
    console.log('[setup] could not run the claude CLI — register the MCP server yourself:')
    console.log(`          ${mcpAdd}`)
  }

  const skillSrc = path.join(__dirname, '..', 'skills', 'canopy')
  const skillDst = path.join(home, '.claude', 'skills', 'canopy')
  try {
    fs.cpSync(skillSrc, skillDst, { recursive: true })
    console.log(`[setup] skill installed at ${skillDst}`)
  } catch (e) {
    console.log(`[setup] could not install the skill: ${e.message}`)
  }

  if (flag('--launchd')) {
    if (process.platform !== 'darwin') {
      console.log('[setup] --launchd is macOS-only, skipped')
    } else {
      const bin = fileURLToPath(import.meta.url)
      const plistPath = path.join(home, 'Library', 'LaunchAgents', 'com.arvore.canopy.plist')
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.arvore.canopy</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string>
    <string>${bin}</string>
    <string>--port</string><string>${port}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(base, 'daemon.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(base, 'daemon.log')}</string>
</dict></plist>
`
      fs.mkdirSync(path.dirname(plistPath), { recursive: true })
      fs.writeFileSync(plistPath, plist)
      try { execSync(`launchctl unload ${plistPath}`, { stdio: 'ignore' }) } catch {}
      try {
        execSync(`launchctl load ${plistPath}`, { stdio: 'ignore' })
        console.log(`[setup] launchd agent loaded (${plistPath}) — the daemon now starts at login`)
        console.log(`[setup] note: it points at this install (${bin}); re-run setup --launchd after moving or updating it`)
      } catch (e) {
        console.log(`[setup] could not load the launchd agent: ${e.message}`)
      }
    }
  }

  console.log(`
next steps:
  1. start the daemon (skip if you used --launchd):  canopy
  2. load the extension: arc://extensions (or chrome://extensions) → Developer mode → Load unpacked → ${path.join(__dirname, '..', 'extension')}
  3. cockpit: http://127.0.0.1:${port}/`)
}

async function cli(cmd, rest) {
  if (cmd === 'help') {
    console.log(`canopy                       start the daemon
canopy --launch-chrome       start the daemon and open a test browser
canopy setup [--launchd]     one-shot install: token, Claude Code MCP + skill
canopy status                daemon/browser state
canopy open <url> [--label]  open an agent tab
canopy tabs                  list agent tabs
canopy close <tab>           close a tab (e.g. canopy close t1)
canopy screenshot <tab> [f]  save a PNG screenshot of the tab`)
    return
  }
  if (cmd === 'setup') return setup()
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
    console.log('[canopy] no Chrome found — install Chrome for Testing:')
    console.log('           pnpm dlx @puppeteer/browsers install chrome@stable --path ~/.canopy/browsers')
  } else {
    // macOS .app bundles launch via `open -g` (background, no focus steal);
    // raw binaries (mac CfT bin, Linux, Windows) spawn directly.
    const child = target.endsWith('.app') || target === 'Google Chrome'
      ? spawn('open', ['-g', '-n', '-a', target, '--args', ...chromeArgs], { detached: true, stdio: 'ignore' })
      : spawn(target, chromeArgs, { detached: true, stdio: 'ignore' })
    child.unref()
    console.log(`[canopy] browser launched in the background: ${path.basename(target)} (profile ${profile}, CDP ${cdpPort})`)
    if (!cft && !opt('--browser', null)) {
      console.log('[canopy] tip: install Chrome for Testing so the extension loads in the test browser:')
      console.log('           pnpm dlx @puppeteer/browsers install chrome@stable --path ~/.canopy/browsers')
    }
  }
}

console.log('[canopy] ready. For Arc: load the extension/ folder at arc://extensions (developer mode).')
