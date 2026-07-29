const http = require('http')
const { session } = require('electron')

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

const CURSOR_SETUP = `(() => {
  if (window.__galhoCursor) return
  const cursor = document.createElement('div')
  cursor.id = '__galho_cursor'
  cursor.style.cssText = 'position:fixed;z-index:2147483647;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;pointer-events:none;background:radial-gradient(circle,rgba(245,158,11,0.95) 0 35%,rgba(245,158,11,0.3) 70%,transparent);box-shadow:0 0 16px rgba(245,158,11,0.85);left:50%;top:40%;transition:left 0.4s cubic-bezier(0.2,0.7,0.3,1),top 0.4s cubic-bezier(0.2,0.7,0.3,1),opacity 0.3s;opacity:0'
  const veil = document.createElement('div')
  veil.id = '__galho_veil'
  veil.style.cssText = 'position:fixed;inset:0;z-index:2147483645;pointer-events:none;background-color:rgba(12,8,24,0.32);background-image:radial-gradient(rgba(255,255,255,0.10) 1px,transparent 1.4px);background-size:9px 9px;opacity:0;transition:opacity 0.5s'
  const glow = document.createElement('div')
  glow.id = '__galho_glow'
  glow.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;box-shadow:inset 0 0 0 3px rgba(245,158,11,0.55),inset 0 0 30px rgba(245,158,11,0.18);border-radius:8px;opacity:0;transition:opacity 0.4s'
  const pill = document.createElement('div')
  pill.id = '__galho_pill'
  pill.style.cssText = 'position:fixed;z-index:2147483647;left:50%;bottom:26px;transform:translateX(-50%) translateY(8px);display:flex;align-items:center;gap:12px;padding:10px 12px 10px 16px;border-radius:14px;background:rgba(22,20,32,0.92);backdrop-filter:blur(16px);box-shadow:0 12px 40px rgba(0,0,0,0.45);font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;opacity:0;pointer-events:none;transition:opacity 0.4s,transform 0.4s'
  const spinner = document.createElement('div')
  spinner.style.cssText = 'width:14px;height:14px;border-radius:50%;border:2px solid rgba(245,158,11,0.9);border-top-color:transparent;animation:__galho_spin 0.9s linear infinite'
  const styleEl = document.createElement('style')
  styleEl.textContent = '@keyframes __galho_spin{to{transform:rotate(360deg)}}'
  const textWrap = document.createElement('div')
  const labelEl = document.createElement('div')
  labelEl.style.cssText = 'font-size:13px;font-weight:600;color:rgba(250,248,255,0.95);max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
  labelEl.textContent = 'Agente'
  const subEl = document.createElement('div')
  subEl.style.cssText = 'font-size:11px;color:rgba(250,248,255,0.55)'
  subEl.textContent = 'Agente no controle'
  textWrap.appendChild(labelEl)
  textWrap.appendChild(subEl)
  const btn = (label, color, action) => {
    const b = document.createElement('button')
    b.textContent = label
    b.style.cssText = 'border:none;border-radius:9px;padding:7px 12px;font-size:12px;font-weight:600;font-family:inherit;background:rgba(255,255,255,0.12);color:' + color + ';cursor:pointer'
    b.onmouseenter = () => { b.style.background = 'rgba(255,255,255,0.2)' }
    b.onmouseleave = () => { b.style.background = 'rgba(255,255,255,0.12)' }
    b.onclick = e => {
      e.stopPropagation()
      if (window.__galhoAgentControl) window.__galhoAgentControl(action)
      window.__galhoCursor.hide()
    }
    return b
  }
  pill.appendChild(spinner)
  pill.appendChild(textWrap)
  pill.appendChild(btn('Assumir', 'rgba(250,248,255,0.95)', 'takeover'))
  pill.appendChild(btn('Parar', '#F87171', 'stop'))
  if (document.documentElement) {
    document.documentElement.appendChild(styleEl)
    document.documentElement.appendChild(veil)
    document.documentElement.appendChild(glow)
    document.documentElement.appendChild(cursor)
    document.documentElement.appendChild(pill)
  }
  window.__galhoCursor = {
    el: cursor,
    glow,
    veil,
    pill,
    labelEl,
    timer: null,
    show(label) {
      if (label) labelEl.textContent = label
      cursor.style.opacity = '1'
      glow.style.opacity = '1'
      veil.style.opacity = '1'
      pill.style.opacity = '1'
      pill.style.pointerEvents = 'auto'
      pill.style.transform = 'translateX(-50%) translateY(0)'
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.hide(), 6000)
    },
    hide() {
      cursor.style.opacity = '0'
      glow.style.opacity = '0'
      veil.style.opacity = '0'
      pill.style.opacity = '0'
      pill.style.pointerEvents = 'none'
      pill.style.transform = 'translateX(-50%) translateY(8px)'
    },
    move(x, y, label) {
      this.show(label)
      cursor.style.left = x + 'px'
      cursor.style.top = y + 'px'
    },
    ripple(x, y) {
      const r = document.createElement('div')
      r.style.cssText = 'position:fixed;z-index:2147483647;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;pointer-events:none;border:2.5px solid rgba(245,158,11,0.9);left:' + x + 'px;top:' + y + 'px;transform:scale(1);opacity:1;transition:transform 0.45s ease-out,opacity 0.45s ease-out'
      document.documentElement.appendChild(r)
      requestAnimationFrame(() => {
        r.style.transform = 'scale(3.2)'
        r.style.opacity = '0'
      })
      setTimeout(() => r.remove(), 500)
    }
  }
})()`

