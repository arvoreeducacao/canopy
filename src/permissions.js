const { t } = require('./i18n')

const AUTO_ALLOW = ['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock']
const AUTO_DENY = ['openExternal', 'hid', 'serial', 'usb', 'midiSysex', 'window-management', 'idle-detection', 'storage-access', 'top-level-storage-access']
const PROMPTED = ['media', 'display-capture', 'geolocation', 'notifications', 'clipboard-read']

function originOf(url) {
  try {
    const u = new URL(url)
    if (u.protocol === 'file:') return 'file://'
    return u.origin
  } catch {
    return null
  }
}

function labelFor(permission, details) {
  if (permission === 'media') {
    const types = (details && details.mediaTypes) || []
    if (types.includes('video') && types.includes('audio')) return t('permCameraMic')
    if (types.includes('video')) return t('permCamera')
    if (types.includes('audio')) return t('permMic')
    return t('permCameraMic')
  }
  return t('perm_' + permission) || permission
}

function keyFor(permission, details) {
  if (permission === 'media') {
    const types = (details && details.mediaTypes) || []
    return types.includes('video') ? 'camera' : 'microphone'
  }
  return permission
}

function glyphFor(permission, details) {
  if (permission === 'media') {
    const types = (details && details.mediaTypes) || []
    return types.includes('video') ? 'camera' : 'microphone'
  }
  if (permission === 'display-capture') return 'screen'
  if (permission === 'geolocation') return 'location'
  if (permission === 'clipboard-read') return 'clipboard'
  return 'notifications'
}

function install(session, store, prompt) {
  const decisions = store.get()
  const pending = new Set()

  const decisionFor = (origin, key) => {
    const forOrigin = decisions[origin]
    return forOrigin ? forOrigin[key] : undefined
  }

  const remember = (origin, key, granted) => {
    if (!decisions[origin]) decisions[origin] = {}
    decisions[origin][key] = granted
    store.save()
  }

  session.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (AUTO_ALLOW.includes(permission)) return true
    if (AUTO_DENY.includes(permission)) return false
    const origin = originOf(requestingOrigin || '')
    if (!origin) return false
    const key = permission === 'media' ? 'camera' : permission
    const direct = decisionFor(origin, key)
    if (direct !== undefined) return direct
    if (permission === 'media') return decisionFor(origin, 'microphone') === true
    return false
  })

  session.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    if (process.env.GALHO_PERM_DEBUG) console.error('permission request:', permission, (details && details.requestingUrl) || '')
    if (AUTO_ALLOW.includes(permission)) return callback(true)
    if (AUTO_DENY.includes(permission)) return callback(false)
    if (!PROMPTED.includes(permission)) return callback(false)

    const origin = originOf((details && details.requestingUrl) || (wc && wc.getURL()) || '')
    if (!origin) return callback(false)

    const key = keyFor(permission, details)
    const saved = decisionFor(origin, key)
    if (saved !== undefined) return callback(saved)

    const gate = origin + ':' + key
    if (pending.has(gate)) return callback(false)
    pending.add(gate)

    const granted = await prompt({
      host: origin.replace(/^https?:\/\//, ''),
      what: t('permWants', labelFor(permission, details)),
      glyph: glyphFor(permission, details)
    })

    pending.delete(gate)
    remember(origin, key, granted)
    callback(granted)
  })
}

module.exports = { install }
