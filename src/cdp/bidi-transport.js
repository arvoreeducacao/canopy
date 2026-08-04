import WebSocket from 'ws'
import { EventEmitter } from 'node:events'

// WebDriver BiDi, spoken as if it were CDP.
//
// Firefox — and therefore Zen, LibreWolf, Floorp — has no chrome.debugger and
// no CDP any more: Mozilla removed its CDP implementation in favour of BiDi, so
// --remote-debugging-port on a Gecko browser opens a BiDi socket and nothing
// else. Rather than teach the controller a second protocol, this transport
// exposes the same send(ref, method, params) surface as the CDP transports and
// translates the subset Canopy actually uses. Tab refs are { context }.
//
// The translation is deliberately narrow: every method in CDP_TO_BIDI below is
// one src/core.js calls, and anything not in it throws rather than resolving
// into a no-op — a silent no-op is the exact failure mode Canopy exists to
// make visible.
export class BidiTransport extends EventEmitter {
  constructor(url = 'ws://127.0.0.1:9223/session', { openSocket } = {}) {
    super()
    this.kind = 'bidi'
    this.url = url
    this.openSocket = openSocket || (u => new WebSocket(u, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 }))
    this.ws = null
    this.msgId = 0
    this.pending = new Map()
    this.ready = false
    this.sessionId = null
    this.browserInfo = 'via WebDriver BiDi'
    this.bindings = new Map()      // context -> Set of binding names
    this.subscriptions = new Map() // context -> subscription id
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.ws = this.openSocket(this.url)
      this.ws.once('open', resolve)
      this.ws.once('error', reject)
    })
    this.ws.on('message', raw => this.onMessage(parse(raw)))
    this.ws.on('close', () => {
      if (!this.ready) return
      this.ready = false
      for (const [, p] of this.pending) p.reject(new Error('BiDi socket closed'))
      this.pending.clear()
      this.emit('disconnected')
    })
    // A refused session (Gecko allows exactly one) leaves an open socket the
    // retry loop would otherwise keep adding to, one every few seconds.
    const { sessionId, capabilities } = await this.raw('session.new', { capabilities: {} })
      .catch(err => { try { this.ws.close() } catch {}; throw err })
    this.sessionId = sessionId
    this.browserInfo = [capabilities?.browserName, capabilities?.browserVersion].filter(Boolean).join(' ') || 'WebDriver BiDi'
    this.ready = true
    return this
  }

  // Firefox keeps a BiDi session alive after its socket goes away, refuses to
  // open a second one ("Maximum number of active sessions") and offers no way
  // to rejoin the old one — so a daemon that exits without ending its session
  // leaves the browser undriveable until it is restarted.
  async end() {
    if (!this.ready) return
    this.ready = false
    await this.raw('session.end', {}).catch(() => {})
    try { this.ws.close() } catch {}
  }

  onMessage(msg) {
    if (!msg) return
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.type === 'error') p.reject(new Error(`${msg.error}: ${msg.message}`))
      else p.resolve(msg.result)
      return
    }
    if (msg.type === 'event') this.onBidiEvent(msg.method, msg.params || {})
  }

  // Internal plumbing. Not private (#) because the translation table below is a
  // module-level map of plain functions rather than a wall of methods.
  raw(method, params = {}) {
    const id = ++this.msgId
    return new Promise((resolve, reject) => {
      // The watchdog is cleared when the reply lands and unref'd meanwhile: a
      // pending 30 s timer per command would otherwise hold the whole process
      // open long after the daemon had shut its listener.
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new Error(`BiDi timeout: ${method}`))
      }, 30000)
      timer.unref?.()
      const settle = fn => value => { clearTimeout(timer); fn(value) }
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err)
      }
    })
  }

  evaluate(context, expression, { awaitPromise = true } = {}) {
    return this.raw('script.evaluate', {
      expression,
      target: { context },
      awaitPromise,
      userActivation: true,
      resultOwnership: 'none'
    })
  }

  perform(context, actions) {
    return this.raw('input.performActions', { context, actions })
  }

  bindingsFor(context) {
    if (!this.bindings.has(context)) this.bindings.set(context, new Set())
    return this.bindings.get(context)
  }

  // ---- tabs ----

  async createTab(url) {
    const { context } = await this.raw('browsingContext.create', { type: 'tab', background: true })
    // Subscribe per context rather than browser-wide: this is the user's own
    // browser, and a global subscription would stream every request and console
    // line out of the tabs they are working in. Canopy watches what it opened.
    const { subscription } = await this.raw('session.subscribe', { events: TAB_EVENTS, contexts: [context] })
      .catch(() => ({ subscription: null }))
    if (subscription) this.subscriptions.set(context, subscription)
    // A Gecko tab that has never been selected is never laid out: innerWidth
    // and innerHeight are 0, screenshots come back empty and every coordinate
    // the agent computes off a snapshot is meaningless. Since every agent tab
    // is a background tab, that is the normal case here, not an edge one — an
    // explicit viewport is what makes it a real page. Taking the tab over
    // clears the override, and the window's own size takes back over.
    const size = await this.evaluate(context, 'JSON.stringify([innerWidth, innerHeight])')
      .then(r => JSON.parse(r.result?.value || '[0,0]'))
      .catch(() => [0, 0])
    if (!size[0] || !size[1]) {
      await this.raw('browsingContext.setViewport', { context, viewport: DEFAULT_VIEWPORT }).catch(() => {})
    }
    if (url && url !== 'about:blank') {
      await this.raw('browsingContext.navigate', { context, url, wait: 'none' }).catch(() => {})
    }
    return { context }
  }

  async listTargets() {
    const { contexts } = await this.raw('browsingContext.getTree', {})
    const out = []
    for (const c of contexts) {
      // getTree carries no titles, and the orphan sweep matches on the "AI · "
      // badge a previous daemon left behind in them.
      const title = await this.evaluate(c.context, 'document.title')
        .then(r => r.result?.value)
        .catch(() => '')
      out.push({ targetId: c.context, type: 'page', url: c.url, title: typeof title === 'string' ? title : '' })
    }
    return out
  }

  async closeTab(ref) {
    const sub = this.subscriptions.get(ref.context)
    if (sub) {
      this.subscriptions.delete(ref.context)
      await this.raw('session.unsubscribe', { subscriptions: [sub] }).catch(() => {})
    }
    this.bindings.delete(ref.context)
    await this.raw('browsingContext.close', { context: ref.context })
  }

  async activateTab(ref) {
    await this.raw('browsingContext.activate', { context: ref.context })
  }

  refKey(ref) {
    return `bidi:${ref.context}`
  }

  matches(ref, evt) {
    return evt.context === ref.context
  }

  send(ref, method, params = {}) {
    const translate = CDP_TO_BIDI[method]
    if (!translate) return Promise.reject(new Error(`${method} is not available over WebDriver BiDi`))
    return translate(this, ref.context, params)
  }

  // ---- events ----

  onBidiEvent(method, params) {
    const emit = (context, cdpMethod, cdpParams) => this.emit('cdpEvent', { context, method: cdpMethod, params: cdpParams })

    if (method === 'browsingContext.load' || method === 'browsingContext.fragmentNavigated') {
      // The controller's contract for Page.frameNavigated is "a main frame
      // arrived". Iframes carry their own context id here, which no tab ref
      // matches, so they fall away without a parentId check.
      return emit(params.context, 'Page.frameNavigated', { frame: { id: params.context, url: params.url } })
    }

    if (method === 'browsingContext.contextDestroyed') {
      return this.emit('tab.removed', { ref: { context: params.context } })
    }

    if (method === 'browsingContext.userPromptOpened') {
      // An unhandled prompt blocks every later script.evaluate on the tab, so
      // the agent would only ever see timeouts. Dismiss it, and say so.
      this.raw('browsingContext.handleUserPrompt', { context: params.context, accept: false }).catch(() => {})
      return emit(params.context, 'Runtime.consoleAPICalled', {
        type: 'error',
        args: [{ type: 'string', value: `dialog dismissed: ${params.type} — ${params.message || ''}` }]
      })
    }

    if (method === 'script.message') {
      return emit(params.source?.context, 'Runtime.bindingCalled', { name: params.channel, payload: params.data?.value })
    }

    if (method === 'log.entryAdded') {
      const context = params.source?.context
      if (params.type === 'javascript') {
        const frame = params.stackTrace?.callFrames?.[0]
        return emit(context, 'Runtime.exceptionThrown', {
          exceptionDetails: {
            text: params.text,
            url: frame?.url,
            lineNumber: frame?.lineNumber,
            exception: { description: params.text }
          }
        })
      }
      // BiDi already renders console arguments into `text` — the same job the
      // controller's RemoteObject formatter does on the CDP side.
      return emit(context, 'Runtime.consoleAPICalled', {
        type: params.method === 'warn' ? 'warning' : params.method || params.level,
        args: [{ type: 'string', value: params.text || '' }]
      })
    }

    if (method === 'network.beforeRequestSent') {
      return emit(params.context, 'Network.requestWillBeSent', {
        requestId: params.request?.request,
        frameId: params.context,
        type: resourceType(params),
        request: {
          url: params.request?.url,
          method: params.request?.method,
          headers: headerObject(params.request?.headers)
        }
      })
    }

    if (method === 'network.responseCompleted') {
      const res = params.response || {}
      return emit(params.context, 'Network.responseReceived', {
        requestId: params.request?.request,
        type: resourceType(params),
        response: {
          url: res.url,
          status: res.status,
          mimeType: String(res.mimeType || '').split(';')[0]
        }
      })
    }

    if (method === 'network.fetchError') {
      return emit(params.context, 'Network.loadingFailed', {
        requestId: params.request?.request,
        type: resourceType(params),
        errorText: params.errorText
      })
    }
  }
}

