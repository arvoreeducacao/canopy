#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { startDaemon } from '../src/daemon.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = name => args.includes(name)
const opt = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}

const port = Number(opt('--port', 4664))
const cdpPort = Number(opt('--cdp-port', 9222))

// Branded Chrome 137+ ignores --load-extension; Chrome for Testing still honors
// it, so the dev browser gets the extension (tab grouping, focus-pause).
// Install once with: pnpm dlx @puppeteer/browsers install chrome@stable --path ~/.canopy/browsers
function findChromeForTesting() {
  const base = path.join(os.homedir(), '.canopy', 'browsers', 'chrome')
  try {
    for (const dir of fs.readdirSync(base).sort().reverse()) {
      const app = path.join(base, dir, 'chrome-mac-arm64', 'Google Chrome for Testing.app')
      if (fs.existsSync(app)) return app
    }
  } catch {}
  return null
}

await startDaemon({ port, cdpUrl: `http://127.0.0.1:${cdpPort}` })

if (flag('--launch-chrome')) {
  const cft = findChromeForTesting()
  const app = opt('--browser', cft || 'Google Chrome')
  const profile = opt('--profile', path.join(os.homedir(), '.canopy', 'chrome-profile'))
  const extDir = path.join(__dirname, '..', 'extension')
  // `open -g -n` launches without stealing focus from whatever the user is doing.
  const child = spawn('open', [
    '-g', '-n', '-a', app, '--args',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${cdpPort}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    `--load-extension=${extDir}`,
    `http://127.0.0.1:${port}/`
  ], { detached: true, stdio: 'ignore' })
  child.unref()
  console.log(`[canopy] browser lançado em segundo plano: ${path.basename(app)} (perfil ${profile}, CDP ${cdpPort})`)
  if (!cft && !opt('--browser', null)) {
    console.log('[canopy] dica: instale o Chrome for Testing para a extensão carregar no browser de teste:')
    console.log('           pnpm dlx @puppeteer/browsers install chrome@stable --path ~/.canopy/browsers')
  }
}

console.log('[canopy] pronto. Para o Arc: carregue a pasta extension/ em arc://extensions (modo desenvolvedor).')
