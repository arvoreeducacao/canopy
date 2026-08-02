// Canopy Bridge — MV3 service worker.
// Keeps a WebSocket to the local Canopy daemon and executes its commands:
// tab lifecycle via chrome.tabs, CDP via chrome.debugger (no --remote-debugging-port
// needed, so this works in Arc). Forwards debugger events and human-focus signals back.

const DAEMON = 'ws://127.0.0.1:4664/ext'
let ws = null
const attached = new Set()
const agentTabs = new Set()

// Pairing secret, shared with the daemon (~/.canopy/ext-secret, shown by
// `canopy pair`) and pasted into the options page once. It is what stops any
// unprivileged local process that grabs port 4664 — squatting it before Canopy
// starts, or in a restart window — from driving chrome.debugger over every tab
// in this browser. Never sent on the wire: both sides prove it over a nonce.
async function pairingSecret() {
  const { canopySecret = '' } = await chrome.storage.local.get('canopySecret')
  return canopySecret.trim()
}

function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function proof(secret, nonce) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(String(nonce))))
}

function badge(text, color, title) {
  chrome.action.setBadgeText({ text })
  if (color) chrome.action.setBadgeBackgroundColor({ color })
  chrome.action.setTitle({ title: title || 'Canopy Bridge' })
}

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

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  const secret = await pairingSecret()
  if (!secret) return badge('!', '#DC2626', 'Canopy Bridge — not paired. Click to enter the pairing code.')
  try { ws = new WebSocket(DAEMON) } catch { return }

  // Handshake before anything else: we prove the secret to the daemon and the
  // daemon proves it to us. Until both sides check out, no command is obeyed.
  let paired = false
  let refused = false
  const myNonce = hex(crypto.getRandomValues(new Uint8Array(16)))
  ws.onopen = () => send({ event: 'auth', nonce: myNonce })
  ws.onclose = () => {
    ws = null
    // Keep the warning up: the alarm retries every ~24s, and a plain
    // "disconnected" would hide the fact that something failed the check.
    if (!refused) badge('', null, 'Canopy Bridge — disconnected')
  }
  ws.onerror = () => {}
  ws.onmessage = async e => {
    let msg
    try { msg = JSON.parse(e.data) } catch { return }

    if (!paired) {
      if (msg.event !== 'auth' || msg.proof !== await proof(secret, myNonce)) {
        // Something is answering on 4664 that does not know the secret. Do not
        // talk to it — it would be handing it this browser's debugger.
        refused = true
        badge('!', '#DC2626', 'Canopy Bridge — daemon failed the pairing check. Wrong code, or another process holds port 4664.')
        try { ws.close() } catch {}
        ws = null
        return
      }
      paired = true
      const orphans = await liveAgentTabs().catch(() => [])
      send({
        event: 'hello',
        proof: await proof(secret, msg.nonce),
        browser: navigator.userAgent.match(/(Chrome\/[\d.]+)/)?.[1] || 'chromium',
        orphans
      })
      badge('on', '#F59E0B', 'Canopy Bridge — connected')
      return
    }

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
chrome.action.onClicked.addListener(async () => {
  if (!await pairingSecret()) return chrome.runtime.openOptionsPage()
  connect()
})
// Pasting a new code in the options page re-pairs without a browser restart.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.canopySecret) {
    if (ws) { try { ws.close() } catch {} ; ws = null }
    connect()
  }
})
connect()
