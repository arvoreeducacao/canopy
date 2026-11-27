import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { test, after } from 'node:test'
import { WebSocketServer } from 'ws'
import { startDaemon } from '../src/daemon.js'
import {
  encodeNativeMessage,
  installNativeHost,
  maxHostMessageBytes,
  nativeHostName,
  nativeMessageReader,
  readPairingSecret,
  runNativeHost,
  storeExtensionIds,
  uninstallNativeHost
} from '../src/native-host.js'

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'canopy.js')
const scratch = []
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-native-'))
  scratch.push(dir)
  return dir
}

const dataDir = tempDir()
const { server } = await startDaemon({ port: 0, bind: '127.0.0.1', dataDir })
const PORT = server.address().port
const token = fs.readFileSync(path.join(dataDir, 'token'), 'utf8').trim()
const daemonUrl = `ws://127.0.0.1:${PORT}/ext`
const api = p => fetch(`http://127.0.0.1:${PORT}${p}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())

after(() => {
  server.close()
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true })
})

async function until(check, ms = 4000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out')
}

function extensionSide() {
  const hostInput = new PassThrough()
  const hostOutput = new PassThrough()
  const received = []
  hostOutput.on('data', nativeMessageReader(m => received.push(m)))
  return { hostInput, hostOutput, received, send: m => hostInput.write(encodeNativeMessage(m)) }
}

function startHost(ext, options) {
  const state = { exited: false }
  const host = runNativeHost({ input: ext.hostInput, output: ext.hostOutput, onExit: () => { state.exited = true }, ...options })
  return { ...host, state }
}

const proof = (secret, role, clientNonce, serverNonce) =>
  crypto.createHmac('sha256', secret).update(`${role}|${clientNonce}|${serverNonce}`).digest('hex')

function fakeDaemon(secret, port = 0) {
  return new Promise(resolve => {
    const wss = new WebSocketServer({ port, host: '127.0.0.1' }, () => resolve(state))
    const state = { wss, hello: null, helloValid: null, socket: null, received: [] }
    wss.on('connection', ws => {
      state.socket = ws
      const nonce = crypto.randomBytes(16).toString('hex')
      let clientNonce = null
      ws.on('message', raw => {
        const msg = JSON.parse(raw)
        if (!clientNonce) {
          clientNonce = msg.nonce
          ws.send(JSON.stringify({ event: 'auth', nonce, proof: proof(secret, 'daemon', clientNonce, nonce) }))
          return
        }
        if (!state.hello) {
          state.hello = msg
          state.helloValid = msg.proof === proof(secret, 'extension', clientNonce, nonce)
          return
        }
        state.received.push(msg)
      })
    })
  })
}

test('native messages survive being split and batched', () => {
  const got = []
  const read = nativeMessageReader(m => got.push(m))
  const first = encodeNativeMessage({ a: 1, text: '\u00e9t\u00e9 \u2728' })
  const second = encodeNativeMessage({ b: 2 })
  assert.equal(first.readUInt32LE(0), first.length - 4)
  const both = Buffer.concat([first, second])
  read(both.subarray(0, 3))
  read(both.subarray(3, 9))
  read(both.subarray(9))
  assert.deepEqual(got, [{ a: 1, text: '\u00e9t\u00e9 \u2728' }, { b: 2 }])
})

test('the host pairs the extension with the real daemon, no pairing code typed', async () => {
  const ext = extensionSide()
  const host = startHost(ext, { daemonUrl, secret: () => readPairingSecret(dataDir), version: 'test' })
  try {
    await until(() => ext.received.find(m => m.host === 'hello'))
    assert.deepEqual(ext.received[0], { host: 'ready', version: 'test' })
    ext.send({ t: 'hello', browser: 'Chrome/140.0.0.0', orphans: [] })
    await until(() => ext.received.find(m => m.host === 'status' && m.state === 'connected'))
    const status = await until(async () => {
      const s = await api('/status')
      return s.connected && s
    })
    assert.match(String(status.browser), /Chrome\/140/)
  } finally {
    ext.hostInput.end()
    await until(() => host.state.exited)
  }
  await until(async () => !(await api('/status')).connected)
})

test('the host never pairs with a daemon that cannot prove the secret', async () => {
  const squatter = await fakeDaemon(crypto.randomBytes(16).toString('hex'))
  const ext = extensionSide()
  const host = startHost(ext, { daemonUrl: `ws://127.0.0.1:${squatter.wss.address().port}/ext`, secret: 'the-real-pairing-secret', retryMs: [50] })
  try {
    await until(() => ext.received.find(m => m.host === 'status' && m.state === 'refused'))
    assert.equal(ext.received.some(m => m.host === 'hello'), false)
    assert.equal(squatter.hello, null)
  } finally {
    host.shutdown()
    squatter.wss.close()
  }
})

