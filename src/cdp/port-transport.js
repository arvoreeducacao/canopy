import WebSocket from 'ws'
import { EventEmitter } from 'node:events'

// CDP over --remote-debugging-port, flat session protocol.
// Tab refs are { sessionId, targetId }.
export class PortTransport extends EventEmitter {
  constructor(baseUrl = 'http://127.0.0.1:9222') {
    super()
    this.kind = 'port'
    this.baseUrl = baseUrl
    this.ws = null
    this.msgId = 0
    this.pending = new Map()
    this.ready = false
  }

  async connect() {
    const res = await fetch(`${this.baseUrl}/json/version`)
    const info = await res.json()
    this.browserInfo = info.Browser
    await new Promise((resolve, reject) => {
      this.ws = new WebSocket(info.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
      this.ws.once('open', resolve)
      this.ws.once('error', reject)
    })
    this.ws.on('message', raw => this.#onMessage(JSON.parse(raw)))
    this.ws.on('close', () => {
      this.ready = false
      this.emit('disconnected')
    })
    this.ready = true
    return this
  }

  disconnect() {
    this.ready = false
    try { this.ws?.close() } catch {}
  }

  #onMessage(msg) {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
      return
    }
    this.emit('cdpEvent', { sessionId: msg.sessionId, method: msg.method, params: msg.params })
  }

  #raw(method, params = {}, sessionId) {
    const id = ++this.msgId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP timeout: ${method}`))
        }
      }, 30000)
    })
  }

  async createTab(url) {
    const { targetId } = await this.#raw('Target.createTarget', { url, background: true })
    const { sessionId } = await this.#raw('Target.attachToTarget', { targetId, flatten: true })
    return { sessionId, targetId }
  }

  async attachTo(targetId) {
    const { sessionId } = await this.#raw('Target.attachToTarget', { targetId, flatten: true })
    return { sessionId, targetId }
  }

  async listTargets() {
    const { targetInfos } = await this.#raw('Target.getTargets')
    return targetInfos.filter(t => t.type === 'page')
  }

  send(ref, method, params = {}) {
    return this.#raw(method, params, ref.sessionId)
  }

  async closeTab(ref) {
    await this.#raw('Target.closeTarget', { targetId: ref.targetId })
  }

  async activateTab(ref) {
    await this.#raw('Target.activateTarget', { targetId: ref.targetId })
  }

  refKey(ref) {
    return `port:${ref.targetId}`
  }

  matches(ref, evt) {
    return evt.sessionId === ref.sessionId
  }
}
