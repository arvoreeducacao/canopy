// Canopy Bridge — MV3 service worker.
// Keeps a WebSocket to the local Canopy daemon and executes its commands:
// tab lifecycle via chrome.tabs, CDP via chrome.debugger (no --remote-debugging-port
// needed, so this works in Arc). Forwards debugger events and human-focus signals back.

const DAEMON = 'ws://127.0.0.1:4664/ext'
let ws = null
const attached = new Set()
const agentTabs = new Set()

// Agent tab ids also live in storage.session: it survives service-worker
// restarts (unlike these Sets) and is cleared when the browser closes — so a
// reconnecting daemon can find tabs a dead daemon left behind and close them.
async function rememberAgentTab(tabId) {
  agentTabs.add(tabId)
  const { agentTabIds = [] } = await chrome.storage.session.get('agentTabIds')
  if (!agentTabIds.includes(tabId)) await chrome.storage.session.set({ agentTabIds: [...agentTabIds, tabId] })
}
async function forgetAgentTab(tabId) {
  agentTabs.delete(tabId)
  attached.delete(tabId)
  const { agentTabIds = [] } = await chrome.storage.session.get('agentTabIds')
  await chrome.storage.session.set({ agentTabIds: agentTabIds.filter(id => id !== tabId) })
}
async function liveAgentTabs() {
  const { agentTabIds = [] } = await chrome.storage.session.get('agentTabIds')
  const alive = []
  for (const id of agentTabIds) {
    try { await chrome.tabs.get(id); alive.push(id) } catch {}
  }
  if (alive.length !== agentTabIds.length) await chrome.storage.session.set({ agentTabIds: alive })
  return alive
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  try { ws = new WebSocket(DAEMON) } catch { return }
  ws.onopen = async () => {
    const orphans = await liveAgentTabs().catch(() => [])
    send({ event: 'hello', browser: navigator.userAgent.match(/(Chrome\/[\d.]+)/)?.[1] || 'chromium', orphans })
    chrome.action.setBadgeText({ text: 'on' })
    chrome.action.setBadgeBackgroundColor({ color: '#F59E0B' })
  }
  ws.onclose = () => {
    ws = null
    chrome.action.setBadgeText({ text: '' })
  }
  ws.onerror = () => {}
  ws.onmessage = async e => {
    let msg
    try { msg = JSON.parse(e.data) } catch { return }
    // Daemon keepalive — receiving it already reset the SW idle timer.
    if (msg.event === 'ping') return
    const reply = payload => send({ id: msg.id, ...payload })
    try {
      if (msg.op === 'cdp') {
        const result = await chrome.debugger.sendCommand({ tabId: msg.tabId }, msg.method, msg.params || {})
        reply({ ok: true, result: result || {} })
      } else if (msg.op === 'attach') {
        if (!attached.has(msg.tabId)) {
          await chrome.debugger.attach({ tabId: msg.tabId }, '1.3')
          attached.add(msg.tabId)
        }
        await rememberAgentTab(msg.tabId)
        reply({ ok: true, result: {} })
      } else if (msg.op === 'tabs.create') {
        const tab = await chrome.tabs.create({ url: msg.url, active: false })
        await rememberAgentTab(tab.id)
        reply({ ok: true, result: { tabId: tab.id } })
      } else if (msg.op === 'tabs.group') {
        // All agent tabs live in one collapsed-friendly amber group ("AI").
        // In Arc the tabs.group/tabGroups promises hang forever — race a
        // short timeout so the daemon always gets a reply.
        const group = (async () => {
          const tab = await chrome.tabs.get(msg.tabId)
          const title = msg.title || 'AI'
          let groupId = null
          try {
            const groups = await chrome.tabGroups.query({ windowId: tab.windowId, title })
            if (groups.length) groupId = groups[0].id
          } catch {}
          if (groupId !== null) {
            await chrome.tabs.group({ tabIds: [msg.tabId], groupId })
          } else {
            groupId = await chrome.tabs.group({ tabIds: [msg.tabId] })
            await chrome.tabGroups.update(groupId, { title, color: 'yellow' })
          }
          return { groupId }
        })()
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('tab groups unsupported (timeout)')), 1500))
        reply({ ok: true, result: await Promise.race([group, timeout]) })
      } else if (msg.op === 'tabs.remove') {
        await forgetAgentTab(msg.tabId)
        await chrome.tabs.remove(msg.tabId).catch(() => {})
        reply({ ok: true, result: {} })
      } else if (msg.op === 'tabs.activate') {
        const tab = await chrome.tabs.get(msg.tabId)
        await chrome.windows.update(tab.windowId, { focused: true })
        await chrome.tabs.update(msg.tabId, { active: true })
        reply({ ok: true, result: {} })
      } else if (msg.op === 'tabs.list') {
        const tabs = await chrome.tabs.query({})
        reply({ ok: true, result: tabs.map(t => ({ tabId: t.id, url: t.url, title: t.title, active: t.active, groupId: t.groupId })) })
      } else {
        reply({ ok: false, error: `unknown op ${msg.op}` })
      }
    } catch (err) {
      reply({ ok: false, error: String(err && err.message || err) })
    }
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId) send({ event: 'cdp', tabId: source.tabId, method, params })
})

chrome.debugger.onDetach.addListener(source => {
  if (source.tabId) {
    attached.delete(source.tabId)
    send({ event: 'debugger.detached', tabId: source.tabId })
  }
})

// Human focused an agent tab -> daemon pauses the agent there.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (agentTabs.has(tabId)) send({ event: 'tab.activated', tabId })
})

chrome.tabs.onRemoved.addListener(tabId => {
  if (agentTabs.has(tabId)) {
    forgetAgentTab(tabId)
    send({ event: 'tab.removed', tabId })
  } else {
    // Even if this worker restarted and lost the in-memory Set, keep storage honest.
    forgetAgentTab(tabId)
  }
})

// MV3 service workers get suspended; an alarm plus event traffic keeps the
// bridge alive and reconnecting.
chrome.alarms.create('canopy-keepalive', { periodInMinutes: 0.4 })
chrome.alarms.onAlarm.addListener(() => connect())
chrome.runtime.onStartup.addListener(() => connect())
chrome.runtime.onInstalled.addListener(() => connect())
chrome.action.onClicked.addListener(() => connect())
connect()