test('the host proves the secret to the daemon and relays commands, events and pings', async () => {
  const secret = crypto.randomBytes(16).toString('hex')
  const daemon = await fakeDaemon(secret)
  const ext = extensionSide()
  const host = startHost(ext, { daemonUrl: `ws://127.0.0.1:${daemon.wss.address().port}/ext`, secret })
  try {
    await until(() => ext.received.find(m => m.host === 'hello'))
    ext.send({ event: 'tab.removed', tabId: 1 })
    ext.send({ t: 'hello', browser: 'Chrome/140.0.0.0', orphans: [3] })
    await until(() => daemon.hello)
    assert.equal(daemon.hello.event, 'hello')
    assert.equal(daemon.helloValid, true)
    assert.deepEqual(daemon.hello.orphans, [3])

    daemon.socket.send(JSON.stringify({ id: 8, op: 'tabs.list' }))
    const op = await until(() => ext.received.find(m => m.id === 8))
    assert.deepEqual(op, { id: 8, op: 'tabs.list' })
    ext.send({ id: 8, ok: true, result: [{ tabId: 3 }] })
    assert.deepEqual(await until(() => daemon.received.find(m => m.id === 8)), { id: 8, ok: true, result: [{ tabId: 3 }] })

    daemon.socket.send(JSON.stringify({ event: 'ping' }))
    await until(() => ext.received.find(m => m.event === 'ping'))
    ext.send({ event: 'pong' })
    ext.send({ event: 'tab.removed', tabId: 3 })
    await until(() => daemon.received.find(m => m.event === 'tab.removed' && m.tabId === 3))
    assert.ok(daemon.received.some(m => m.event === 'pong'))

    daemon.socket.send(JSON.stringify({ id: 9, op: 'cdp', tabId: 3, method: 'Runtime.evaluate', params: { expression: 'x'.repeat(maxHostMessageBytes) } }))
    const refused = await until(() => daemon.received.find(m => m.id === 9))
    assert.equal(refused.ok, false)
    assert.match(refused.error, /too large/)
    assert.equal(ext.received.some(m => m.id === 9), false)
  } finally {
    host.shutdown()
    daemon.wss.close()
  }
})

test('the host waits for a daemon that is not running yet', async () => {
  const probe = net.createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const secret = crypto.randomBytes(16).toString('hex')
  const ext = extensionSide()
  const host = startHost(ext, { daemonUrl: `ws://127.0.0.1:${port}/ext`, secret, retryMs: [20] })
  try {
    await until(() => ext.received.find(m => m.host === 'status' && m.state === 'down'))
    const daemon = await fakeDaemon(secret, port)
    try {
      await until(() => ext.received.find(m => m.host === 'hello'))
    } finally {
      daemon.wss.close()
    }
  } finally {
    host.shutdown()
  }
})