async function agentCursor(wc, method, args = []) {
  try {
    await wc.executeJavaScript(CURSOR_SETUP, true)
    await wc.executeJavaScript(`window.__galhoCursor && window.__galhoCursor.${method}(${args.join(',')})`, true)
  } catch {}
}

async function captureTab(tabs, tab) {
  const win = tabs.win
  const wasAttached = tabs.attachedViews.includes(tab.view)
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

function ensureAgentSpace(tabs, spaceName) {
  let space = tabs.spaces.find(s => s.name.toLowerCase() === spaceName.toLowerCase())
  if (!space) {
    space = {
      id: Math.random().toString(36).slice(2, 10),
      name: spaceName,
      color: AGENT_COLOR,
      icon: 'robot',
      folders: [],
      archived: [],
      tabIds: [],
      activeTabId: null
    }
    tabs.spaces.push(space)
  }
  return space
}

function startAgentApi(ctx) {
  const server = http.createServer(async (req, res) => {
    const tabs = ctx.tabs()
    if (!tabs) return json(res, 503, { error: 'window not ready' })
    const managers = ctx.managers ? ctx.managers() : [tabs]
    const findTab = id => {
      for (const m of managers) {
        const tab = m.tabs.get(id)
        if (tab) return { m, tab }
      }
      return null
    }
    const url = new URL(req.url, 'http://localhost')
    const parts = url.pathname.split('/').filter(Boolean)

    try {
      if (req.method === 'GET' && parts.length === 0) {
        return json(res, 200, {
          name: 'galho',
          version: '0.2.0',
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
            'POST /tabs/:id/click {x, y, button?, double?}',
            'POST /tabs/:id/type {text, delay?}',
            'POST /tabs/:id/press {key}',
            'POST /tabs/:id/scroll {dy, dx?}',
            'POST /tabs/:id/control {takenOver?, stopRequested?}',
            'DELETE /tabs/:id',
            'GET /spaces',
            'PUT /spaces/:id {name?, color?, icon?}',
            'GET /folders',
            'POST /folders {space, name, links}',
            'PUT /folders/:id {name?, links?}',
            'DELETE /folders/:id',
            'GET /extensions',
            'POST /extensions {id}',
            'GET /downloads',
            'GET /boosts',
            'PUT /boosts/:host {css?, js?}',
            'DELETE /boosts/:host'
          ]
        })
      }

      if (parts[0] === 'extensions') {
        if (req.method === 'GET') {
          return json(res, 200, session.defaultSession.extensions.getAllExtensions().map(e => ({
            id: e.id,
            name: e.name,
            version: e.version
          })))
        }
        if (req.method === 'POST') {
          const body = await readBody(req)
          if (!body.id) return json(res, 400, { error: 'id required (Chrome Web Store extension id)' })
          const { installExtension } = require('electron-chrome-web-store')
          const ext = await installExtension(body.id, { session: session.defaultSession })
          return json(res, 201, { id: ext.id, name: ext.name, version: ext.version })
        }
      }

      if (parts[0] === 'downloads' && req.method === 'GET') {
        return json(res, 200, ctx.downloads ? ctx.downloads() : [])
      }

      if (parts[0] === 'boosts') {
        const boosts = ctx.boosts ? ctx.boosts() : {}
        if (req.method === 'GET' && parts.length === 1) {
          return json(res, 200, boosts)
        }
        if (parts[1]) {
          const host = decodeURIComponent(parts[1])
          if (req.method === 'GET') {
            return json(res, 200, boosts[host] || {})
          }
          if (req.method === 'PUT') {
            const body = await readBody(req)
            boosts[host] = { css: body.css || '', js: body.js || '' }
            if (ctx.saveBoosts) ctx.saveBoosts()
            return json(res, 200, { ok: true })
          }
          if (req.method === 'DELETE') {
            delete boosts[host]
            if (ctx.saveBoosts) ctx.saveBoosts()
            return json(res, 200, { ok: true })
          }
        }
      }

      if (req.method === 'PUT' && parts[0] === 'spaces' && parts[1]) {
        const space = tabs.spaces.find(s => s.id === parts[1])
        if (!space) return json(res, 404, { error: 'space not found' })
        const body = await readBody(req)
        if (body.name) tabs.renameSpace(space.id, body.name)
        if (body.color) tabs.setSpaceColor(space.id, body.color)
        if (body.icon !== undefined) tabs.setSpaceIcon(space.id, body.icon)
        return json(res, 200, { ok: true })
      }

      if (req.method === 'GET' && parts[0] === 'spaces') {
        return json(res, 200, tabs.spaces.map(s => ({
          id: s.id,
          name: s.name,
          color: s.color,
          icon: s.icon,
          active: s.id === tabs.activeSpaceId,
          tabCount: s.tabIds.length,
          archivedCount: s.archived.length
        })))
      }

      if (parts[0] === 'folders') {
        if (req.method === 'GET' && parts.length === 1) {
          const list = []
          for (const space of tabs.spaces) {
            for (const f of space.folders) {
              list.push({ id: f.id, space: space.name, name: f.name, live: f.live, links: f.links })
            }
          }
          return json(res, 200, list)
        }
        if (req.method === 'POST' && parts.length === 1) {
          const body = await readBody(req)
          if (!body.name) return json(res, 400, { error: 'name required' })
          const space = ensureAgentSpace(tabs, body.space || AGENT_SPACE)
          const folder = tabs.createFolder(space.id, body.name, { live: true, links: Array.isArray(body.links) ? body.links : [] })
          return json(res, 201, { id: folder.id, space: space.name, name: folder.name, links: folder.links })
        }
        if (parts[1]) {
          const found = tabs.findFolder(parts[1])
          if (!found) return json(res, 404, { error: 'folder not found' })
          if (req.method === 'PUT') {
            const body = await readBody(req)
            if (body.name) tabs.renameFolder(parts[1], body.name)
            if (Array.isArray(body.links)) tabs.setFolderLinks(parts[1], body.links)
            return json(res, 200, { ok: true })
          }
          if (req.method === 'DELETE') {
            tabs.deleteFolder(parts[1], { closeTabs: false })
            return json(res, 200, { ok: true })
          }
        }
      }

      if (parts[0] === 'tabs' && parts.length === 1) {
        if (req.method === 'GET') {
          const list = []
          for (let w = 0; w < managers.length; w++) {
            const m = managers[w]
            for (const space of m.spaces) {
              for (const id of space.tabIds) {
                const tab = m.tabs.get(id)
                if (!tab) continue
                const entry = {
                  id: tab.id,
                  url: tab.url,
                  title: tab.title,
                  space: space.name,
                  window: w,
                  active: space.activeTabId === tab.id && space.id === m.activeSpaceId,
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
          }
          return json(res, 200, list)
        }
        if (req.method === 'POST') {
          const body = await readBody(req)
          if (!body.url) return json(res, 400, { error: 'url required' })
          const space = ensureAgentSpace(tabs, body.space || AGENT_SPACE)
          const tab = tabs.createTab({ url: body.url, spaceId: space.id, activate: !!body.activate })
          tabs.agentPulse(tab.id, body.label)
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
        const found = findTab(parts[1])
        if (!found) return json(res, 404, { error: 'tab not found' })
        const { m, tab } = found
        const sub = parts[2]
        const wc = tab.view ? tab.view.webContents : null
        const labelArg = label => [JSON.stringify(label || tab.agentLabel || 'Agente')]

        if (req.method === 'DELETE' && !sub) {
          m.closeTab(tab.id)
          return json(res, 200, { ok: true })
        }

        if (req.method === 'GET' && !sub) {
          const targetId = wc ? await targetIdOf(wc) : null
          return json(res, 200, {
            id: tab.id,
            url: tab.url,
            title: tab.title,
            loading: tab.loading,
            label: tab.agentLabel,
            takenOver: !!tab.agentTakenOver,
            stopRequested: !!tab.agentStopRequested,
            targetId,
            cdpUrl: targetId ? `ws://127.0.0.1:${ctx.cdpPort}/devtools/page/${targetId}` : null
          })
        }

        if (req.method === 'POST' && sub === 'control') {
          const body = await readBody(req)
          if (body.takenOver !== undefined) tab.agentTakenOver = !!body.takenOver
          if (body.stopRequested !== undefined) tab.agentStopRequested = !!body.stopRequested
          return json(res, 200, { takenOver: !!tab.agentTakenOver, stopRequested: !!tab.agentStopRequested })
        }

        if (!wc) return json(res, 409, { error: 'tab has no view yet' })

        if (req.method === 'POST' && sub === 'navigate') {
          const body = await readBody(req)
          if (!body.url) return json(res, 400, { error: 'url required' })
          m.agentPulse(tab.id, body.label)
          m.navigate(tab.id, body.url)
          return json(res, 200, { ok: true })
        }

        if (req.method === 'POST' && sub === 'activate') {
          m.activateTab(tab.id)
          return json(res, 200, { ok: true })
        }

        if (req.method === 'GET' && sub === 'screenshot') {
          const png = await captureTab(m, tab)
          if (!png) return json(res, 500, { error: 'capture failed' })
          res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length })
          return res.end(png)
        }

        if (req.method === 'GET' && sub === 'text') {
          const text = await wc.executeJavaScript('document.body ? document.body.innerText : ""', true)
          return json(res, 200, { id: tab.id, url: tab.url, title: tab.title, text })
        }

        if (req.method === 'POST' && sub === 'eval') {
          const body = await readBody(req)
          if (!body.expression) return json(res, 400, { error: 'expression required' })
          m.agentPulse(tab.id, body.label)
          const result = await wc.executeJavaScript(body.expression, true)
          return json(res, 200, { result })
        }

        if (req.method === 'POST' && sub === 'click') {
          const body = await readBody(req)
          const x = Math.round(body.x || 0)
          const y = Math.round(body.y || 0)
          m.agentPulse(tab.id, body.label)
          await agentCursor(wc, 'move', [x, y, ...labelArg(body.label)])
          await new Promise(r => setTimeout(r, 420))
          await agentCursor(wc, 'ripple', [x, y])
          const button = body.button === 'right' ? 'right' : 'left'
          const clickCount = body.double ? 2 : 1
          wc.sendInputEvent({ type: 'mouseMove', x, y })
          for (let i = 0; i < clickCount; i++) {
            wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: i + 1 })
            wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: i + 1 })
          }
          return json(res, 200, { ok: true })
        }

        if (req.method === 'POST' && sub === 'type') {
          const body = await readBody(req)
          if (typeof body.text !== 'string') return json(res, 400, { error: 'text required' })
          m.agentPulse(tab.id, body.label)
          await agentCursor(wc, 'show', labelArg(body.label))
          const delay = Math.min(Math.max(body.delay || 25, 0), 200)
          for (const ch of body.text) {
            wc.sendInputEvent({ type: 'char', keyCode: ch })
            if (delay) await new Promise(r => setTimeout(r, delay))
          }
          return json(res, 200, { ok: true })
        }

        if (req.method === 'POST' && sub === 'press') {
          const body = await readBody(req)
          if (!body.key) return json(res, 400, { error: 'key required' })
          m.agentPulse(tab.id, body.label)
          wc.sendInputEvent({ type: 'keyDown', keyCode: body.key })
          wc.sendInputEvent({ type: 'keyUp', keyCode: body.key })
          return json(res, 200, { ok: true })
        }

        if (req.method === 'POST' && sub === 'scroll') {
          const body = await readBody(req)
          m.agentPulse(tab.id, body.label)
          await agentCursor(wc, 'show', labelArg(body.label))
          const dy = Number(body.dy || 0)
          const dx = Number(body.dx || 0)
          await wc.executeJavaScript(`window.scrollBy({ top: ${dy}, left: ${dx}, behavior: 'smooth' })`, true)
          return json(res, 200, { ok: true })
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
