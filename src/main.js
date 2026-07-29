const { app, BrowserWindow, ipcMain, session, Menu, clipboard, shell, Notification, dialog } = require('electron')
const { t } = require('./i18n')
const path = require('path')
const fs = require('fs')
const { ElectronChromeExtensions } = require('electron-chrome-extensions')
const { installChromeWebStore } = require('electron-chrome-web-store')
const Store = require('./state')
const { TabManager, SPACE_COLORS, SPACE_ICONS } = require('./tab-manager')
const PaletteController = require('./palette-controller')
const FindController = require('./find-controller')
const buildMenu = require('./menu')
const { startAgentApi } = require('./agent-api')

const CDP_PORT = process.env.GALHO_CDP_PORT || '9223'
const API_PORT = Number(process.env.GALHO_API_PORT || '9224')

app.setName('Galho')
if (process.env.GALHO_PROFILE) {
  app.setPath('userData', process.env.GALHO_PROFILE)
}
app.commandLine.appendSwitch('remote-debugging-port', CDP_PORT)
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

const windows = []
let store = null
let sharedHistory = []
let quitting = false
let extensions = null
let boosts = {}
const downloads = []
const pendingUrls = []

function openExternalUrl(url) {
  if (!/^https?:\/\//i.test(url)) return
  const entry = focusedEntry()
  if (!entry) {
    pendingUrls.push(url)
    return
  }
  entry.tabs.createTab({ url, activate: true })
  if (entry.win.isMinimized()) entry.win.restore()
  entry.win.show()
  entry.win.focus()
}

function findTabByWebContents(wc) {
  for (const entry of windows) {
    if (!entry.tabs) continue
    for (const tab of entry.tabs.tabs.values()) {
      if (tab.view && tab.view.webContents === wc) return { entry, tab }
    }
  }
  return null
}

const extensionHooks = {
  viewCreated(tab, win) {
    try {
      if (extensions) extensions.addTab(tab.view.webContents, win)
    } catch {}
  },
  tabActivated(tab) {
    try {
      if (extensions) extensions.selectTab(tab.view.webContents)
    } catch {}
  },
  contextMenuItems(wc, params) {
    try {
      return extensions ? extensions.getContextMenuItems(wc, params) : []
    } catch {
      return []
    }
  }
}

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
    boosts,
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
    (e.palette && e.palette.view && e.palette.view.webContents === wc) ||
    (e.find && e.find.view && e.find.view.webContents === wc) ||
    (e.peekView && e.peekView.webContents === wc)
  )
}

function ensurePeek(entry) {
  if (entry.peekView) return
  const { WebContentsView } = require('electron')
  entry.peekView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      transparent: true
    }
  })
  entry.peekView.setBackgroundColor('#00000000')
  entry.peekView.webContents.loadFile(path.join(__dirname, '..', 'ui', 'index.html'), { hash: 'peek' })
  entry.peekView.webContents.on('did-finish-load', () => {
    if (entry.tabs) entry.peekView.webContents.send('state', entry.tabs.uiState())
  })
}

function showPeek(entry) {
  if (entry.peekVisible || entry.tabs.sidebarOpen) return
  ensurePeek(entry)
  const [, h] = entry.win.getContentSize()
  entry.peekView.setBounds({ x: 0, y: 0, width: 324, height: h })
  entry.win.contentView.addChildView(entry.peekView)
  entry.peekVisible = true
  entry.peekView.webContents.send('state', entry.tabs.uiState())
}

function hidePeek(entry) {
  if (!entry.peekVisible) return
  entry.win.contentView.removeChildView(entry.peekView)
  entry.peekVisible = false
}

function focusedEntry() {
  const focused = BrowserWindow.getFocusedWindow()
  const entry = windows.find(e => e.win === focused)
  return entry || windows[0]
}

