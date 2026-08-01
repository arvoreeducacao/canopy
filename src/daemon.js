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

export async function startDaemon({ port = 4664, cdpUrl = 'http://127.0.0.1:9222', dataDir } = {}) {
  const base = dataDir || path.join(os.homedir(), '.canopy')
  mkdirSync(base, { recursive: true })
  const recorder = new Recorder(path.join(base, 'sessions'))
  const controller = new Controller(recorder)

  // Shared-secret auth: any local process can reach 127.0.0.1, and /mcp + REST
  // can drive the user's logged-in browser. The token gates every control
  // surface; the cockpit UI keeps its read-only feeds. CANOPY_NO_AUTH=1 opts out.
  const tokenPath = path.join(base, 'token')
  let token = ''
  try { token = readFileSync(tokenPath, 'utf8').trim() } catch {}
  if (!token) {
    token = crypto.randomBytes(24).toString('hex')
    writeFileSync(tokenPath, token + '\n', { mode: 0o600 })
  }
  const noAuth = process.env.CANOPY_NO_AUTH === '1'
  const authed = (req, url) => noAuth
    || req.headers.authorization === `Bearer ${token}`
    || url.searchParams.get('token') === token
  const needsAuth = (req, url) => {
    if (url.pathname === '/mcp') return true
    if (url.pathname === '/ext-tabs') return true
    if (req.method !== 'GET') return true
    // Live page content (text, snapshots, screenshots, network) is as
    // sensitive as control — only the cockpit's own feeds stay open.
    return /^\/tabs\/[^/]+\/(screenshot|text|snapshot|requests|request)/.test(url.pathname)
  }

  // Port transport: retry in the background so Chrome can come up later.
  const portTransport = new PortTransport(cdpUrl)
  controller.addTransport(portTransport)
  const tryPort = async () => {
    if (portTransport.ready) return
    try {
      await portTransport.connect()
      console.log(`[canopy] CDP conectado: ${portTransport.browserInfo} (${cdpUrl})`)
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
  portTransport.on('disconnected', () => console.log('[canopy] CDP (porta) desconectou'))

  // Browser closed? openTab asks us to launch one in the background and waits
  // for a transport (extension hello or CDP port) to come up.
  controller.requestBrowser = async () => {
    if (process.platform !== 'darwin') return null
    const app = ['/Applications/Arc.app', '/Applications/Google Chrome.app', '/Applications/Chromium.app']
      .find(a => existsSync(a))
    if (!app) return null
    console.log(`[canopy] nenhum browser conectado — abrindo ${path.basename(app, '.app')} em segundo plano`)
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
  extTransport.on('connected', () => console.log(`[canopy] extensão conectada: ${extTransport.browserInfo}`))
  extTransport.on('disconnected', () => console.log('[canopy] extensão desconectou'))

  const rest = restHandler(controller, recorder)
  const mcp = mcpHandler(controller)
  const cockpitHtml = () => readFileSync(path.join(__dirname, '..', 'cockpit', 'index.html'))

  // DNS-rebinding guard: a hostile page can point its own domain at 127.0.0.1
  // and fetch us same-origin — the Host header gives it away.
  const hostOk = req => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.host || '')

  const server = http.createServer(async (req, res) => {
    if (!hostOk(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'forbidden host' }))
    }
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/' || url.pathname === '/cockpit') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(cockpitHtml())
    }
    if (needsAuth(req, url) && !authed(req, url)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: `unauthorized — pass "Authorization: Bearer <token>" (token em ${tokenPath})` }))
    }
    if (url.pathname === '/mcp') return mcp(req, res)
    return rest(req, res, url)
  })

  const wssExt = new WebSocketServer({ noServer: true })
  const wssCockpit = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    if (!hostOk(req)) return socket.destroy()
    const { pathname } = new URL(req.url, 'http://localhost')
    if (pathname === '/ext') {
      wssExt.handleUpgrade(req, socket, head, ws => {
        ws.once('message', raw => {
          let hello = {}
          try { hello = JSON.parse(raw) } catch {}
          if (hello.event === 'hello') extTransport.attachSocket(ws, hello)
        })
      })
    } else if (pathname === '/ws') {
      wssCockpit.handleUpgrade(req, socket, head, ws => {
        controller.setStreaming(true)
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
      })
    } else {
      socket.destroy()
    }
  })

  controller.viewers = () => wssCockpit.clients.size

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
    server.listen(port, '127.0.0.1', resolve)
  })

  console.log(`[canopy] cockpit  http://127.0.0.1:${port}/`)
  console.log(`[canopy] mcp      http://127.0.0.1:${port}/mcp`)
  console.log(`[canopy] rest     http://127.0.0.1:${port}/status`)
  if (noAuth) {
    console.log('[canopy] auth     DESLIGADA (CANOPY_NO_AUTH=1)')
  } else {
    console.log(`[canopy] auth     token em ${tokenPath}`)
    console.log(`[canopy] conectar: claude mcp add --transport http canopy http://127.0.0.1:${port}/mcp --header "Authorization: Bearer ${token}"`)
  }
  return { server, controller, recorder, token }
}
