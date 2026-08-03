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
const COMMANDS = new Set(['setup', 'pair', 'open', 'tabs', 'status', 'close', 'screenshot', 'help'])

// Mint-or-read a 0600 secret under ~/.canopy. Same files the daemon uses, so
// setup can run before the daemon has ever started.
function secretFile(name, bytes) {
  const p = path.join(os.homedir(), '.canopy', name)
  try {
    const existing = fs.readFileSync(p, 'utf8').trim()
    if (existing) return { path: p, value: existing, minted: false }
  } catch {}
  const value = crypto.randomBytes(bytes).toString('hex')
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, value + '\n', { mode: 0o600 })
  return { path: p, value, minted: true }
}

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
  const { path: tokenPath, value: token, minted } = secretFile('token', 24)
  console.log(`[setup] token ${minted ? 'minted at' : 'already at'} ${tokenPath}`)
  const pairing = secretFile('ext-secret', 16)
  console.log(`[setup] extension pairing code ${pairing.minted ? 'minted at' : 'already at'} ${pairing.path}`)

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

  if (flag('--systemd')) {
    if (process.platform !== 'linux') {
      console.log('[setup] --systemd is Linux-only, skipped (macOS: --launchd)')
    } else {
      const bin = fileURLToPath(import.meta.url)
      const unitPath = path.join(home, '.config', 'systemd', 'user', 'canopy.service')
      const unit = `[Unit]
Description=Canopy daemon (MCP + CDP bridge)
After=graphical-session.target

[Service]
ExecStart=${process.execPath} ${bin} --port ${port}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`
      fs.mkdirSync(path.dirname(unitPath), { recursive: true })
      fs.writeFileSync(unitPath, unit)
      try {
        execSync('systemctl --user daemon-reload', { stdio: 'ignore' })
        execSync('systemctl --user enable --now canopy.service', { stdio: 'ignore' })
        console.log(`[setup] systemd user unit installed (${unitPath}) — the daemon now starts at login`)
        console.log(`[setup] note: it points at this install (${bin}); re-run setup --systemd after moving or updating it`)
        console.log('[setup] logs: journalctl --user -u canopy -f')
      } catch (e) {
        console.log(`[setup] wrote ${unitPath} but could not enable it: ${e.message}`)
        console.log('[setup] enable it yourself: systemctl --user enable --now canopy.service')
      }
    }
  }

  if (flag('--launchd')) {
    if (process.platform !== 'darwin') {
      console.log(`[setup] --launchd is macOS-only, skipped${process.platform === 'linux' ? ' (use --systemd here)' : ''}`)
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
next steps — Chromium (Arc, Chrome, Brave, Edge):
  1. start the daemon (skip if you used --launchd/--systemd):  canopy
  2. load the extension: arc://extensions (or chrome://extensions) → Developer mode → Load unpacked → ${path.join(__dirname, '..', 'extension')}
  3. pair it: the extension's Details → Extension options → paste  ${pairing.value}
  4. cockpit: http://127.0.0.1:${port}/

next steps — Firefox family (Zen, Firefox, LibreWolf, Floorp):
  1. quit the browser if it is running (the remote agent only starts at launch)
  2. canopy --launch-firefox --real-profile
  3. cockpit: http://127.0.0.1:${port}/`)
}

async function cli(cmd, rest) {
  if (cmd === 'help') {
    console.log(`canopy                       start the daemon
canopy --launch-chrome       start the daemon and open a Chromium test browser
canopy --launch-firefox      start the daemon and open Zen/Firefox (BiDi)
    --real-profile           ...on your own profile, with your logins
    --browser <path>         ...on a specific binary
canopy setup [--launchd]     one-shot install: token, Claude Code MCP + skill
             [--systemd]     ...and start at login (Linux)
canopy pair                  print the extension pairing code
canopy status                daemon/browser state
canopy open <url> [--label]  open an agent tab
canopy tabs                  list agent tabs
canopy close <tab>           close a tab (e.g. canopy close t1)
canopy screenshot <tab> [f]  save a PNG screenshot of the tab`)
    return
  }
  if (cmd === 'setup') return setup()
  if (cmd === 'pair') {
    const pairing = secretFile('ext-secret', 16)
    console.log(pairing.value)
    console.log(`\npaste it into the extension: arc://extensions (or chrome://extensions)\n  → Canopy Bridge → Details → Extension options`)
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
const { findChromeForTesting, findChromium, findGecko, describeBrowser, geckoArgs, withFilesystem } = await import('../src/launch.js')

const port = Number(opt('--port', process.env.CANOPY_PORT || 4664))
const cdpPort = Number(opt('--cdp-port', process.env.CANOPY_CDP_PORT || 9222))
const bidiPort = Number(opt('--bidi-port', process.env.CANOPY_BIDI_PORT || 9223))
const bind = opt('--bind', process.env.CANOPY_BIND || '127.0.0.1')
const publicHost = opt('--public-host', process.env.CANOPY_PUBLIC_HOST || '')
const ssoHost = opt('--sso-host', process.env.CANOPY_SSO_HOST || '')
const ssoHeader = (opt('--sso-header', process.env.CANOPY_SSO_HEADER || 'x-auth-request-email')).toLowerCase()
const ssoSecret = process.env.CANOPY_SSO_SECRET || ''
const extId = opt('--ext-id', process.env.CANOPY_EXT_ID || '')
const mcpOrigin = opt('--mcp-origin', process.env.CANOPY_MCP_ORIGIN || '')
const dataDir = opt('--data-dir', process.env.CANOPY_DATA_DIR || '') || undefined

await startDaemon({
  port, bind, publicHost, ssoHost, ssoHeader, ssoSecret, extId, mcpOrigin, dataDir,
  cdpUrl: process.env.CANOPY_CDP_URL || `http://127.0.0.1:${cdpPort}`,
  bidiUrl: process.env.CANOPY_BIDI_URL || `ws://127.0.0.1:${bidiPort}/session`
})

const spawnDetached = (found, browserArgs) => {
  const child = spawn(found.command, [...found.args, ...browserArgs], { detached: true, stdio: 'ignore' })
  child.unref()
  return child
}

if (flag('--launch-chrome')) {
  // Branded Chrome 137+ ignores --load-extension; Chrome for Testing still
  // honours it, so only that build gets the extension (tab grouping,
  // focus-pause). Install it once with:
  //   pnpm dlx @puppeteer/browsers install chrome@stable --path ~/.canopy/browsers
  const cft = findChromeForTesting()
  const override = opt('--browser', null)
  const found = override ? describeBrowser(override, 'chromium') : cft || findChromium()
  const profile = opt('--profile', path.join(os.homedir(), '.canopy', 'chrome-profile'))
  const extDir = path.join(__dirname, '..', 'extension')
  if (!found) {
    console.log('[canopy] no Chromium browser found — install Chrome for Testing:')
    console.log('           pnpm dlx @puppeteer/browsers install chrome@stable --path ~/.canopy/browsers')
  } else {
    spawnDetached(withFilesystem(found, path.dirname(profile)), [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${cdpPort}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      `--load-extension=${extDir}`,
      `http://127.0.0.1:${port}/`
    ])
    console.log(`[canopy] browser launched in the background: ${found.name} (profile ${profile}, CDP ${cdpPort})`)
    if (!cft && !override) {
      console.log('[canopy] tip: install Chrome for Testing so the extension loads in the test browser:')
      console.log('           pnpm dlx @puppeteer/browsers install chrome@stable --path ~/.canopy/browsers')
    }
  }
}

// Firefox and its forks. There is no extension path here — Gecko has no
// chrome.debugger — so the remote-debugging port is the whole bridge, and it
// only exists if the browser was started with it. That is also why a browser
// already running on the same profile has to be quit first: Gecko hands the
// arguments to the running copy and exits, and the port never opens.
if (flag('--launch-firefox') || flag('--launch-zen') || flag('--launch-gecko')) {
  const override = opt('--browser', null)
  const found = override ? describeBrowser(override, 'gecko') : findGecko()
  // The default is a throwaway profile, like --launch-chrome. --real-profile
  // is the opposite trade and the reason Canopy exists: your own profile, your
  // own logins, the tabs opening next to the ones you are working in.
  const realProfile = flag('--real-profile')
  const profile = realProfile ? null : opt('--profile', path.join(os.homedir(), '.canopy', 'firefox-profile'))
  if (!found) {
    console.log('[canopy] no Firefox-family browser found (looked for zen, firefox, librewolf, floorp — binary and Flatpak)')
    console.log('[canopy] point at one with: --launch-firefox --browser /path/to/zen')
  } else {
    if (profile) fs.mkdirSync(profile, { recursive: true })
    spawnDetached(withFilesystem(found, profile && path.dirname(profile)), [
      ...geckoArgs({ bidiPort, profile }),
      `http://127.0.0.1:${port}/`
    ])
    console.log(`[canopy] browser launched: ${found.name} (${profile ? `profile ${profile}` : 'your default profile'}, BiDi ${bidiPort})`)
    if (realProfile) console.log('[canopy] note: quit any other window of it first, or the remote agent never starts')
  }
}

console.log('[canopy] ready. Chromium: load extension/ at chrome://extensions (developer mode). Firefox/Zen: canopy --launch-firefox.')
