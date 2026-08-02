// Security regression test — no browser required.
//
// Covers the boundaries that are easy to reopen by accident:
//   * /ws and /ext must refuse a hostile web Origin, on loopback too
//     (WebSocket is exempt from CORS, so a page the user has open can dial
//     127.0.0.1 directly unless we check Origin ourselves)
//   * /ext must not hand the bridge to a peer that cannot prove the pairing
//     secret, and must prove that secret back to the extension
//   * every route except the cockpit shell needs a credential
//   * cloud mode must not navigate to file:, chrome:, or private networks
//
//   node test/security.mjs
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { test, after } from 'node:test'
import { WebSocket } from 'ws'
import { startDaemon } from '../src/daemon.js'
import { Controller } from '../src/core.js'
import { Recorder } from '../src/recorder.js'

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-test-'))
const { server } = await startDaemon({ port: 0, bind: '127.0.0.1', dataDir })
const PORT = server.address().port
const BASE = `http://127.0.0.1:${PORT}`
const SELF_ORIGIN = `http://127.0.0.1:${PORT}`
const token = readFileSync(path.join(dataDir, 'token'), 'utf8').trim()
const extSecret = readFileSync(path.join(dataDir, 'ext-secret'), 'utf8').trim()

after(() => {
  server.close()
  rmSync(dataDir, { recursive: true, force: true })
})

const proof = (secret, nonce) => crypto.createHmac('sha256', secret).update(String(nonce)).digest('hex')
const status = () => fetch(`${BASE}/status`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())

// Resolves 'connected' only once the daemon sends something, so a socket that
// is accepted and then dropped never counts as a pass.
function dialCockpit(opts) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, opts)
    const done = r => { clearTimeout(timer); try { ws.close() } catch {}; resolve(r) }
    const timer = setTimeout(() => done('timeout'), 3000)
    ws.on('message', () => done('connected'))
    ws.on('error', () => done('refused'))
    ws.on('close', () => done('refused'))
  })
}

// Plays the extension's side of the handshake. Reports both whether the daemon
// accepted us and whether the daemon's own proof checked out.
function dialExt({ secret, origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', browser, keepOpen = false } = {}) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ext`, { origin })
    const myNonce = crypto.randomBytes(16).toString('hex')
    const timers = []
    let daemonProved = null
    let settled = false
    const done = r => {
      if (settled) return
      settled = true
      timers.forEach(clearTimeout)
      if (!keepOpen) { try { ws.close() } catch {} }
      resolve({ ...r, daemonProved, ws })
    }
    timers.push(setTimeout(() => done({ attached: false }), 3000))
    ws.on('open', () => ws.send(JSON.stringify({ event: 'auth', nonce: myNonce })))
    ws.on('message', raw => {
      const msg = JSON.parse(raw)
      if (msg.event !== 'auth') return
      daemonProved = msg.proof === proof(secret, myNonce)
      ws.send(JSON.stringify({ event: 'hello', proof: proof(secret, msg.nonce), browser, orphans: [] }))
      // Give attachSocket a beat, then ask the daemon who it thinks it is.
      timers.push(setTimeout(() => {
        if (settled) return
        status().then(s => done({ attached: s.browser === browser }), () => done({ attached: false }))
      }, 300))
    })
    ws.on('error', () => done({ attached: false }))
    ws.on('close', () => done({ attached: false }))
  })
}

test('cockpit shell hands over the token as an HttpOnly cookie', async () => {
  const res = await fetch(`${BASE}/`, { redirect: 'manual' })
  const cookie = res.headers.get('set-cookie') || ''
  assert.match(cookie, /canopy_token=/)
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Strict/)
})

test('?token= is redirected away so it leaves the URL and history', async () => {
  const res = await fetch(`${BASE}/?token=${token}`, { redirect: 'manual' })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), '/')
})

test('read-only feeds need a credential on loopback too', async () => {
  for (const route of ['/status', '/actions', '/sessions', '/tabs']) {
    assert.equal((await fetch(BASE + route)).status, 401, `${route} should be gated`)
  }
})

