import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { readFileSync } from 'node:fs'
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
  const recorder = new Recorder(path.join(base, 'sessions'))
  const controller = new Controller(recorder)

  // Port transport: retry in the background so Chrome can come up later.
  const portTransport = new PortTransport(cdpUrl)
  controller.addTransport(portTransport)
  const tryPort = async () => {
    if (portTransport.ready) return
    try {
      await portTransport.connect()
      console.log(`[canopy] CDP conectado: ${portTransport.browserInfo} (${cdpUrl})`)
    } catch {}
  }
  await tryPort()
  setInterval(tryPort, 3000).unref()
  portTransport.on('disconnected', () => console.log('[canopy] CDP (porta) desconectou'))

  // Extension transport: waits for the extension to dial in on /ext.
  const extTransport = new ExtensionTransport()
  controller.addTransport(extTransport)
  extTransport.on('connected', () => console.log(`[canopy] extensão conectada: ${extTransport.browserInfo}`))
  extTransport.on('disconnected', () => console.log('[canopy] extensão desconectou'))

  const rest = restHandler(controller, recorder)
  const mcp = mcpHandler(controller)
  const cockpitHtml = () => readFileSync(path.join(__dirname, '..', 'cockpit', 'index.html'))

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/' || url.pathname === '/cockpit') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(cockpitHtml())
    }
    if (url.pathname === '/mcp') return mcp(req, res)
    return rest(req, res, url)
  })

  const wssExt = new WebSocketServer({ noServer: true })
  const wssCockpit = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
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
  return { server, controller, recorder }
}
