import { EventEmitter } from 'node:events'
import { OVERLAY_SETUP, BADGE_ON, BADGE_OFF, cursorCall } from './overlay.js'
import { SNAPSHOT_JS, PROBE_JS, refCenterJs, focusRefJs, formatSnapshot, formatProblems } from './snapshot.js'

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

// An agent tab is only ever closed by the agent that opened it, and an agent
// that dies — a killed session, a crashed client — never gets to. Nothing else
// reclaimed them, so they accumulated for as long as the browser stayed up.
// Idle time is measured from the last action the agent took on the tab, not
// from when it was opened: a tab being worked on for hours is not idle.
const TAB_IDLE_MS = Number(process.env.CANOPY_TAB_IDLE_MS) || 30 * 60 * 1000
const MAX_TABS_PER_SESSION = Number(process.env.CANOPY_MAX_TABS_PER_SESSION) || 8

// Keystroke-HUD glyphs (KeyCastr style), shown in-page when the agent types.
const KEYCAP = {
  Enter: '⏎ enter', Return: '⏎ enter', Tab: '⇥ tab', Escape: '⎋ esc',
  Backspace: '⌫ delete', Delete: '⌦ del', ArrowUp: '↑', ArrowDown: '↓',
  ArrowLeft: '←', ArrowRight: '→', PageDown: '⇟ page down', PageUp: '⇞ page up',
  Home: '↖ home', End: '↘ end'
}

