import { EventEmitter } from 'node:events'

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
      try { this.socket.close() } catch {}
    }
    this.socket = ws
    this.browserInfo = hello.browser || 'via extension'
    this.ready = true
    // MV3 service workers idle out after ~30s and take the socket with them;
    // inbound WS traffic resets that timer (Chrome 116+), so a ping every 20s
    // keeps the bridge alive instead of flapping connect/disconnect.
    clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => {
      try { ws.send(JSON.stringify({ event: 'ping' })) } catch {}
    }, 20000)
    this.pingTimer.unref?.()
    ws.on('message', raw => {
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
    // Group agent tabs together — visible as an amber "Agentes" group in
    // Chrome's tab strip / Arc's sidebar. Best-effort (Arc may ignore groups).
    await this.#op('tabs.group', { tabId, title: 'AI' }).catch(() => {})
    return { extTabId: tabId }
  }

  send(ref, method, params = {}) {
    return this.#op('cdp', { tabId: ref.extTabId, method, params })
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
