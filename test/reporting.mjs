// Failure-reporting regression test — no browser required.
//
// The point of these is that a step which quietly does nothing must never look
// like a step that worked:
//   * a dead page load is remembered and reported once
//   * console errors, exceptions and 4xx/5xx reach the agent
//   * an element that is hidden or covered is refused, not clicked
//   * the verdict of an action distinguishes "reacted" from "did nothing"
//
//   node --test test/reporting.mjs
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { test, after } from 'node:test'
import { Controller } from '../src/core.js'
import { Recorder } from '../src/recorder.js'
import { formatSnapshot } from '../src/snapshot.js'

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-report-'))
after(() => rmSync(dataDir, { recursive: true, force: true }))

function harness() {
  const transport = new EventEmitter()
  transport.kind = 'port'
  transport.ready = true
  transport.sent = []
  transport.send = async (ref, method, params) => {
    transport.sent.push({ method, params })
    return {}
  }
  transport.matches = () => true
  const c = new Controller(new Recorder(path.join(dataDir, 'sessions')))
  c.addTransport(transport)
  const tab = {
    id: 't1', ref: {}, transport, session: 'default', url: 'https://example.test/',
    title: '', label: 'Agent', takenOver: false, stopRequested: false, driving: true,
    steps: 0, requests: [], reqUrls: new Map(), messages: [], msgSeq: 0, msgCursor: 0,
    createdAt: Date.now()
  }
  c.tabs.set('t1', tab)
  return { c, tab, transport }
}

test('a page that never loaded is reported, and reported once', () => {
  const { c, tab, transport } = harness()
  transport.emit('cdpEvent', {
    method: 'Network.requestWillBeSent',
    params: { requestId: 'r1', type: 'Document', request: { url: 'https://staging.dead/login', method: 'GET' } }
  })
  transport.emit('cdpEvent', {
    method: 'Network.loadingFailed',
    params: { requestId: 'r1', type: 'Document', errorText: 'net::ERR_NAME_NOT_RESOLVED' }
  })

  assert.equal(tab.navError, 'net::ERR_NAME_NOT_RESOLVED')
  assert.equal(tab.navErrorUrl, 'https://staging.dead/login')
  const first = c.unseenProblems(tab)
  assert.equal(first.length, 1)
  assert.match(first[0].text, /ERR_NAME_NOT_RESOLVED/)
  // Already shown: the next snapshot must not re-report the same error, or the
  // warning becomes noise the agent learns to skip.
  assert.equal(c.unseenProblems(tab).length, 0)
})

test('console errors, exceptions and 4xx reach the agent; ordinary logs do not', () => {
  const { c, tab, transport } = harness()
  const emit = (method, params) => transport.emit('cdpEvent', { method, params })

  emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'just a log' }] })
  emit('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'login failed' }] })
  emit('Runtime.consoleAPICalled', {
    type: 'error',
    args: [{ type: 'object', className: 'Object', description: 'Object', preview: { properties: [{ name: 'status', value: '401' }] } }]
  })
  emit('Runtime.exceptionThrown', { exceptionDetails: { exception: { description: 'TypeError: x is null' } } })
  emit('Network.requestWillBeSent', { requestId: 'r2', type: 'XHR', request: { url: 'https://api.test/me', method: 'GET' } })
  emit('Network.responseReceived', { requestId: 'r2', type: 'XHR', response: { status: 401, url: 'https://api.test/me' } })

  const problems = c.unseenProblems(tab, { markSeen: false })
  const text = problems.map(p => p.text).join('\n')
  assert.match(text, /login failed/)
  assert.match(text, /status: 401/, 'a logged object must show its preview, not just "Object"')
  assert.match(text, /TypeError: x is null/)
  assert.match(text, /HTTP 401 GET https:\/\/api\.test\/me/)
  assert.ok(!text.includes('just a log'), 'a plain console.log is not a problem')

  // And they are what a snapshot shows the agent.
  const snap = { title: 'x', url: 'https://x/', viewport: [800, 600], scrollY: 0, scrollMax: 0, elements: [] }
  assert.match(formatSnapshot(snap, problems), /⚠ 4 error\(s\)/)
})

test('identical repeated errors collapse instead of flooding the buffer', () => {
  const { c, tab, transport } = harness()
  for (let i = 0; i < 5; i++) {
    transport.emit('cdpEvent', {
      method: 'Runtime.consoleAPICalled',
      params: { type: 'error', args: [{ type: 'string', value: 'same failure' }] }
    })
  }
  const problems = c.unseenProblems(tab)
  assert.equal(problems.length, 1)
  assert.equal(problems[0].count, 5)
})

test('act refuses a ref that is hidden or covered, unless forced', async () => {
  const { c, transport } = harness()
  let probe = { x: 10, y: 10, desc: '<button#save> "Salvar"', hidden: true }
  c.eval = async () => JSON.stringify(probe)

  await assert.rejects(c.act('t1', { action: 'click', ref: 1 }), /not visible|closed modal/i)

  probe = { x: 10, y: 10, desc: '<button#save> "Salvar"', blocked: '<div.modal-backdrop>' }
  await assert.rejects(c.act('t1', { action: 'click', ref: 1 }), /covered .*modal-backdrop/i)

  // force is the documented escape hatch, so it has to actually dispatch.
  transport.sent.length = 0
  await c.act('t1', { action: 'click', ref: 1, force: true, verify: false })
  assert.ok(transport.sent.some(s => s.method === 'Input.dispatchMouseEvent'), 'force must still click')
})

test('an action that changes nothing says so', async () => {
  const { c } = harness()
  const state = { url: 'https://x/', title: 'x', len: 10, sig: 42, nodes: 5, dialogs: 0, acts: 3, active: null }
  c.eval = async (id, expr) => {
    if (expr.includes('activeElement')) return JSON.stringify(state)
    return JSON.stringify({ x: 5, y: 5, desc: '<button>' })
  }
  const dead = await c.act('t1', { action: 'click', ref: 1 })
  assert.match(dead.after, /NO CHANGE DETECTED/)

  // Same page, one class flipped: no new text, no new nodes, but two more
  // controls became actionable — that is a modal opening.
  let calls = 0
  c.eval = async (id, expr) => {
    if (expr.includes('activeElement')) return JSON.stringify(++calls > 1 ? { ...state, acts: 5 } : state)
    return JSON.stringify({ x: 5, y: 5, desc: '<button>' })
  }
  const opened = await c.act('t1', { action: 'click', ref: 1 })
  assert.match(opened.after, /interactive elements 3 -> 5/)
})
