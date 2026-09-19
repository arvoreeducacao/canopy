// Fill-by-coordinate regression test — no browser required.
//
// Filling by coordinate has to click the point first, or the text goes to
// whatever the page had focused last. It used to click three times, to focus
// and select in one gesture. The extra two arrive at the page as a dblclick,
// and a widget that reads a double click as its own gesture answers by moving
// focus off the field — every character then goes into nothing while the tool
// still reports a fill. These cover what replaced it:
//   * exactly one click at the point, never a dblclick
//   * the old content is selected from script instead
//   * a field that ignores insertText is typed key by key before giving up
//   * a fill that cannot be read back says so instead of claiming success
//
//   node --test test/fill.mjs
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { test, after } from 'node:test'
import { Controller } from '../src/core.js'
import { Recorder } from '../src/recorder.js'

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-fill-'))
after(() => rmSync(dataDir, { recursive: true, force: true }))

// `field` decides what the page pretends the focused element holds, which is
// what the fill reads back: a string it accepts, null for a widget that shows
// script no value at all, and 'deaf' for one that ignores insertText and only
// takes real keys.
function harness({ field = 'typed' } = {}) {
  const transport = new EventEmitter()
  transport.kind = 'port'
  transport.ready = true
  transport.calls = []
  let seq = 0
  let held = ''
  transport.createTab = async () => ({ extTabId: ++seq })
  transport.closeTab = async () => {}
  transport.activateTab = async () => {}
  transport.send = async (ref, method, params = {}) => {
    transport.calls.push({ method, params })
    if (method === 'Input.insertText' && field === 'typed') held = params.text
    if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown' && params.text) held += params.text
    if (method === 'Runtime.evaluate') {
      const expr = String(params.expression || '')
      if (expr.includes('deepActive')) {
        if (expr.includes('el.select')) return { result: { value: 'INPUT' } }
        const value = field === null ? null : held
        return { result: { value: { tag: 'INPUT', value } } }
      }
      return { result: { value: '{}' } }
    }
    if (method === 'Page.getLayoutMetrics') return {}
    return {}
  }
  transport.matches = (ref, evt) => evt.extTabId === ref.extTabId
  transport.refKey = ref => `ext:${ref.extTabId}`
  const c = new Controller(new Recorder(path.join(dataDir, 'sessions')))
  c.addTransport(transport)
  return { c, transport }
}

const mouseAt = t => t.calls.filter(c => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed')

test('fill by coordinate clicks the point exactly once', async () => {
  const { c, transport } = harness()
  const tab = await c.openTab('https://example.test', { session: 'fill' })
  await c.act(tab.id, { action: 'fill', x: 100, y: 200, text: 'hello', verify: false })

  const presses = mouseAt(transport)
  assert.equal(presses.length, 1, 'a fill must deliver one click, not a double or triple one')
  assert.equal(presses[0].params.clickCount, 1)
  assert.ok(
    !transport.calls.some(c => c.method === 'Input.dispatchMouseEvent' && c.params.clickCount > 1),
    'no dispatch may carry clickCount > 1 — that is what the page reads as a dblclick'
  )
})

test('fill selects the old content from script, reaching shadow roots', async () => {
  const { c, transport } = harness()
  const tab = await c.openTab('https://example.test', { session: 'fill' })
  await c.act(tab.id, { action: 'fill', x: 10, y: 20, text: 'x', verify: false })

  const select = transport.calls.find(c => c.method === 'Runtime.evaluate' && String(c.params.expression).includes('el.select'))
  assert.ok(select, 'the fill must select the field content from script')
  assert.match(select.params.expression, /shadowRoot/, 'the walk must descend shadow roots')
  assert.match(select.params.expression, /IFRAME/, 'the walk must descend subframes')
})

test('a field that ignores insertText is typed key by key', async () => {
  const { c, transport } = harness({ field: 'deaf' })
  const tab = await c.openTab('https://example.test', { session: 'fill' })
  const out = await c.act(tab.id, { action: 'fill', x: 10, y: 20, text: 'abc', verify: false })

  const keys = transport.calls.filter(c => c.method === 'Input.dispatchKeyEvent' && c.params.type === 'keyDown')
  assert.deepEqual(keys.map(k => k.params.text), ['a', 'b', 'c'], 'every character has to be delivered as a real key')
  assert.equal(out.filled, true)
  assert.equal(out.verified, true, 'the fallback landed, so the fill is verified')
})

test('a fill that cannot be read back does not claim it worked', async () => {
  const { c } = harness({ field: null })
  const tab = await c.openTab('https://example.test', { session: 'fill' })
  const out = await c.act(tab.id, { action: 'fill', x: 10, y: 20, text: 'secret', verify: false })

  assert.equal(out.verified, false)
  assert.match(out.note, /could not be read back/)
})