test('the token is accepted as Bearer, cookie or query', async () => {
  assert.equal((await fetch(`${BASE}/status`, { headers: { Authorization: `Bearer ${token}` } })).status, 200)
  assert.equal((await fetch(`${BASE}/status`, { headers: { Cookie: `canopy_token=${token}` } })).status, 200)
  assert.equal((await fetch(`${BASE}/status?token=${token}`)).status, 200)
})

test('a wrong token is refused', async () => {
  const wrong = 'a'.repeat(token.length)
  assert.equal((await fetch(`${BASE}/status`, { headers: { Authorization: `Bearer ${wrong}` } })).status, 401)
})

test('identity headers alone never authenticate', async () => {
  const res = await fetch(`${BASE}/status`, { headers: { 'x-auth-request-email': 'someone@example.com' } })
  assert.equal(res.status, 401)
})

test('a page on another origin cannot open the cockpit socket', async () => {
  // Even holding the token: this is what stops any tab the user has open from
  // subscribing to the screencast of every agent tab.
  assert.equal(await dialCockpit({ origin: 'https://evil.example', headers: { Authorization: `Bearer ${token}` } }), 'refused')
})

test('the cockpit socket still needs the token from our own origin', async () => {
  assert.equal(await dialCockpit({ origin: SELF_ORIGIN }), 'refused')
})

test('the real cockpit and CLI can open the socket', async () => {
  assert.equal(await dialCockpit({ origin: SELF_ORIGIN, headers: { Cookie: `canopy_token=${token}` } }), 'connected')
  assert.equal(await dialCockpit({ headers: { Authorization: `Bearer ${token}` } }), 'connected')
})

test('the extension bridge requires the pairing secret both ways', async () => {
  const good = await dialExt({ secret: extSecret, browser: 'GOOD/1.0', keepOpen: true })
  assert.equal(good.attached, true, 'the paired extension should attach')
  assert.equal(good.daemonProved, true, 'the daemon should prove the secret to the extension')

  // A local process that squats the port learns nothing it can replay, and
  // must not be able to displace the bridge that is already attached.
  const impostor = await dialExt({ secret: '0'.repeat(32), browser: 'IMPOSTOR/1.0' })
  assert.equal(impostor.attached, false)
  assert.equal(impostor.daemonProved, false, 'the extension must be able to spot a fake daemon')
  assert.equal((await status()).browser, 'GOOD/1.0', 'a failed pairing must not knock off the real bridge')

  good.ws.close()
})

test('a web page cannot pose as the extension', async () => {
  const res = await dialExt({ secret: extSecret, origin: 'https://evil.example', browser: 'WEB/1.0' })
  assert.equal(res.attached, false)
})

test('cloud mode refuses local schemes and private networks', async () => {
  const cloud = new Controller(new Recorder(path.join(dataDir, 'sessions')), { restrictUrls: true })
  const blocked = [
    'file:///data/token',                    // the daemon's own token
    'file:///data/profile/Default/Cookies',  // the logged-in profile's cookie DB
    'chrome://net-internals',
    'view-source:http://example.com',
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://10.0.0.5/admin',
    'http://172.17.0.1:4664/status',         // the Docker bridge
    'http://canopy:4664/status',             // a bare service name
    'http://[fd00::1]/'
  ]
  for (const url of blocked) {
    await assert.rejects(cloud.openTab(url), /not allowed|refusing to navigate/, `${url} should be blocked`)
  }
  // Real sites still get through — they fail later, on there being no browser.
  await assert.rejects(cloud.openTab('https://example.com'), /no browser connected/)
})

test('local mode keeps dev servers reachable but still blocks file:', async () => {
  const local = new Controller(new Recorder(path.join(dataDir, 'sessions')), { restrictUrls: false })
  await assert.rejects(local.openTab('file:///etc/passwd'), /not allowed/)
  await assert.rejects(local.openTab('http://localhost:3000/'), /no browser connected/)
})
