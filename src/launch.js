import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// Finding a browser, on the three platforms and the four ways Linux ships one.
//
// Everything here returns the same shape, ready for spawn():
//
//   { name, engine: 'chromium' | 'gecko', command, args }
//
// so a caller can append browser flags without caring whether it is talking to
// a raw binary, a macOS .app bundle or a Flatpak. `engine` decides the
// protocol: Chromium browsers are driven over CDP (or the extension), Gecko
// browsers over WebDriver BiDi.

const isLinux = process.platform === 'linux'
const isMac = process.platform === 'darwin'
const isWindows = process.platform === 'win32'

const exists = p => { try { return fs.existsSync(p) } catch { return false } }

// macOS .app bundles are opened, not executed: `open -g` starts them in the
// background without stealing focus, and -n forces a new instance so the flags
// after --args are honoured rather than dropped into a running copy.
const macApp = (app, name, engine) => ({ name, engine, command: 'open', args: ['-g', '-n', '-a', app, '--args'] })
const bin = (command, name, engine) => ({ name, engine, command, args: [] })
// `id` travels with the descriptor so a caller can widen the sandbox for one
// run (--filesystem=...) before the app id, which is the only place Flatpak
// accepts it.
const flatpak = (id, name, engine) => ({ name, engine, command: 'flatpak', args: ['run', id], flatpakId: id })

function onPath(command) {
  if (isWindows) return false
  try {
    execFileSync('/bin/sh', ['-c', `command -v ${command}`], { stdio: ['ignore', 'pipe', 'ignore'] })
    return true
  } catch { return false }
}

// Cheaper and more reliable than shelling out to `flatpak info`: an installed
// app has a directory under one of the two installation roots.
function flatpakInstalled(id) {
  return exists(path.join('/var/lib/flatpak/app', id))
    || exists(path.join(os.homedir(), '.local/share/flatpak/app', id))
}

function firstOf(candidates) {
  for (const c of candidates) {
    if (!c) continue
    if (c.kind === 'path' && exists(c.value)) return c.make()
    if (c.kind === 'bin' && onPath(c.value)) return c.make()
    if (c.kind === 'flatpak' && flatpakInstalled(c.value)) return c.make()
  }
  return null
}

const atPath = (value, make) => ({ kind: 'path', value, make })
const inPath = (value, make) => ({ kind: 'bin', value, make })
const inFlatpak = (value, make) => ({ kind: 'flatpak', value, make })

// Chrome for Testing, installed under ~/.canopy/browsers. Branded Chrome 137+
// ignores --load-extension, so this is the only build that can be started with
// the Canopy extension already loaded.
export function findChromeForTesting() {
  const base = path.join(os.homedir(), '.canopy', 'browsers', 'chrome')
  const inner = {
    darwin: p => path.join(p, `chrome-mac-${os.arch() === 'arm64' ? 'arm64' : 'x64'}`, 'Google Chrome for Testing.app'),
    linux: p => path.join(p, 'chrome-linux64', 'chrome'),
    win32: p => path.join(p, 'chrome-win64', 'chrome.exe')
  }[process.platform]
  if (!inner) return null
  try {
    for (const dir of fs.readdirSync(base).sort().reverse()) {
      const exe = inner(path.join(base, dir))
      if (!exists(exe)) continue
      return exe.endsWith('.app')
        ? macApp(exe, 'Chrome for Testing', 'chromium')
        : bin(exe, 'Chrome for Testing', 'chromium')
    }
  } catch {}
  return null
}

