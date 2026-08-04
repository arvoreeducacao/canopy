// CDP -> WebDriver BiDi translation, with a fake browser on the other end.
//
// The transport is the one place where a mistake is invisible: a wrong
// parameter name makes Gecko reject a command the controller then swallows, so
// the agent sees a step that "worked" and did nothing. These assert the wire
// format, not just that the code runs.
//
//   node --test test/bidi.mjs
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { BidiTransport, fromRemoteValue, resourceType } from '../src/cdp/bidi-transport.js'

// A socket that records what was sent and answers whatever the test says.
class FakeSocket extends EventEmitter {
  constructor(reply) {
    super()
    this.sent = []
    this.reply = reply
    setImmediate(() => this.emit('open'))
  }
  send(raw) {
    const msg = JSON.parse(raw)
    this.sent.push(msg)
    const result = this.reply(msg.method, msg.params)
    if (result === undefined) return
    setImmediate(() => this.emit('message', JSON.stringify({ type: 'success', id: msg.id, result })))
  }
  close() { this.emit('close') }
}

const connect = async (reply = () => ({})) => {
  let socket
  const t = new BidiTransport('ws://fake/session', {
    openSocket: () => {
      socket = new FakeSocket((method, params) => {
        if (method === 'session.new') return { sessionId: 's1', capabilities: { browserName: 'zen', browserVersion: '1.0' } }
        if (method === 'browsingContext.create') return { context: 'ctx-1' }
        if (method === 'session.subscribe') return { subscription: 'sub-1' }
        return reply(method, params)
      })
      return socket
    }
  })
  await t.connect()
  socket.sent.length = 0
  return { t, socket, ref: { context: 'ctx-1' } }
}

const lastOf = (socket, method) => [...socket.sent].reverse().find(m => m.method === method)

test('connect reports the browser it reached', async () => {
  const { t } = await connect()
  assert.equal(t.browserInfo, 'zen 1.0')
  assert.equal(t.kind, 'bidi')
})

test('a new tab opens in the background and is subscribed on its own', async () => {
  const { t, socket } = await connect((method) => {
    if (method === 'script.evaluate') return { type: 'success', result: { type: 'string', value: '[1280,800]' } }
    return {}
  })
  const ref = await t.createTab('https://example.com')
  assert.deepEqual(ref, { context: 'ctx-1' })
  assert.deepEqual(lastOf(socket, 'browsingContext.create').params, { type: 'tab', background: true })
  // Per context, never browser-wide: the user's own tabs stay out of the daemon.
  assert.deepEqual(lastOf(socket, 'session.subscribe').params.contexts, ['ctx-1'])
  assert.equal(lastOf(socket, 'browsingContext.navigate').params.url, 'https://example.com')
})

test('a tab that was never laid out is given a viewport', async () => {
  const { t, socket } = await connect((method) => {
    if (method === 'script.evaluate') return { type: 'success', result: { type: 'string', value: '[0,0]' } }
    return {}
  })
  await t.createTab('https://example.com')
  assert.deepEqual(lastOf(socket, 'browsingContext.setViewport').params.viewport, { width: 1280, height: 800 })
})

test('a tab that already has a layout keeps it', async () => {
  const { t, socket } = await connect((method) => {
    if (method === 'script.evaluate') return { type: 'success', result: { type: 'string', value: '[1024,768]' } }
    return {}
  })
  await t.createTab('https://example.com')
  assert.equal(lastOf(socket, 'browsingContext.setViewport'), undefined)
})

test('evaluate unwraps the value and surfaces a page exception', async () => {
  const { t, socket, ref } = await connect((method) => {
    if (method !== 'script.evaluate') return {}
    return JSON.parse(socket.sent.at(-1).params.expression).throw
      ? { type: 'exception', exceptionDetails: { text: 'ReferenceError: nope is not defined' } }
      : { type: 'success', result: { type: 'string', value: 'Example Domain' } }
  })
  const ok = await t.send(ref, 'Runtime.evaluate', { expression: '{"throw":false}' })
  assert.equal(ok.result.value, 'Example Domain')
  const bad = await t.send(ref, 'Runtime.evaluate', { expression: '{"throw":true}' })
  assert.match(bad.exceptionDetails.text, /ReferenceError/)
  assert.equal(bad.result, undefined)
})

test('a click becomes a pointer sequence at the right place', async () => {
  const { t, socket, ref } = await connect()
  await t.send(ref, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 120, y: 40, button: 'left' })
  await t.send(ref, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: 120, y: 40, button: 'left' })
  const [down, up] = socket.sent.map(m => m.params.actions[0].actions)
  assert.deepEqual(down, [{ type: 'pointerMove', x: 120, y: 40 }, { type: 'pointerDown', button: 0 }])
  assert.deepEqual(up, [{ type: 'pointerUp', button: 0 }])
})