export class Controller extends EventEmitter {
  // restrictUrls: cloud mode. The browser sits inside someone's private
  // network, so it must not be usable as an SSRF pivot (or a metadata-service
  // reader) by whoever holds the token.
  constructor(recorder, { restrictUrls = false } = {}) {
    super()
    this.restrictUrls = restrictUrls
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
      if (closed) console.log(`[canopy] closed ${closed} orphaned agent tab(s)`)
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
      const params = on ? { format: 'jpeg', quality: 55, maxWidth: 800, maxHeight: 800, everyNthFrame: 4 } : {}
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
    const target = normalizeUrl(url, this.restrictUrls)
    let t = this.transport()
    // No browser? Try to launch one (hook set by the daemon) and wait for a
    // transport to dial in — the agent can start from a fully closed browser.
    if (!t && this.requestBrowser) t = await this.requestBrowser().catch(() => null)
    if (!t) throw new Error('no browser connected — launch Chrome with --remote-debugging-port or connect the Canopy extension')
    const s = this.#resolveSession(session)
    await this.#enforceTabBudget(s)
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
      url: target,
      title: '',
      label: label || 'Agent',
      takenOver: false,
      stopRequested: false,
      driving: true,
      steps: 0,
      requests: [],
      reqUrls: new Map(),
      messages: [],
      msgSeq: 0,
      msgCursor: 0,
      createdAt: Date.now(),
      lastUsedAt: Date.now()
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
    // Console + browser log domains: a page that fails silently (swallowed
    // catch, dead API host, 401 on login) looks identical to one that worked
    // from the DOM alone. These are what make the difference visible.
    await send('Log.enable').catch(() => {})
    // Learn the top frame's id before the first navigation, so the very first
    // request already knows whether it is the page or something the page embeds.
    await send('Page.getFrameTree')
      .then(r => { tab.mainFrameId = r?.frameTree?.frame?.id })
      .catch(() => {})
    await send('Runtime.addBinding', { name: '__canopyControl' }).catch(() => {})
    // Screencast only streams while someone is actually watching the cockpit —
    // it is the main constant CPU cost otherwise.
    if (this.streaming) await send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: 800, maxHeight: 800, everyNthFrame: 4 }).catch(() => {})
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
        steps: t.steps, requests: t.requests.length, createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt || t.createdAt
      }))
  }

  // Reclaim tabs whose agent stopped working them. A tab the human took over is
  // theirs for as long as they want it, however idle it looks from here.
  async reapIdleTabs(now = Date.now()) {
    const reaped = []
    const bereaved = new Set()
    for (const tab of [...this.tabs.values()]) {
      if (tab.takenOver) continue
      if (now - (tab.lastUsedAt || tab.createdAt) < TAB_IDLE_MS) continue
      bereaved.add(tab.session)
      await this.closeTab(tab.id).catch(() => {})
      reaped.push(tab.id)
    }
    // Only sessions this sweep emptied. A session left empty by the agent
    // itself belongs to an agent that is alive and probably between tabs —
    // deleting it would fail its next open with "session not found".
    for (const id of bereaved) {
      const s = this.sessions.get(id)
      if (!s || id === 'default' || s.endedAt) continue
      if (s.tabIds.some(tabId => this.tabs.has(tabId))) continue
      s.endedAt = now
      this.recorder.writeMeta(s)
      this.sessions.delete(id)
    }
    if (reaped.length) this.#state()
    return reaped
  }

  // Refusing beats evicting: the tabs still open may all be in use, and only the
  // agent knows which one it is done with. Sweep first so an agent is never
  // blocked by tabs that were already dead.
  async #enforceTabBudget(s) {
    const live = () => s.tabIds.filter(id => this.tabs.has(id))
    if (live().length < MAX_TABS_PER_SESSION) return
    await this.reapIdleTabs()
    const still = live()
    if (still.length < MAX_TABS_PER_SESSION) return
    throw new Error(
      `session ${s.id} already holds ${still.length} open tabs (limit ${MAX_TABS_PER_SESSION}) — `
      + `close one with browser_close before opening another: ${still.join(', ')}`
    )
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
      // Handing the tab back means handing it back intact. An emulated viewport
      // outlives the agent otherwise — and #guard then refuses the very call
      // that would undo it, so the user is left with a phone-sized tab that
      // turns their mouse into touch events and nobody able to fix it.
      tab.transport.send(tab.ref, 'Emulation.clearDeviceMetricsOverride').catch(() => {})
      tab.transport.send(tab.ref, 'Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {})
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
    const problems = this.unseenProblems(tab)
    this.#log(tab, 'snapshot', { url: snap.url, elements: snap.elements.length, problems: problems.length })
    this.#state()
    return { snap, problems, text: formatSnapshot(snap, problems) }
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
    tab.url = normalizeUrl(url, this.restrictUrls)
    tab.navError = null
    tab.navErrorUrl = null
    await tab.transport.send(tab.ref, 'Page.navigate', { url: tab.url })
    this.#log(tab, 'navigate', { url: tab.url, label })
    this.#state()
  }

  async #point(tab, { ref, x, y, force }, focus = false) {
    if (ref !== undefined && ref !== null) {
      const raw = await this.eval(tab.id, focus ? focusRefJs(ref) : refCenterJs(ref), { silent: true })
      const pos = JSON.parse(raw)
      if (pos.error) throw new Error(pos.error)
      // A ref can point at something that is in the DOM but not really there:
      // a modal still hidden in its portal, a control behind an overlay. The
      // dispatch would "succeed" and change nothing, so refuse instead.
      if (!force) {
        if (pos.hidden) {
          throw new Error(`ref ${ref} (${pos.desc || 'element'}) is in the DOM but not visible — it is probably a closed modal/menu. Open it first and take a new snapshot, or pass force:true.`)
        }
        if (!focus && pos.blocked) {
          throw new Error(`ref ${ref} (${pos.desc || 'element'}) is covered at (${pos.x},${pos.y}) by ${pos.blocked} — the click would hit that instead. Take a new snapshot (the overlay may be a modal that is now open), or pass force:true.`)
        }
      }
      await sleep(120)
      return pos
    }
    if (x === undefined || y === undefined) throw new Error('pass ref (from snapshot) or x/y coordinates')
    return { x: Math.round(x), y: Math.round(y) }
  }

  // Cheap "did anything happen?" fingerprint, taken before and after an action.
  async #probe(tab) {
    try { return JSON.parse(await this.eval(tab.id, PROBE_JS, { silent: true })) } catch { return null }
  }

  #verdict(before, after, problems) {
    if (!before || !after) return problems.length ? formatProblems(problems) : undefined
    const bits = []
    if (before.url !== after.url) bits.push(`url -> ${after.url}`)
    if (before.title !== after.title) bits.push(`title -> "${after.title}"`)
    if (before.dialogs !== after.dialogs) bits.push(`open dialogs ${before.dialogs} -> ${after.dialogs}`)
    if (before.acts !== after.acts) bits.push(`interactive elements ${before.acts} -> ${after.acts} (take a new snapshot — refs moved)`)
    const dText = after.len - before.len
    const dNodes = after.nodes - before.nodes
    if (before.sig !== after.sig) bits.push(`text changed (${dText >= 0 ? '+' : ''}${dText} chars)`)
    if (dNodes) bits.push(`dom ${dNodes > 0 ? '+' : ''}${dNodes} nodes`)
    // Focus moves on every click, so on its own it proves nothing about whether
    // the page reacted — it is a footnote, never the evidence.
    const focus = before.active !== after.active ? ` (focus -> ${after.active || 'none'})` : ''
    const summary = bits.length
      ? `changed: ${bits.join(' · ')}${focus}`
      : `NO CHANGE DETECTED${focus} — the page did not react; do not assume this step worked (re-snapshot or screenshot before moving on)`
    return problems.length ? `${summary}\n${formatProblems(problems)}` : summary
  }

  async act(id, { action, ref, x, y, text, key, dy, dx, label, button, double, force, verify }) {
    const tab = this.getTab(id)
    this.#guard(tab)
    if (label) tab.label = label
    const send = (m, p) => tab.transport.send(tab.ref, m, p)
    const labelJs = JSON.stringify(tab.label)
    // The overlay blocks human input while the agent owns the tab; CDP input is
    // just as "trusted", so we open a narrow pass-through around our dispatches.
    const allow = on => this.eval(tab.id, `window.__canopyAllow = ${on ? 'true' : 'false'}`, { silent: true, awaitPromise: false }).catch(() => {})
    // Optimistic sequencing is how an agent ends up clicking three buttons of a
    // modal that never opened. Every action reports what actually changed.
    const checking = verify !== false && action !== 'scroll'
    const before = checking ? await this.#probe(tab) : null
    const settle = async result => {
      if (!checking) return result
      await sleep(400)
      const after = await this.#probe(tab)
      const verdict = this.#verdict(before, after, this.unseenProblems(tab))
      return verdict ? { ...result, after: verdict } : result
    }

    if (action === 'click') {
      const p = await this.#point(tab, { ref, x, y, force })
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
      return settle({ clicked: p, on: p.desc })
    }

    if (action === 'fill') {
      if (typeof text !== 'string') throw new Error('fill requires text')
      const p = await this.#point(tab, { ref, x, y, force }, true)
      await this.#cursor(tab, 'move', [p.x, p.y, labelJs])
      await this.#cursor(tab, 'key', [JSON.stringify('⌨ ' + (text.length > 22 ? text.slice(0, 22) + '…' : text))])
      await sleep(300)
      await allow(true)
      await send('Input.insertText', { text })
      await allow(false)
      this.#log(tab, 'fill', { ref, chars: text.length, label })
      return settle({ filled: true, on: p.desc })
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
      return settle({ pressed: key })
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

  // Emulated viewport (the OS window is untouched — this resizes what the page
  // renders into, which is what a background agent tab actually needs).
  async resize(id, { width, height, deviceScaleFactor = 1, mobile = false, reset = false } = {}) {
    const tab = this.getTab(id)
    this.#guard(tab)
    if (reset) {
      await tab.transport.send(tab.ref, 'Emulation.clearDeviceMetricsOverride')
      await tab.transport.send(tab.ref, 'Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {})
    } else {
      const w = Math.round(width), h = Math.round(height)
      if (!(w > 0 && h > 0)) throw new Error('resize needs width and height (or reset:true)')
      // Unbounded metrics are a memory-amplification primitive: the renderer is
      // asked to rasterise whatever surface it is given, and a fractional scale
      // factor multiplies it again at screenshot time.
      if (w > 8000 || h > 8000) throw new Error('resize is capped at 8000x8000 — a larger surface is a rasterisation bomb, not a viewport')
      const dsf = clamp(deviceScaleFactor, 0.5, 4)
      await tab.transport.send(tab.ref, 'Emulation.setDeviceMetricsOverride', {
        width: w, height: h, deviceScaleFactor: dsf, mobile: !!mobile, screenWidth: w, screenHeight: h
      })
      await tab.transport.send(tab.ref, 'Emulation.setTouchEmulationEnabled', { enabled: !!mobile, maxTouchPoints: mobile ? 5 : 0 }).catch(() => {})
    }
    const vp = await this.eval(id, 'JSON.stringify([innerWidth, innerHeight, devicePixelRatio])', { silent: true })
    const [vw, vh, dpr] = JSON.parse(vp)
    this.#log(tab, 'resize', { width: vw, height: vh, reset: !!reset })
    return { viewport: [vw, vh], devicePixelRatio: dpr, emulated: !reset }
  }

  // Screenshots are clipped to the visual viewport at scale 1, so one image
  // pixel is one CSS pixel and coordinates read off the image can be passed
  // straight back to act(). Without the clip, a 2x display returns a 2x image
  // and every coordinate derived from it lands in the wrong place.
  async screenshot(id, { fullPage = false } = {}) {
    const tab = this.getTab(id)
    const send = (m, p) => tab.transport.send(tab.ref, m, p)
    const metrics = await send('Page.getLayoutMetrics').catch(() => null)
    const params = { format: 'png' }
    const box = fullPage
      ? metrics && (metrics.cssContentSize || metrics.contentSize)
      : metrics && (metrics.cssVisualViewport || metrics.visualViewport)
    if (box) {
      // clip.scale multiplies the device scale factor rather than replacing it,
      // so on a retina display scale:1 still yields a 2x image — and every
      // coordinate read off that image lands at twice its intended place.
      // devicePixelRatio is read out of the page, and a page can redefine it —
      // an unclamped 1/dpr turns a screenshot into a request to rasterise
      // millions of pixels per side.
      const dpr = clamp(Number(await this.eval(id, 'devicePixelRatio', { silent: true }).catch(() => 1)) || 1, 0.5, 4)
      params.clip = {
        x: Math.round(box.pageX || box.x || 0),
        y: Math.round(box.pageY || box.y || 0),
        width: Math.round(box.clientWidth || box.width),
        height: Math.round(box.clientHeight || box.height),
        scale: 1 / dpr
      }
      if (fullPage) params.captureBeyondViewport = true
    }
    let { data } = await send('Page.captureScreenshot', params)
    // An emulated viewport can be larger than the real window, and Chrome then
    // hands back an empty capture instead of an error — which an agent would
    // read as a blank page. Widen the render, then drop the clip entirely
    // (that path always works, at the display's pixel ratio) before giving up.
    if (!data && params.clip) {
      ;({ data } = await send('Page.captureScreenshot', { ...params, captureBeyondViewport: true }))
      if (!data) {
        delete params.clip
        ;({ data } = await send('Page.captureScreenshot', { format: 'png' }))
      }
    }
    if (!data) throw new Error('Chrome returned an empty screenshot — the tab may be mid-navigation; retry or call browser_wait first')
    const size = pngSize(data)
    const viewport = params.clip ? [params.clip.width, params.clip.height] : (box ? [Math.round(box.clientWidth || box.width), Math.round(box.clientHeight || box.height)] : null)
    this.#log(tab, 'screenshot', { fullPage, size: size ? `${size.width}x${size.height}` : undefined })
    return { data, size, viewport }
  }

  async waitFor(id, { until = 'js', value, timeoutMs = 15000 } = {}) {
    const tab = this.getTab(id)
    // until:'js' runs caller-supplied code, so it is an evaluation primitive and
    // has to respect Stop and Take over like every other one. The built-in
    // predicates are ours and stay usable while the user holds the tab.
    if (until === 'js') this.#guard(tab)
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
      tab.mainFrameId = evt.params.frame.id
      // A main-frame navigation that arrived is, by definition, not the failed
      // one — otherwise the warning outlives the page it was about. Chrome's
      // own error page also navigates here, and it carries unreachableUrl:
      // that one must keep the warning it was created by.
      if (!evt.params.frame.unreachableUrl) {
        tab.navError = null
        tab.navErrorUrl = null
      }
      if (tab.driving) setTimeout(() => this.#applyBadge(tab), 600)
      this.#state()
      return
    }
    if (evt.method === 'Runtime.consoleAPICalled') {
      const level = evt.params.type === 'error' ? 'error'
        : ['warning', 'assert'].includes(evt.params.type) ? 'warn' : 'log'
      this.#note(tab, level, (evt.params.args || []).map(fmtRemote).filter(Boolean).join(' '), { source: 'console' })
      return
    }
    if (evt.method === 'Runtime.exceptionThrown') {
      const d = evt.params.exceptionDetails || {}
      const where = d.url ? ` (${d.url.split('/').pop()}:${(d.lineNumber || 0) + 1})` : ''
      this.#note(tab, 'error', (d.exception?.description || d.text || 'uncaught exception') + where, { source: 'exception' })
      return
    }
    if (evt.method === 'Log.entryAdded') {
      const e = evt.params.entry || {}
      // Network entries are covered with more detail by the handlers below.
      if (e.source === 'network') return
      const level = e.level === 'error' ? 'error' : e.level === 'warning' ? 'warn' : 'log'
      this.#note(tab, level, e.text, { source: e.source || 'log' })
      return
    }
    if (evt.method === 'Network.requestWillBeSent') {
      const { requestId, request, type } = evt.params
      if (request.url.startsWith('data:')) return
      // Every request's identity is kept (cheaply) so a later failure can name
      // the URL, even for types the agent-facing buffer does not collect.
      // Only the top frame's own document is "the page". Every frame's main
      // resource has requestId === loaderId, iframes included, so the frame id
      // is the only thing that distinguishes them — and without that, any dead
      // third-party iframe would announce that the page failed to load, with an
      // attacker-chosen URL printed above everything else.
      const main = type === 'Document' && !!tab.mainFrameId && evt.params.frameId === tab.mainFrameId
      tab.reqUrls.set(requestId, { url: request.url, method: request.method, type, main })
      if (tab.reqUrls.size > 400) tab.reqUrls.delete(tab.reqUrls.keys().next().value)
      if (!['XHR', 'Fetch', 'Document'].includes(type)) return
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
      const status = evt.params.response.status
      if (status >= 400 && ['XHR', 'Fetch', 'Document'].includes(evt.params.type)) {
        const meta = tab.reqUrls.get(evt.params.requestId) || {}
        this.#note(tab, 'error', `HTTP ${status} ${meta.method || ''} ${evt.params.response.url}`, { source: 'network', status })
      }
      return
    }
    if (evt.method === 'Network.loadingFailed') {
      const { requestId, errorText, canceled, type, blockedReason } = evt.params
      if (canceled && !blockedReason) return
      const meta = tab.reqUrls.get(requestId) || {}
      const r = tab.requests.find(x => x.id === requestId)
      if (r) r.failed = errorText || blockedReason
      const kind = type || meta.type || 'request'
      if (!['XHR', 'Fetch', 'Document', 'Script', 'Stylesheet'].includes(kind)) return
      const why = blockedReason ? `blocked (${blockedReason})` : errorText || 'failed'
      this.#note(tab, 'error', `${kind} ${meta.method || ''} ${meta.url || '?'} — ${why}`, { source: 'network' })
      // A dead main-frame navigation is the one failure worth putting in the
      // replay: it is why the page "just did nothing", and it is rare enough
      // not to spam. Subframes fail all the time and are not the page.
      if (meta.main) {
        tab.navError = why
        tab.navErrorUrl = String(meta.url || '').slice(0, 200)
        this.#log(tab, 'neterror', { url: tab.navErrorUrl, error: why })
      }
    }
  }

  // ---- console / problems ----

  #note(tab, level, text, extra = {}) {
    // Newlines collapse and the block's own gutter marker is stripped, so a
    // page cannot forge extra entries inside the warning block it can write to.
    const clean = String(text || '').replace(/\s+/g, ' ').replace(/^[|⚠\s]+/, '').trim().slice(0, 400)
    if (!clean) return
    const last = tab.messages[tab.messages.length - 1]
    if (last && last.level === level && last.text === clean) {
      last.count += 1
      last.ts = Date.now()
      return
    }
    tab.messages.push({ seq: ++tab.msgSeq, ts: Date.now(), level, text: clean, count: 1, ...extra })
    if (tab.messages.length > 200) tab.messages.splice(0, tab.messages.length - 200)
  }

  // Errors the agent has not been shown yet. Snapshots and actions report these
  // inline, so a silent failure surfaces at the moment it happens instead of
  // ten steps later.
  unseenProblems(tab, { markSeen = true } = {}) {
    const list = tab.messages.filter(m => m.seq > tab.msgCursor && m.level === 'error')
    if (markSeen) tab.msgCursor = tab.msgSeq
    return list
  }

  // Un-see problems reported into a snapshot that got thrown away, so the
  // replacement snapshot carries them instead of dropping them on the floor.
  rewindProblems(id, problems) {
    if (!problems?.length) return
    const tab = this.getTab(id)
    tab.msgCursor = Math.min(tab.msgCursor, problems[0].seq - 1)
  }

  consoleMessages(id, { level = 'error', limit = 30, clear = false } = {}) {
    const tab = this.getTab(id)
    const keep = level === 'all' ? ['error', 'warn', 'log'] : level === 'warn' ? ['error', 'warn'] : ['error']
    const matching = tab.messages.filter(m => keep.includes(m.level))
    const list = matching.slice(-limit)
    // `limit` drops the OLDEST matches, and reading the log marks everything up
    // to the newest as delivered — so without saying how many were withheld,
    // this tool would silently swallow errors. That is the failure mode it
    // exists to prevent, so the count travels with the answer.
    const omitted = matching.length - list.length
    if (list.length) tab.msgCursor = Math.max(tab.msgCursor, list[list.length - 1].seq)
    if (clear) tab.messages = []
    this.#log(tab, 'console', { level, shown: list.length, omitted })
    return { messages: list.map(({ seq, ...m }) => m), total: matching.length, omitted }
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
    // Every agent action funnels through here; the title poller deliberately
    // does not, so it cannot keep an abandoned tab looking alive.
    tab.lastUsedAt = Date.now()
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

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n) || lo))

