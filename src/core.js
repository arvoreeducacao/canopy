import { EventEmitter } from 'node:events'
import { OVERLAY_SETUP, BADGE_ON, BADGE_OFF, cursorCall } from './overlay.js'
import { SNAPSHOT_JS, refCenterJs, focusRefJs, formatSnapshot } from './snapshot.js'

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Return: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Keystroke-HUD glyphs (KeyCastr style), shown in-page when the agent types.
const KEYCAP = {
  Enter: '⏎ enter', Return: '⏎ enter', Tab: '⇥ tab', Escape: '⎋ esc',
  Backspace: '⌫ delete', Delete: '⌦ del', ArrowUp: '↑', ArrowDown: '↓',
  ArrowLeft: '←', ArrowRight: '→', PageDown: '⇟ page down', PageUp: '⇞ page up',
  Home: '↖ home', End: '↘ end'
}

export class Controller extends EventEmitter {
  constructor(recorder) {
    super()
    this.recorder = recorder
    this.transports = []
    this.tabs = new Map()      // id -> tab
    this.sessions = new Map()  // id -> session
    this.lastFrames = new Map() // id -> base64 jpeg (cockpit survives refresh)
    this.recentActions = []     // ring buffer so the feed survives refresh too
    this.tabSeq = 0
    this.sessionSeq = 0
    this.startSession('default')
  }

  addTransport(t) {
    this.transports.push(t)
    t.on('cdpEvent', evt => this.#onCdpEvent(t, evt))
    // Note: focusing an agent tab does NOT auto-take-over — the input guard
    // makes watching safe; control changes hands only via the pill/cockpit.
    t.on('tab.removed', msg => this.#onExtTabRemoved(msg.tabId))
    // Orphan sweep: agent tabs left behind by a dead daemon get closed on
    // reconnect — an agent tab without a controlling session is just litter.
    t.on('orphans', async extTabIds => {
      let closed = 0
      for (const extTabId of extTabIds) {
        const tracked = [...this.tabs.values()].some(tab => tab.transport === t && tab.ref.extTabId === extTabId)
        if (tracked) continue
        await t.closeTab({ extTabId }).then(() => { closed += 1 }).catch(() => {})
      }
      if (closed) console.log(`[canopy] ${closed} aba(s) de agente órfã(s) fechada(s)`)
    })
    t.on('connected', () => clearTimeout(t._dropTimer))
    t.on('disconnected', () => {
      // Extension refs (extTabId) stay valid across WS reconnects, so give the
      // bridge a grace window to come back before declaring the tabs dead.
      // Port-mode refs (CDP sessionId) die with the socket — drop immediately.
      const drop = () => {
        for (const tab of this.tabs.values()) {
          if (tab.transport === t) this.#dropTab(tab, 'transport disconnected')
        }
      }
      if (t.kind !== 'extension') return drop()
      clearTimeout(t._dropTimer)
      t._dropTimer = setTimeout(() => { if (!t.ready) drop() }, 60000)
      t._dropTimer.unref?.()
    })
  }

  async setStreaming(on) {
    if (this.streaming === on) return
    this.streaming = on
    for (const tab of this.tabs.values()) {
      const method = on ? 'Page.startScreencast' : 'Page.stopScreencast'
      const params = on ? { format: 'jpeg', quality: 55, maxWidth: 800, maxHeight: 800, everyNthFrame: 2 } : {}
      tab.transport.send(tab.ref, method, params).catch(() => {})
    }
  }

  transport() {
    // The extension transport wins when connected: it can group tabs, detect
    // human focus, and needs no CDP port — it's the path used inside Arc.
    return this.transports.find(t => t.ready && t.kind === 'extension')
      || this.transports.find(t => t.ready)
      || null
  }

  status() {
    const t = this.transport()
    return {
      connected: !!t,
      mode: t ? t.kind : 'disconnected',
      browser: t ? t.browserInfo : null,
      transports: this.transports.map(x => ({ kind: x.kind, ready: x.ready })),
      sessions: [...this.sessions.values()].map(s => this.sessionInfo(s)),
      tabs: this.listTabs()
    }
  }

  // ---- sessions ----

  startSession(label) {
    const id = label === 'default' ? 'default' : `s${++this.sessionSeq}-${Date.now().toString(36)}`
    const session = { id, label: label || id, startedAt: Date.now(), endedAt: null, tabIds: [] }
    this.sessions.set(id, session)
    this.recorder.writeMeta(session)
    this.#state()
    return session
  }

  sessionInfo(s) {
    return { ...s, tabs: s.tabIds.filter(id => this.tabs.has(id)).length }
  }

  async endSession(id) {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`session ${id} not found`)
    for (const tabId of [...session.tabIds]) {
      if (this.tabs.has(tabId)) await this.closeTab(tabId).catch(() => {})
    }
    session.endedAt = Date.now()
    this.recorder.writeMeta(session)
    if (id !== 'default') this.sessions.delete(id)
    this.#state()
    return session
  }

  // ---- tabs ----

  #resolveSession(sessionId) {
    const s = this.sessions.get(sessionId || 'default')
    if (!s) throw new Error(`session ${sessionId} not found`)
    return s
  }

