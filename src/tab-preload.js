const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__galhoAgentControl', action => {
  if (action === 'takeover' || action === 'stop') {
    ipcRenderer.send('agent:control', { action })
  }
})
