const { app, BrowserWindow, ipcMain, session, Menu, clipboard } = require('electron')
const path = require('path')
const fs = require('fs')
const Store = require('./state')
const { TabManager, SPACE_COLORS, SPACE_ICONS } = require('./tab-manager')
const PaletteController = require('./palette-controller')
const FindController = require('./find-controller')
const buildMenu = require('./menu')
const { startAgentApi } = require('./agent-api')

const CDP_PORT = process.env.GALHO_CDP_PORT || '9223'
const API_PORT = Number(process.env.GALHO_API_PORT || '9224')

app.setName('Galho')
app.commandLine.appendSwitch('remote-debugging-port', CDP_PORT)
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

const windows = []
let store = null
let sharedHistory = []
let quitting = false

function chromeUserAgent() {
  const major = process.versions.chrome.split('.')[0]
  const platform = process.platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

function migrate(data) {
  if (!data || !Object.keys(data).length) return { history: [], windows: [{}] }
  if (data.windows) return data
  return {
    history: data.history || [],
    windows: [{ sidebarOpen: data.sidebarOpen, activeSpaceId: data.activeSpaceId, spaces: data.spaces }]
  }
}

function serializeAll() {
  return {
    version: 2,
    history: sharedHistory.slice(0, 3000),
    windows: windows.map(e => e.tabs.serialize())
  }
}

function saveAll(flush = false) {
  if (!store || !windows.length) return
  store.save(serializeAll())
  if (flush) store.flush()
}

function entryFor(wc) {
  if (!wc) return windows[0]
  return windows.find(e =>
    e.win.webContents === wc ||
    (e.palette.view && e.palette.view.webContents === wc) ||
    (e.find.view && e.find.view.webContents === wc)
  )
}

function focusedEntry() {
  const focused = BrowserWindow.getFocusedWindow()
  const entry = windows.find(e => e.win === focused)
  return entry || windows[0]
}

function createWindow(winState = {}) {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 900,
    minHeight: 560,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: process.platform === 'darwin' ? '#00000000' : '#1B1B22',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  })

  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'))
  win.once('ready-to-show', () => win.show())

  const entry = { win, tabs: null, palette: null, find: null }
  windows.push(entry)

  const pushState = () => {
    if (win.isDestroyed()) return
    win.webContents.send('state', entry.tabs.uiState())
    saveAll()
  }
  entry.pushState = pushState

  entry.tabs = new TabManager(win, winState, sharedHistory, pushState)
  entry.palette = new PaletteController(win, entry.tabs, {
    find: () => entry.find,
    newWindow: () => createWindow()
  })
  entry.find = new FindController(win, entry.tabs)

  win.on('resize', () => {
    entry.tabs.layout()
    entry.palette.layout()
    entry.find.layout()
    pushState()
  })

  win.on('enter-full-screen', () => entry.tabs.layout())
  win.on('leave-full-screen', () => entry.tabs.layout())

  win.on('close', () => saveAll(true))

  win.on('closed', () => {
    const idx = windows.indexOf(entry)
    if (idx >= 0) windows.splice(idx, 1)
    entry.tabs.destroy()
    if (!quitting) saveAll(true)
  })

  win.webContents.on('did-finish-load', () => pushState())

  return entry
}

function showTabContextMenu(entry, id) {
  const tabs = entry.tabs
  const tab = tabs.tabs.get(id)
  if (!tab) return
  const space = tabs.spaceOf(tab)
  const others = tabs.spaces.filter(s => s.id !== tab.spaceId)
  const active = tabs.activeTab()
  const template = [
    { label: tab.pinned ? 'Desafixar' : 'Fixar como favorito', click: () => tabs.togglePin(id) },
    ...(active && active.id !== id ? [{ label: 'Abrir em split view', click: () => tabs.openSplit(active.id, id) }] : []),
    { label: 'Duplicar aba', click: () => tabs.duplicateTab(id) },
    { label: 'Copiar URL', click: () => clipboard.writeText(tab.url) },
    ...(space && space.folders.length || true ? [{
      label: 'Mover para pasta',
      submenu: [
        ...(space ? space.folders.map(f => ({
          label: f.name,
          type: 'radio',
          checked: tab.folderId === f.id,
          click: () => tabs.moveTabToFolder(id, f.id)
        })) : []),
        { label: 'Nenhuma', type: 'radio', checked: !tab.folderId, click: () => tabs.moveTabToFolder(id, null) },
        { type: 'separator' },
        { label: 'Nova pasta com esta aba', click: () => { const f = tabs.createFolder(tab.spaceId); if (f) tabs.moveTabToFolder(id, f.id) } }
      ]
    }] : []),
    ...(others.length ? [{
      label: 'Mover para espaco',
      submenu: others.map(s => ({ label: s.name, click: () => tabs.moveTabToSpace(id, s.id) }))
    }] : []),
    { type: 'separator' },
    { label: 'Arquivar aba', click: () => tabs.archiveTab(id) },
    { label: 'Fechar aba', click: () => tabs.closeTab(id) }
  ]
  Menu.buildFromTemplate(template).popup({ window: entry.win })
}

