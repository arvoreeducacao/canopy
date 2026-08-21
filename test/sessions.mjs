// Per-client sessions — no browser required.
//
//   node --test test/sessions.mjs
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { test, after } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startDaemon } from '../src/daemon.js'
import { Controller, sessionFromHeaders } from '../src/core.js'
import { Recorder } from '../src/recorder.js'

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-sessions-'))
const { server, controller } = await startDaemon({ port: 0, bind: '127.0.0.1', dataDir })
const BASE = `http://127.0.0.1:${server.address().port}`
const token = readFileSync(path.join(dataDir, 'token'), 'utf8').trim()
after(() => {
  server.close()
  rmSync(dataDir, { recursive: true, force: true })
})

const MAX_TABS = 8

function fakeTransport() {
  const transport = new EventEmitter()
  transport.kind = 'port'
  transport.ready = true
  let seq = 0
  transport.createTab = async () => ({ extTabId: ++seq })
  transport.closeTab = async () => {}
  transport.activateTab = async () => {}
  transport.send = async () => ({})
  transport.matches = (ref, evt) => evt.extTabId === ref.extTabId
  transport.refKey = ref => `ext:${ref.extTabId}`
  return transport
}

function standalone() {
  const c = new Controller(new Recorder(path.join(dataDir, 'standalone')))
  c.addTransport(fakeTransport())
  return c
}

controller.addTransport(fakeTransport())

const auth = { Authorization: `Bearer ${token}` }
const api = (route, init = {}) => fetch(`${BASE}${route}`, { ...init, headers: { ...auth, 'Content-Type': 'application/json', ...(init.headers || {}) } }).then(r => r.json())
const sessionsByLabel = async () => {
  const { active } = await api('/sessions')
  return Object.fromEntries(active.map(s => [s.label, s]))
}

async function mcpClient(headers) {
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { ...auth, ...headers } } }))
  return client
}

test('the header is read per request and an unexpanded variable is ignored', () => {
  assert.equal(sessionFromHeaders({ 'x-canopy-session': ' seat-a ' }), 'seat-a')
  assert.equal(sessionFromHeaders({ 'x-canopy-session': ['seat-a', 'seat-b'] }), 'seat-a')
  assert.equal(sessionFromHeaders({}), '')
  assert.equal(sessionFromHeaders({ 'x-canopy-session': '${HIVE_SEAT}' }), '')
  assert.equal(sessionFromHeaders({ 'x-canopy-session': '${HIVE_SEAT:-}' }), '')
})

test('opening a tab in an unknown session creates it, labelled by that name', async () => {
  const c = standalone()
  const tab = await c.openTab('https://example.test/', { session: 'seat-a' })
  const s = c.sessions.get(tab.session)
  assert.equal(s.label, 'seat-a')
  assert.notEqual(s.id, 'seat-a')
  const again = await c.openTab('https://example.test/', { session: 'seat-a' })
  assert.equal(again.session, tab.session)
  const byId = await c.openTab('https://example.test/', { session: tab.session })
  assert.equal(byId.session, tab.session)
  assert.equal(c.listTabs('seat-a').length, 3)
  assert.equal(c.listTabs(tab.session).length, 3)
  const plain = await c.openTab('https://example.test/')
  assert.equal(plain.session, 'default')
  const blank = await c.openTab('https://example.test/', { session: '   ' })
  assert.equal(blank.session, 'default')
})

test('creating a session through REST with only the header reuses the one the header already names', async () => {
  await api('/tabs', { method: 'POST', headers: { 'X-Canopy-Session': 'rest-dup' }, body: JSON.stringify({ url: 'https://example.test/' }) })
  const again = await api('/sessions', { method: 'POST', headers: { 'X-Canopy-Session': 'rest-dup' }, body: '{}' })
  const { active } = await api('/sessions')
  assert.equal(active.filter(s => s.label === 'rest-dup').length, 1)
  assert.equal(again.label, 'rest-dup')
})

test('the tab budget is counted per session', async () => {
  const c = standalone()
  for (let i = 0; i < MAX_TABS; i++) await c.openTab('https://example.test/', { session: 'seat-a' })
  for (let i = 0; i < MAX_TABS; i++) await c.openTab('https://example.test/', { session: 'seat-b' })
  await assert.rejects(c.openTab('https://example.test/', { session: 'seat-a' }), /limit 8/)
  assert.equal(c.listTabs('seat-b').length, MAX_TABS)
  await assert.rejects(c.openTab('https://example.test/', { session: 'seat-b' }), /limit 8/)
})

test('a session can be ended by its label', async () => {
  const c = standalone()
  const tab = await c.openTab('https://example.test/', { session: 'seat-a' })
  const ended = await c.endSession('seat-a')
  assert.equal(ended.id, tab.session)
  assert.equal(c.tabs.size, 0)
  assert.equal(c.findSession('seat-a'), null)
})

test('two REST clients with different headers land in different sessions', async () => {
  const a = await api('/tabs', { method: 'POST', headers: { 'X-Canopy-Session': 'rest-a' }, body: JSON.stringify({ url: 'https://example.test/a' }) })
  const b = await api('/tabs', { method: 'POST', headers: { 'X-Canopy-Session': 'rest-b' }, body: JSON.stringify({ url: 'https://example.test/b' }) })
  const none = await api('/tabs', { method: 'POST', body: JSON.stringify({ url: 'https://example.test/c' }) })
  const explicit = await api('/tabs', { method: 'POST', headers: { 'X-Canopy-Session': 'rest-a' }, body: JSON.stringify({ url: 'https://example.test/d', session: 'rest-b' }) })
  assert.notEqual(a.session, b.session)
  assert.equal(none.session, 'default')
  assert.equal(explicit.session, b.session)
  const byLabel = await sessionsByLabel()
  assert.equal(byLabel['rest-a'].id, a.session)
  assert.equal(byLabel['rest-b'].id, b.session)
  assert.equal(byLabel['rest-a'].tabs, 1)
  assert.equal(byLabel['rest-b'].tabs, 2)
  const listed = await api('/tabs', { headers: { 'X-Canopy-Session': 'rest-a' } })
  assert.deepEqual(listed.map(t => t.id), [a.id])
})

test('two MCP clients with different headers land in different sessions', async () => {
  const a = await mcpClient({ 'X-Canopy-Session': 'mcp-a' })
  const b = await mcpClient({ 'X-Canopy-Session': 'mcp-b' })
  const statusA = JSON.parse((await a.callTool({ name: 'browser_status', arguments: {} })).content[0].text)
  assert.equal(statusA.defaultSession, 'mcp-a')
  await a.callTool({ name: 'browser_open', arguments: { url: 'https://example.test/a' } })
  await b.callTool({ name: 'browser_open', arguments: { url: 'https://example.test/b' } })
  const byLabel = await sessionsByLabel()
  assert.equal(byLabel['mcp-a'].tabs, 1)
  assert.equal(byLabel['mcp-b'].tabs, 1)
  const tabsA = JSON.parse((await a.callTool({ name: 'browser_tabs', arguments: {} })).content[0].text)
  assert.deepEqual(tabsA.map(t => t.session), [byLabel['mcp-a'].id])
  await a.close()
  await b.close()
})
