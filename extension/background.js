// Canopy Bridge — MV3 service worker.
// The daemon socket lives in the offscreen document (offscreen.js), which Chrome
// does not idle out. This worker owns what that document cannot reach —
// chrome.tabs, chrome.debugger, chrome.action, chrome.storage — and is woken on
// demand by the port the offscreen document holds open. It is free to die
// between commands: nothing it keeps in memory is load-bearing.

const attached = new Set()
const outbox = []
let bridge = null
let creating = null

// Pairing secret, shared with the daemon (~/.canopy/ext-secret, shown by
// `canopy pair`) and pasted into the options page once. It is what stops any
// unprivileged local process that grabs port 4664 — squatting it before Canopy
// starts, or in a restart window — from driving chrome.debugger over every tab
// in this browser. Never sent on the wire: both sides prove it over a nonce.
async function pairingSecret() {
  const { canopySecret = '' } = await chrome.storage.local.get('canopySecret')
  return canopySecret.trim()
}

function badge(text, color, title) {
  chrome.action.setBadgeText({ text })
  if (color) chrome.action.setBadgeBackgroundColor({ color })
  chrome.action.setTitle({ title: title || 'Canopy Bridge' })
}

async function hasOffscreen() {
  if (chrome.offscreen?.hasDocument) return chrome.offscreen.hasDocument()
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
  return contexts.length > 0
}

async function ensureOffscreen() {
  if (await hasOffscreen().catch(() => false)) return
  if (creating) return creating
  creating = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'Holds the WebSocket to the local Canopy daemon; a service worker is recycled mid-session and takes the socket with it.'
  }).catch(err => {
    // Two wake-ups can race here; losing the race is the same as winning it.
    if (!/single offscreen document/i.test(String(err && err.message || err))) throw err
  }).finally(() => { creating = null })
  return creating
}

// Agent tab ids live in storage.session: it survives service-worker restarts
// (an in-memory Set does not) and is cleared when the browser closes — so a
// reconnecting daemon can find tabs a dead daemon left behind and close them.
async function agentTabIds() {
  const { agentTabIds = [] } = await chrome.storage.session.get('agentTabIds')
  return agentTabIds
}
async function rememberAgentTab(tabId) {
  const ids = await agentTabIds()
  if (!ids.includes(tabId)) await chrome.storage.session.set({ agentTabIds: [...ids, tabId] })
}
async function forgetAgentTab(tabId) {
  attached.delete(tabId)
  const ids = await agentTabIds()
  await chrome.storage.session.set({ agentTabIds: ids.filter(id => id !== tabId) })
}
async function liveAgentTabs() {
  const ids = await agentTabIds()
  const alive = []
  for (const id of ids) {
    try { await chrome.tabs.get(id); alive.push(id) } catch {}
  }
  if (alive.length !== ids.length) await chrome.storage.session.set({ agentTabIds: alive })
  return alive
}

// A debugger or tab event can wake this worker while the port is still down —
// the offscreen document only reconnects it when it has something to say, and
// it has no way of knowing a new worker just started. Hold the message and ask
// the document to reconnect; onConnect drains what piled up.
function toBridge(msg) {
  if (bridge) {
    try {
      bridge.postMessage(msg)
      return true
    } catch {
      bridge = null
    }
  }
  outbox.push(msg)
  if (outbox.length > 500) outbox.shift()
  chrome.runtime.sendMessage({ t: 'wake' }).catch(() => ensureOffscreen())
  return false
}

function emit(payload) {
  toBridge({ t: 'event', payload })
}

