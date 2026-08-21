// Screencast follows the cockpit's session filter; browser contexts per session — no browser required.
//
//   node --test test/watch.mjs
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { test, after } from 'node:test'
import { WebSocket } from 'ws'
import { startDaemon } from '../src/daemon.js'
import { Controller } from '../src/core.js'
import { Recorder } from '../src/recorder.js'

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-watch-'))
const { server, controller } = await startDaemon({ port: 0, bind: '127.0.0.1', dataDir })
const PORT = server.address().port
const ORIGIN = `http://127.0.0.1:${PORT}`
const token = readFileSync(path.join(dataDir, 'token'), 'utf8').trim()
after(() => {
  server.close()
  rmSync(dataDir, { recursive: true, force: true })
})

const sleep = ms => new Promise(r => setTimeout(r, ms))

function fakeTransport({ contexts = false } = {}) {
  const transport = new EventEmitter()
  transport.kind = 'port'
  transport.ready = true
  transport.sent = []
  transport.created = []
  transport.contexts = []
  transport.disposed = []
  let seq = 0
  transport.createTab = async (url, opts) => {
    const ref = { extTabId: ++seq }
    transport.created.push({ ref, opts })
    return ref
  }
  if (contexts) {
    transport.createContext = async () => {
      const id = `ctx${transport.contexts.length + 1}`
      transport.contexts.push(id)
      return id
    }
    transport.disposeContext = async id => { transport.disposed.push(id) }
  }
  transport.closeTab = async () => {}
  transport.activateTab = async () => {}
  transport.send = async (ref, method) => { transport.sent.push({ ref, method }); return {} }
  transport.matches = (ref, evt) => evt.extTabId === ref.extTabId
  transport.refKey = ref => `ext:${ref.extTabId}`
  return transport
}

const fake = fakeTransport()
controller.addTransport(fake)

const screencastCalls = (ref, method) => fake.sent.filter(m => m.ref === ref && m.method === method).length

function dial(session) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws${session ? `?session=${encodeURIComponent(session)}` : ''}`, {
      origin: ORIGIN,
      headers: { Authorization: `Bearer ${token}` }
    })
    ws.frames = []
    ws.on('message', raw => {
      const msg = JSON.parse(raw)
      if (msg.t === 'frame') ws.frames.push(msg)
    })
    ws.once('message', () => resolve(ws))
    ws.on('error', reject)
  })
}

const closed = ws => new Promise(resolve => { ws.once('close', resolve); ws.close() })

test('without any cockpit open no tab screencasts', async () => {
  const tab = await controller.openTab('https://example.test/', { session: 'idle' })
  assert.equal(screencastCalls(tab.ref, 'Page.startScreencast'), 0)
  await controller.endSession('idle')
})

test('screencast runs only on the tabs somebody is watching', async () => {
  const filtered = await dial('seat-a')
  const a = await controller.openTab('https://example.test/a', { session: 'seat-a' })
  const b = await controller.openTab('https://example.test/b', { session: 'seat-b' })
  assert.equal(screencastCalls(a.ref, 'Page.startScreencast'), 1)
  assert.equal(screencastCalls(b.ref, 'Page.startScreencast'), 0)

  const everything = await dial()
  await sleep(50)
  assert.equal(screencastCalls(b.ref, 'Page.startScreencast'), 1)
  assert.equal(screencastCalls(a.ref, 'Page.startScreencast'), 1)

  await closed(everything)
  await sleep(50)
  assert.equal(screencastCalls(b.ref, 'Page.stopScreencast'), 1)
  assert.equal(screencastCalls(a.ref, 'Page.stopScreencast'), 0)

  controller.emit('frame', { tab: a.id, session: a.session, data: 'AAA' })
  controller.emit('frame', { tab: b.id, session: b.session, data: 'BBB' })
  await sleep(50)
  assert.deepEqual(filtered.frames.map(f => f.tab), [a.id])

  await closed(filtered)
  await sleep(50)
  assert.equal(screencastCalls(a.ref, 'Page.stopScreencast'), 1)
  await controller.endSession('seat-a')
  await controller.endSession('seat-b')
})

test('a cockpit watching a session by id gets its frames as well', async () => {
  const a = await controller.openTab('https://example.test/a', { session: 'seat-c' })
  const byId = await dial(a.session)
  await sleep(50)
  assert.equal(screencastCalls(a.ref, 'Page.startScreencast'), 1)
  controller.emit('frame', { tab: a.id, session: a.session, data: 'AAA' })
  await sleep(50)
  assert.equal(byId.frames.length, 1)
  await closed(byId)
  await controller.endSession('seat-c')
})

test('isolated sessions get a browser context each, default does not', async () => {
  const t = fakeTransport({ contexts: true })
  const c = new Controller(new Recorder(path.join(dataDir, 'isolated')), { isolateSessions: true })
  c.addTransport(t)
  const a1 = await c.openTab('https://example.test/', { session: 'seat-a' })
  const a2 = await c.openTab('https://example.test/', { session: 'seat-a' })
  const b = await c.openTab('https://example.test/', { session: 'seat-b' })
  const d = await c.openTab('https://example.test/')
  const optsOf = tab => t.created.find(x => x.ref === tab.ref).opts
  assert.equal(optsOf(a1).browserContextId, 'ctx1')
  assert.equal(optsOf(a2).browserContextId, 'ctx1')
  assert.equal(optsOf(b).browserContextId, 'ctx2')
  assert.deepEqual(optsOf(d), {})
  assert.equal(c.sessionInfo(c.sessions.get(a1.session)).isolated, true)
  assert.equal(c.sessionInfo(c.sessions.get('default')).isolated, false)
  await c.endSession('seat-a')
  assert.deepEqual(t.disposed, ['ctx1'])
  await c.endSession('seat-b')
  assert.deepEqual(t.disposed, ['ctx1', 'ctx2'])
})

test('a transport that reconnects gets a fresh context instead of the dead one', async () => {
  const t = fakeTransport({ contexts: true })
  const c = new Controller(new Recorder(path.join(dataDir, 'isolated-reconnect')), { isolateSessions: true })
  c.addTransport(t)
  const before = await c.openTab('https://example.test/', { session: 'seat-a' })
  t.emit('disconnected')
  t.emit('connected')
  assert.equal(c.tabs.size, 0)
  assert.equal(c.sessions.get(before.session).browserContextId, null)
  const after = await c.openTab('https://example.test/', { session: 'seat-a' })
  assert.equal(after.session, before.session)
  assert.equal(t.created.find(x => x.ref === after.ref).opts.browserContextId, 'ctx2')
})

test('a failing createContext does not block the tab', async () => {
  const t = fakeTransport({ contexts: true })
  t.createContext = async () => { throw new Error('no contexts here') }
  const c = new Controller(new Recorder(path.join(dataDir, 'isolated-fail')), { isolateSessions: true })
  c.addTransport(t)
  const tab = await c.openTab('https://example.test/', { session: 'seat-a' })
  assert.deepEqual(t.created[0].opts, {})
  assert.equal(c.sessionInfo(c.sessions.get(tab.session)).isolated, false)
})

test('with the flag off createTab never receives a browser context', async () => {
  const t = fakeTransport({ contexts: true })
  const c = new Controller(new Recorder(path.join(dataDir, 'plain')))
  c.addTransport(t)
  await c.openTab('https://example.test/', { session: 'seat-a' })
  assert.deepEqual(t.created[0].opts, {})
  assert.deepEqual(t.contexts, [])
})