test('a right click keeps its button', async () => {
  const { t, socket, ref } = await connect()
  await t.send(ref, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 2, button: 'right' })
  assert.equal(socket.sent[0].params.actions[0].actions[1].button, 2)
})

test('named keys become WebDriver key code points', async () => {
  const { t, socket, ref } = await connect()
  await t.send(ref, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', text: '\r' })
  await t.send(ref, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', text: '\r' })
  assert.deepEqual(socket.sent[0].params.actions[0].actions, [{ type: 'keyDown', value: '\uE007' }])
  assert.deepEqual(socket.sent[1].params.actions[0].actions, [{ type: 'keyUp', value: '\uE007' }])
})

test('insertText types code points, not UTF-16 halves', async () => {
  const { t, socket, ref } = await connect()
  await t.send(ref, 'Input.insertText', { text: 'a🌲' })
  const actions = socket.sent[0].params.actions[0].actions
  assert.deepEqual(actions.map(a => a.value), ['a', 'a', '🌲', '🌲'])
  assert.deepEqual(actions.map(a => a.type), ['keyDown', 'keyUp', 'keyDown', 'keyUp'])
})

test('the control binding becomes a preload script with a channel', async () => {
  const { t, socket, ref } = await connect()
  await t.send(ref, 'Runtime.addBinding', { name: '__canopyControl' })
  const params = lastOf(socket, 'script.addPreloadScript').params
  assert.deepEqual(params.arguments, [{ type: 'channel', value: { channel: '__canopyControl', ownership: 'none' } }])
  assert.deepEqual(params.contexts, ['ctx-1'])
  // Adding it twice would stack a second preload script on every navigation.
  socket.sent.length = 0
  await t.send(ref, 'Runtime.addBinding', { name: '__canopyControl' })
  assert.equal(lastOf(socket, 'script.addPreloadScript'), undefined)
})

test('a screenshot clip is sent in page coordinates', async () => {
  const { t, socket, ref } = await connect(() => ({ data: 'iVBOR' }))
  await t.send(ref, 'Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 10, width: 800, height: 600, scale: 0.5 } })
  const params = lastOf(socket, 'browsingContext.captureScreenshot').params
  assert.equal(params.origin, 'document')
  assert.deepEqual(params.clip, { type: 'box', x: 0, y: 10, width: 800, height: 600 })
  assert.deepEqual(params.format, { type: 'image/png' })
})

test('an unclipped screenshot captures the viewport', async () => {
  const { t, socket, ref } = await connect(() => ({ data: 'iVBOR' }))
  await t.send(ref, 'Page.captureScreenshot', { format: 'jpeg', quality: 50 })
  const params = lastOf(socket, 'browsingContext.captureScreenshot').params
  assert.equal(params.origin, 'viewport')
  assert.deepEqual(params.format, { type: 'image/jpeg', quality: 0.5 })
})

test('viewport emulation maps onto setViewport, and reset clears it', async () => {
  const { t, socket, ref } = await connect()
  await t.send(ref, 'Emulation.setDeviceMetricsOverride', { width: 390.4, height: 844, deviceScaleFactor: 2 })
  assert.deepEqual(lastOf(socket, 'browsingContext.setViewport').params, {
    context: 'ctx-1', viewport: { width: 390, height: 844 }, devicePixelRatio: 2
  })
  await t.send(ref, 'Emulation.clearDeviceMetricsOverride', {})
  assert.deepEqual(lastOf(socket, 'browsingContext.setViewport').params, {
    context: 'ctx-1', viewport: null, devicePixelRatio: null
  })
})

test('a method with no BiDi equivalent is refused, never silently ignored', async () => {
  const { t, ref } = await connect()
  await assert.rejects(t.send(ref, 'Target.setDiscoverTargets', {}), /not available over WebDriver BiDi/)
  // Response bodies really are missing from BiDi — the error has to say what to do instead.
  await assert.rejects(t.send(ref, 'Network.getResponseBody', {}), /browser_eval/)
})

test('domains the controller enables are accepted as no-ops', async () => {
  const { t, socket, ref } = await connect()
  for (const m of ['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable', 'Page.startScreencast']) {
    await t.send(ref, m, {})
  }
  assert.equal(socket.sent.length, 0)
})

test('a console entry reaches the controller as consoleAPICalled', async () => {
  const { t, socket } = await connect()
  const seen = []
  t.on('cdpEvent', e => seen.push(e))
  socket.emit('message', JSON.stringify({
    type: 'event',
    method: 'log.entryAdded',
    params: { type: 'console', method: 'error', level: 'error', text: 'boom', source: { context: 'ctx-1' } }
  }))
  assert.equal(seen[0].method, 'Runtime.consoleAPICalled')
  assert.equal(seen[0].context, 'ctx-1')
  assert.equal(seen[0].params.args[0].value, 'boom')
})

test('an uncaught page error arrives as exceptionThrown', async () => {
  const { t, socket } = await connect()
  const seen = []
  t.on('cdpEvent', e => seen.push(e))
  socket.emit('message', JSON.stringify({
    type: 'event',
    method: 'log.entryAdded',
    params: {
      type: 'javascript', level: 'error', text: 'TypeError: x is not a function',
      source: { context: 'ctx-1' },
      stackTrace: { callFrames: [{ url: 'https://example.com/app.js', lineNumber: 12 }] }
    }
  }))
  assert.equal(seen[0].method, 'Runtime.exceptionThrown')
  assert.match(seen[0].params.exceptionDetails.text, /TypeError/)
  assert.equal(seen[0].params.exceptionDetails.url, 'https://example.com/app.js')
})

test('a failed response is reported with its status', async () => {
  const { t, socket } = await connect()
  const seen = []
  t.on('cdpEvent', e => seen.push(e))
  socket.emit('message', JSON.stringify({
    type: 'event',
    method: 'network.responseCompleted',
    params: {
      context: 'ctx-1',
      request: { request: 'r1', url: 'https://api.test/x', method: 'GET', initiatorType: 'fetch' },
      response: { url: 'https://api.test/x', status: 503, mimeType: 'application/json; charset=utf-8' }
    }
  }))
  assert.equal(seen[0].method, 'Network.responseReceived')
  assert.equal(seen[0].params.response.status, 503)
  assert.equal(seen[0].params.response.mimeType, 'application/json')
  assert.equal(seen[0].params.type, 'Fetch')
})

test('the take-over binding arrives as bindingCalled', async () => {
  const { t, socket } = await connect()
  const seen = []
  t.on('cdpEvent', e => seen.push(e))
  socket.emit('message', JSON.stringify({
    type: 'event',
    method: 'script.message',
    params: { channel: '__canopyControl', data: { type: 'string', value: '{"action":"stop"}' }, source: { context: 'ctx-1' } }
  }))
  assert.equal(seen[0].method, 'Runtime.bindingCalled')
  assert.equal(seen[0].params.name, '__canopyControl')
  assert.equal(seen[0].params.payload, '{"action":"stop"}')
})

test('a tab the user closed is announced with its ref', async () => {
  const { t, socket } = await connect()
  const seen = []
  t.on('tab.removed', e => seen.push(e))
  socket.emit('message', JSON.stringify({
    type: 'event', method: 'browsingContext.contextDestroyed', params: { context: 'ctx-1' }
  }))
  assert.deepEqual(seen[0], { ref: { context: 'ctx-1' } })
})

test('refs only match their own context', async () => {
  const { t } = await connect()
  assert.equal(t.refKey({ context: 'ctx-1' }), 'bidi:ctx-1')
  assert.equal(t.matches({ context: 'ctx-1' }, { context: 'ctx-1' }), true)
  assert.equal(t.matches({ context: 'ctx-1' }, { context: 'ctx-2' }), false)
})

test('remote values come back as plain JavaScript', () => {
  assert.equal(fromRemoteValue({ type: 'string', value: 'x' }), 'x')
  assert.equal(fromRemoteValue({ type: 'number', value: 3 }), 3)
  assert.equal(fromRemoteValue({ type: 'number', value: 'NaN' }), Number('NaN'))
  assert.equal(fromRemoteValue({ type: 'null' }), null)
  assert.equal(fromRemoteValue({ type: 'undefined' }), undefined)
  assert.deepEqual(fromRemoteValue({ type: 'array', value: [{ type: 'number', value: 1 }] }), [1])
  assert.deepEqual(fromRemoteValue({ type: 'object', value: [['a', { type: 'boolean', value: true }]] }), { a: true })
})

test('resource types keep XHR, fetch and documents apart', () => {
  assert.equal(resourceType({ request: { initiatorType: 'xmlhttprequest' } }), 'XHR')
  assert.equal(resourceType({ request: { initiatorType: 'fetch' } }), 'Fetch')
  assert.equal(resourceType({ request: { destination: 'document' }, navigation: 'n1' }), 'Document')
  assert.equal(resourceType({ request: { destination: 'script' } }), 'Script')
  assert.equal(resourceType({ request: { destination: '' } }), 'Fetch')
})