async function runOp(op, a) {
  if (op === 'cdp') {
    const result = await chrome.debugger.sendCommand({ tabId: a.tabId }, a.method, a.params || {})
    return { ok: true, result: result || {} }
  }
  if (op === 'attach') {
    if (!attached.has(a.tabId)) {
      // The debugger session belongs to the extension, not this worker
      // instance — after a SW restart the Set is empty but the tab may
      // still be attached from the previous life.
      try {
        await chrome.debugger.attach({ tabId: a.tabId }, '1.3')
      } catch (err) {
        if (!/already attached/i.test(String(err && err.message || err))) throw err
      }
      attached.add(a.tabId)
    }
    await rememberAgentTab(a.tabId)
    return { ok: true, result: {} }
  }
  if (op === 'tabs.create') {
    const tab = await chrome.tabs.create({ url: a.url, active: false })
    await rememberAgentTab(tab.id)
    return { ok: true, result: { tabId: tab.id } }
  }
  if (op === 'tabs.group') {
    // All agent tabs live in one collapsed-friendly amber group ("AI").
    // In Arc the tabs.group/tabGroups promises hang forever — race a
    // short timeout so the daemon always gets a reply.
    const group = (async () => {
      const tab = await chrome.tabs.get(a.tabId)
      const title = a.title || 'AI'
      let groupId = null
      try {
        const groups = await chrome.tabGroups.query({ windowId: tab.windowId, title })
        if (groups.length) groupId = groups[0].id
      } catch {}
      if (groupId !== null) {
        await chrome.tabs.group({ tabIds: [a.tabId], groupId })
      } else {
        groupId = await chrome.tabs.group({ tabIds: [a.tabId] })
        await chrome.tabGroups.update(groupId, { title, color: 'yellow' })
      }
      return { groupId }
    })()
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('tab groups unsupported (timeout)')), 1500))
    return { ok: true, result: await Promise.race([group, timeout]) }
  }
  if (op === 'tabs.remove') {
    await forgetAgentTab(a.tabId)
    await chrome.tabs.remove(a.tabId).catch(() => {})
    return { ok: true, result: {} }
  }
  if (op === 'tabs.activate') {
    const tab = await chrome.tabs.get(a.tabId)
    await chrome.windows.update(tab.windowId, { focused: true })
    await chrome.tabs.update(a.tabId, { active: true })
    return { ok: true, result: {} }
  }
  if (op === 'tabs.list') {
    const tabs = await chrome.tabs.query({})
    return { ok: true, result: tabs.map(t => ({ tabId: t.id, url: t.url, title: t.title, active: t.active, groupId: t.groupId })) }
  }
  if (op === 'tabs.orphans') {
    return { ok: true, result: await liveAgentTabs().catch(() => []) }
  }
  return { ok: false, error: `unknown op ${op}` }
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'canopy-bridge') return
  bridge = port
  while (outbox.length) {
    try { port.postMessage(outbox.shift()) } catch { break }
  }
  port.onDisconnect.addListener(() => { if (bridge === port) bridge = null })
  port.onMessage.addListener(async msg => {
    const answer = payload => {
      try { port.postMessage({ t: 'result', id: msg.id, ...payload }) } catch {}
    }
    if (msg.t === 'badge') return badge(msg.text, msg.color, msg.title)
    if (msg.t === 'secret') return answer({ ok: true, value: await pairingSecret() })
    if (msg.t !== 'op') return
    try {
      answer(await runOp(msg.op, msg.args || {}))
    } catch (err) {
      answer({ ok: false, error: String(err && err.message || err) })
    }
  })
})

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId) emit({ event: 'cdp', tabId: source.tabId, method, params })
})

chrome.debugger.onDetach.addListener(source => {
  if (source.tabId) {
    attached.delete(source.tabId)
    emit({ event: 'debugger.detached', tabId: source.tabId })
  }
})

// Human focused an agent tab -> daemon pauses the agent there. Read from
// storage rather than memory: this worker is usually a fresh one that never saw
// the tab being opened.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if ((await agentTabIds()).includes(tabId)) emit({ event: 'tab.activated', tabId })
})

chrome.tabs.onRemoved.addListener(async tabId => {
  const wasAgentTab = (await agentTabIds()).includes(tabId)
  await forgetAgentTab(tabId)
  if (wasAgentTab) emit({ event: 'tab.removed', tabId })
})

// Watchdog only. The offscreen document holds the socket and reconnects on its
// own; this is here for the case where the document itself is gone (browser
// startup, a crash, an extension reload).
chrome.alarms.create('canopy-keepalive', { periodInMinutes: 1 })
chrome.alarms.onAlarm.addListener(() => ensureOffscreen())
chrome.runtime.onStartup.addListener(() => ensureOffscreen())
chrome.runtime.onInstalled.addListener(() => ensureOffscreen())
chrome.action.onClicked.addListener(async () => {
  if (!await pairingSecret()) return chrome.runtime.openOptionsPage()
  ensureOffscreen()
})
// Pasting a new code in the options page re-pairs without a browser restart.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.canopySecret) toBridge({ t: 'repair' })
})
ensureOffscreen()
