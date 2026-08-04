// Live probe: the whole controller, driven through WebDriver BiDi.
//
// Needs a Gecko browser listening on a BiDi port and nothing else — no daemon,
// no MCP client, no network. The page under test is served from this process,
// so a failure here is Canopy's, not the internet's.
//
//   canopy --launch-firefox          # or: zen --remote-debugging-port=9223
//   node test/bidi-live.mjs
//
// CANOPY_BIDI_URL overrides the endpoint.
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { Controller } from '../src/core.js'
import { Recorder } from '../src/recorder.js'
import { BidiTransport } from '../src/cdp/bidi-transport.js'

const PAGE = `<!doctype html>
<meta charset="utf-8"><title>Canopy BiDi probe</title>
<body style="margin:0;font:16px system-ui">
  <h1 id="head">probe</h1>
  <button id="go" style="width:200px;height:44px">Open the panel</button>
  <div id="panel" hidden><p>panel is open</p></div>
  <form id="f" onsubmit="event.preventDefault();out.textContent='submitted:'+q.value">
    <input id="q" name="q" placeholder="search" style="width:300px;height:36px">
  </form>
  <p id="out">idle</p>
  <p style="height:1200px">tall</p>
  <script>
    go.onclick = () => { panel.hidden = false; out.textContent = 'panel opened' }
    console.error('a console error the agent should see')
    fetch('/api/thing').then(r => r.json()).catch(() => {})
    fetch('/api/missing').catch(() => {})
  </script>
</body>`

const server = http.createServer((req, res) => {
  if (req.url === '/api/thing') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end('{"ok":true}')
  }
  if (req.url === '/api/missing') {
    res.writeHead(503, { 'Content-Type': 'application/json' })
    return res.end('{"error":"nope"}')
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(PAGE)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-bidi-'))
const controller = new Controller(new Recorder(path.join(dataDir, 'sessions')))
const transport = new BidiTransport(process.env.CANOPY_BIDI_URL || 'ws://127.0.0.1:9223/session')
controller.addTransport(transport)

let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  — ${detail}` : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

try {
  await transport.connect()
} catch (err) {
  console.error(`could not reach a Gecko browser at ${transport.url}: ${err.message}`)
  console.error('start one with: canopy --launch-firefox')
  server.close()
  process.exit(1)
}
console.log(`connected: ${transport.browserInfo}`)

const tab = await controller.openTab(origin, { label: 'probe' })
await controller.waitFor(tab.id, { until: 'load', timeoutMs: 15000 })

const { snap, text } = await controller.snapshot(tab.id)
check('snapshot finds the page', snap.title === 'Canopy BiDi probe', snap.title)
check('snapshot finds interactive refs', snap.elements.length >= 2, `${snap.elements.length} elements`)

const button = snap.elements.find(e => (e.name || '').includes('Open the panel'))
const input = snap.elements.find(e => e.tag === 'input')
check('the button is in the snapshot', !!button)
check('the input is in the snapshot', !!input)

const clicked = await controller.act(tab.id, { action: 'click', ref: button?.ref })
check('click reaches a background tab', /panel opened/.test(await controller.eval(tab.id, 'out.textContent', { silent: true })))
check('click reports what changed', /changed:/.test(clicked.after || ''), clicked.after)

await controller.act(tab.id, { action: 'fill', ref: input?.ref, text: 'hello bidi' })
check('fill types into the focused field', (await controller.eval(tab.id, 'q.value', { silent: true })) === 'hello bidi')

await controller.act(tab.id, { action: 'press', key: 'Enter' })
await sleep(300)
check('Enter submits the form', /submitted:hello bidi/.test(await controller.eval(tab.id, 'out.textContent', { silent: true })))

const problems = controller.consoleMessages(tab.id, { level: 'error', limit: 10 })
const messages = problems.messages.map(m => m.text).join(' | ')
check('console errors reach the agent', /a console error the agent should see/.test(messages), messages.slice(0, 120))
check('a 5xx response is reported', /503/.test(messages), messages.slice(0, 120))

const requests = controller.listRequests(tab.id, { limit: 40 })
check('XHR/fetch traffic is captured', requests.some(r => r.url.endsWith('/api/thing')), `${requests.length} requests`)

const read = await controller.readPage(tab.id, 500)
check('readPage returns page text', /panel is open/.test(read))

await controller.act(tab.id, { action: 'scroll', dy: 300 })
check('scroll moves the page', Number(await controller.eval(tab.id, 'window.scrollY', { silent: true })) > 100)

const shot = await controller.screenshot(tab.id)
check('screenshot is a real PNG', !!shot.size && shot.size.width > 0, shot.size && `${shot.size.width}x${shot.size.height}`)

const resized = await controller.resize(tab.id, { width: 390, height: 844, mobile: true })
check('resize emulates a viewport', resized.viewport[0] === 390, JSON.stringify(resized.viewport))
await controller.resize(tab.id, { reset: true })

// The Take over / Stop pill talks to the daemon through the binding, which on
// BiDi is a preload script channel — the one piece with no CDP equivalent.
const control = new Promise(resolve => {
  const onState = () => {
    if (controller.getTab(tab.id).takenOver) {
      controller.off('state', onState)
      resolve(true)
    }
  }
  controller.on('state', onState)
  setTimeout(() => resolve(false), 5000)
})
await controller.eval(tab.id, `window.__canopyControl(JSON.stringify({ action: 'takeover' })), 1`, { silent: true })
check('the take-over binding reaches the daemon', await control)

controller.setControl(tab.id, { takenOver: false })
await controller.closeTab(tab.id)
check('the tab is gone after close', controller.listTabs().length === 0)

await transport.end()
server.close()
rmSync(dataDir, { recursive: true, force: true })
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
