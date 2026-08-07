// Canopy Bridge — offscreen document.
// Owns the WebSocket to the local Canopy daemon. Chrome recycles MV3 service
// workers after ~30s idle and the socket dies with them; an offscreen document
// has no idle lifetime, so the bridge stays up between commands. It cannot
// touch chrome.tabs or chrome.debugger (chrome.runtime is the only API offscreen
// documents get), so every command is handed to the service worker over a
// long-lived port and the reply is sent back to the daemon here.

const DAEMON = 'ws://127.0.0.1:4664/ext'
const RETRY_MS = [500, 1000, 2000, 5000, 10000]

let ws = null
let workerPort = null
let retry = 0
let reconnectTimer = null
let seq = 0
const waiting = new Map()

function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// Each side signs a different string. Sharing one would let anything talk the
// daemon into producing the proof it then asks for, and attach without knowing
// the secret; the role prefix is what stops that. Both nonces go in so a proof
// belongs to the exchange that produced it.
async function proof(secret, role, clientNonce, serverNonce) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${role}|${clientNonce}|${serverNonce}`)))
}

function port() {
  if (workerPort) return workerPort
  workerPort = chrome.runtime.connect({ name: 'canopy-bridge' })
  workerPort.onMessage.addListener(msg => {
    if (msg.t === 'event') return toDaemon(msg.payload)
    if (msg.t === 'repair') { dropSocket(); return connect() }
    if (msg.t !== 'result') return
    const settle = waiting.get(msg.id)
    if (settle) {
      waiting.delete(msg.id)
      settle(msg)
    }
  })
  // The worker is allowed to die — it is woken by the next port connect. Anything
  // in flight died with it, so fail those now instead of letting the daemon burn
  // its 30s op timeout.
  workerPort.onDisconnect.addListener(() => {
    workerPort = null
    for (const [, settle] of waiting) settle({ ok: false, error: 'extension worker restarted' })
    waiting.clear()
  })
  return workerPort
}

function ask(message) {
  return new Promise(resolve => {
    const id = ++seq
    waiting.set(id, resolve)
    try {
      port().postMessage({ ...message, id })
    } catch {
      workerPort = null
      waiting.delete(id)
      resolve({ ok: false, error: 'extension worker unreachable' })
    }
  })
}

function tell(message) {
  try {
    port().postMessage(message)
  } catch {
    workerPort = null
  }
}

function toDaemon(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function badge(text, color, title) {
  tell({ t: 'badge', text, color, title })
}

function dropSocket() {
  if (!ws) return
  const dying = ws
  ws = null
  try {
    dying.onclose = null
    dying.close()
  } catch {}
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer)
  const wait = RETRY_MS[Math.min(retry, RETRY_MS.length - 1)]
  retry++
  reconnectTimer = setTimeout(connect, wait)
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  const answer = await ask({ t: 'secret' })
  // A worker that died mid-question is not an unpaired browser — say nothing and
  // try again, or the badge would send the user to the options page for nothing.
  if (!answer.ok) return scheduleReconnect()
  const secret = answer.value
  if (!secret) return badge('!', '#DC2626', 'Canopy Bridge — not paired. Click to enter the pairing code.')
  try {
    ws = new WebSocket(DAEMON)
  } catch {
    return scheduleReconnect()
  }

  // Handshake before anything else: we prove the secret to the daemon and the
  // daemon proves it to us. Until both sides check out, no command is obeyed.
  let paired = false
  let refused = false
  const myNonce = hex(crypto.getRandomValues(new Uint8Array(16)))
  ws.onopen = () => toDaemon({ event: 'auth', nonce: myNonce })
  ws.onclose = () => {
    ws = null
    if (refused) return
    badge('', null, 'Canopy Bridge — disconnected')
    scheduleReconnect()
  }
  ws.onerror = () => {}
  ws.onmessage = async e => {
    let msg
    try {
      msg = JSON.parse(e.data)
    } catch {
      return
    }

    if (!paired) {
      if (msg.event !== 'auth' || typeof msg.nonce !== 'string'
          || msg.proof !== await proof(secret, 'daemon', myNonce, msg.nonce)) {
        // Something is answering on 4664 that does not know the secret. Do not
        // talk to it — it would be handing it this browser's debugger.
        refused = true
        badge('!', '#DC2626', 'Canopy Bridge — daemon failed the pairing check. Wrong code, or another process holds port 4664.')
        dropSocket()
        // Keep retrying, slowly: the squatter may go away and the real daemon
        // come back, and nothing is handed over until it proves the secret.
        retry = RETRY_MS.length
        scheduleReconnect()
        return
      }
      paired = true
      retry = 0
      const orphans = await ask({ t: 'op', op: 'tabs.orphans', args: {} })
      toDaemon({
        event: 'hello',
        proof: await proof(secret, 'extension', myNonce, msg.nonce),
        browser: navigator.userAgent.match(/(Chrome\/[\d.]+)/)?.[1] || 'chromium',
        orphans: orphans.ok ? orphans.result : []
      })
      badge('on', '#F59E0B', 'Canopy Bridge — connected')
      return
    }

    // Answered here rather than in the worker: the daemon only wants proof the
    // bridge is alive, and waking the worker every 20s for it would be the
    // churn this document exists to stop.
    if (msg.event === 'ping') return toDaemon({ event: 'pong' })

    const res = await ask({ t: 'op', op: msg.op, args: msg })
    toDaemon(res.ok ? { id: msg.id, ok: true, result: res.result } : { id: msg.id, ok: false, error: res.error })
  }
}

// A fresh service worker has no port until we open one, and it cannot open one
// itself — it asks here when it has an event to deliver.
chrome.runtime.onMessage.addListener(msg => {
  if (msg && msg.t === 'wake') port()
})

connect()