function showSpaceContextMenu(entry, id) {
  const tabs = entry.tabs
  const space = tabs.spaces.find(s => s.id === id)
  if (!space) return
  const template = [
    { label: 'Renomear', click: () => entry.win.webContents.send('space:edit', { id }) },
    {
      label: 'Icone',
      submenu: SPACE_ICONS.map(icon => ({
        label: icon,
        type: 'radio',
        checked: space.icon === icon,
        click: () => tabs.setSpaceIcon(id, icon)
      }))
    },
    {
      label: 'Cor',
      submenu: SPACE_COLORS.map(c => ({
        label: c,
        type: 'radio',
        checked: space.color === c,
        click: () => tabs.setSpaceColor(id, c)
      }))
    },
    { type: 'separator' },
    { label: 'Limpar abas', click: () => tabs.archiveAllUnpinned(id) },
    { label: 'Excluir espaco', enabled: tabs.spaces.length > 1, click: () => tabs.deleteSpace(id) }
  ]
  Menu.buildFromTemplate(template).popup({ window: entry.win })
}

function showFolderContextMenu(entry, id) {
  const tabs = entry.tabs
  const found = tabs.findFolder(id)
  if (!found) return
  const template = [
    { label: 'Renomear', click: () => entry.win.webContents.send('space:edit', { folderId: id }) },
    { label: found.folder.collapsed ? 'Expandir' : 'Recolher', click: () => tabs.toggleFolderCollapse(id) },
    { type: 'separator' },
    { label: 'Dissolver pasta', click: () => tabs.deleteFolder(id, { closeTabs: false }) },
    { label: 'Fechar pasta e abas', click: () => tabs.deleteFolder(id, { closeTabs: true }) }
  ]
  Menu.buildFromTemplate(template).popup({ window: entry.win })
}

function wireIpc() {
  ipcMain.on('ui', (e, msg) => {
    const entry = entryFor(e.sender)
    if (!entry || !msg) return
    const tabs = entry.tabs
    switch (msg.type) {
      case 'tab:activate': tabs.activateTab(msg.id); break
      case 'tab:close': tabs.closeTab(msg.id); break
      case 'tab:archive': tabs.archiveTab(msg.id); break
      case 'tab:reorder': tabs.reorderTab(msg.id, msg.index, msg.folderId || null); break
      case 'tab:context': showTabContextMenu(entry, msg.id); break
      case 'space:switch': tabs.activateSpace(msg.id); break
      case 'space:new': tabs.createSpace(); break
      case 'space:rename': tabs.renameSpace(msg.id, msg.name); break
      case 'space:context': showSpaceContextMenu(entry, msg.id); break
      case 'space:clean': tabs.archiveAllUnpinned(msg.id); break
      case 'folder:toggle': tabs.toggleFolderCollapse(msg.id); break
      case 'folder:context': showFolderContextMenu(entry, msg.id); break
      case 'folder:rename': tabs.renameFolder(msg.id, msg.name); break
      case 'link:open': tabs.createTab({ url: msg.url, activate: true }); break
      case 'nav:back': tabs.goBack(); break
      case 'nav:forward': tabs.goForward(); break
      case 'nav:reload': tabs.reload(); break
      case 'palette:open': entry.palette.open(msg.mode || 'default'); break
      case 'state:request': entry.pushState(); break
    }
  })

  ipcMain.handle('palette:query', (e, q) => {
    const entry = entryFor(e.sender)
    return entry ? entry.palette.results(q) : []
  })

  ipcMain.on('palette:run', (e, { item, mode }) => {
    const entry = entryFor(e.sender)
    if (!entry) return
    const keepOpen = item && item.type === 'action' && (item.id === 'split' || item.id === 'archived')
    if (!keepOpen) entry.palette.close()
    entry.palette.execute(item, mode)
  })

  ipcMain.on('palette:hide', e => {
    const entry = entryFor(e.sender)
    if (entry) entry.palette.close()
  })

  ipcMain.on('find:query', (e, { query, next, forward }) => {
    const entry = entryFor(e.sender)
    if (entry) entry.find.find(query, { forward: forward !== false, findNext: !!next })
  })

  ipcMain.on('find:close', e => {
    const entry = entryFor(e.sender)
    if (entry) entry.find.close()
  })
}

app.whenReady().then(() => {
  store = new Store(path.join(app.getPath('userData'), 'state.json'))
  const data = migrate(store.data)
  sharedHistory = Array.isArray(data.history) ? data.history : []

  if (process.platform === 'darwin' && app.dock) {
    const iconPath = path.join(__dirname, '..', 'build', 'icon.png')
    if (fs.existsSync(iconPath)) {
      try { app.dock.setIcon(iconPath) } catch {}
    }
  }

  session.defaultSession.setUserAgent(chromeUserAgent())

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'display-capture']
    callback(allowed.includes(permission))
  })

  wireIpc()

  for (const winState of data.windows || [{}]) {
    createWindow(winState)
  }
  if (!windows.length) createWindow()

  buildMenu({
    entry: () => focusedEntry(),
    newWindow: () => createWindow()
  })

  startAgentApi({
    tabs: () => windows[0] && windows[0].tabs,
    port: API_PORT,
    cdpPort: CDP_PORT
  })

  setInterval(() => {
    for (const entry of windows) entry.tabs.autoArchive()
  }, 10 * 60 * 1000)
})

app.on('second-instance', () => {
  const entry = windows[0]
  if (entry) {
    if (entry.win.isMinimized()) entry.win.restore()
    entry.win.focus()
  }
})

app.on('activate', () => {
  if (!windows.length) createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  quitting = true
  saveAll(true)
})