function createWindow(winState = {}) {
  const { nativeTheme } = require('electron')
  const themeBg = () => nativeTheme.shouldUseDarkColors ? '#1B1B22' : '#F4F2FA'
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 900,
    minHeight: 560,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: themeBg(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  })
  const themeListener = () => {
    if (!win.isDestroyed()) win.setBackgroundColor(themeBg())
  }
  nativeTheme.on('updated', themeListener)
  win.on('closed', () => nativeTheme.removeListener('updated', themeListener))

  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'))
  win.once('ready-to-show', () => {
    win.show()
    setTimeout(() => {
      if (!win.isDestroyed() && entry.tabs) entry.tabs.restoreActive()
    }, 50)
  })

  const entry = { win, tabs: null, palette: null, find: null }
  windows.push(entry)

  const pushState = () => {
    if (win.isDestroyed()) return
    const state = entry.tabs.uiState()
    win.webContents.send('state', state)
    if (entry.peekView) entry.peekView.webContents.send('state', state)
    if (entry.tabs.sidebarOpen && entry.peekVisible) hidePeek(entry)
    saveAll()
  }
  entry.pushState = pushState

  entry.tabs = new TabManager(win, winState, sharedHistory, pushState, extensionHooks, boosts)
  entry.palette = new PaletteController(win, entry.tabs, {
    find: () => entry.find,
    newWindow: () => createWindow(),
    setDefaultBrowser: () => {
      app.setAsDefaultProtocolClient('http')
      app.setAsDefaultProtocolClient('https')
    },
    openDownloads: () => shell.openPath(app.getPath('downloads'))
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
    { label: tab.pinned ? t('unpin') : t('pinFav'), click: () => tabs.togglePin(id) },
    { label: t('renameTab'), click: () => entry.win.webContents.send('space:edit', { tabId: id }) },
    ...(active && active.id !== id ? [{ label: t('openInSplit'), click: () => tabs.openSplit(active.id, id) }] : []),
    { label: t('duplicateTab'), click: () => tabs.duplicateTab(id) },
    { label: t('copyUrl'), click: () => clipboard.writeText(tab.url) },
    {
      label: t('moveToFolder'),
      submenu: [
        ...(space ? space.folders.map(f => ({
          label: f.name,
          type: 'radio',
          checked: tab.folderId === f.id,
          click: () => tabs.moveTabToFolder(id, f.id)
        })) : []),
        { label: t('noFolder'), type: 'radio', checked: !tab.folderId, click: () => tabs.moveTabToFolder(id, null) },
        { type: 'separator' },
        { label: t('newFolderWithTab'), click: () => { const f = tabs.createFolder(tab.spaceId); if (f) tabs.moveTabToFolder(id, f.id) } }
      ]
    },
    ...(others.length ? [{
      label: t('moveToSpace'),
      submenu: others.map(s => ({ label: s.name, click: () => tabs.moveTabToSpace(id, s.id) }))
    }] : []),
    { type: 'separator' },
    { label: t('archiveTab'), click: () => tabs.archiveTab(id) },
    { label: t('closeTab'), click: () => tabs.closeTab(id) }
  ]
  Menu.buildFromTemplate(template).popup({ window: entry.win })
}

function showSpaceContextMenu(entry, id) {
  const tabs = entry.tabs
  const space = tabs.spaces.find(s => s.id === id)
  if (!space) return
  const template = [
    { label: t('rename'), click: () => entry.win.webContents.send('space:edit', { id }) },
    {
      label: t('icon'),
      submenu: SPACE_ICONS.map(icon => ({
        label: icon,
        type: 'radio',
        checked: space.icon === icon,
        click: () => tabs.setSpaceIcon(id, icon)
      }))
    },
    {
      label: t('color'),
      submenu: SPACE_COLORS.map(c => ({
        label: c,
        type: 'radio',
        checked: space.color === c,
        click: () => tabs.setSpaceColor(id, c)
      }))
    },
    {
      label: t('autoArchive'),
      submenu: [
        { label: t('hours12'), type: 'radio', checked: !space.archiveAfterMs, click: () => tabs.setSpaceArchiveAfter(id, null) },
        { label: t('hours24'), type: 'radio', checked: space.archiveAfterMs === 86400000, click: () => tabs.setSpaceArchiveAfter(id, 86400000) },
        { label: t('days7'), type: 'radio', checked: space.archiveAfterMs === 604800000, click: () => tabs.setSpaceArchiveAfter(id, 604800000) },
        { label: t('never'), type: 'radio', checked: space.archiveAfterMs === 0, click: () => tabs.setSpaceArchiveAfter(id, 0) }
      ]
    },
    { type: 'separator' },
    { label: t('cleanTabs'), click: () => tabs.archiveAllUnpinned(id) },
    {
      label: t('deleteSpace'),
      enabled: tabs.spaces.length > 1,
      click: () => {
        const n = space.tabIds.length
        if (n > 0) {
          const choice = dialog.showMessageBoxSync(entry.win, {
            type: 'warning',
            buttons: [t('deleteConfirmYes'), t('cancel')],
            defaultId: 1,
            cancelId: 1,
            message: t('deleteSpaceConfirm', space.name, n)
          })
          if (choice !== 0) return
        }
        tabs.deleteSpace(id)
      }
    }
  ]
  Menu.buildFromTemplate(template).popup({ window: entry.win })
}

