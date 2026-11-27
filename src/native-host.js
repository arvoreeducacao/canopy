import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { WebSocket } from 'ws'

export const nativeHostName = 'com.arvoretech.canopy'
export const storeExtensionIds = []
export const maxHostMessageBytes = 1024 * 1024

const defaultRetryMs = [500, 1000, 2000, 5000, 10000]
const extensionIdPattern = /^[a-p]{32}$/

export function encodeNativeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

export function nativeMessageReader(onMessage) {
  let buffered = Buffer.alloc(0)
  return chunk => {
    buffered = Buffer.concat([buffered, chunk])
    while (buffered.length >= 4) {
      const length = buffered.readUInt32LE(0)
      if (buffered.length < 4 + length) return
      const body = buffered.subarray(4, 4 + length)
      buffered = buffered.subarray(4 + length)
      let message
      try {
        message = JSON.parse(body.toString('utf8'))
      } catch {
        continue
      }
      onMessage(message)
    }
  }
}

function readExistingSecret(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

export function readPairingSecret(dataDir) {
  const file = path.join(dataDir || path.join(os.homedir(), '.canopy'), 'ext-secret')
  const existing = readExistingSecret(file)
  if (existing) return existing
  const minted = crypto.randomBytes(16).toString('hex')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    fs.writeFileSync(file, minted + '\n', { mode: 0o600, flag: 'wx' })
    return minted
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
    return readExistingSecret(file)
  }
}

const pairingProof = (secret, role, clientNonce, serverNonce) =>
  crypto.createHmac('sha256', secret).update(`${role}|${clientNonce}|${serverNonce}`).digest('hex')

