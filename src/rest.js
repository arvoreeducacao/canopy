// REST mirror of the MCP tools — same controller, curl-friendly. Ports the
// Canopy agent API surface (tabs, navigate, act, eval, screenshot,
// text, control) plus sessions and replay.

// No CORS header on purpose: the cockpit is served same-origin by the daemon,
// and no other web page has any business reading these responses.
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

export function restHandler(controller, recorder) {
  return async (req, res, url) => {
    const parts = url.pathname.split('/').filter(Boolean)
    try {
      if (req.method === 'GET' && parts[0] === 'status') {
        return json(res, 200, controller.status())
      }

      if (req.method === 'GET' && parts[0] === 'ext-tabs') {
        const ext = controller.transports.find(t => t.kind === 'extension' && t.ready)
        if (!ext) return json(res, 503, { error: 'extension not connected' })
        return json(res, 200, await ext.listTabs())
      }

      if (req.method === 'GET' && parts[0] === 'actions') {
        return json(res, 200, controller.recentActions.slice(-Number(url.searchParams.get('limit') || 80)))
      }

      if (parts[0] === 'sessions') {
        if (req.method === 'GET' && !parts[1]) {
          return json(res, 200, { active: [...controller.sessions.values()].map(s => controller.sessionInfo(s)), recorded: recorder.listSessions() })
        }
        if (req.method === 'POST' && !parts[1]) {
          const body = await readBody(req)
          return json(res, 201, controller.startSession(body.label || 'sessão'))
        }
        if (req.method === 'DELETE' && parts[1]) {
          return json(res, 200, await controller.endSession(parts[1]))
        }
      }

      if (parts[0] === 'replay' && parts[1]) {
        if (parts[2] === 'frame' && parts[3]) {
          const p = recorder.framePath(parts[1], decodeURIComponent(parts[3]))
          if (!p) return json(res, 404, { error: 'frame not found' })
          const { createReadStream } = await import('node:fs')
          res.writeHead(200, { 'Content-Type': 'image/jpeg' })
          return createReadStream(p).pipe(res)
        }
        const data = recorder.replay(parts[1])
        if (!data) return json(res, 404, { error: 'session not found' })
        return json(res, 200, data)
      }

      if (parts[0] === 'tabs' && !parts[1]) {
        if (req.method === 'GET') return json(res, 200, controller.listTabs(url.searchParams.get('session') || undefined))
        if (req.method === 'POST') {
          const body = await readBody(req)
          if (!body.url) return json(res, 400, { error: 'url required' })
          const tab = await controller.openTab(body.url, body)
          return json(res, 201, { id: tab.id, url: tab.url, session: tab.session })
        }
      }

      if (parts[0] === 'tabs' && parts[1]) {
        const id = parts[1]
        const sub = parts[2]
        if (req.method === 'DELETE' && !sub) {
          await controller.closeTab(id)
          return json(res, 200, { ok: true })
        }
        if (req.method === 'GET' && !sub) {
          const t = controller.getTab(id)
          return json(res, 200, {
            id: t.id, url: t.url, title: t.title, session: t.session, label: t.label,
            takenOver: t.takenOver, stopRequested: t.stopRequested
          })
        }
        if (req.method === 'GET' && sub === 'frame') {
          const data = controller.lastFrames.get(id)
          if (!data) return json(res, 404, { error: 'no frame yet' })
          const buf = Buffer.from(data, 'base64')
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'no-store' })
          return res.end(buf)
        }
        if (req.method === 'GET' && sub === 'requests') {
          return json(res, 200, controller.listRequests(id, {
            filter: url.searchParams.get('filter') || undefined,
            limit: Number(url.searchParams.get('limit')) || undefined
          }))
        }
        if (req.method === 'GET' && sub === 'request' && parts[3]) {
          return json(res, 200, await controller.requestBody(id, parts[3]))
        }
        if (req.method === 'GET' && sub === 'screenshot') {
          const { data } = await controller.screenshot(id, { fullPage: url.searchParams.get('fullPage') === '1' })
          const buf = Buffer.from(data, 'base64')
          res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length })
          return res.end(buf)
        }
        if (req.method === 'GET' && sub === 'console') {
          return json(res, 200, controller.consoleMessages(id, {
            level: url.searchParams.get('level') || undefined,
            limit: Number(url.searchParams.get('limit')) || undefined,
            clear: url.searchParams.get('clear') === '1'
          }))
        }
        if (req.method === 'GET' && sub === 'text') {
          return json(res, 200, { text: await controller.readPage(id, Number(url.searchParams.get('max')) || 12000) })
        }
        if (req.method === 'GET' && sub === 'snapshot') {
          const { snap, text } = await controller.snapshot(id)
          return json(res, 200, url.searchParams.get('format') === 'text' ? { text } : snap)
        }
        const body = req.method === 'POST' ? await readBody(req) : {}
        if (req.method === 'POST' && sub === 'navigate') {
          await controller.navigate(id, body.url, body)
          return json(res, 200, { ok: true })
        }
        if (req.method === 'POST' && sub === 'activate') {
          await controller.activateTab(id)
          return json(res, 200, { ok: true })
        }
        if (req.method === 'POST' && sub === 'act') {
          return json(res, 200, await controller.act(id, body))
        }
        if (req.method === 'POST' && sub === 'resize') {
          return json(res, 200, await controller.resize(id, body))
        }
        if (req.method === 'POST' && sub === 'eval') {
          if (!body.expression) return json(res, 400, { error: 'expression required' })
          return json(res, 200, { result: await controller.eval(id, body.expression, body) })
        }
        if (req.method === 'POST' && sub === 'wait') {
          await controller.waitFor(id, body)
          return json(res, 200, { ok: true })
        }
        if (req.method === 'POST' && sub === 'control') {
          return json(res, 200, controller.setControl(id, body))
        }
      }

      return json(res, 404, { error: 'not found' })
    } catch (err) {
      return json(res, 500, { error: String(err && err.message || err) })
    }
  }
}
