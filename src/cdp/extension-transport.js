import { EventEmitter } from 'node:events'

// Chrome walks the whole frame tree before letting an extension speak
// chrome.debugger to a tab, and refuses while any frame belongs to a *different*
// extension. A password manager's autofill menu is exactly that: the moment it
// opens, the live session is detached and every later command fails. The page
// guard (src/frame-guard.js) takes the menu back out from inside the page, so
// the block clears on its own within a moment — these are the errors worth
// waiting out and re-attaching for, instead of letting the tab die silently.
const RECOVERABLE = /not attached to the tab|Debugger is not attached|Cannot access a chrome-extension|Detached while handling command|target is not attached/i
const REATTACH_TRIES = 8
const REATTACH_WAIT_MS = 250

const sleep = ms => new Promise(r => setTimeout(r, ms))

// CDP bridged through the Canopy extension (chrome.debugger). Works in Arc
// and any Chromium browser without --remote-debugging-port. The extension keeps
// a WebSocket open to the daemon; commands flow daemon -> extension, events and
// tab lifecycle flow back. Tab refs are { extTabId }.
export class ExtensionTransport extends EventEmitter {
  constructor() {
    super()
    this.kind = 'extension'
    this.socket = null
    this.msgId = 0
    this.pending = new Map()
    this.ready = false
    this.browserInfo = 'via extension'
  }

  attachSocket(ws, hello = {}) {
    if (this.socket) {
      // The old worker died without closing its socket (Arc leaves zombies) —
      // anything still in flight there will never answer. Fail those callers
      // now instead of letting each one burn the full 30s op timeout.
      try { this.socket.close() } catch {}
      for (const [, p] of this.pending) p.reject(new Error('extension reconnected'))
      this.pending.clear()
    }
    this.socket = ws
    this.browserInfo = hello.browser || 'via extension'
    this.ready = true
    this.lastSeen = Date.now()
    // MV3 service workers idle out after ~30s and take the socket with them;
    // a ping every 20s keeps the bridge alive, and the extension answers with
    // a pong so a socket whose worker silently died can be detected and
    // dropped instead of swallowing commands.
    clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastSeen > 65000) {
        try { ws.close() } catch {}
        return
      }
      try { ws.send(JSON.stringify({ event: 'ping' })) } catch {}
    }, 20000)
    this.pingTimer.unref?.()
    ws.on('message', raw => {
      this.lastSeen = Date.now()
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      this.#onMessage(msg)
    })
    ws.on('close', () => {
      if (this.socket === ws) {
        clearInterval(this.pingTimer)
        this.ready = false
        this.socket = null
        for (const [, p] of this.pending) p.reject(new Error('extension disconnected'))
        this.pending.clear()
        this.emit('disconnected')
      }
    })
    this.emit('connected')
    // Agent tabs a previous daemon left behind (extension tracks them in
    // storage.session) — the controller decides what to do with them.
    if (Array.isArray(hello.orphans) && hello.orphans.length) this.emit('orphans', hello.orphans)
  }

  #onMessage(msg) {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error || 'extension error'))
      return
    }
    if (msg.event === 'cdp') {
      this.emit('cdpEvent', { extTabId: msg.tabId, method: msg.method, params: msg.params })
    } else if (msg.event) {
      this.emit(msg.event, msg)
    }
  }

  #op(op, payload = {}) {
    if (!this.ready) return Promise.reject(new Error('extension not connected'))
    const id = ++this.msgId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, op, ...payload }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`extension timeout: ${op}`))
        }
      }, 30000)
    })
  }

  async createTab(url) {
    const { tabId } = await this.#op('tabs.create', { url })
    await this.#op('attach', { tabId })
    // Group agent tabs together — visible as an amber "AI" group in Chrome's
    // tab strip. Fire-and-forget: grouping is cosmetic, and in Arc
    // chrome.tabs.group never resolves — awaiting it here stalled every
    // open on the 30 s op timeout.
    this.#op('tabs.group', { tabId, title: 'AI' }).catch(() => {})
    return { extTabId: tabId }
  }

  attach(ref) {
    return this.#op('attach', { tabId: ref.extTabId })
  }

  async send(ref, method, params = {}) {
    try {
      return await this.#op('cdp', { tabId: ref.extTabId, method, params })
    } catch (err) {
      if (!RECOVERABLE.test(String(err && err.message || err))) throw err
      await this.#reattach(ref)
      return this.#op('cdp', { tabId: ref.extTabId, method, params })
    }
  }

  async #reattach(ref) {
    let last = null
    for (let attempt = 0; attempt < REATTACH_TRIES; attempt++) {
      try {
        await this.attach(ref)
        // A fresh debugger session starts with every domain disabled, so the
        // caller has to re-enable what the tab was set up with — otherwise the
        // command succeeds and the tab goes deaf (no console, no network, no
        // screencast) for the rest of its life.
        this.emit('reattached', { extTabId: ref.extTabId })
        return
      } catch (err) {
        last = err
        await sleep(REATTACH_WAIT_MS)
      }
    }
    throw new Error(
      `the browser detached the debugger from this tab and will not let it back in: ${String(last && last.message || last)}. ` +
      'This is what a password manager autofill menu does — Chrome blocks debugging the whole tab while an extension frame is open in it. ' +
      'Dismiss the menu in the tab (Escape, or click elsewhere) and try again; if it keeps happening, open a new tab and avoid focusing the field the menu attaches to.'
    )
  }

  async closeTab(ref) {
    await this.#op('tabs.remove', { tabId: ref.extTabId })
  }

  async activateTab(ref) {
    await this.#op('tabs.activate', { tabId: ref.extTabId })
  }

  listTabs() {
    return this.#op('tabs.list')
  }

  refKey(ref) {
    return `ext:${ref.extTabId}`
  }

  matches(ref, evt) {
    return evt.extTabId === ref.extTabId
  }
}