// What an unpainted background tab is given so it has a layout at all. Roughly
// a laptop window; browser_resize replaces it whenever the agent needs another.
const DEFAULT_VIEWPORT = { width: 1280, height: 800 }

// Everything a tab needs in order to report on itself. Subscribed per context,
// never browser-wide — see createTab.
const TAB_EVENTS = [
  'browsingContext.load',
  'browsingContext.fragmentNavigated',
  'browsingContext.contextDestroyed',
  'browsingContext.userPromptOpened',
  'log.entryAdded',
  'script.message',
  'network.beforeRequestSent',
  'network.responseCompleted',
  'network.fetchError'
]

// CDP key names -> the WebDriver key code points BiDi expects.
const BIDI_KEYS = {
  Enter: '\uE007', Return: '\uE007', Tab: '\uE004', Escape: '\uE00C',
  Backspace: '\uE003', Delete: '\uE017',
  ArrowUp: '\uE013', ArrowDown: '\uE015', ArrowLeft: '\uE012', ArrowRight: '\uE014',
  PageUp: '\uE00E', PageDown: '\uE00F', Home: '\uE011', End: '\uE010'
}

const BIDI_BUTTONS = { left: 0, middle: 1, right: 2 }

const mouse = actions => [{ type: 'pointer', id: 'canopy-mouse', parameters: { pointerType: 'mouse' }, actions }]
const keyboard = actions => [{ type: 'key', id: 'canopy-keys', actions }]

