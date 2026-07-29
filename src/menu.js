const { Menu, app, clipboard } = require('electron')

function buildMenu(ctx) {
  const t = () => ctx.tabs()
  const p = () => ctx.palette()

  const spaceItems = []
  for (let i = 1; i <= 9; i++) {
    spaceItems.push({
      label: `Espaco ${i}`,
      accelerator: `Control+${i}`,
      click: () => t() && t().activateSpaceAtIndex(i)
    })
  }

  const tabIndexItems = []
  for (let i = 1; i <= 9; i++) {
    tabIndexItems.push({
      label: i === 9 ? 'Ultima aba' : `Aba ${i}`,
      accelerator: `CommandOrControl+${i}`,
      click: () => t() && t().activateTabAtIndex(i)
    })
  }

  const template = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: 'Sobre o Galho' },
        { type: 'separator' },
        { role: 'hide', label: 'Ocultar Galho' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Sair do Galho' }
      ]
    }] : []),
    {
      label: 'Arquivo',
      submenu: [
        { label: 'Nova aba...', accelerator: 'CommandOrControl+T', click: () => p() && p().open('default') },
        { label: 'Abrir URL...', accelerator: 'CommandOrControl+L', click: () => p() && p().open('url') },
        { type: 'separator' },
        { label: 'Fechar aba', accelerator: 'CommandOrControl+W', click: () => { const tm = t(); if (tm) { const a = tm.activeTab(); if (a) tm.closeTab(a.id) } } },
        { label: 'Reabrir aba fechada', accelerator: 'CommandOrControl+Shift+T', click: () => t() && t().reopenClosed() },
        { type: 'separator' },
        { label: 'Novo espaco', accelerator: 'CommandOrControl+Shift+N', click: () => t() && t().createSpace() }
      ]
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'undo', label: 'Desfazer' },
        { role: 'redo', label: 'Refazer' },
        { type: 'separator' },
        { role: 'cut', label: 'Recortar' },
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Colar' },
        { role: 'selectAll', label: 'Selecionar tudo' },
        { type: 'separator' },
        { label: 'Copiar URL', accelerator: 'CommandOrControl+Shift+C', click: () => { const tm = t(); const a = tm && tm.activeTab(); if (a && a.url) clipboard.writeText(a.url) } }
      ]
    },
    {
      label: 'Visualizar',
      submenu: [
        { label: 'Recarregar', accelerator: 'CommandOrControl+R', click: () => t() && t().reload(false) },
        { label: 'Recarregar sem cache', accelerator: 'CommandOrControl+Shift+R', click: () => t() && t().reload(true) },
        { type: 'separator' },
        { label: 'Mostrar/ocultar sidebar', accelerator: 'CommandOrControl+S', click: () => t() && t().toggleSidebar() },
        { type: 'separator' },
        { label: 'Aumentar zoom', accelerator: 'CommandOrControl+Plus', click: () => zoom(t(), 0.5) },
        { label: 'Diminuir zoom', accelerator: 'CommandOrControl+-', click: () => zoom(t(), -0.5) },
        { label: 'Zoom padrao', accelerator: 'CommandOrControl+0', click: () => zoom(t(), 0) },
        { type: 'separator' },
        { label: 'DevTools da aba', accelerator: 'CommandOrControl+Alt+I', click: () => { const tm = t(); const a = tm && tm.activeTab(); if (a && a.view) a.view.webContents.openDevTools({ mode: 'detach' }) } },
        { label: 'DevTools da interface', accelerator: 'CommandOrControl+Alt+Shift+I', click: () => ctx.win() && ctx.win().webContents.openDevTools({ mode: 'detach' }) },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Tela cheia' }
      ]
    },
    {
      label: 'Historico',
      submenu: [
        { label: 'Voltar', accelerator: 'CommandOrControl+[', click: () => t() && t().goBack() },
        { label: 'Avancar', accelerator: 'CommandOrControl+]', click: () => t() && t().goForward() }
      ]
    },
    {
      label: 'Abas',
      submenu: [
        { label: 'Proxima aba', accelerator: 'Control+Tab', click: () => t() && t().cycleTab(1) },
        { label: 'Aba anterior', accelerator: 'Control+Shift+Tab', click: () => t() && t().cycleTab(-1) },
        { type: 'separator' },
        ...tabIndexItems
      ]
    },
    {
      label: 'Espacos',
      submenu: [
        { label: 'Proximo espaco', accelerator: 'CommandOrControl+Alt+Right', click: () => t() && t().cycleSpace(1) },
        { label: 'Espaco anterior', accelerator: 'CommandOrControl+Alt+Left', click: () => t() && t().cycleSpace(-1) },
        { type: 'separator' },
        ...spaceItems
      ]
    },
    {
      label: 'Janela',
      submenu: [
        { role: 'minimize', label: 'Minimizar' },
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
