const { WebContentsView, clipboard, Notification } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

function isUrlish(q) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(q)) return true
  if (/^localhost(:\d+)?(\/|$)/.test(q)) return true
  if (!q.includes(' ') && q.includes('.')) return true
  return false
}

function normalizeUrl(q) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(q)) return q
  return 'https://' + q
}

function searchUrl(q) {
  return 'https://www.google.com/search?q=' + encodeURIComponent(q)
}

function score(query, text) {
  if (!text) return 0
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (t === q) return 100
  if (t.startsWith(q)) return 80
  const idx = t.indexOf(q)
  if (idx >= 0) return 60 - Math.min(idx, 30) * 0.5
  let ti = 0
  let hits = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found < 0) return 0
    ti = found + 1
    hits++
  }
  return hits > 2 ? 25 : 0
}

class PaletteController {
  constructor(win, tabs, ctx) {
    this.win = win
    this.tabs = tabs
    this.ctx = ctx
    this.view = null
    this.visible = false
    this.mode = 'default'
  }

  actions() {
    const split = !!this.tabs.split
    return [
      { id: 'pin-toggle', title: 'Fixar/desafixar como favorito', hint: 'Cmd D' },
      { id: 'find', title: 'Buscar na pagina', hint: 'Cmd F' },
      { id: 'split', title: split ? 'Trocar aba do split view' : 'Split view com...', hint: 'Cmd Shift D' },
      ...(split ? [{ id: 'close-split', title: 'Fechar split view' }] : []),
      { id: 'pip', title: 'Picture-in-Picture', hint: 'Cmd Shift P' },
      { id: 'clean', title: 'Limpar abas do espaco', hint: 'Cmd Shift K' },
      { id: 'archived', title: 'Ver abas arquivadas' },
      { id: 'close-tab', title: 'Arquivar aba', hint: 'Cmd W' },
      { id: 'reopen-tab', title: 'Reabrir aba fechada', hint: 'Cmd Shift T' },
      { id: 'new-window', title: 'Nova janela', hint: 'Cmd N' },
      { id: 'new-space', title: 'Novo espaco', hint: 'Cmd Ctrl N' },
      { id: 'new-folder', title: 'Nova pasta no espaco' },
      { id: 'toggle-sidebar', title: 'Mostrar/ocultar sidebar', hint: 'Cmd S' },
      { id: 'copy-url', title: 'Copiar URL da aba', hint: 'Cmd Shift C' },
      { id: 'screenshot', title: 'Capturar tela da aba' },
      { id: 'webstore', title: 'Instalar extensoes (Chrome Web Store)' },
      { id: 'devtools', title: 'Abrir DevTools', hint: 'Cmd Alt I' },
      { id: 'reload', title: 'Recarregar pagina', hint: 'Cmd R' },
      { id: 'clear-history', title: 'Limpar historico' }
    ]
  }