function sameProof(value, expected) {
  if (typeof value !== 'string') return false
  const a = Buffer.from(value)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export function runNativeHost({
  input = process.stdin,
  output = process.stdout,
  daemonUrl,
  secret,
  version = '',
  retryMs = defaultRetryMs,
  onExit = () => process.exit(0)
}) {
  let socket = null
  let paired = false
  let handshake = null
  let attempt = 0
  let timer = null
  let closed = false
  let reported = null

  const toExtension = message => {
    const frame = encodeNativeMessage(message)
    if (frame.length - 4 > maxHostMessageBytes) {
      if (message.id !== undefined) toDaemon({ id: message.id, ok: false, error: 'command too large for the native messaging bridge' })
      return
    }
    output.write(frame)
  }
  const toDaemon = message => {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }
  const report = state => {
    if (reported === state) return
    reported = state
    toExtension({ host: 'status', state })
  }
  const schedule = slow => {
    if (closed) return
    clearTimeout(timer)
    const wait = slow ? retryMs[retryMs.length - 1] : retryMs[Math.min(attempt, retryMs.length - 1)]
    attempt++
    timer = setTimeout(connect, wait)
  }

  function connect() {
    if (closed) return
    let currentSecret
    try {
      currentSecret = typeof secret === 'function' ? secret() : secret
    } catch {
      report('down')
      return schedule(false)
    }
    const ws = new WebSocket(daemonUrl)
    const myNonce = crypto.randomBytes(16).toString('hex')
    let refused = false
    socket = ws
    paired = false
    handshake = null
    ws.on('open', () => ws.send(JSON.stringify({ event: 'auth', nonce: myNonce })))
    ws.on('error', () => {})
    ws.on('close', () => {
      if (socket !== ws) return
      socket = null
      paired = false
      handshake = null
      if (closed) return
      if (!refused) report('down')
      schedule(refused)
    })
    ws.on('message', raw => {
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      if (paired) return toExtension(msg)
      if (handshake) return
      if (msg.event !== 'auth' || typeof msg.nonce !== 'string' || !sameProof(msg.proof, pairingProof(currentSecret, 'daemon', myNonce, msg.nonce))) {
        refused = true
        report('refused')
        try { ws.close() } catch {}
        return
      }
      handshake = { ws, proof: pairingProof(currentSecret, 'extension', myNonce, msg.nonce) }
      toExtension({ host: 'hello' })
    })
  }

  const fromExtension = msg => {
    if (msg && msg.t === 'hello') {
      if (!handshake || handshake.ws !== socket) return
      toDaemon({ event: 'hello', proof: handshake.proof, browser: msg.browser, orphans: Array.isArray(msg.orphans) ? msg.orphans : [] })
      handshake = null
      paired = true
      attempt = 0
      report('connected')
      return
    }
    if (paired) toDaemon(msg)
  }

  const shutdown = () => {
    if (closed) return
    closed = true
    clearTimeout(timer)
    if (socket) {
      try { socket.close() } catch {}
    }
    onExit()
  }

  input.on('data', nativeMessageReader(fromExtension))
  input.on('end', shutdown)
  input.on('error', shutdown)
  output.on?.('error', shutdown)
  toExtension({ host: 'ready', version })
  connect()
  return { shutdown }
}

function browserTargets(platform, home, env) {
  if (platform === 'linux') {
    const config = env.XDG_CONFIG_HOME || path.join(home, '.config')
    return [
      ['Google Chrome', 'google-chrome'],
      ['Google Chrome Beta', 'google-chrome-beta'],
      ['Google Chrome Dev', 'google-chrome-unstable'],
      ['Chromium', 'chromium'],
      ['Brave', path.join('BraveSoftware', 'Brave-Browser')],
      ['Microsoft Edge', 'microsoft-edge'],
      ['Vivaldi', 'vivaldi']
    ].map(([name, dir]) => ({ name, root: path.join(config, dir) }))
  }
  if (platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support')
    return [
      ['Google Chrome', path.join('Google', 'Chrome')],
      ['Google Chrome Beta', path.join('Google', 'Chrome Beta')],
      ['Google Chrome Canary', path.join('Google', 'Chrome Canary')],
      ['Chromium', 'Chromium'],
      ['Brave', path.join('BraveSoftware', 'Brave-Browser')],
      ['Microsoft Edge', 'Microsoft Edge'],
      ['Arc', path.join('Arc', 'User Data')],
      ['Vivaldi', 'Vivaldi']
    ].map(([name, dir]) => ({ name, root: path.join(support, dir) }))
  }
  return []
}

const windowsRegistryKeys = [
  ['Google Chrome', 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts'],
  ['Chromium', 'HKCU\\Software\\Chromium\\NativeMessagingHosts'],
  ['Brave', 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts'],
  ['Microsoft Edge', 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts']
]

const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`

function batchValue(value) {
  const text = String(value)
  if (/["\r\n]/.test(text)) throw new Error(`a Windows launcher cannot hold ${JSON.stringify(text)}`)
  return text.replace(/%/g, '%%')
}

function launcherScript({ platform, nodePath, cliPath, port, dataDir }) {
  if (platform === 'win32') {
    const lines = ['@echo off']
    if (port) lines.push(`set "CANOPY_PORT=${batchValue(port)}"`)
    if (dataDir) lines.push(`set "CANOPY_DATA_DIR=${batchValue(dataDir)}"`)
    lines.push(`"${batchValue(nodePath)}" "${batchValue(cliPath)}" native-host %*`)
    return lines.join('\r\n') + '\r\n'
  }
  const env = []
  if (port) env.push(`CANOPY_PORT=${shellQuote(port)}`)
  if (dataDir) env.push(`CANOPY_DATA_DIR=${shellQuote(dataDir)}`)
  return `#!/bin/sh\n${env.length ? env.join(' ') + ' ' : ''}exec ${shellQuote(nodePath)} ${shellQuote(cliPath)} native-host "$@"\n`
}

function readInstalledIds(manifestPath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    return (manifest.allowed_origins || [])
      .map(origin => /^chrome-extension:\/\/([a-p]{32})\/$/.exec(origin)?.[1])
      .filter(Boolean)
  } catch {
    return []
  }
}

function hostPaths({ platform, home, dataDir }) {
  const dir = path.join(dataDir || path.join(home, '.canopy'), 'native-host')
  return {
    dir,
    launcher: path.join(dir, platform === 'win32' ? 'canopy-native-host.bat' : 'canopy-native-host'),
    manifest: path.join(dir, `${nativeHostName}.json`)
  }
}

export function installNativeHost({
  extensionIds = [],
  platform = process.platform,
  home = os.homedir(),
  env = process.env,
  dataDir,
  port,
  nodePath = process.execPath,
  cliPath,
  runReg = args => execFileSync('reg', args, { stdio: 'ignore' })
} = {}) {
  const invalid = extensionIds.filter(id => !extensionIdPattern.test(id))
  if (invalid.length) throw new Error(`not a Chrome extension id: ${invalid.join(', ')}`)
  if (!cliPath) throw new Error('cliPath is required')
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new Error(`not a TCP port: ${port}`)
  const paths = hostPaths({ platform, home, dataDir })
  const ids = [...new Set([...storeExtensionIds, ...readInstalledIds(paths.manifest), ...extensionIds])]
  if (!ids.length) return { installed: false, browsers: [], extensionIds: [] }

  const manifest = {
    name: nativeHostName,
    description: 'Canopy Bridge: connects the browser extension to the local Canopy daemon',
    path: paths.launcher,
    type: 'stdio',
    allowed_origins: ids.map(id => `chrome-extension://${id}/`)
  }
  const body = JSON.stringify(manifest, null, 2) + '\n'
  const launcher = launcherScript({ platform, nodePath, cliPath, port, dataDir })
  fs.mkdirSync(paths.dir, { recursive: true })
  fs.writeFileSync(paths.launcher, launcher, { mode: 0o755 })
  fs.chmodSync(paths.launcher, 0o755)
  fs.writeFileSync(paths.manifest, body)

  const browsers = []
  if (platform === 'win32') {
    for (const [name, key] of windowsRegistryKeys) {
      try {
        runReg(['add', `${key}\\${nativeHostName}`, '/ve', '/t', 'REG_SZ', '/d', paths.manifest, '/f'])
        browsers.push(name)
      } catch {}
    }
  } else {
    for (const { name, root } of browserTargets(platform, home, env)) {
      if (!fs.existsSync(root)) continue
      const dir = path.join(root, 'NativeMessagingHosts')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `${nativeHostName}.json`), body)
      browsers.push(name)
    }
  }
  return { installed: true, browsers, extensionIds: ids, launcher: paths.launcher, manifest: paths.manifest }
}

export function uninstallNativeHost({
  platform = process.platform,
  home = os.homedir(),
  env = process.env,
  dataDir,
  runReg = args => execFileSync('reg', args, { stdio: 'ignore' })
} = {}) {
  const removed = []
  if (platform === 'win32') {
    for (const [name, key] of windowsRegistryKeys) {
      try {
        runReg(['delete', `${key}\\${nativeHostName}`, '/f'])
        removed.push(name)
      } catch {}
    }
  } else {
    for (const { name, root } of browserTargets(platform, home, env)) {
      const file = path.join(root, 'NativeMessagingHosts', `${nativeHostName}.json`)
      if (!fs.existsSync(file)) continue
      fs.rmSync(file, { force: true })
      removed.push(name)
    }
  }
  fs.rmSync(hostPaths({ platform, home, dataDir }).dir, { recursive: true, force: true })
  return { browsers: removed }
}
