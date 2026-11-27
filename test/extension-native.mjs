import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeChrome, loadBackground, settle } from './fake-chrome.mjs'

const plain = value => JSON.parse(JSON.stringify(value))

function nativeHostStub() {
  const stub = { port: null, available: true, connections: 0 }
  stub.connect = port => {
    if (!stub.available) return false
    stub.connections++
    stub.port = port
    port.onMessage.fire({ host: 'ready', version: 'test' })
  }
  stub.reply = async (msg, match) => {
    const before = stub.port.sent.length
    stub.port.onMessage.fire(msg)
    for (let i = 0; i < 200; i++) {
      const found = stub.port.sent.slice(before).find(match)
      if (found) return plain(found)
      await settle()
    }
    throw new Error('the extension never answered ' + JSON.stringify(msg))
  }
  return stub
}

test('with the native host registered the extension never opens the paired socket', async () => {
  const stub = nativeHostStub()
  const chrome = fakeChrome({ nativeHost: stub.connect })
  loadBackground(chrome)
  await settle()
  assert.deepEqual(plain(chrome.calls.connectNative), ['com.arvoretech.canopy'])
  assert.equal(chrome.calls.offscreen, 0)
})

test('the extension runs daemon commands that arrive through the native host', async () => {
  const stub = nativeHostStub()
  const chrome = fakeChrome({ nativeHost: stub.connect })
  loadBackground(chrome)
  await settle()

  const hello = await stub.reply({ host: 'hello' }, m => m.t === 'hello')
  assert.deepEqual(hello, { t: 'hello', browser: 'Chrome/140.0.0.0', orphans: [] })

  stub.port.onMessage.fire({ host: 'status', state: 'connected' })
  assert.equal(chrome.action.badge.text, 'on')

  const created = await stub.reply({ id: 1, op: 'tabs.create', url: 'https://example.com/' }, m => m.id === 1)
  assert.equal(created.ok, true)
  const tabId = created.result.tabId
  assert.equal((await stub.reply({ id: 2, op: 'attach', tabId }, m => m.id === 2)).ok, true)

  const foreign = await stub.reply({ id: 3, op: 'attach', tabId: 999 }, m => m.id === 3)
  assert.equal(foreign.ok, false)
  assert.match(foreign.error, /not opened by Canopy/)

  assert.deepEqual(await stub.reply({ event: 'ping' }, m => m.event === 'pong'), { event: 'pong' })

  chrome.debugger.onEvent.fire({ tabId }, 'Page.loadEventFired', { timestamp: 1 })
  assert.deepEqual(plain(stub.port.sent.at(-1)), { event: 'cdp', tabId, method: 'Page.loadEventFired', params: { timestamp: 1 } })
})

test('without the native host the extension falls back to the paired socket, quietly', async () => {
  const chrome = fakeChrome()
  loadBackground(chrome)
  await settle()
  assert.equal(chrome.calls.offscreen, 1)
  assert.deepEqual(plain(chrome.calls.lastErrorChecked), [true])
})

test('a native host registered later takes over from the paired socket', async () => {
  const stub = nativeHostStub()
  stub.available = false
  const chrome = fakeChrome({ nativeHost: stub.connect })
  loadBackground(chrome)
  await settle()
  assert.equal(chrome.calls.offscreen, 1)

  stub.available = true
  chrome.alarms.onAlarm.fire({ name: 'canopy-keepalive' })
  await settle()
  assert.equal(stub.connections, 1)
  assert.equal(chrome.calls.closedOffscreen, 1)
})

test('a native link that drops is retried instead of falling back to the socket', async () => {
  const stub = nativeHostStub()
  const chrome = fakeChrome({ nativeHost: stub.connect })
  loadBackground(chrome)
  await settle()
  stub.port.onDisconnect.fire(stub.port)
  await new Promise(resolve => setTimeout(resolve, 2100))
  assert.equal(stub.connections, 2)
  assert.equal(chrome.calls.offscreen, 0)
})

test('with no native host and no pairing code the icon opens the options page', async () => {
  const chrome = fakeChrome()
  loadBackground(chrome)
  await settle()
  chrome.action.onClicked.fire()
  await settle()
  assert.equal(chrome.calls.optionsOpened, 1)
})

test('with the native host linked the icon does not ask for a pairing code', async () => {
  const stub = nativeHostStub()
  const chrome = fakeChrome({ nativeHost: stub.connect })
  loadBackground(chrome)
  await settle()
  chrome.action.onClicked.fire()
  await settle()
  assert.equal(chrome.calls.optionsOpened, 0)
})
