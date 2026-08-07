import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { Controller } from './core.js'
import { Recorder } from './recorder.js'
import { PortTransport } from './cdp/port-transport.js'
import { ExtensionTransport } from './cdp/extension-transport.js'
import { restHandler } from './rest.js'
import { mcpHandler } from './mcp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export async function startDaemon({ port = 4664, bind = '127.0.0.1', publicHost = '', ssoHost = '', ssoHeader = 'x-auth-request-email', ssoSecret = '', extId = '', mcpOrigin = '', cdpUrl = 'http://127.0.0.1:9222', dataDir } = {}) {
  const plain = { log: console.log.bind(console), error: console.error.bind(console) }
  const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
  console.log = (...args) => plain.log(stamp(), ...args)
  console.error = (...args) => plain.error(stamp(), ...args)

  // Cloud mode: bound beyond loopback, every route and socket is token-gated
  // (only the cockpit shell stays open — it holds no data without the token).
  const isPublic = !/^(127\.0\.0\.1|localhost|::1)$/.test(bind)
  const publicHosts = publicHost.split(',').map(s => s.trim()).filter(Boolean)
  const base = dataDir || path.join(os.homedir(), '.canopy')
  mkdirSync(base, { recursive: true })
  const recorder = new Recorder(path.join(base, 'sessions'))
  const controller = new Controller(recorder, { restrictUrls: isPublic })

  // Shared-secret auth: any local process can reach 127.0.0.1, and /mcp + REST
  // can drive the user's logged-in browser. The token gates every route and
  // socket except the cockpit shell, which carries no data of its own.
  // CANOPY_NO_AUTH=1 opts out, and is refused on a non-loopback bind.
  const tokenPath = path.join(base, 'token')
  let token = (process.env.CANOPY_TOKEN || '').trim()
  if (token) writeFileSync(tokenPath, token + '\n', { mode: 0o600 })
  try { if (!token) token = readFileSync(tokenPath, 'utf8').trim() } catch {}
  if (!token) {
    token = crypto.randomBytes(24).toString('hex')
    writeFileSync(tokenPath, token + '\n', { mode: 0o600 })
  }
  const noAuth = process.env.CANOPY_NO_AUTH === '1'
  if (isPublic && noAuth) throw new Error('CANOPY_NO_AUTH=1 with a non-loopback bind would expose the browser to the internet — refusing to start')

  // Pairing secret for the extension bridge. Separate from the API token: the
  // extension proves it with an HMAC and never puts it on the wire, so a local
  // process squatting the port learns nothing it could replay.
  const extSecretPath = path.join(base, 'ext-secret')
  let extSecret = (process.env.CANOPY_EXT_SECRET || '').trim()
  if (extSecret) writeFileSync(extSecretPath, extSecret + '\n', { mode: 0o600 })
  try { if (!extSecret) extSecret = readFileSync(extSecretPath, 'utf8').trim() } catch {}
  if (!extSecret) {
    extSecret = crypto.randomBytes(16).toString('hex')
    writeFileSync(extSecretPath, extSecret + '\n', { mode: 0o600 })
  }

  const secretEq = (value, expected) => {
    if (typeof value !== 'string' || !expected) return false
    const a = Buffer.from(value)
    const b = Buffer.from(expected)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }
  const tokenEq = value => secretEq(value, token)
  const bearer = req => {
    const h = req.headers.authorization || ''
    return h.startsWith('Bearer ') ? h.slice(7) : ''
  }
  const cookie = (req, name) => {
    for (const part of (req.headers.cookie || '').split(';')) {
      const eq = part.indexOf('=')
      if (eq > 0 && part.slice(0, eq).trim() === name) {
        const raw = part.slice(eq + 1).trim()
        // A malformed percent-escape makes decodeURIComponent throw, and this
        // runs before any auth check — one bad byte would take the daemon down.
        try { return decodeURIComponent(raw) } catch { return raw }
      }
    }
    return ''
  }
  // Origin, measured against the Host we were addressed as — hostOk has already
  // pinned that to loopback or a configured public host, so a match means the
  // request came from a page we served. An absent Origin means a non-browser
  // client, which is held to the token instead.
  const sameOrigin = req => {
    const origin = req.headers.origin
    if (origin === undefined) return true
    const host = req.headers.host || ''
    return origin === `http://${host}` || origin === `https://${host}`
  }
  // The cookie is an ambient credential: the browser attaches it to requests
  // the page never meant to make, and SameSite=Strict is scoped to the *site*,
  // which ignores ports — so any other service on 127.0.0.1 counts as same-site
  // and could ride it. Bearer and ?token= callers are explicit and stay exempt;
  // cookie callers have to look like our own page.
  const cookieAuthed = req => {
    if (!tokenEq(cookie(req, 'canopy_token'))) return false
    const site = req.headers['sec-fetch-site']
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return false
    if (req.method === 'GET' || req.method === 'HEAD') return true
    // Anything that changes state must carry a matching Origin. Browsers always
    // send one on these methods; the cockpit itself only ever GETs.
    return req.headers.origin !== undefined && sameOrigin(req)
  }
  // SSO: the proxy's forwardAuth overwrites the identity header, so on the SSO
  // host its presence does mean a logged-in user — but only for traffic that
  // actually went through the proxy. The shared secret is what establishes
  // that; without one configured, SSO stays off rather than becoming a weaker
  // path to authentication than the token.
  const ssoOk = req => !!ssoHost && !!ssoSecret
    && (req.headers.host || '').replace(/:\d+$/, '') === ssoHost
    && !!req.headers[ssoHeader]
    && secretEq(req.headers['x-canopy-sso-secret'], ssoSecret)
  const authed = (req, url) => noAuth
    || tokenEq(bearer(req))
    || tokenEq(url.searchParams.get('token'))
    || cookieAuthed(req)
    || ssoOk(req)
  // Only the cockpit shell is served without a token, and it carries no data.
  // The action feed, session list and recorded frames are as sensitive as
  // control — every local process shares loopback, so they are gated too.
  const needsAuth = url => url.pathname !== '/' && url.pathname !== '/cockpit'

  // Port transport: retry in the background so Chrome can come up later.
  const portTransport = new PortTransport(cdpUrl)
  controller.addTransport(portTransport)
  const tryPort = async () => {
    if (portTransport.ready) return
    try {
      await portTransport.connect()
      console.log(`[canopy] CDP connected: ${portTransport.browserInfo} (${cdpUrl})`)
      // Orphan sweep (port mode): tabs still wearing the "AI · " badge belong
      // to a dead daemon — this one tracks none of them yet.
      const targets = await portTransport.listTargets().catch(() => [])
      for (const t of targets) {
        if (/^AI · /.test(t.title || '')) await portTransport.closeTab({ targetId: t.targetId }).catch(() => {})
      }
    } catch {}
  }
  await tryPort()
  setInterval(tryPort, 3000).unref()
  portTransport.on('disconnected', () => console.log('[canopy] CDP (port) disconnected'))

  // Browser closed? openTab asks us to launch one in the background and waits
  // for a transport (extension hello or CDP port) to come up.
  controller.requestBrowser = async () => {
    if (process.platform !== 'darwin') return null
    const app = ['/Applications/Arc.app', '/Applications/Google Chrome.app', '/Applications/Chromium.app']
      .find(a => existsSync(a))
    if (!app) return null
    console.log(`[canopy] no browser connected — launching ${path.basename(app, '.app')} in the background`)
    spawn('open', ['-g', '-a', app], { detached: true, stdio: 'ignore' }).unref()
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const t = controller.transport()
      if (t) return t
      await new Promise(r => setTimeout(r, 500))
    }
    return null
  }

  // Extension transport: waits for the extension to dial in on /ext.
  const extTransport = new ExtensionTransport()
  controller.addTransport(extTransport)
  extTransport.on('connected', () => console.log(`[canopy] extension connected: ${extTransport.browserInfo}`))
  extTransport.on('disconnected', () => console.log('[canopy] extension disconnected'))

  const rest = restHandler(controller, recorder)
  const mcp = mcpHandler(controller)
  const cockpitHtml = () => {
    let html = readFileSync(path.join(__dirname, '..', 'cockpit', 'index.html'), 'utf8')
    if (mcpOrigin) html = html.replace('window.CANOPY_MCP_ORIGIN = null', `window.CANOPY_MCP_ORIGIN = ${JSON.stringify(mcpOrigin)}`)
    return html
  }

  // DNS-rebinding guard: a hostile page can point its own domain at 127.0.0.1
  // and fetch us same-origin — the Host header gives it away. In cloud mode
  // the reverse proxy forwards the public hostname, so that one is allowed too.
  const hostOk = req => {
    const host = req.headers.host || ''
    if (/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return true
    return publicHosts.includes(host.replace(/:\d+$/, ''))
  }

  // A request-target the URL parser rejects — "//" is protocol-relative with no
  // host — would otherwise throw here, before any auth runs, and take the whole
  // daemon with it. Any page the user has open can send one.
  const parseUrl = req => {
    try { return new URL(req.url, 'http://localhost') } catch { return null }
  }

  const server = http.createServer(async (req, res) => {
    if (!hostOk(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'forbidden host' }))
    }
    const url = parseUrl(req)
    if (!url) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'bad request target' }))
    }
    if (url.pathname === '/' || url.pathname === '/cockpit') {
      const headers = { 'Content-Type': 'text/html; charset=utf-8' }
      // The cockpit gets its credential as an HttpOnly cookie: out of reach of
      // page JS, out of the address bar and out of the proxy access log. On
      // loopback the shell hands it over (any local process can already read
      // the token file); in cloud mode you arrive with ?token= once, or via SSO.
      if (!isPublic || authed(req, url)) {
        headers['Set-Cookie'] = `canopy_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${isPublic ? '; Secure' : ''}`
        if (url.searchParams.get('token')) {
          res.writeHead(302, { ...headers, Location: url.pathname })
          return res.end()
        }
      }
      res.writeHead(200, headers)
      return res.end(cockpitHtml())
    }
    if (needsAuth(url) && !authed(req, url)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: `unauthorized — pass "Authorization: Bearer <token>" (token at ${tokenPath})` }))
    }
    if (url.pathname === '/mcp') return mcp(req, res)
    return rest(req, res, url)
  })

  const wssExt = new WebSocketServer({ noServer: true })
  const wssCockpit = new WebSocketServer({ noServer: true })


  // Mutual proof over the pairing secret. The extension verifies us before it
  // will run a single command — otherwise any local process that grabs the
  // port (squatting it before we start, or during a restart) inherits
  // chrome.debugger over every tab in the real browser — and we verify it
  // before handing it the bridge.
  // Each direction signs a different string. With one shared function the
  // daemon is an oracle for the very value it then demands: open a second
  // socket, hand it the nonce you were challenged with, and reflect its answer
  // back on the first — attaching without ever knowing the secret. The role
  // prefix breaks that, and binding both nonces keeps a proof tied to the
  // exchange it was made in.
  const extProof = (role, clientNonce, serverNonce) =>
    crypto.createHmac('sha256', extSecret).update(`${role}|${clientNonce}|${serverNonce}`).digest('hex')
  const extHandshake = ws => {
    const ourNonce = crypto.randomBytes(16).toString('hex')
    const timer = setTimeout(() => { try { ws.close() } catch {} }, 10000)
    const refuse = why => {
      clearTimeout(timer)
      console.log(`[canopy] /ext refused: ${why}`)
      try { ws.close() } catch {}
    }
    ws.once('message', raw => {
      let msg = {}
      try { msg = JSON.parse(raw) } catch {}
      if (msg.event !== 'auth' || typeof msg.nonce !== 'string') return refuse('no handshake (outdated extension?)')
      ws.send(JSON.stringify({ event: 'auth', proof: extProof('daemon', msg.nonce, ourNonce), nonce: ourNonce }))
      ws.once('message', raw2 => {
        let hello = {}
        try { hello = JSON.parse(raw2) } catch {}
        if (hello.event !== 'hello' || !secretEq(hello.proof, extProof('extension', msg.nonce, ourNonce))) return refuse('bad pairing proof')
        clearTimeout(timer)
        extTransport.attachSocket(ws, hello)
      })
    })
  }

  const cockpitSocket = ws => {
    controller.setStreaming(true)
    ws.isAlive = true
    ws.on('pong', () => { ws.isAlive = true })
    ws.on('close', () => {
      if (wssCockpit.clients.size === 0) controller.setStreaming(false)
    })
    ws.send(JSON.stringify({ t: 'state', data: controller.status() }))
    ws.on('message', async raw => {
      let msg = {}
      try { msg = JSON.parse(raw) } catch { return }
      try {
        if (msg.t === 'takeover') {
          controller.setControl(msg.tab, { takenOver: true })
          await controller.activateTab(msg.tab).catch(() => {})
        }
        if (msg.t === 'resume') controller.setControl(msg.tab, { takenOver: false, stopRequested: false })
        if (msg.t === 'stop') controller.setControl(msg.tab, { stopRequested: true })
        if (msg.t === 'close') await controller.closeTab(msg.tab)
      } catch {}
    })
  }

  server.on('upgrade', (req, socket, head) => {
    if (!hostOk(req)) return socket.destroy()
    const url = parseUrl(req)
    if (!url) return socket.destroy()
    const origin = req.headers.origin
    const { pathname } = url

    if (pathname === '/ext') {
      // Web origins have no business here at all; past that gate the peer
      // still has to prove the pairing secret before it becomes the bridge.
      if (origin !== undefined && !origin.startsWith('chrome-extension://')) return socket.destroy()
      if (extId && origin !== undefined && origin !== `chrome-extension://${extId}`) return socket.destroy()
      // Cloud mode runs headless with no extension at all, so nothing legitimate
      // dials this from the internet — require the token there as well.
      if (isPublic && !authed(req, url)) return socket.destroy()
      return wssExt.handleUpgrade(req, socket, head, extHandshake)
    }

    if (pathname === '/ws') {
      // Browser clients must come from a page we served ourselves; every
      // client, browser or not, must still present the token.
      if (!sameOrigin(req)) return socket.destroy()
      if (!authed(req, url)) return socket.destroy()
      return wssCockpit.handleUpgrade(req, socket, head, cockpitSocket)
    }

    socket.destroy()
  })

  controller.viewers = () => wssCockpit.clients.size

  // A cockpit tab that dies without a FIN (Arc archives tabs in place) would
  // otherwise hold clients.size above zero and keep every tab screencasting
  // at full rate forever — ping each client and drop the ones that go quiet.
  const cockpitSweep = setInterval(() => {
    for (const c of wssCockpit.clients) {
      if (c.isAlive === false) { c.terminate(); continue }
      c.isAlive = false
      try { c.ping() } catch {}
    }
    if (wssCockpit.clients.size === 0) controller.setStreaming(false)
  }, 30000)
  cockpitSweep.unref?.()

  // Nothing else ever reclaims a tab whose agent died without closing it.
  const idleSweep = setInterval(() => {
    controller.reapIdleTabs()
      .then(ids => { if (ids.length) console.log(`[canopy] reclaimed ${ids.length} idle agent tab(s): ${ids.join(', ')}`) })
      .catch(() => {})
  }, 60000)
  idleSweep.unref?.()

  const broadcast = msg => {
    const raw = JSON.stringify(msg)
    for (const c of wssCockpit.clients) {
      if (c.readyState === 1 && c.bufferedAmount < 4 * 1024 * 1024) c.send(raw)
    }
  }
  controller.on('state', data => broadcast({ t: 'state', data }))
  controller.on('action', data => broadcast({ t: 'action', data }))
  controller.on('frame', ({ tab, session, data }) => broadcast({ t: 'frame', tab, session, data }))

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, bind, resolve)
  })

  const shownHost = publicHosts[0] || (isPublic ? bind : '127.0.0.1')
  const origin = publicHosts[0] ? `https://${publicHosts[0]}` : `http://${shownHost}:${port}`
  console.log(`[canopy] bind     ${bind}:${port}${isPublic ? ' (public — everything requires the token)' : ''}`)
  console.log(`[canopy] cockpit  ${origin}/${isPublic ? '?token=<token>' : ''}`)
  console.log(`[canopy] mcp      ${origin}/mcp`)
  console.log(`[canopy] rest     ${origin}/status`)
  if (noAuth) {
    console.log('[canopy] auth     OFF (CANOPY_NO_AUTH=1)')
  } else if (isPublic) {
    // Never print the token here: stdout is the container log, which the
    // Dokploy UI and every log shipper can read.
    console.log('[canopy] auth     token via CANOPY_TOKEN')
    console.log(`[canopy] connect: claude mcp add --transport http canopy ${origin}/mcp --header "Authorization: Bearer <CANOPY_TOKEN>"`)
  } else {
    console.log(`[canopy] auth     token at ${tokenPath}`)
    console.log(`[canopy] connect: claude mcp add --transport http canopy ${origin}/mcp --header "Authorization: Bearer $(cat ${tokenPath})"`)
    console.log(`[canopy] pairing  pair the extension once with the code in ${extSecretPath} (canopy pair)`)
  }
  if (ssoHost && !ssoSecret) {
    console.log('[canopy] warning  CANOPY_SSO_HOST without CANOPY_SSO_SECRET — SSO is off; use the token')
  }
  return { server, controller, recorder, token, extSecret }
}
