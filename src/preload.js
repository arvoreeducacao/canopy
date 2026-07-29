const { contextBridge, ipcRenderer } = require('electron')

const SEND_CHANNELS = ['ui', 'palette:run', 'palette:hide', 'find:query', 'find:close']
const INVOKE_CHANNELS = ['palette:query']
const ON_CHANNELS = ['state', 'palette:open', 'space:edit', 'find:open', 'find:result']

contextBridge.exposeInMainWorld('galho', {
  send: (channel, data) => {
    if (SEND_CHANNELS.includes(channel)) ipcRenderer.send(channel, data)
  },
  invoke: (channel, data) => {
    if (INVOKE_CHANNELS.includes(channel)) return ipcRenderer.invoke(channel, data)
    return Promise.resolve(null)
  },
  on: (channel, fn) => {
    if (ON_CHANNELS.includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data))
  }
})