// CDP RemoteObject -> short printable string, for console.* arguments.
function fmtRemote(a) {
  if (!a) return ''
  if (a.type === 'string') return String(a.value)
  if (a.unserializableValue) return String(a.unserializableValue)
  if ('value' in a) {
    if (a.value === null || typeof a.value !== 'object') return String(a.value)
    try { return JSON.stringify(a.value).slice(0, 200) } catch { return a.className || 'object' }
  }
  // console.error(someObject) arrives by reference: its description is the bare
  // class name ("Object", "Array"), so the preview is the only real content —
  // it has to win, otherwise every logged object reads as a useless "Object".
  if (a.preview && a.preview.properties?.length) {
    const props = a.preview.properties.map(p => `${p.name}: ${p.value}`).join(', ')
    const head = a.subtype === 'array' ? '' : (a.className || a.description || '')
    return `${head}{${props}${a.preview.overflow ? ', …' : ''}}`.slice(0, 300)
  }
  return a.description || a.className || a.type || ''
}

// PNG IHDR: bytes 16-24 of the file hold width/height, so the real dimensions
// come from the image itself rather than from what we asked Chrome for.
function pngSize(b64) {
  try {
    const buf = Buffer.from(b64.slice(0, 64), 'base64')
    if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) return null
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  } catch { return null }
}