  ensure() {
    if (this.view) return
    this.view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        transparent: true
      }
    })
    this.view.setBackgroundColor('#00000000')
    this.view.webContents.loadFile(path.join(__dirname, '..', 'ui', 'palette.html'))
    this.view.webContents.on('blur', () => {
      if (this.visible) this.close()
    })
  }

  open(mode = 'default') {
    this.ensure()
    this.mode = mode
    if (!this.visible) {
      this.win.contentView.addChildView(this.view)
      this.visible = true
    }
    this.layout()
    const active = this.tabs.activeTab()
    const space = this.tabs.activeSpace()
    const placeholders = {
      default: 'Buscar, abrir URL ou executar acao...',
      url: 'Abrir URL nesta aba...',
      split: 'Escolher aba para o split view...',
      archived: 'Buscar nas abas arquivadas...'
    }
    this.view.webContents.send('palette:open', {
      mode,
      placeholder: placeholders[mode] || placeholders.default,
      prefill: mode === 'url' && active ? active.url : '',
      color: space ? space.color : '#8B5CF6'
    })
    this.view.webContents.focus()
  }

  close() {
    if (!this.visible) return
    this.win.contentView.removeChildView(this.view)
    this.visible = false
    const active = this.tabs.activeTab()
    if (active && active.view) active.view.webContents.focus()
    else this.win.webContents.focus()
  }

  layout() {
    if (!this.visible || !this.view) return
    const [w, h] = this.win.getContentSize()
    this.view.setBounds({ x: 0, y: 0, width: w, height: h })
  }

  results(query) {
    const q = (query || '').trim()
    if (this.mode === 'split') return this.splitResults(q)
    if (this.mode === 'archived') return this.archivedResults(q)
    return this.defaultResults(q)
  }

  splitResults(q) {
    const space = this.tabs.activeSpace()
    const active = this.tabs.activeTab()
    if (!space) return []
    return space.tabIds
      .map(id => this.tabs.tabs.get(id))
      .filter(t => t && (!active || t.id !== active.id))
      .filter(t => !q || score(q, t.title) > 20 || score(q, t.url) > 20)
      .slice(0, 12)
      .map(t => ({ type: 'split-with', id: t.id, title: t.title, subtitle: t.url, favicon: t.favicon, kind: 'tab' }))
  }

  archivedResults(q) {
    const items = []
    for (const space of this.tabs.spaces) {
      space.archived.forEach((a, index) => {
        if (!q || score(q, a.title) > 20 || score(q, a.url) > 20) {
          items.push({ type: 'archived', spaceId: space.id, index, title: a.title, subtitle: `${space.name} - ${a.url}`, favicon: a.favicon, kind: 'history' })
        }
      })
    }
    return items.slice(0, 14)
  }

  defaultResults(q) {
    const items = []
    const openUrls = new Set()
    const allTabs = []
    for (const space of this.tabs.spaces) {
      for (const id of space.tabIds) {
        const tab = this.tabs.tabs.get(id)
        if (!tab) continue
        openUrls.add(tab.url)
        allTabs.push({ tab, space })
      }
    }

    if (q) {
      if (isUrlish(q)) {
        items.push({ type: 'nav', title: q, subtitle: 'Abrir', url: normalizeUrl(q), kind: 'globe' })
        items.push({ type: 'search', title: `Buscar "${q}" no Google`, url: searchUrl(q), kind: 'search' })
      } else {
        items.push({ type: 'search', title: `Buscar "${q}" no Google`, url: searchUrl(q), kind: 'search' })
      }

      const tabMatches = allTabs
        .map(({ tab, space }) => ({
          s: Math.max(score(q, tab.title), score(q, tab.url)) + 5,
          item: { type: 'tab', id: tab.id, title: tab.title, subtitle: `${space.name} - aba aberta`, favicon: tab.favicon, kind: 'tab' }
        }))
        .filter(x => x.s > 20)
        .sort((a, b) => b.s - a.s)
        .slice(0, 5)
      items.push(...tabMatches.map(x => x.item))

      const actionMatches = this.actions()
        .map(a => ({ s: score(q, a.title), item: { type: 'action', id: a.id, title: a.title, subtitle: a.hint || 'Acao', kind: 'action' } }))
        .filter(x => x.s > 20)
        .sort((a, b) => b.s - a.s)
        .slice(0, 4)
      items.push(...actionMatches.map(x => x.item))

      const now = Date.now()
      const histMatches = this.tabs.history
        .filter(h => !openUrls.has(h.url))
        .map(h => {
          const base = Math.max(score(q, h.title), score(q, h.url))
          const recency = Math.max(0, 10 - (now - (h.last || 0)) / 86400000)
          return { s: base > 0 ? base + Math.min(h.count || 1, 10) + recency : 0, item: { type: 'history', title: h.title, subtitle: h.url, url: h.url, kind: 'history' } }
        })
        .filter(x => x.s > 25)
        .sort((a, b) => b.s - a.s)
        .slice(0, 6)
      items.push(...histMatches.map(x => x.item))

      const archMatches = []
      for (const space of this.tabs.spaces) {
        space.archived.forEach((a, index) => {
          const s = Math.max(score(q, a.title), score(q, a.url))
          if (s > 30) archMatches.push({ s, item: { type: 'archived', spaceId: space.id, index, title: a.title, subtitle: `Arquivada - ${space.name}`, favicon: a.favicon, kind: 'history' } })
        })
      }
      items.push(...archMatches.sort((a, b) => b.s - a.s).slice(0, 3).map(x => x.item))
    } else {
      const space = this.tabs.activeSpace()
      if (space) {
        for (const id of space.tabIds.slice(0, 6)) {
          const tab = this.tabs.tabs.get(id)
          if (tab) items.push({ type: 'tab', id: tab.id, title: tab.title, subtitle: 'Aba aberta', favicon: tab.favicon, kind: 'tab' })
        }
      }
      for (const a of this.actions().slice(0, 6)) {
        items.push({ type: 'action', id: a.id, title: a.title, subtitle: a.hint || 'Acao', kind: 'action' })
      }
      for (const h of this.tabs.history.slice(0, 4)) {
        if (!openUrls.has(h.url)) items.push({ type: 'history', title: h.title, subtitle: h.url, url: h.url, kind: 'history' })
      }
    }

    return items.slice(0, 14)
  }

  execute(item, mode) {
    const tabs = this.tabs
    if (!item) return
    if (item.type === 'tab') {
      tabs.activateTab(item.id)
    } else if (item.type === 'split-with') {
      const active = tabs.activeTab()
      if (active) tabs.openSplit(active.id, item.id)
    } else if (item.type === 'archived') {
      tabs.restoreArchived(item.spaceId, item.index)
    } else if (item.type === 'nav' || item.type === 'search' || item.type === 'history') {
      const active = tabs.activeTab()
      if (mode === 'url' && active) tabs.navigate(active.id, item.url)
      else tabs.createTab({ url: item.url, activate: true })
    } else if (item.type === 'action') {
      this.runAction(item.id)
    }
  }

  runAction(id) {
    const tabs = this.tabs
    const active = tabs.activeTab()
    switch (id) {
      case 'pin-toggle':
        if (active) tabs.togglePin(active.id)
        break
      case 'find':
        if (this.ctx && this.ctx.find) this.ctx.find().open()
        break
      case 'split':
        this.open('split')
        return
      case 'close-split':
        tabs.closeSplit()
        break
      case 'pip':
        tabs.togglePip()
        break
      case 'clean':
        tabs.archiveAllUnpinned()
        break
      case 'archived':
        this.open('archived')
        return
      case 'close-tab':
        if (active) tabs.archiveTab(active.id)
        break
      case 'reopen-tab':
        tabs.reopenClosed()
        break
      case 'new-window':
        if (this.ctx && this.ctx.newWindow) this.ctx.newWindow()
        break
      case 'new-space':
        tabs.createSpace()
        break
      case 'new-folder':
        tabs.createFolder(tabs.activeSpaceId)
        break
      case 'toggle-sidebar':
        tabs.toggleSidebar()
        break
      case 'copy-url':
        if (active) clipboard.writeText(active.url)
        break
      case 'screenshot':
        this.screenshot()
        break
      case 'webstore':
        tabs.createTab({ url: 'https://chromewebstore.google.com/', activate: true })
        break
      case 'devtools':
        if (active && active.view) active.view.webContents.openDevTools({ mode: 'detach' })
        break
      case 'reload':
        tabs.reload()
        break
      case 'clear-history':
        tabs.history.length = 0
        tabs.emit()
        break
    }
  }

  async screenshot() {
    const active = this.tabs.activeTab()
    if (!active || !active.view) return
    try {
      const image = await active.view.webContents.capturePage()
      const file = path.join(os.homedir(), 'Desktop', `galho-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
      fs.writeFileSync(file, image.toPNG())
      clipboard.writeImage(image)
      if (Notification.isSupported()) {
        new Notification({ title: 'Screenshot salvo', body: file }).show()
      }
    } catch {}
  }
}

module.exports = PaletteController
