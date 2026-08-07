// Tab lifecycle regression test — no browser required.
//
// An agent tab used to outlive the agent that opened it: only that agent ever
// closed one, and an agent that dies never gets to. These cover the two things
// that now bound it:
//   * an idle tab is reclaimed, unless a human took it over
//   * a session cannot hold an unbounded number of tabs at once
//
//   node --test test/lifecycle.mjs
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { test, after } from 'node:test'
import { Controller } from '../src/core.js'
import { Recorder } from '../src/recorder.js'

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-lifecycle-'))
after(() => rmSync(dataDir, { recursive: true, force: true }))

const IDLE_MS = 30 * 60 * 1000
const MAX_TABS = 8

function harness() {
  const transport = new EventEmitter()
  transport.kind = 'port'
  transport.ready = true
  transport.closed = []
  let seq = 0
  transport.createTab = async () => ({ extTabId: ++seq })
  transport.closeTab = async ref => { transport.closed.push(ref.extTabId) }
  transport.activateTab = async () => {}
  transport.send = async () => ({})
  transport.matches = (ref, evt) => evt.extTabId === ref.extTabId
  transport.refKey = ref => `ext:${ref.extTabId}`
  const c = new Controller(new Recorder(path.join(dataDir, 'sessions')))
  c.addTransport(transport)
  return { c, transport }
}

async function drain(c) {
  for (const id of [...c.tabs.keys()]) await c.closeTab(id).catch(() => {})
}

test('a tab nobody has touched past the idle window is reclaimed', async () => {
  const { c } = harness()
  const tab = await c.openTab('https://example.test/')
  const reaped = await c.reapIdleTabs(Date.now() + IDLE_MS + 1000)
  assert.deepEqual(reaped, [tab.id])
  assert.equal(c.tabs.size, 0)
  await drain(c)
})

test('a tab worked recently survives the sweep', async () => {
  const { c } = harness()
  await c.openTab('https://example.test/')
  const reaped = await c.reapIdleTabs(Date.now() + IDLE_MS - 1000)
  assert.deepEqual(reaped, [])
  assert.equal(c.tabs.size, 1)
  await drain(c)
})

test('idle is measured from the last action, not from when the tab opened', async () => {
  const { c } = harness()
  const tab = await c.openTab('https://example.test/')
  const opened = Date.now() - IDLE_MS * 2
  tab.createdAt = opened
  tab.lastUsedAt = Date.now()
  assert.deepEqual(await c.reapIdleTabs(Date.now() + 1000), [])
  assert.equal(c.tabs.size, 1)
  await drain(c)
})

test('a tab the human took over is never reclaimed', async () => {
  const { c } = harness()
  const tab = await c.openTab('https://example.test/')
  tab.takenOver = true
  const reaped = await c.reapIdleTabs(Date.now() + IDLE_MS * 10)
  assert.deepEqual(reaped, [])
  assert.equal(c.tabs.size, 1)
  tab.takenOver = false
  await drain(c)
})

test('a session cannot hold more than the tab limit at once', async () => {
  const { c } = harness()
  for (let i = 0; i < MAX_TABS; i++) await c.openTab('https://example.test/')
  await assert.rejects(
    () => c.openTab('https://example.test/'),
    err => /limit 8/.test(err.message) && /browser_close/.test(err.message)
  )
  assert.equal(c.tabs.size, MAX_TABS)
  await drain(c)
})

test('hitting the limit sweeps first, so dead tabs never block a live agent', async () => {
  const { c } = harness()
  const old = []
  for (let i = 0; i < MAX_TABS; i++) old.push(await c.openTab('https://example.test/'))
  for (const t of old) t.lastUsedAt = Date.now() - IDLE_MS - 1000
  const fresh = await c.openTab('https://example.test/')
  assert.ok(c.tabs.has(fresh.id))
  assert.equal(c.tabs.size, 1)
  await drain(c)
})

test('a session whose tabs were all reclaimed is closed out', async () => {
  const { c } = harness()
  const s = c.startSession('scraper')
  await c.openTab('https://example.test/', { session: s.id })
  await c.reapIdleTabs(Date.now() + IDLE_MS + 1000)
  assert.equal(c.sessions.has(s.id), false)
  assert.equal(c.sessions.has('default'), true)
  await drain(c)
})

test('a session that has not opened a tab yet is left alone', async () => {
  const { c } = harness()
  const s = c.startSession('starting-up')
  await c.reapIdleTabs(Date.now() + IDLE_MS * 10)
  assert.equal(c.sessions.has(s.id), true)
  await drain(c)
})

test('a session the agent emptied itself survives to open its next tab', async () => {
  const { c } = harness()
  const s = c.startSession('between-tabs')
  const tab = await c.openTab('https://example.test/', { session: s.id })
  await c.closeTab(tab.id)
  await c.reapIdleTabs(Date.now() + IDLE_MS * 10)
  assert.equal(c.sessions.has(s.id), true)
  const next = await c.openTab('https://example.test/', { session: s.id })
  assert.ok(c.tabs.has(next.id))
  await drain(c)
})
