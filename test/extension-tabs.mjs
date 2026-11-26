import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectBridge, fakeChrome, loadBackground } from './fake-chrome.mjs'

async function bridge() {
  const chrome = fakeChrome()
  loadBackground(chrome)
  const user = await chrome.tabs.create({ url: 'https://mail.example.com/' })
  return { chrome, user, ...connectBridge(chrome) }
}

test('the extension attaches the debugger to a tab it opened for an agent', async () => {
  const { chrome, op } = await bridge()
  const created = await op('tabs.create', { url: 'https://example.com/' })
  assert.equal(created.ok, true)
  const attached = await op('attach', { tabId: created.result.tabId })
  assert.equal(attached.ok, true)
  assert.deepEqual(chrome.calls.attach, [created.result.tabId])
  const sent = await op('cdp', { tabId: created.result.tabId, method: 'Page.navigate', params: { url: 'https://example.com/' } })
  assert.equal(sent.ok, true)
})

test('the extension refuses to attach the debugger to a tab the person opened', async () => {
  const { chrome, op, user } = await bridge()
  const answer = await op('attach', { tabId: user.id })
  assert.equal(answer.ok, false)
  assert.match(answer.error, /not opened by Canopy/)
  assert.deepEqual(chrome.calls.attach, [])
})

test('the extension refuses every tab command on a tab the person opened', async () => {
  const { chrome, op, user } = await bridge()
  for (const name of ['cdp', 'tabs.group', 'tabs.remove', 'tabs.activate']) {
    const answer = await op(name, { tabId: user.id, method: 'Runtime.evaluate', params: {} })
    assert.equal(answer.ok, false, name)
    assert.match(answer.error, /not opened by Canopy/, name)
  }
  assert.deepEqual(chrome.calls.sendCommand, [])
  assert.equal(chrome._tabs.has(user.id), true)
})

test('a restarted service worker still recognises the agent tabs of its previous life', async () => {
  const chrome = fakeChrome()
  loadBackground(chrome)
  const first = connectBridge(chrome)
  const created = await first.op('tabs.create', { url: 'https://example.com/' })
  chrome.runtime.onConnect.listeners.length = 0
  loadBackground(chrome)
  const second = connectBridge(chrome)
  const attached = await second.op('attach', { tabId: created.result.tabId })
  assert.equal(attached.ok, true)
  const orphans = await second.op('tabs.orphans')
  assert.deepEqual([...orphans.result], [created.result.tabId])
})

test('a closed agent tab stops being an agent tab', async () => {
  const { chrome, op } = await bridge()
  const created = await op('tabs.create', { url: 'https://example.com/' })
  await op('tabs.remove', { tabId: created.result.tabId })
  const answer = await op('attach', { tabId: created.result.tabId })
  assert.equal(answer.ok, false)
  assert.deepEqual([...chrome._sessionStore.agentTabIds], [])
})

test('listing tabs still covers every tab, so the daemon can report them', async () => {
  const { op, user } = await bridge()
  const listed = await op('tabs.list')
  assert.equal(listed.ok, true)
  assert.ok(listed.result.some(t => t.tabId === user.id))
})
