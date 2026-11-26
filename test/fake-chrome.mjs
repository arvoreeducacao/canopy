import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const extensionDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension')

function event() {
  const listeners = []
  return {
    listeners,
    addListener: fn => listeners.push(fn),
    removeListener: fn => {
      const i = listeners.indexOf(fn)
      if (i >= 0) listeners.splice(i, 1)
    },
    fire: (...args) => listeners.map(fn => fn(...args))
  }
}

export function fakePort(name) {
  const sent = []
  const port = {
    name,
    sent,
    onMessage: event(),
    onDisconnect: event(),
    postMessage: msg => sent.push(msg),
    disconnect: () => {}
  }
  return port
}

export function fakeChrome() {
  let nextTabId = 100
  const tabs = new Map()
  const sessionStore = {}
  const localStore = {}
  const debuggee = new Set()
  const calls = { attach: [], sendCommand: [], offscreen: 0 }
  let offscreenOpen = false

  const chrome = {
    calls,
    tabs: {
      create: async ({ url }) => {
        const tab = { id: nextTabId++, url, title: '', active: false, windowId: 1, groupId: -1 }
        tabs.set(tab.id, tab)
        return tab
      },
      get: async id => {
        if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`)
        return tabs.get(id)
      },
      remove: async id => { tabs.delete(id) },
      update: async () => ({}),
      query: async () => [...tabs.values()],
      group: async () => 1,
      onActivated: event(),
      onRemoved: event()
    },
    tabGroups: { query: async () => [], update: async () => ({}) },
    windows: { update: async () => ({}) },
    debugger: {
      attach: async ({ tabId }) => {
        calls.attach.push(tabId)
        debuggee.add(tabId)
      },
      sendCommand: async ({ tabId }, method) => {
        calls.sendCommand.push({ tabId, method })
        if (!debuggee.has(tabId)) throw new Error('Debugger is not attached to the tab with id: ' + tabId + '.')
        return {}
      },
      onEvent: event(),
      onDetach: event()
    },
    storage: {
      session: {
        get: async key => (key in sessionStore ? { [key]: sessionStore[key] } : {}),
        set: async obj => { Object.assign(sessionStore, obj) }
      },
      local: {
        get: async key => (key in localStore ? { [key]: localStore[key] } : {}),
        set: async obj => { Object.assign(localStore, obj) }
      },
      onChanged: event()
    },
    action: {
      badge: { text: '', title: '' },
      setBadgeText: ({ text }) => { chrome.action.badge.text = text },
      setBadgeBackgroundColor: () => {},
      setTitle: ({ title }) => { chrome.action.badge.title = title },
      onClicked: event()
    },
    offscreen: {
      hasDocument: async () => offscreenOpen,
      createDocument: async () => {
        calls.offscreen++
        offscreenOpen = true
      }
    },
    alarms: { create: () => {}, onAlarm: event() },
    runtime: {
      onConnect: event(),
      onMessage: event(),
      onStartup: event(),
      onInstalled: event(),
      sendMessage: async () => {},
      openOptionsPage: () => {},
      getContexts: async () => (offscreenOpen ? [{}] : [])
    },
    _tabs: tabs,
    _sessionStore: sessionStore,
    _localStore: localStore
  }
  return chrome
}

export function loadBackground(chrome) {
  const context = vm.createContext({
    chrome,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    navigator: { userAgent: 'Mozilla/5.0 Chrome/140.0.0.0' }
  })
  vm.runInContext(readFileSync(path.join(extensionDir, 'background.js'), 'utf8'), context, { filename: 'background.js' })
  return context
}

export function connectBridge(chrome) {
  const port = fakePort('canopy-bridge')
  chrome.runtime.onConnect.fire(port)
  let seq = 0
  const op = (name, args = {}) => new Promise(resolve => {
    const id = ++seq
    const before = port.sent.length
    port.onMessage.fire({ t: 'op', id, op: name, args })
    const poll = () => {
      const found = port.sent.slice(before).find(m => m.t === 'result' && m.id === id)
      if (found) return resolve(found)
      setTimeout(poll, 1)
    }
    poll()
  })
  return { port, op }
}

export const settle = () => new Promise(resolve => setTimeout(resolve, 5))
