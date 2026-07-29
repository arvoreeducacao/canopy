const http = require('http')

const AGENT_SPACE = 'Agentes'
const AGENT_COLOR = '#F59E0B'

function json(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(body)
}

function readBody(req) {
  return new Promise(resolve => {
    let data = ''
    req.on('data', c => { data += c })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) } catch { resolve({}) }
    })
  })
}

async function targetIdOf(wc) {
  const attached = wc.debugger.isAttached()
  try {
    if (!attached) wc.debugger.attach('1.3')
    const { targetInfo } = await wc.debugger.sendCommand('Target.getTargetInfo')
    if (!attached) wc.debugger.detach()
    return targetInfo.targetId
  } catch {
    return null
  }
}

async function captureTab(tabs, tab) {
  const win = tabs.win
  const wasAttached = tabs.attachedView === tab.view
  if (!wasAttached) {
    tab.view.setBounds(tabs.contentBounds || { x: 0, y: 0, width: 1200, height: 800 })
    win.contentView.addChildView(tab.view, 0)
    await new Promise(r => setTimeout(r, 350))
  }
  let png = null
  try {
    const image = await tab.view.webContents.capturePage()
    if (!image.isEmpty()) png = image.toPNG()
  } catch {}
  if (!png) {
    const wc = tab.view.webContents
    const attached = wc.debugger.isAttached()
    try {
      if (!attached) wc.debugger.attach('1.3')
      const { data } = await wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: false })
      png = Buffer.from(data, 'base64')
    } catch {}
    if (!attached && wc.debugger.isAttached()) {
      try { wc.debugger.detach() } catch {}
    }
  }
  if (!wasAttached) win.contentView.removeChildView(tab.view)
  return png
}

function startAgentApi(ctx) {
  const server = http.createServer(async (req, res) => {
    const tabs = ctx.tabs()
    if (!tabs) return json(res, 503, { error: 'window not ready' })
    const url = new URL(req.url, 'http://localhost')
    const parts = url.pathname.split('/').filter(Boolean)

    try {
      if (req.method === 'GET' && parts.length === 0) {
        return json(res, 200, {
          name: 'galho',
          version: '0.1.0',
          cdp: { port: Number(ctx.cdpPort), list: `http://127.0.0.1:${ctx.cdpPort}/json` },
          endpoints: [
            'GET /tabs',
            'POST /tabs {url, space?, activate?}',
            'GET /tabs/:id',
            'POST /tabs/:id/navigate {url}',
            'POST /tabs/:id/activate',
            'GET /tabs/:id/screenshot',
            'GET /tabs/:id/text',
            'POST /tabs/:id/eval {expression}',
            'DELETE /tabs/:id',
            'GET /spaces'
          ]
        })
      }

      if (req.method === 'GET' && parts[0] === 'spaces') {
        return json(res, 200, tabs.spaces.map(s => ({
          id: s.id,
          name: s.name,
          color: s.color,
          active: s.id === tabs.activeSpaceId,
          tabCount: s.tabIds.length
        })))
      }

      if (parts[0] === 'tabs' && parts.length === 1) {
        if (req.method === 'GET') {
          const list = []
          for (const space of tabs.spaces) {
            for (const id of space.tabIds) {
              const tab = tabs.tabs.get(id)
              if (!tab) continue
              const entry = {
                id: tab.id,
                url: tab.url,
                title: tab.title,
                space: space.name,
                active: space.activeTabId === tab.id && space.id === tabs.activeSpaceId,
                loading: tab.loading
              }
              if (tab.view) {
                const targetId = await targetIdOf(tab.view.webContents)
                if (targetId) {
                  entry.targetId = targetId
                  entry.cdpUrl = `ws://127.0.0.1:${ctx.cdpPort}/devtools/page/${targetId}`
                }
              }
              list.push(entry)
            }
          }
          return json(res, 200, list)
        }
        if (req.method === 'POST') {
          const body = await readBody(req)
          if (!body.url) return json(res, 400, { error: 'url required' })
          const spaceName = body.space || AGENT_SPACE
          let space = tabs.spaces.find(s => s.name.toLowerCase() === spaceName.toLowerCase())
          if (!space) {
            space = {
              id: Math.random().toString(36).slice(2, 10),
              name: spaceName,
              color: AGENT_COLOR,
              tabIds: [],
              activeTabId: null
            }
            tabs.spaces.push(space)
          }
          const tab = tabs.createTab({ url: body.url, spaceId: space.id, activate: !!body.activate })
          const targetId = await targetIdOf(tab.view.webContents)
          return json(res, 201, {
            id: tab.id,
            url: tab.url,
            space: space.name,
            targetId,
            cdpUrl: targetId ? `ws://127.0.0.1:${ctx.cdpPort}/devtools/page/${targetId}` : null
          })
        }
      }

      if (parts[0] === 'tabs' && parts[1]) {
        const tab = tabs.tabs.get(parts[1])
        if (!tab) return json(res, 404, { error: 'tab not found' })
        const sub = parts[2]

        if (req.method === 'DELETE' && !sub) {
          tabs.closeTab(tab.id)
          return json(res, 200, { ok: true })
        }

        if (req.method === 'GET' && !sub) {
          const targetId = tab.view ? await targetIdOf(tab.view.webContents) : null
          return json(res, 200, {
            id: tab.id,
            url: tab.url,
            title: tab.title,
            loading: tab.loading,
            targetId,
            cdpUrl: targetId ? `ws://127.0.0.1:${ctx.cdpPort}/devtools/page/${targetId}` : null
          })
        }

        if (req.method === 'POST' && sub === 'navigate') {
          const body = await readBody(req)
          if (!body.url) return json(res, 400, { error: 'url required' })
          tabs.navigate(tab.id, body.url)
          return json(res, 200, { ok: true })
        }

        if (req.method === 'POST' && sub === 'activate') {
          tabs.activateTab(tab.id)
          return json(res, 200, { ok: true })
        }

        if (req.method === 'GET' && sub === 'screenshot') {
          if (!tab.view) return json(res, 409, { error: 'tab has no view yet' })
          const png = await captureTab(tabs, tab)
          if (!png) return json(res, 500, { error: 'capture failed' })
          res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length })
          return res.end(png)
        }

        if (req.method === 'GET' && sub === 'text') {
          if (!tab.view) return json(res, 409, { error: 'tab has no view yet' })
          const text = await tab.view.webContents.executeJavaScript('document.body ? document.body.innerText : ""', true)
          return json(res, 200, { id: tab.id, url: tab.url, title: tab.title, text })
        }

        if (req.method === 'POST' && sub === 'eval') {
          if (!tab.view) return json(res, 409, { error: 'tab has no view yet' })
          const body = await readBody(req)
          if (!body.expression) return json(res, 400, { error: 'expression required' })
          const result = await tab.view.webContents.executeJavaScript(body.expression, true)
          return json(res, 200, { result })
        }
      }

      return json(res, 404, { error: 'not found' })
    } catch (err) {
      return json(res, 500, { error: String(err && err.message || err) })
    }
  })

  server.listen(ctx.port, '127.0.0.1')
  return server
}

module.exports = { startAgentApi }