function pickHeaders(headers = {}) {
  const keep = {}
  for (const k of Object.keys(headers)) {
    const lk = k.toLowerCase()
    if (['content-type', 'accept', 'x-requested-with'].includes(lk) || lk.startsWith('x-api')) keep[k] = String(headers[k]).slice(0, 200)
  }
  return Object.keys(keep).length ? keep : undefined
}

// Schemes an agent may navigate to. Everything else — file:, chrome:,
// devtools:, view-source:, filesystem: — turns "open a page" into reading the
// host: file:///data/token, the profile's Cookies DB, chrome://net-internals.
// CANOPY_ALLOW_SCHEMES=file: opts back in on a machine where that is fine.
const ALLOWED_SCHEMES = new Set([
  'http:', 'https:',
  ...(process.env.CANOPY_ALLOW_SCHEMES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
])

// Loopback, RFC1918, CGNAT, the link-local metadata range, Oracle's metadata
// address and the RFC2544 benchmarking block.
const PRIVATE_IPV4 = /^(0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|^192\.0\.0\.192$|^198\.1[89]\./
const PRIVATE_NAME = /^(localhost|[^.]+)$|\.(local|internal|localhost|home|lan)$/i

function isPrivateHost(hostname) {
  // A trailing dot is a legal absolute-FQDN form that resolves identically.
  // WHATWG URL strips it from IPv4 literals but keeps it on names, so without
  // this "localhost." and "metadata.google.internal." would sail past both
  // branches below.
  const h = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (PRIVATE_IPV4.test(h)) return true
  if (h === '::1' || h === '::' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true
  // IPv4-mapped IPv6. The URL parser serialises ::ffff:169.254.169.254 to its
  // hex form (::ffff:a9fe:a9fe), so match that and rebuild the dotted quad.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h)
  if (mapped) {
    const n = (parseInt(mapped[1], 16) << 16) | parseInt(mapped[2], 16)
    if (PRIVATE_IPV4.test(`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`)) return true
  }
  if (h.startsWith('::ffff:') && PRIVATE_IPV4.test(h.slice(7))) return true
  return PRIVATE_NAME.test(h)
}

function normalizeUrl(url, restrict = false) {
  if (!url) return 'about:blank'
  const full = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`
  if (full === 'about:blank') return full
  let parsed
  try { parsed = new URL(full) } catch { throw new Error(`invalid url: ${url}`) }
  if (!ALLOWED_SCHEMES.has(parsed.protocol.toLowerCase())) {
    throw new Error(`scheme ${parsed.protocol} is not allowed — Canopy navigates http(s) only`)
  }
  // Best effort: a hostname that resolves into private space still gets
  // through (and DNS rebinding could flip it after this check). The proxy
  // in front of a cloud deploy is the real egress control.
  if (restrict && isPrivateHost(parsed.hostname)) {
    throw new Error(`refusing to navigate to ${parsed.hostname} — private and link-local addresses are blocked in cloud mode`)
  }
  return parsed.href
}