  async openTab(url, { session, label, activate } = {}) {
    let t = this.transport()
    // No browser? Try to launch one (hook set by the daemon) and wait for a
    // transport to dial in — the agent can start from a fully closed browser.
    if (!t && this.requestBrowser) t = await this.requestBrowser().catch(() => null)
    if (!t) throw new Error('no browser connected — launch Chrome with --remote-debugging-port or connect the Canopy extension')
    const s = this.#resolveSession(session)
    // Open on about:blank first so Network/Runtime/Emulation are enabled
    // BEFORE the real navigation — otherwise the page's initial API calls
    // escape the request capture.
    const ref = await t.createTab('about:blank')
    if (process.env.CANOPY_DEBUG) console.log('[openTab]', JSON.stringify(ref))
    const tab = {
      id: `t${++this.tabSeq}`,
      ref,
      transport: t,
      session: s.id,
      url: normalizeUrl(url),
      title: '',
      label: label || 'Agent',
      takenOver: false,
      stopRequested: false,
      driving: true,
      steps: 0,
      requests: [],
      createdAt: Date.now()
    }
    this.tabs.set(tab.id, tab)
    s.tabIds.push(tab.id)
    this.recorder.writeMeta(s)
    await this.#prepareTab(tab)
    await t.send(ref, 'Page.navigate', { url: tab.url }).catch(() => {})
    if (activate) await t.activateTab(ref).catch(() => {})
    this.#log(tab, 'open', { url: tab.url })
    this.#state()
    return tab
  }