function showFolderContextMenu(entry, id) {
  const tabs = entry.tabs
  const found = tabs.findFolder(id)
  if (!found) return
  const template = [
    { label: t('rename'), click: () => entry.win.webContents.send('space:edit', { folderId: id }) },
    { label: found.folder.collapsed ? t('expand') : t('collapse'), click: () => tabs.toggleFolderCollapse(id) },
    { type: 'separator' },
    { label: t('dissolveFolder'), click: () => tabs.deleteFolder(id, { closeTabs: false }) },
    { label: t('closeFolderTabs'), click: () => tabs.deleteFolder(id, { closeTabs: true }) }
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
      case 'fav:click': tabs.favClick(msg.id); break
      case 'tab:rename': tabs.renameTab(msg.id, msg.name); break
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
      case 'peek:show': showPeek(entry); break
      case 'peek:hide': hidePeek(entry); break
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

  ipcMain.on('agent:control', (e, msg) => {
    const found = findTabByWebContents(e.sender)
    if (!found || !msg) return
    if (msg.action === 'takeover') {
      found.tab.agentTakenOver = true
      found.tab.agentUntil = 0
    } else if (msg.action === 'stop') {
      found.tab.agentStopRequested = true
      found.tab.agentUntil = 0
    }
    found.entry.tabs.emit()
  })
}

app.whenReady().then(() => {
  store = new Store(path.join(app.getPath('userData'), 'state.json'))
  const data = migrate(store.data)
  sharedHistory = Array.isArray(data.history) ? data.history : []
  boosts = data.boosts && typeof data.boosts === 'object' ? data.boosts : {}

  session.defaultSession.on('will-download', (_e, item) => {
    let file = path.join(app.getPath('downloads'), item.getFilename())
    let n = 1
    while (fs.existsSync(file)) {
      const ext = path.extname(item.getFilename())
      const base = path.basename(item.getFilename(), ext)
      file = path.join(app.getPath('downloads'), `${base} (${n++})${ext}`)
    }
    item.setSavePath(file)
    const record = { filename: path.basename(file), path: file, url: item.getURL(), state: 'progressing', startedAt: Date.now() }
    downloads.unshift(record)
    if (downloads.length > 100) downloads.length = 100
    item.on('done', (_ev, state) => {
      record.state = state
      record.bytes = item.getReceivedBytes()
      if (state === 'completed' && Notification.isSupported()) {
        const n = new Notification({ title: t('downloadDone'), body: record.filename })
        n.on('click', () => shell.showItemInFolder(file))
        n.show()
      }
    })
  })

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

  if (!process.env.GALHO_NO_EXT) extensions = new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session: session.defaultSession,
    async createTab(details) {
      const entry = windows.find(e => e.win.id === details.windowId) || focusedEntry()
      const tab = entry.tabs.createTab({ url: details.url || 'about:blank', activate: details.active !== false })
      return [tab.view.webContents, entry.win]
    },
    selectTab(wc) {
      const found = findTabByWebContents(wc)
      if (found) found.entry.tabs.activateTab(found.tab.id)
    },
    removeTab(wc) {
      const found = findTabByWebContents(wc)
      if (found) found.entry.tabs.closeTab(found.tab.id)
    },
    async createWindow(details) {
      const entry = createWindow()
      const url = Array.isArray(details.url) ? details.url[0] : details.url
      if (url) entry.tabs.createTab({ url, activate: true })
      return entry.win
    },
    removeWindow(win) {
      win.close()
    }
  })
  if (!process.env.GALHO_NO_EXT) ElectronChromeExtensions.handleCRXProtocol(session.defaultSession)

  wireIpc()

  const webstoreReady = process.env.GALHO_NO_EXT
    ? Promise.resolve()
    : installChromeWebStore({ session: session.defaultSession }).catch(() => {})
  Promise.race([webstoreReady, new Promise(r => setTimeout(r, 1500))]).then(() => {
    for (const winState of data.windows || [{}]) {
      createWindow(winState)
    }
    if (!windows.length) createWindow()
    while (pendingUrls.length) openExternalUrl(pendingUrls.shift())
  })

  buildMenu({
    entry: () => focusedEntry(),
    newWindow: () => createWindow()
  })

  startAgentApi({
    tabs: () => windows[0] && windows[0].tabs,
    managers: () => windows.map(e => e.tabs),
    downloads: () => downloads,
    boosts: () => boosts,
    saveBoosts: () => saveAll(),
    port: API_PORT,
    cdpPort: CDP_PORT
  })

  setInterval(() => {
    for (const entry of windows) {
      if (!entry.tabs) continue
      entry.tabs.autoArchive()
      entry.tabs.sleepIdleViews()
    }
  }, 10 * 60 * 1000)

  const { screen } = require('electron')
  setInterval(() => {
    const focused = BrowserWindow.getFocusedWindow()
    for (const entry of windows) {
      if (!entry.tabs || entry.tabs.sidebarOpen) {
        if (entry.peekVisible) hidePeek(entry)
        continue
      }
      if (entry.win !== focused) {
        if (entry.peekVisible) hidePeek(entry)
        continue
      }
      const cursor = screen.getCursorScreenPoint()
      const bounds = entry.win.getBounds()
      const inWindow = cursor.x >= bounds.x && cursor.x <= bounds.x + bounds.width &&
        cursor.y >= bounds.y && cursor.y <= bounds.y + bounds.height
      const relX = cursor.x - bounds.x
      if (!entry.peekVisible && inWindow && relX <= 4) {
        showPeek(entry)
      } else if (entry.peekVisible && (!inWindow || relX > 340)) {
        hidePeek(entry)
      }
    }
  }, 130)
})

app.on('open-url', (e, url) => {
  e.preventDefault()
  openExternalUrl(url)
})

app.on('second-instance', (_e, argv) => {
  const url = (argv || []).find(a => /^https?:\/\//i.test(a))
  if (url) {
    openExternalUrl(url)
    return
  }
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