export function findChromium() {
  if (isMac) {
    return firstOf([
      atPath('/Applications/Arc.app', () => macApp('/Applications/Arc.app', 'Arc', 'chromium')),
      atPath('/Applications/Google Chrome.app', () => macApp('/Applications/Google Chrome.app', 'Google Chrome', 'chromium')),
      atPath('/Applications/Chromium.app', () => macApp('/Applications/Chromium.app', 'Chromium', 'chromium')),
      atPath('/Applications/Brave Browser.app', () => macApp('/Applications/Brave Browser.app', 'Brave', 'chromium')),
      atPath('/Applications/Microsoft Edge.app', () => macApp('/Applications/Microsoft Edge.app', 'Microsoft Edge', 'chromium'))
    ])
  }
  if (isWindows) {
    const dirs = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter(Boolean)
    const candidates = []
    for (const d of dirs) {
      candidates.push(atPath(path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe'), () => bin(path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'Google Chrome', 'chromium')))
      candidates.push(atPath(path.join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), () => bin(path.join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'Microsoft Edge', 'chromium')))
      candidates.push(atPath(path.join(d, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), () => bin(path.join(d, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), 'Brave', 'chromium')))
    }
    return firstOf(candidates)
  }
  return firstOf([
    inPath('google-chrome', () => bin('google-chrome', 'Google Chrome', 'chromium')),
    inPath('google-chrome-stable', () => bin('google-chrome-stable', 'Google Chrome', 'chromium')),
    inPath('chromium', () => bin('chromium', 'Chromium', 'chromium')),
    inPath('chromium-browser', () => bin('chromium-browser', 'Chromium', 'chromium')),
    inPath('brave-browser', () => bin('brave-browser', 'Brave', 'chromium')),
    inPath('microsoft-edge', () => bin('microsoft-edge', 'Microsoft Edge', 'chromium')),
    inFlatpak('com.google.Chrome', () => flatpak('com.google.Chrome', 'Google Chrome (Flatpak)', 'chromium')),
    inFlatpak('org.chromium.Chromium', () => flatpak('org.chromium.Chromium', 'Chromium (Flatpak)', 'chromium')),
    inFlatpak('com.brave.Browser', () => flatpak('com.brave.Browser', 'Brave (Flatpak)', 'chromium'))
  ])
}

// Gecko: Zen first, because someone who has installed it is unlikely to want
// Canopy driving stock Firefox instead.
export function findGecko() {
  if (isMac) {
    return firstOf([
      atPath('/Applications/Zen.app', () => macApp('/Applications/Zen.app', 'Zen', 'gecko')),
      atPath('/Applications/Zen Browser.app', () => macApp('/Applications/Zen Browser.app', 'Zen', 'gecko')),
      atPath('/Applications/Firefox.app', () => macApp('/Applications/Firefox.app', 'Firefox', 'gecko')),
      atPath('/Applications/LibreWolf.app', () => macApp('/Applications/LibreWolf.app', 'LibreWolf', 'gecko')),
      atPath('/Applications/Floorp.app', () => macApp('/Applications/Floorp.app', 'Floorp', 'gecko'))
    ])
  }
  if (isWindows) {
    const dirs = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter(Boolean)
    const candidates = []
    for (const d of dirs) {
      candidates.push(atPath(path.join(d, 'Zen Browser', 'zen.exe'), () => bin(path.join(d, 'Zen Browser', 'zen.exe'), 'Zen', 'gecko')))
      candidates.push(atPath(path.join(d, 'Mozilla Firefox', 'firefox.exe'), () => bin(path.join(d, 'Mozilla Firefox', 'firefox.exe'), 'Firefox', 'gecko')))
      candidates.push(atPath(path.join(d, 'LibreWolf', 'librewolf.exe'), () => bin(path.join(d, 'LibreWolf', 'librewolf.exe'), 'LibreWolf', 'gecko')))
    }
    return firstOf(candidates)
  }
  return firstOf([
    inPath('zen', () => bin('zen', 'Zen', 'gecko')),
    inPath('zen-browser', () => bin('zen-browser', 'Zen', 'gecko')),
    inPath('zen-bin', () => bin('zen-bin', 'Zen', 'gecko')),
    atPath('/opt/zen/zen', () => bin('/opt/zen/zen', 'Zen', 'gecko')),
    inFlatpak('app.zen_browser.zen', () => flatpak('app.zen_browser.zen', 'Zen (Flatpak)', 'gecko')),
    inPath('librewolf', () => bin('librewolf', 'LibreWolf', 'gecko')),
    inPath('floorp', () => bin('floorp', 'Floorp', 'gecko')),
    inPath('firefox', () => bin('firefox', 'Firefox', 'gecko')),
    inPath('firefox-esr', () => bin('firefox-esr', 'Firefox ESR', 'gecko')),
    inFlatpak('io.gitlab.librewolf-community', () => flatpak('io.gitlab.librewolf-community', 'LibreWolf (Flatpak)', 'gecko')),
    inFlatpak('org.mozilla.firefox', () => flatpak('org.mozilla.firefox', 'Firefox (Flatpak)', 'gecko'))
  ])
}

// A --browser override, in the same shape as everything discovered above. A
// macOS bundle still has to be opened rather than executed, so the path decides
// which of the two it is.
export function describeBrowser(target, engine) {
  const name = path.basename(target).replace(/\.(app|exe)$/, '')
  return target.endsWith('.app') ? macApp(target, name, engine) : bin(target, name, engine)
}

// What to start when an agent asks for a tab and nothing is connected. A
// Chromium browser comes first: it is the one the extension can reach, which
// is the richer path (tab groups, focus detection, no debugging banner in Arc).
export function findBrowser() {
  return findChromium() || findGecko()
}

// The flags a Gecko browser needs to be driveable. --new-instance is what makes
// the difference between starting a remote agent and handing the arguments to a
// copy that is already running on the same profile — in which case the port
// never opens and nothing explains why.
export function geckoArgs({ bidiPort, profile }) {
  const args = [`--remote-debugging-port=${bidiPort}`]
  if (profile) args.push('--profile', profile, '--new-instance')
  return args
}

// A Flatpak browser sees its own filesystem, so a profile under ~/.canopy is
// invisible to it unless this run is granted the directory.
export function withFilesystem(found, dir) {
  if (!found?.flatpakId || !dir) return found
  return { ...found, args: ['run', `--filesystem=${dir}`, found.flatpakId] }
}
