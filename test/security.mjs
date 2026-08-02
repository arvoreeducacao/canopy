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

const proof = (secret, role, clientNonce, serverNonce) =>
  crypto.createHmac('sha256', secret).update(`${role}|${clientNonce}|${serverNonce}`).digest('hex')
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
    // origin: null exercises the path a non-browser peer takes (a local process
    // squatting the port sends no Origin at all).
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ext`, origin ? { origin } : {})
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
      daemonProved = msg.proof === proof(secret, 'daemon', myNonce, msg.nonce)
      ws.send(JSON.stringify({ event: 'hello', proof: proof(secret, 'extension', myNonce, msg.nonce), browser, orphans: [] }))
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

test('the pairing handshake cannot be reflected back at the daemon', async () => {
  // The daemon signs a nonce we choose, before we have proved anything. If both
  // directions signed the same string, a second socket would be a free oracle
  // for the proof the first one is asked for — attach with no secret at all.
  const askOracle = nonce => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ext`)
    const t = setTimeout(() => { try { ws.close() } catch {}; reject(new Error('oracle timeout')) }, 3000)
    ws.on('message', raw => {
      clearTimeout(t)
      try { ws.close() } catch {}
      resolve(JSON.parse(raw).proof)
    })
    ws.on('open', () => ws.send(JSON.stringify({ event: 'auth', nonce })))
    ws.on('error', e => { clearTimeout(t); reject(e) })
  })

  const attached = await new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ext`) // no Origin, like a local squatter
    const t = setTimeout(() => resolve(false), 6000)
    ws.on('message', async raw => {
      const msg = JSON.parse(raw)
      if (msg.event !== 'auth') return
      const stolen = await askOracle(msg.nonce).catch(() => null)
      ws.send(JSON.stringify({ event: 'hello', proof: stolen, browser: 'REFLECTED/1.0', orphans: [] }))
      setTimeout(async () => {
        clearTimeout(t)
        resolve((await status()).browser === 'REFLECTED/1.0')
        try { ws.close() } catch {}
      }, 400)
    })
    ws.on('open', () => ws.send(JSON.stringify({ event: 'auth', nonce: 'attacker-chosen' })))
    ws.on('error', () => { clearTimeout(t); resolve(false) })
  })
  assert.equal(attached, false, 'reflected proof must not attach the bridge')
})

test('a malformed cookie does not take the daemon down', async () => {
  // decodeURIComponent throws on a bad escape, and this runs before auth.
  const res = await fetch(`${BASE}/status`, { headers: { Cookie: 'canopy_token=%' } })
  assert.equal(res.status, 401)
  assert.equal((await fetch(`${BASE}/status`, { headers: { Authorization: `Bearer ${token}` } })).status, 200,
    'daemon should still be alive')
})

test('an unparseable request target does not take the daemon down', async () => {
  // "//" is protocol-relative with no host; new URL() throws on it.
  const res = await fetch(`${BASE}//`)
  assert.ok(res.status === 400 || res.status === 401, `expected 400/401, got ${res.status}`)
  assert.equal((await fetch(`${BASE}/status`, { headers: { Authorization: `Bearer ${token}` } })).status, 200,
    'daemon should still be alive')
})

test('the cookie cannot be used for cross-site writes', async () => {
  // SameSite=Strict is scoped to the site, which ignores ports — a page on any
  // other 127.0.0.1 port is same-site and its requests carry this cookie.
  const cookie = `canopy_token=${token}`
  const write = extra => fetch(`${BASE}/tabs`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'text/plain', ...extra },
    body: JSON.stringify({ url: 'https://example.com' })
  })
  assert.equal((await write({ Origin: 'http://127.0.0.1:3000', 'Sec-Fetch-Site': 'same-site' })).status, 401)
  assert.equal((await write({ Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' })).status, 401)
  assert.equal((await write({})).status, 401, 'a cookie write with no Origin at all should be refused too')
  // And a genuine cockpit read still works.
  assert.equal((await fetch(`${BASE}/actions`, {
    headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' }
  })).status, 200)
})

test('cookie reads from another origin are refused', async () => {
  const res = await fetch(`${BASE}/actions`, {
    headers: { Cookie: `canopy_token=${token}`, 'Sec-Fetch-Site': 'cross-site' }
  })
  assert.equal(res.status, 401)
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
    'http://[fd00::1]/',
    'http://localhost.:4664/status',         // trailing dot still resolves
    'http://metadata.google.internal./computeMetadata/v1/',
    'http://169.254.169.254./latest/meta-data/',
    'http://[::ffff:169.254.169.254]/',      // IPv4-mapped IPv6
    'http://[::ffff:127.0.0.1]:4664/status',
    'http://192.0.0.192/',                   // Oracle metadata
    'http://198.18.0.1/',                    // RFC2544 benchmarking block
    'http://2130706433/',                    // 127.0.0.1 as a decimal integer
    'http://0x7f000001/'                     // and as hex
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

test('an unlabelled password field does not leak its value as a name', () => {
  // nameOf() falls back to el.value, and a password box has no innerText — so
  // without an early return the password becomes the element's accessible name
  // and ships in the snapshot, which PRIVACY.md and the Web Store listing both
  // say never happens. Lift the real function out of the injected source and
  // run it, rather than pattern-matching the text.
  const src = readFileSync(new URL('../src/snapshot.js', import.meta.url), 'utf8')
  const start = src.indexOf('const nameOf = el => {')
  const end = src.indexOf('let n = 0', start)
  assert.ok(start > 0 && end > start, 'could not locate nameOf in snapshot.js')
  const body = src.slice(start, src.lastIndexOf('}', end) + 1).replace('const nameOf = ', '')
  const nameOf = eval(`(${body})`)

  const field = (over = {}) => ({
    type: 'password', value: 'SECRET-NO-LABEL', innerText: '', title: '',
    labels: [], parentElement: null,
    getAttribute: () => null, querySelector: () => null, ...over
  })
  assert.ok(!nameOf(field()).includes('SECRET'), 'the password value must not become the name')
  // A labelled one still gets a useful name, so the fix does not blind the agent.
  assert.equal(nameOf(field({ getAttribute: a => (a === 'aria-label' ? 'Senha' : null) })), 'Senha')
  // And an ordinary text input keeps its value-derived name.
  assert.equal(nameOf(field({ type: 'text', value: 'jane@example.com' })), 'jane@example.com')
})

test('browser_wait with until:js respects Stop and Take over', async () => {
  // until:'js' runs caller-supplied code through eval({silent:true}), which
  // skips #guard — it must not be a way around the user's kill switch.
  const c = new Controller(new Recorder(path.join(dataDir, 'sessions')), {})
  const tab = { id: 't1', stopRequested: true, takenOver: false, steps: 0, transport: {}, ref: {} }
  c.tabs.set('t1', tab)
  await assert.rejects(c.waitFor('t1', { until: 'js', value: 'true' }), /STOP|took over/i)
  tab.stopRequested = false
  tab.takenOver = true
  await assert.rejects(c.waitFor('t1', { until: 'js', value: 'true' }), /STOP|took over/i)
})