// The CDP calls src/core.js makes, and what each becomes. A method absent from
// this table is rejected by send() — see the note at the top of the file.
export const CDP_TO_BIDI = {
  // Domain enables have no BiDi equivalent: subscriptions are per context and
  // already in place by the time the controller asks. Screencast has none at
  // all (the controller's screenshot poller is the fallback feed it already
  // uses for background tabs), and focus emulation is unnecessary — Gecko
  // delivers synthesised input to background tabs without it.
  'Page.enable': async () => ({}),
  'Runtime.enable': async () => ({}),
  'Network.enable': async () => ({}),
  'Log.enable': async () => ({}),
  'Emulation.setFocusEmulationEnabled': async () => ({}),
  'Emulation.setTouchEmulationEnabled': async () => ({}),
  'Page.startScreencast': async () => ({}),
  'Page.stopScreencast': async () => ({}),
  'Page.screencastFrameAck': async () => ({}),

  'Page.getFrameTree': async (t, context) => ({ frameTree: { frame: { id: context } } }),

  'Page.navigate': (t, context, { url }) =>
    t.raw('browsingContext.navigate', { context, url, wait: 'none' }),

  // Preload scripts are how BiDi does Runtime.addBinding: the channel argument
  // arrives in the page as a callable, and calling it emits script.message.
  // They apply from the next document on, which is why the controller adds the
  // binding while the tab is still on about:blank.
  'Runtime.addBinding': async (t, context, { name }) => {
    const seen = t.bindingsFor(context)
    if (seen.has(name)) return {}
    seen.add(name)
    await t.raw('script.addPreloadScript', {
      functionDeclaration: `function(channel) { window[${JSON.stringify(name)}] = channel }`,
      arguments: [{ type: 'channel', value: { channel: name, ownership: 'none' } }],
      contexts: [context]
    })
    return {}
  },

  'Runtime.evaluate': async (t, context, { expression, awaitPromise }) => {
    const res = await t.evaluate(context, expression, { awaitPromise: awaitPromise !== false })
    if (res.type === 'exception') {
      const text = res.exceptionDetails?.text || 'page threw'
      return { exceptionDetails: { text, exception: { description: text } } }
    }
    return { result: { value: fromRemoteValue(res.result) } }
  },

  'Input.dispatchMouseEvent': async (t, context, { type, x, y, button }) => {
    const btn = BIDI_BUTTONS[button] ?? 0
    if (type === 'mouseMoved') return t.perform(context, mouse([{ type: 'pointerMove', x, y }]))
    // BiDi keeps the pointer position per input source, but repeating the move
    // costs nothing and makes each dispatch self-contained.
    if (type === 'mousePressed') {
      return t.perform(context, mouse([{ type: 'pointerMove', x, y }, { type: 'pointerDown', button: btn }]))
    }
    if (type === 'mouseReleased') return t.perform(context, mouse([{ type: 'pointerUp', button: btn }]))
    throw new Error(`unsupported mouse event ${type}`)
  },

  'Input.dispatchKeyEvent': async (t, context, params) => {
    const value = BIDI_KEYS[params.key] || (params.text ? [...params.text][0] : '') || params.key
    if (!value) throw new Error(`unmappable key ${params.key}`)
    const down = params.type === 'keyDown' || params.type === 'rawKeyDown'
    return t.perform(context, keyboard([{ type: down ? 'keyDown' : 'keyUp', value }]))
  },

  // BiDi has no insertText, so the text gets typed. Iterating with the spread
  // yields code points rather than UTF-16 units, which keeps astral characters
  // (emoji) as one key each instead of two broken halves.
  'Input.insertText': async (t, context, { text }) => {
    const chars = [...String(text)]
    if (!chars.length) return {}
    return t.perform(context, keyboard(chars.flatMap(c => [{ type: 'keyDown', value: c }, { type: 'keyUp', value: c }])))
  },

  'Emulation.setDeviceMetricsOverride': (t, context, { width, height, deviceScaleFactor }) =>
    t.raw('browsingContext.setViewport', {
      context,
      viewport: { width: Math.round(width), height: Math.round(height) },
      devicePixelRatio: deviceScaleFactor || null
    }),

  'Emulation.clearDeviceMetricsOverride': (t, context) =>
    t.raw('browsingContext.setViewport', { context, viewport: null, devicePixelRatio: null }),

  // Reported in CSS pixels, in the shape the controller reads — it prefers the
  // css* fields precisely because those map 1:1 to the coordinates it hands
  // back to act().
  'Page.getLayoutMetrics': async (t, context) => {
    const res = await t.evaluate(context, LAYOUT_METRICS_JS)
    const m = JSON.parse(res.result?.value || '{}')
    return {
      cssVisualViewport: { pageX: m.pageX, pageY: m.pageY, clientWidth: m.clientWidth, clientHeight: m.clientHeight },
      cssContentSize: { x: 0, y: 0, width: m.contentWidth, height: m.contentHeight }
    }
  },

  'Page.captureScreenshot': async (t, context, { format, quality, clip }) => {
    const image = format === 'jpeg'
      ? { type: 'image/jpeg', quality: (quality ?? 80) / 100 }
      : { type: 'image/png' }
    const params = { context, format: image }
    if (clip) {
      // The controller's clip is in page coordinates, which is BiDi's
      // "document" origin. Its scale field is a CDP-ism for undoing the device
      // pixel ratio; BiDi captures at the context's own ratio, so it is dropped
      // and the controller reads the real size back out of the PNG.
      params.origin = 'document'
      params.clip = { type: 'box', x: clip.x, y: clip.y, width: clip.width, height: clip.height }
    } else {
      params.origin = 'viewport'
    }
    const { data } = await t.raw('browsingContext.captureScreenshot', params)
    return { data }
  },

  'Network.getResponseBody': async () => {
    throw new Error('response bodies are not exposed by WebDriver BiDi — re-issue the call from the page with browser_eval and fetch(url, { credentials: "include" })')
  }
}