  async #prepareTab(tab) {
    const send = (m, p) => tab.transport.send(tab.ref, m, p)
    await send('Page.enable').catch(() => {})
    await send('Runtime.enable').catch(() => {})
    // Background tabs drop keyboard input unless the renderer believes it is
    // focused (same trick Puppeteer uses) — without this, key events are flaky.
    await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    await send('Network.enable', { maxPostDataSize: 32768 }).catch(() => {})
    await send('Runtime.addBinding', { name: '__canopyControl' }).catch(() => {})
    // Screencast only streams while someone is actually watching the cockpit —
    // it is the main constant CPU cost otherwise.
    if (this.streaming) await send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: 800, maxHeight: 800, everyNthFrame: 2 }).catch(() => {})
    this.#applyBadge(tab).catch(() => {})
    // Screencast only streams while the tab is rendered; background tabs go
    // dark. Poll captureScreenshot (which works occluded) as a fallback feed.
    tab.lastFrameAt = 0
    tab.poller = setInterval(async () => {
      if (!this.tabs.has(tab.id)) return clearInterval(tab.poller)
      try {
        const title = await this.eval(tab.id, 'document.title', { silent: true })
        const clean = String(title || '').replace(/^AI · /, '')
        if (clean && clean !== tab.title) {
          tab.title = clean
          this.#state()
        }
      } catch {}
      if (Date.now() - tab.lastFrameAt < 2000) return
      // captureScreenshot costs real CPU per tab — full rate only while the
      // cockpit is actually open; sparse frames (8s) otherwise, for the replay.
      const watching = this.viewers ? this.viewers() > 0 : true
      if (!watching && Date.now() - (tab.lastSavedAt || 0) < 8000) return
      try {
        const { data } = await tab.transport.send(tab.ref, 'Page.captureScreenshot', { format: 'jpeg', quality: 50 })
        tab.lastSavedAt = Date.now()
        this.recorder.frame(tab.session, tab.id, data)
        this.lastFrames.set(tab.id, data)
        this.emit('frame', { tab: tab.id, session: tab.session, data })
      } catch {}
    }, 1500)
    tab.poller.unref?.()
  }

  async #applyBadge(tab) {
    await this.eval(tab.id, BADGE_ON, { silent: true }).catch(() => {})
    // Persistent presence: glow + pill stay visible the whole time the agent
    // owns the tab, not just while an action runs.
    await this.eval(tab.id, OVERLAY_SETUP, { silent: true, awaitPromise: false }).catch(() => {})
    await this.eval(tab.id, cursorCall('presence', [JSON.stringify(tab.label)]), { silent: true, awaitPromise: false }).catch(() => {})
  }

  getTab(id) {
    const tab = this.tabs.get(id)
    if (!tab) throw new Error(`tab ${id} not found`)
    return tab
  }

  listTabs(session) {
    return [...this.tabs.values()]
      .filter(t => !session || t.session === session)
      .map(t => ({
        id: t.id, url: t.url, title: t.title, session: t.session, label: t.label,
        takenOver: t.takenOver, stopRequested: t.stopRequested, driving: t.driving,
        steps: t.steps, requests: t.requests.length, createdAt: t.createdAt
      }))
  }

  async closeTab(id) {
    const tab = this.getTab(id)
    await this.eval(id, BADGE_OFF, { silent: true }).catch(() => {})
    await tab.transport.closeTab(tab.ref).catch(() => {})
    this.#dropTab(tab, 'closed')
    this.#log(tab, 'close', {})
  }

  #dropTab(tab, reason) {
    if (tab.poller) clearInterval(tab.poller)
    this.lastFrames.delete(tab.id)
    this.tabs.delete(tab.id)
    const s = this.sessions.get(tab.session)
    if (s) s.tabIds = s.tabIds.filter(x => x !== tab.id)
    this.emit('tabClosed', { tab: tab.id, reason })
    this.#state()
  }

  async activateTab(id) {
    const tab = this.getTab(id)
    await tab.transport.activateTab(tab.ref)
  }

  setControl(id, { takenOver, stopRequested }) {
    const tab = this.getTab(id)
    if (takenOver !== undefined) tab.takenOver = !!takenOver
    if (stopRequested !== undefined) tab.stopRequested = !!stopRequested
    if (tab.takenOver || tab.stopRequested) {
      this.eval(id, BADGE_OFF, { silent: true }).catch(() => {})
      tab.driving = false
    } else {
      this.#applyBadge(tab).catch(() => {})
      tab.driving = true
    }
    this.#log(tab, 'control', { takenOver: tab.takenOver, stopRequested: tab.stopRequested })
    this.#state()
    return { takenOver: tab.takenOver, stopRequested: tab.stopRequested }
  }

  #guard(tab) {
    if (tab.stopRequested) throw new Error(`the user clicked STOP on tab ${tab.id} — halt all actions on it and check in with the user`)
    if (tab.takenOver) throw new Error(`the user TOOK OVER tab ${tab.id} — do not act on it; wait or ask the user, or clear control via setControl`)
  }

  // ---- actions ----

  async eval(id, expression, { label, silent, awaitPromise } = {}) {
    const tab = this.getTab(id)
    if (!silent) this.#guard(tab)
    const { result, exceptionDetails } = await tab.transport.send(tab.ref, 'Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: awaitPromise !== false, userGesture: true
    })
    if (exceptionDetails) {
      const desc = exceptionDetails.exception?.description || exceptionDetails.text
      throw new Error(`page JS error: ${String(desc).slice(0, 500)}`)
    }
    if (!silent) this.#log(tab, 'eval', { expression: expression.slice(0, 200), label })
    return result?.value
  }

  async #cursor(tab, method, args) {
    try {
      await this.eval(tab.id, OVERLAY_SETUP, { silent: true, awaitPromise: false })
      await this.eval(tab.id, cursorCall(method, args), { silent: true, awaitPromise: false })
    } catch {}
  }

  async snapshot(id) {
    const raw = await this.eval(id, SNAPSHOT_JS, { silent: true })
    const tab = this.getTab(id)
    const snap = JSON.parse(raw)
    tab.url = snap.url
    tab.title = snap.title
    this.#log(tab, 'snapshot', { url: snap.url, elements: snap.elements.length })
    this.#state()
    return { snap, text: formatSnapshot(snap) }
  }

  async readPage(id, maxChars = 12000) {
    const text = await this.eval(id, 'document.body ? document.body.innerText : ""', { silent: true })
    const tab = this.getTab(id)
    this.#log(tab, 'read', { chars: (text || '').length })
    return (text || '').slice(0, maxChars)
  }

  async navigate(id, url, { label } = {}) {
    const tab = this.getTab(id)
    this.#guard(tab)
    if (label) tab.label = label
    tab.url = normalizeUrl(url)
    await tab.transport.send(tab.ref, 'Page.navigate', { url: tab.url })
    this.#log(tab, 'navigate', { url: tab.url, label })
    this.#state()
  }

  async #point(tab, { ref, x, y }, focus = false) {
    if (ref !== undefined && ref !== null) {
      const raw = await this.eval(tab.id, focus ? focusRefJs(ref) : refCenterJs(ref), { silent: true })
      const pos = JSON.parse(raw)
      if (pos.error) throw new Error(pos.error)
      await sleep(120)
      return pos
    }
    if (x === undefined || y === undefined) throw new Error('pass ref (from snapshot) or x/y coordinates')
    return { x: Math.round(x), y: Math.round(y) }
  }

  async act(id, { action, ref, x, y, text, key, dy, dx, label, button, double }) {
    const tab = this.getTab(id)
    this.#guard(tab)
    if (label) tab.label = label
    const send = (m, p) => tab.transport.send(tab.ref, m, p)
    const labelJs = JSON.stringify(tab.label)
    // The overlay blocks human input while the agent owns the tab; CDP input is
    // just as "trusted", so we open a narrow pass-through around our dispatches.
    const allow = on => this.eval(tab.id, `window.__canopyAllow = ${on ? 'true' : 'false'}`, { silent: true, awaitPromise: false }).catch(() => {})

    if (action === 'click') {
      const p = await this.#point(tab, { ref, x, y })
      await this.#cursor(tab, 'move', [p.x, p.y, labelJs])
      await sleep(420)
      await this.#cursor(tab, 'ripple', [p.x, p.y])
      const btn = button === 'right' ? 'right' : 'left'
      const clicks = double ? 2 : 1
      await allow(true)
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' })
      for (let i = 1; i <= clicks; i++) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: btn, clickCount: i })
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: btn, clickCount: i })
      }
      await allow(false)
      this.#log(tab, 'click', { ref, x: p.x, y: p.y, label })
      return { clicked: p }
    }

    if (action === 'fill') {
      if (typeof text !== 'string') throw new Error('fill requires text')
      const p = await this.#point(tab, { ref, x, y }, true)
      await this.#cursor(tab, 'move', [p.x, p.y, labelJs])
      await this.#cursor(tab, 'key', [JSON.stringify('⌨ ' + (text.length > 22 ? text.slice(0, 22) + '…' : text))])
      await sleep(300)
      await allow(true)
      await send('Input.insertText', { text })
      await allow(false)
      this.#log(tab, 'fill', { ref, chars: text.length, label })
      return { filled: true }
    }

    if (action === 'press') {
      const def = KEYS[key]
      if (!def) throw new Error(`unknown key "${key}" — use one of: ${Object.keys(KEYS).join(', ')}`)
      await this.#cursor(tab, 'show', [labelJs])
      await this.#cursor(tab, 'key', [JSON.stringify(KEYCAP[key] || key)])
      await sleep(120)
      await allow(true)
      await send('Input.dispatchKeyEvent', { type: def.text ? 'keyDown' : 'rawKeyDown', ...def })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...def })
      await allow(false)
      this.#log(tab, 'press', { key, label })
      return { pressed: key }
    }

    if (action === 'scroll') {
      await this.#cursor(tab, 'show', [labelJs])
      await this.eval(tab.id, `window.scrollBy({ top: ${Number(dy) || 400}, left: ${Number(dx) || 0}, behavior: 'smooth' })`, { silent: true, awaitPromise: false })
      await sleep(450)
      this.#log(tab, 'scroll', { dy: Number(dy) || 400, label })
      return { scrolled: true }
    }

    throw new Error(`unknown action "${action}" — use click | fill | press | scroll`)
  }

  async screenshot(id) {
    const tab = this.getTab(id)
    const { data } = await tab.transport.send(tab.ref, 'Page.captureScreenshot', { format: 'png' })
    this.#log(tab, 'screenshot', {})
    return data
  }

  async waitFor(id, { until = 'js', value, timeoutMs = 15000 } = {}) {
    const tab = this.getTab(id)
    const deadline = Date.now() + Math.min(timeoutMs, 60000)
    const checks = {
      load: `document.readyState === 'complete' && location.href !== 'about:blank'`,
      selector: `!!document.querySelector(${JSON.stringify(value || 'body')})`,
      text: `(document.body ? document.body.innerText : '').includes(${JSON.stringify(value || '')})`,
      js: value || 'true'
    }
    const expr = checks[until]
    if (!expr) throw new Error('until must be load | selector | text | js')
    while (Date.now() < deadline) {
      try {
        const ok = await this.eval(id, `!!(${expr})`, { silent: true })
        if (ok) {
          this.#log(tab, 'wait', { until, value, ok: true })
          return true
        }
      } catch {}
      await sleep(350)
    }
    this.#log(tab, 'wait', { until, value, ok: false })
    throw new Error(`wait timed out after ${timeoutMs}ms (until=${until} ${value || ''})`)
  }

  // ---- events ----

  #onCdpEvent(transport, evt) {
    const tab = [...this.tabs.values()].find(t => t.transport === transport && transport.matches(t.ref, evt))
    if (!tab) return
    if (evt.method === 'Page.screencastFrame') {
      transport.send(tab.ref, 'Page.screencastFrameAck', { sessionId: evt.params.sessionId }).catch(() => {})
      tab.lastFrameAt = Date.now()
      this.recorder.frame(tab.session, tab.id, evt.params.data)
      this.lastFrames.set(tab.id, evt.params.data)
      this.emit('frame', { tab: tab.id, session: tab.session, data: evt.params.data })
      return
    }
    if (evt.method === 'Runtime.bindingCalled' && evt.params.name === '__canopyControl') {
      let payload = {}
      try { payload = JSON.parse(evt.params.payload) } catch {}
      if (payload.action === 'takeover') this.setControl(tab.id, { takenOver: true })
      if (payload.action === 'stop') this.setControl(tab.id, { stopRequested: true })
      return
    }
    if (evt.method === 'Page.frameNavigated' && !evt.params.frame.parentId) {
      tab.url = evt.params.frame.url
      if (tab.driving) setTimeout(() => this.#applyBadge(tab), 600)
      this.#state()
      return
    }
    if (evt.method === 'Network.requestWillBeSent') {
      const { requestId, request, type, timestamp } = evt.params
      if (!['XHR', 'Fetch', 'Document'].includes(type)) return
      if (request.url.startsWith('data:')) return
      tab.requests.push({
        id: requestId, ts: Date.now(), type,
        method: request.method, url: request.url,
        postData: request.postData ? String(request.postData).slice(0, 4000) : undefined,
        headers: pickHeaders(request.headers)
      })
      if (tab.requests.length > 300) tab.requests.splice(0, tab.requests.length - 300)
      return
    }
    if (evt.method === 'Network.responseReceived') {
      const r = tab.requests.find(x => x.id === evt.params.requestId)
      if (r) {
        r.status = evt.params.response.status
        r.mimeType = evt.params.response.mimeType
      }
    }
  }

  listRequests(id, { filter, limit = 40 } = {}) {
    const tab = this.getTab(id)
    let list = tab.requests
    if (filter) {
      const f = filter.toLowerCase()
      list = list.filter(r => r.url.toLowerCase().includes(f) || r.method.toLowerCase() === f || (r.mimeType || '').includes(f))
    }
    return list.slice(-limit).map(({ id: rid, ts, type, method, url, status, mimeType, postData }) => ({
      id: rid, ts, type, method, url: url.slice(0, 300), status, mimeType,
      postData: postData ? postData.slice(0, 500) : undefined
    }))
  }

  async requestBody(id, requestId) {
    const tab = this.getTab(id)
    const meta = tab.requests.find(r => r.id === requestId)
    if (!meta) throw new Error(`request ${requestId} not found (buffer keeps the last 300 XHR/Fetch)`)
    let body = null
    try {
      const { body: data, base64Encoded } = await tab.transport.send(tab.ref, 'Network.getResponseBody', { requestId })
      body = base64Encoded ? `<base64 ${data.length} chars>` : data.slice(0, 30000)
    } catch (err) {
      body = `<unavailable: ${err.message}>`
    }
    this.#log(tab, 'request_body', { url: meta.url.slice(0, 120) })
    return { request: meta, responseBody: body }
  }

  #onExtTabRemoved(extTabId) {
    const tab = [...this.tabs.values()].find(t => t.ref.extTabId === extTabId)
    if (tab) this.#dropTab(tab, 'closed by user')
  }

  #log(tab, tool, detail) {
    tab.steps += 1
    const entry = { session: tab.session, tab: tab.id, tool, ...detail }
    this.recorder.action(tab.session, entry)
    const evt = { ts: Date.now(), ...entry, title: tab.title, url: tab.url, label: tab.label }
    this.recentActions.push(evt)
    if (this.recentActions.length > 300) this.recentActions.splice(0, this.recentActions.length - 300)
    this.emit('action', evt)
  }

  #state() {
    this.emit('state', this.status())
  }
}

function pickHeaders(headers = {}) {
  const keep = {}
  for (const k of Object.keys(headers)) {
    const lk = k.toLowerCase()
    if (['content-type', 'accept', 'x-requested-with'].includes(lk) || lk.startsWith('x-api')) keep[k] = String(headers[k]).slice(0, 200)
  }
  return Object.keys(keep).length ? keep : undefined
}

function normalizeUrl(url) {
  if (!url) return 'about:blank'
  if (/^[a-z]+:\/\//i.test(url) || url.startsWith('about:')) return url
  return `https://${url}`
}