test('canopy native-host speaks only native messages on stdout', { skip: process.platform === 'win32' }, async () => {
  const child = spawn(process.execPath, [cli, 'native-host', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/'], {
    env: { ...process.env, CANOPY_PORT: String(PORT), CANOPY_DATA_DIR: dataDir },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const received = []
  child.stdout.on('data', nativeMessageReader(m => received.push(m)))
  try {
    await until(() => received.find(m => m.host === 'hello'))
    assert.equal(received[0].host, 'ready')
    child.stdin.write(encodeNativeMessage({ t: 'hello', browser: 'Chrome/140.0.0.0', orphans: [] }))
    await until(() => received.find(m => m.host === 'status' && m.state === 'connected'))
  } finally {
    child.stdin.end()
  }
  const code = await new Promise(resolve => child.on('exit', resolve))
  assert.equal(code, 0)
  await until(async () => !(await api('/status')).connected)
})

const someId = 'abcdefghijklmnopabcdefghijklmnop'
const otherId = 'ponmlkjihgfedcbaponmlkjihgfedcba'
const origins = ids => [...new Set([...storeExtensionIds, ...ids])].map(id => `chrome-extension://${id}/`)
const readManifest = file => JSON.parse(fs.readFileSync(file, 'utf8'))

test('the host is registered only in the browsers installed on the machine', () => {
  const home = tempDir()
  fs.mkdirSync(path.join(home, '.config', 'google-chrome'), { recursive: true })
  fs.mkdirSync(path.join(home, '.config', 'BraveSoftware', 'Brave-Browser'), { recursive: true })
  const result = installNativeHost({ extensionIds: [someId], platform: 'linux', home, env: {}, nodePath: '/usr/bin/node', cliPath: '/opt/canopy/bin/canopy.js' })
  assert.deepEqual(result.browsers, ['Google Chrome', 'Brave'])
  const manifest = readManifest(path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts', `${nativeHostName}.json`))
  assert.equal(manifest.name, nativeHostName)
  assert.equal(manifest.type, 'stdio')
  assert.deepEqual(manifest.allowed_origins, origins([someId]))
  assert.equal(manifest.path, path.join(home, '.canopy', 'native-host', 'canopy-native-host'))
  assert.equal(fs.existsSync(path.join(home, '.config', 'chromium')), false)
  assert.equal(fs.readFileSync(manifest.path, 'utf8'), `#!/bin/sh\nexec '/usr/bin/node' '/opt/canopy/bin/canopy.js' native-host "$@"\n`)
  assert.equal(fs.statSync(manifest.path).mode & 0o111, 0o111)
})

test('a later run keeps the extension ids allowed before', () => {
  const home = tempDir()
  fs.mkdirSync(path.join(home, '.config', 'chromium'), { recursive: true })
  const base = { platform: 'linux', home, env: {}, cliPath: '/opt/canopy/bin/canopy.js' }
  installNativeHost({ ...base, extensionIds: [someId] })
  installNativeHost({ ...base, extensionIds: [] })
  const file = path.join(home, '.config', 'chromium', 'NativeMessagingHosts', `${nativeHostName}.json`)
  assert.deepEqual(readManifest(file).allowed_origins, origins([someId]))
  installNativeHost({ ...base, extensionIds: [otherId] })
  assert.deepEqual(readManifest(file).allowed_origins, origins([someId, otherId]))
})

test('nothing is registered while no extension id is known', { skip: storeExtensionIds.length > 0 }, () => {
  const home = tempDir()
  fs.mkdirSync(path.join(home, '.config', 'google-chrome'), { recursive: true })
  const result = installNativeHost({ platform: 'linux', home, env: {}, cliPath: '/opt/canopy/bin/canopy.js' })
  assert.equal(result.installed, false)
  assert.equal(fs.existsSync(path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts')), false)
  assert.equal(fs.existsSync(path.join(home, '.canopy')), false)
})

test('an extension id Chrome could not have issued is refused', () => {
  assert.throws(() => installNativeHost({ extensionIds: ['../../etc'], platform: 'linux', home: tempDir(), env: {}, cliPath: '/x' }), /not a Chrome extension id/)
})

test('the launcher reaches the daemon on its port and data dir, whatever the path holds', { skip: process.platform === 'win32' }, () => {
  const home = tempDir()
  const odd = path.join(tempDir(), "it's \$HOME \`dir\`")
  fs.mkdirSync(odd, { recursive: true })
  const echo = path.join(odd, 'echo.mjs')
  fs.writeFileSync(echo, 'console.log(JSON.stringify({ port: process.env.CANOPY_PORT, dataDir: process.env.CANOPY_DATA_DIR, args: process.argv.slice(2) }))\n')
  const result = installNativeHost({ extensionIds: [someId], platform: 'linux', home, env: {}, port: 5000, dataDir: odd, cliPath: echo })
  assert.equal(result.launcher, path.join(odd, 'native-host', 'canopy-native-host'))
  const out = JSON.parse(execFileSync(result.launcher, ['chrome-extension://' + someId + '/'], { encoding: 'utf8' }))
  assert.deepEqual(out, { port: '5000', dataDir: odd, args: ['native-host', 'chrome-extension://' + someId + '/'] })
})

test('on macOS the host also reaches Arc', () => {
  const home = tempDir()
  const arc = path.join(home, 'Library', 'Application Support', 'Arc', 'User Data')
  fs.mkdirSync(arc, { recursive: true })
  const result = installNativeHost({ extensionIds: [someId], platform: 'darwin', home, env: {}, cliPath: '/x' })
  assert.deepEqual(result.browsers, ['Arc'])
  assert.ok(fs.existsSync(path.join(arc, 'NativeMessagingHosts', `${nativeHostName}.json`)))
})

test('on Windows the manifest goes in each browser registry key', () => {
  const home = tempDir()
  const calls = []
  const result = installNativeHost({ extensionIds: [someId], platform: 'win32', home, env: {}, nodePath: 'C:\\node\\node.exe', cliPath: 'C:\\canopy\\bin\\canopy.js', runReg: args => calls.push(args) })
  assert.deepEqual(result.browsers, ['Google Chrome', 'Chromium', 'Brave', 'Microsoft Edge'])
  assert.deepEqual(calls[0], ['add', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${nativeHostName}`, '/ve', '/t', 'REG_SZ', '/d', result.manifest, '/f'])
  assert.match(fs.readFileSync(result.launcher, 'utf8'), /^@echo off\r\n"C:\\node\\node\.exe" "C:\\canopy\\bin\\canopy\.js" native-host %\*\r\n$/)
  const removed = []
  uninstallNativeHost({ platform: 'win32', home, env: {}, runReg: args => removed.push(args) })
  assert.equal(removed.length, 4)
  assert.equal(removed[0][0], 'delete')
})

test('uninstalling removes the host from every browser', () => {
  const home = tempDir()
  fs.mkdirSync(path.join(home, '.config', 'google-chrome'), { recursive: true })
  fs.mkdirSync(path.join(home, '.config', 'microsoft-edge'), { recursive: true })
  installNativeHost({ extensionIds: [someId], platform: 'linux', home, env: {}, cliPath: '/x' })
  const { browsers } = uninstallNativeHost({ platform: 'linux', home, env: {} })
  assert.deepEqual(browsers, ['Google Chrome', 'Microsoft Edge'])
  assert.equal(fs.existsSync(path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts', `${nativeHostName}.json`)), false)
  assert.equal(fs.existsSync(path.join(home, '.canopy', 'native-host')), false)
})