const LAYOUT_METRICS_JS = `JSON.stringify({
  pageX: Math.round(window.scrollX),
  pageY: Math.round(window.scrollY),
  clientWidth: Math.round(window.innerWidth),
  clientHeight: Math.round(window.innerHeight),
  contentWidth: Math.round(Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0)),
  contentHeight: Math.round(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0))
})`

// BiDi RemoteValue -> plain JS. The controller only evaluates expressions that
// return primitives or JSON strings, but a page can return anything, and a
// throw here would be indistinguishable from a page that did nothing.
export function fromRemoteValue(v) {
  if (!v || typeof v !== 'object') return v
  switch (v.type) {
    case 'undefined': return undefined
    case 'null': return null
    case 'string': case 'boolean': return v.value
    case 'number': return typeof v.value === 'string' ? Number(v.value) : v.value
    case 'bigint': return String(v.value)
    case 'array': case 'set': return (v.value || []).map(fromRemoteValue)
    case 'object': case 'map': {
      const out = {}
      for (const [k, val] of v.value || []) out[typeof k === 'object' ? fromRemoteValue(k) : k] = fromRemoteValue(val)
      return out
    }
    default: return v.value === undefined ? undefined : v.value
  }
}

// BiDi describes a request by what asked for it; the controller reasons in CDP
// resource types and keeps Document/XHR/Fetch as the ones worth showing.
export function resourceType({ request = {}, navigation } = {}) {
  const initiator = request.initiatorType
  const destination = request.destination
  if (initiator === 'xmlhttprequest') return 'XHR'
  if (initiator === 'fetch') return 'Fetch'
  if (destination === 'document' || destination === 'iframe') return 'Document'
  if (destination === 'script') return 'Script'
  if (destination === 'style') return 'Stylesheet'
  if (destination === 'image') return 'Image'
  if (destination === 'font') return 'Font'
  if (navigation) return 'Document'
  // An empty destination outside a navigation is fetch()/XHR whose initiator
  // Gecko did not label — the agent-facing buffer is better off keeping it.
  return destination ? 'Other' : 'Fetch'
}

function headerObject(headers = []) {
  const out = {}
  for (const h of headers) out[h.name] = h.value?.value ?? ''
  return out
}

function parse(raw) {
  try { return JSON.parse(raw) } catch { return null }
}
