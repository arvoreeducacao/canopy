const { Menu, app, clipboard } = require('electron')
const { t } = require('./i18n')

function buildMenu(ctx) {
  const t_ = t
  const tabs = () => {
    const e = ctx.entry()
    return e && e.tabs
  }
  const palette = () => {
    const e = ctx.entry()
    return e && e.palette
  }
  const find = () => {
    const e = ctx.entry()
    return e && e.find
  }
  const win = () => {
    const e = ctx.entry()
    return e && e.win
  }

  const spaceItems = []
  for (let i = 1; i <= 9; i++) {
    spaceItems.push({
      label: t_('spaceN', i),
      accelerator: `Control+${i}`,
      click: () => tabs() && tabs().activateSpaceAtIndex(i)
    })
  }

  const tabIndexItems = []
  for (let i = 1; i <= 9; i++) {
    tabIndexItems.push({
      label: i === 9 ? t_('lastTab') : t_('tabN', i),
      accelerator: `CommandOrControl+${i}`,
      click: () => tabs() && tabs().activateTabAtIndex(i)
    })
  }

  const template = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: t_('about') },
        { type: 'separator' },
        { role: 'hide', label: t_('hide') },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: t_('quit') }
      ]
    }] : []),
    {
      label: t_('fileMenu'),
      submenu: [
        { label: t_('newTab'), accelerator: 'CommandOrControl+T', click: () => palette() && palette().open('default') },
        { label: t_('openUrl'), accelerator: 'CommandOrControl+L', click: () => palette() && palette().open('url') },
        { label: t_('newWindow'), accelerator: 'CommandOrControl+N', click: () => ctx.newWindow() },
        { type: 'separator' },
        { label: t_('archiveTab'), accelerator: 'CommandOrControl+W', click: () => { const tm = tabs(); if (tm) { const a = tm.activeTab(); if (a) tm.archiveTab(a.id) } } },
        { label: t_('reopenTab'), accelerator: 'CommandOrControl+Shift+T', click: () => tabs() && tabs().reopenClosed() },
        { label: t_('cleanSpace'), accelerator: 'CommandOrControl+Shift+K', click: () => tabs() && tabs().archiveAllUnpinned() },
        { type: 'separator' },
        { label: t_('newSpace'), accelerator: 'CommandOrControl+Control+N', click: () => tabs() && tabs().createSpace() }
      ]
    },
    {
      label: t_('editMenu'),
      submenu: [
        { role: 'undo', label: t_('undo') },
        { role: 'redo', label: t_('redo') },
        { type: 'separator' },
        { role: 'cut', label: t_('cut') },
        { role: 'copy', label: t_('copy') },
        { role: 'paste', label: t_('paste') },
        { role: 'selectAll', label: t_('selectAll') },
        { type: 'separator' },
        { label: t_('copyUrl'), accelerator: 'CommandOrControl+Shift+C', click: () => { const tm = tabs(); const a = tm && tm.activeTab(); if (a && a.url) clipboard.writeText(a.url) } },
        { label: t_('findInPage'), accelerator: 'CommandOrControl+F', click: () => find() && find().open() }
      ]
    },
    {
      label: t_('viewMenu'),
      submenu: [
        { label: t_('reload'), accelerator: 'CommandOrControl+R', click: () => tabs() && tabs().reload(false) },
        { label: t_('reloadNoCache'), accelerator: 'CommandOrControl+Shift+R', click: () => tabs() && tabs().reload(true) },
        { type: 'separator' },
        { label: t_('toggleSidebar'), accelerator: 'CommandOrControl+S', click: () => tabs() && tabs().toggleSidebar() },
        { label: t_('pinToggle'), accelerator: 'CommandOrControl+D', click: () => tabs() && tabs().togglePin() },
        { label: t_('pip'), accelerator: 'CommandOrControl+Shift+P', click: () => tabs() && tabs().togglePip() },
        { type: 'separator' },
        { label: t_('splitView'), accelerator: 'CommandOrControl+Shift+D', click: () => { const tm = tabs(); if (!tm) return; tm.split ? tm.closeSplit() : palette().open('split') } },
        { type: 'separator' },
        { label: t_('zoomIn'), accelerator: 'CommandOrControl+Plus', click: () => zoom(tabs(), 0.5) },
        { label: t_('zoomOut'), accelerator: 'CommandOrControl+-', click: () => zoom(tabs(), -0.5) },
        { label: t_('zoomReset'), accelerator: 'CommandOrControl+0', click: () => zoom(tabs(), 0) },
        { type: 'separator' },
        { label: t_('devtoolsTab'), accelerator: 'CommandOrControl+Alt+I', click: () => { const tm = tabs(); const a = tm && tm.activeTab(); if (a && a.view) a.view.webContents.openDevTools({ mode: 'detach' }) } },
        { label: t_('devtoolsUi'), accelerator: 'CommandOrControl+Alt+Shift+I', click: () => win() && win().webContents.openDevTools({ mode: 'detach' }) },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t_('fullscreen') }
      ]
    },
    {
      label: t_('historyMenu'),
      submenu: [
        { label: t_('back'), accelerator: 'CommandOrControl+[', click: () => tabs() && tabs().goBack() },
        { label: t_('forward'), accelerator: 'CommandOrControl+]', click: () => tabs() && tabs().goForward() },
        { type: 'separator' },
        { label: t_('archivedTabs'), click: () => palette() && palette().open('archived') }
      ]
    },
    {
      label: t_('tabsMenu'),
      submenu: [
        { label: t_('nextTab'), accelerator: 'Control+Tab', click: () => tabs() && tabs().cycleTab(1) },
        { label: t_('prevTab'), accelerator: 'Control+Shift+Tab', click: () => tabs() && tabs().cycleTab(-1) },
        { type: 'separator' },
        ...tabIndexItems
      ]
    },
    {
      label: t_('spacesMenu'),
      submenu: [
        { label: t_('nextSpace'), accelerator: 'CommandOrControl+Alt+Right', click: () => tabs() && tabs().cycleSpace(1) },
        { label: t_('prevSpace'), accelerator: 'CommandOrControl+Alt+Left', click: () => tabs() && tabs().cycleSpace(-1) },
        { type: 'separator' },
        ...spaceItems
      ]
    },
    {
      label: t_('windowMenu'),
      submenu: [
        { role: 'minimize', label: t_('minimize') },
        { role: 'zoom' },
        ...(process.platform === 'darwin' ? [{ role: 'front' }] : [{ role: 'close' }])
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function zoom(tm, delta) {
  const a = tm && tm.activeTab()
  if (!a || !a.view) return
  const wc = a.view.webContents
  if (delta === 0) wc.setZoomLevel(0)
  else wc.setZoomLevel(wc.getZoomLevel() + delta)
}

module.exports = buildMenu
