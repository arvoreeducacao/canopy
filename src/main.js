const { app, BrowserWindow, ipcMain, session, Menu } = require('electron')
const path = require('path')
const Store = require('./state')
const { TabManager, SPACE_COLORS } = require('./tab-manager')
const PaletteController = require('./palette-controller')
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

let win = null
let tabs = null
let palette = null
let store = null

function chromeUserAgent() {
  const major = process.versions.chrome.split('.')[0]
  const platform = process.platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

function pushState() {
  if (!win || !tabs) return
  win.webContents.send('state', tabs.uiState())
  store.save(tabs.serialize())
}

function createWindow() {
  win = new BrowserWindow({
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

  tabs = new TabManager(win, store, pushState)
  palette = new PaletteController(win, tabs)

  win.on('resize', () => {
    tabs.layout()
    palette.layout()
    pushState()
  })

  win.on('enter-full-screen', () => tabs.layout())
  win.on('leave-full-screen', () => tabs.layout())

  win.on('close', () => {
    if (tabs) {
      store.save(tabs.serialize())
      store.flush()
    }
  })

  win.on('closed', () => {
    win = null
    tabs = null
    palette = null
  })

  win.webContents.on('did-finish-load', () => pushState())
}

function showTabContextMenu(id) {
  const tab = tabs.tabs.get(id)
  if (!tab) return
  const others = tabs.spaces.filter(s => s.id !== tab.spaceId)
  const template = [
    { label: tab.pinned ? 'Desafixar' : 'Fixar como favorito', click: () => tabs.togglePin(id) },
    { label: 'Duplicar aba', click: () => tabs.duplicateTab(id) },
    { label: 'Copiar URL', click: () => require('electron').clipboard.writeText(tab.url) },
    ...(others.length ? [{
      label: 'Mover para espaco',
      submenu: others.map(s => ({ label: s.name, click: () => tabs.moveTabToSpace(id, s.id) }))
    }] : []),
    { type: 'separator' },
    { label: 'Fechar aba', click: () => tabs.closeTab(id) }
  ]
  Menu.buildFromTemplate(template).popup({ window: win })
}

function showSpaceContextMenu(id) {
  const space = tabs.spaces.find(s => s.id === id)
  if (!space) return
  const template = [
    { label: 'Renomear', click: () => win.webContents.send('space:edit', { id }) },
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
    { label: 'Excluir espaco', enabled: tabs.spaces.length > 1, click: () => tabs.deleteSpace(id) }
  ]
  Menu.buildFromTemplate(template).popup({ window: win })
}

function wireIpc() {
  ipcMain.on('ui', (_e, msg) => {
    if (!tabs || !msg) return
    switch (msg.type) {
      case 'tab:activate': tabs.activateTab(msg.id); break
      case 'tab:close': tabs.closeTab(msg.id); break
      case 'tab:new': tabs.createTab({ activate: true }); break
      case 'tab:reorder': tabs.reorderTab(msg.id, msg.index); break
      case 'tab:context': showTabContextMenu(msg.id); break
      case 'space:switch': tabs.activateSpace(msg.id); break
      case 'space:new': tabs.createSpace(); break
      case 'space:rename': tabs.renameSpace(msg.id, msg.name); break
      case 'space:context': showSpaceContextMenu(msg.id); break
      case 'nav:back': tabs.goBack(); break
      case 'nav:forward': tabs.goForward(); break
      case 'nav:reload': tabs.reload(); break
      case 'palette:open': palette.open(msg.mode || 'default'); break
      case 'state:request': pushState(); break
    }
  })

  ipcMain.handle('palette:query', (_e, q) => {
    return palette ? palette.results(q) : []
  })

  ipcMain.on('palette:run', (_e, { item, mode }) => {
    if (!palette) return
    palette.close()
    palette.execute(item, mode)
  })

  ipcMain.on('palette:hide', () => {
    if (palette) palette.close()
  })
}

app.whenReady().then(() => {
  store = new Store(path.join(app.getPath('userData'), 'state.json'))

  session.defaultSession.setUserAgent(chromeUserAgent())

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'display-capture']
    callback(allowed.includes(permission))
  })

  wireIpc()
  createWindow()
  buildMenu({ tabs: () => tabs, palette: () => palette, win: () => win })
  startAgentApi({ tabs: () => tabs, port: API_PORT, cdpPort: CDP_PORT })
})

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.on('activate', () => {
  if (!win) createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  if (tabs && store) {
    store.save(tabs.serialize())
    store.flush()
  }
})
