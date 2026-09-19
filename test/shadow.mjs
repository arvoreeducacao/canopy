// Shadow-DOM regression test — no browser required.
//
// A page built out of custom elements keeps its real controls inside shadow
// roots. Every query that starts at `document` stops at the host, so the
// snapshot came back empty (no refs — coordinates were the only way left) and
// the change probe saw no controls and no text, so its verdict read NO CHANGE
// DETECTED however much of the screen had moved. This runs the walk that
// replaced those queries against a stub DOM, so it fails if the walk ever
// stops piercing the boundary again.
//
//   node --test test/shadow.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEEP_DOM_JS, SNAPSHOT_JS, PROBE_JS } from '../src/snapshot.js'

// Smallest DOM that has the shape that used to defeat us: a host element whose
// shadow root holds the input and the buttons the agent actually needs.
function stubDom() {
  const make = (tagName, attrs = {}) => ({
    tagName,
    attrs,
    shadowRoot: null,
    matches(sel) { return sel.split(',').some(s => s.trim() === tagName.toLowerCase() || (attrs.role && s.trim() === `[role="${attrs.role}"]`)) },
    textContent: attrs.text || ''
  })
  const input = make('input')
  const ok = make('button', { text: 'Ok' })
  const cancel = make('button', { text: 'Cancelar' })
  const dialogInner = make('div', { role: 'dialog', text: 'Serie / Notas' })
  const host = make('wa-text-input')
  host.shadowRoot = { querySelectorAll: () => [input], textContent: 'Numero' }
  const dialogHost = make('wa-dialog')
  dialogHost.shadowRoot = { querySelectorAll: () => [dialogInner, ok, cancel], textContent: 'Serie / Notas Ok Cancelar' }
  return {
    document: {
      querySelectorAll: () => [host, dialogHost],
      body: { innerText: '' }
    },
    nodes: { input, ok, cancel, dialogInner, host, dialogHost }
  }
}

const run = (document, expr) => new Function('document', `${DEEP_DOM_JS}; return (${expr})`)(document)

test('the walk reaches elements inside shadow roots', () => {
  const { document, nodes } = stubDom()
  const all = run(document, 'ALL')
  assert.ok(all.includes(nodes.input), 'the input inside the shadow root must be reached')
  assert.ok(all.includes(nodes.ok) && all.includes(nodes.cancel), 'both shadow buttons must be reached')
  assert.equal(all.length, 6, 'hosts and their shadow children, nothing dropped')
})

test('controls inside shadow roots are found by selector', () => {
  const { document, nodes } = stubDom()
  assert.deepEqual(run(document, "deepMatching('button')"), [nodes.ok, nodes.cancel])
  assert.equal(run(document, "deepFind('input')"), nodes.input)
  assert.equal(
    run(document, `deepMatching('[role="dialog"]').length`), 1,
    'a dialog drawn inside a shadow root has to count, or the verdict never reports one opening'
  )
})

test('the change signature includes text held in shadow roots', () => {
  const { document } = stubDom()
  const text = run(document, 'deepText()')
  assert.match(text, /Serie \/ Notas/, 'text that only exists in a shadow root must reach the signature')
  assert.notEqual(text, '', 'document.body.innerText alone is empty here — that was the blind spot')
})

test('the walk is bounded, so it cannot hang the hot path', () => {
  const deep = { querySelectorAll: () => [node] }
  const node = { tagName: 'div', shadowRoot: deep, matches: () => false }
  const document = { querySelectorAll: () => [node], body: { innerText: '' } }
  const all = run(document, 'ALL')
  assert.equal(all.length, 20000, 'a cyclic or runaway tree stops at the budget instead of spinning')
})

test('snapshot and probe both use the piercing walk', () => {
  for (const [name, js] of [['SNAPSHOT_JS', SNAPSHOT_JS], ['PROBE_JS', PROBE_JS]]) {
    assert.ok(js.includes('deepEls'), `${name} must carry the walk`)
    assert.ok(!/\bdocument\.querySelectorAll\(SEL\)/.test(js), `${name} must not query only the light DOM`)
  }
})

// Runs the REAL predicate that waitFor builds, against the stub DOM — not a
// copy of it, so it cannot drift.
test('the built-in waits look through shadow roots too', async () => {
  const { Controller } = await import('../src/core.js')
  const { Recorder } = await import('../src/recorder.js')
  const os = await import('node:os')
  const path = await import('node:path')
  const { mkdtempSync } = await import('node:fs')
  const { EventEmitter } = await import('node:events')

  const { document } = stubDom()
  const seen = []
  const transport = new EventEmitter()
  transport.kind = 'port'
  transport.ready = true
  transport.createTab = async () => ({ extTabId: 1 })
  transport.closeTab = async () => {}
  transport.activateTab = async () => {}
  transport.send = async (ref, method, params = {}) => {
    if (method !== 'Runtime.evaluate') return {}
    const expr = String(params.expression)
    if (!expr.includes('deepEls')) return { result: { value: '{}' } }
    seen.push(expr)
    return { result: { value: new Function('document', `return (${expr})`)(document) } }
  }
  transport.matches = () => true
  transport.refKey = () => 'ext:1'

  const dir = mkdtempSync(path.join(os.tmpdir(), 'canopy-wait-'))
  const c = new Controller(new Recorder(path.join(dir, 'sessions')))
  c.addTransport(transport)
  const tab = await c.openTab('https://example.test', { session: 'wait' })

  // The dialog title exists only inside a shadow root: document.body.innerText
  // is empty here, which is what used to make the wait burn its whole timeout
  // while the thing it waited for was on screen the entire time.
  assert.equal(await c.waitFor(tab.id, { until: 'text', value: 'Serie / Notas', timeoutMs: 2000 }), true)
  assert.equal(await c.waitFor(tab.id, { until: 'selector', value: 'button', timeoutMs: 2000 }), true)
  await assert.rejects(
    () => c.waitFor(tab.id, { until: 'text', value: 'nao existe na tela', timeoutMs: 700 }),
    /wait timed out/
  )
  assert.ok(seen.length >= 3, 'every built-in wait must go through the piercing walk')
})
