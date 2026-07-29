const { WebContentsView, Menu, clipboard } = require('electron')
const path = require('path')
const crypto = require('crypto')

const NEWTAB_URL = 'file://' + path.join(__dirname, '..', 'ui', 'newtab.html')
const SPACE_COLORS = ['#8B5CF6', '#0EA5E9', '#10B981', '#F59E0B', '#EF4444', '#EC4899', '#14B8A6', '#6366F1']
const SIDEBAR_WIDTH = 300
const PAD = 8

function shortId() {
  return crypto.randomBytes(4).toString('hex')
}

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

function isNewtab(url) {
  return !url || url.startsWith('file://') && url.includes('newtab.html')
}

class TabManager {
  constructor(win, store, onChange) {
    this.win = win
    this.store = store
    this.onChange = onChange
    this.tabs = new Map()
    this.spaces = []
    this.closedStack = []
    this.attachedView = null
    this.emitTimer = null

    const data = store.data || {}
    this.sidebarOpen = data.sidebarOpen !== false
    this.history = Array.isArray(data.history) ? data.history : []

    for (const s of data.spaces || []) {
      const space = { id: s.id || shortId(), name: s.name || 'Espaco', color: s.color || SPACE_COLORS[0], tabIds: [], activeTabId: null }
      for (const t of s.tabs || []) {
        if (!t.url) continue
        const tab = this.makeRecord({ id: t.id, url: t.url, title: t.title, favicon: t.favicon, pinned: t.pinned, spaceId: space.id })
        space.tabIds.push(tab.id)
      }
      if (s.activeTabId && space.tabIds.includes(s.activeTabId)) space.activeTabId = s.activeTabId
      else space.activeTabId = space.tabIds[0] || null
      this.spaces.push(space)
    }

    if (!this.spaces.length) this.seed()

    const wanted = data.activeSpaceId
    this.activeSpaceId = this.spaces.find(s => s.id === wanted) ? wanted : this.spaces[0].id
    this.activateSpace(this.activeSpaceId)
  }

  seed() {
    const personal = { id: shortId(), name: 'Pessoal', color: '#8B5CF6', tabIds: [], activeTabId: null }
    const work = { id: shortId(), name: 'Trabalho', color: '#14B8A6', tabIds: [], activeTabId: null }
    this.spaces.push(personal, work)
    const tab = this.makeRecord({ url: NEWTAB_URL, spaceId: personal.id })
    personal.tabIds.push(tab.id)
    personal.activeTabId = tab.id
  }

  makeRecord({ id, url, title, favicon, pinned, spaceId }) {
    const tab = {
      id: id || shortId(),
      url,
      title: title || hostOf(url) || 'Nova aba',
      favicon: favicon || null,
      pinned: !!pinned,
      spaceId,
      loading: false,
      view: null
    }
    this.tabs.set(tab.id, tab)
    return tab
  }

  spaceOf(tab) {
    return this.spaces.find(s => s.id === tab.spaceId)
  }

  activeSpace() {
    return this.spaces.find(s => s.id === this.activeSpaceId)
  }

  activeTab() {
    const space = this.activeSpace()
    return space && space.activeTabId ? this.tabs.get(space.activeTabId) : null
  }

  ensureView(tab) {
    if (tab.view) return tab.view
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        backgroundThrottling: true
      }
    })
    view.setBackgroundColor('#FFFFFFFF')
    if (typeof view.setBorderRadius === 'function') {
      try { view.setBorderRadius(10) } catch {}
    }
    tab.view = view
    this.wire(tab)
    view.webContents.loadURL(tab.url).catch(() => {})
    return view
  }

  wire(tab) {
    const wc = tab.view.webContents

    wc.on('page-title-updated', (_e, title) => {
      tab.title = title || tab.title
      this.recordVisit(tab.url, tab.title)
      this.emit()
    })

    wc.on('page-favicon-updated', (_e, favicons) => {
      if (favicons && favicons.length) {
        tab.favicon = favicons[favicons.length - 1]
        this.emit()
      }
    })

    wc.on('did-start-loading', () => {
      tab.loading = true
      this.emit()
    })

    wc.on('did-stop-loading', () => {
      tab.loading = false
      this.emit()
    })

    wc.on('did-navigate', (_e, url) => {
      tab.url = url
      this.recordVisit(url, tab.title)
      this.emit()
    })

    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) {
        tab.url = url
        this.emit()
      }
    })

    wc.setWindowOpenHandler(details => {
      const activate = details.disposition !== 'background-tab'
      this.createTab({ url: details.url, spaceId: tab.spaceId, activate })
      return { action: 'deny' }
    })

    wc.on('context-menu', (_e, params) => {
      this.showPageContextMenu(tab, params)
    })

    wc.on('found-in-page', () => {})
  }

  showPageContextMenu(tab, params) {
    const wc = tab.view.webContents
    const template = []
    if (params.linkURL) {
      template.push(
        { label: 'Abrir link em nova aba', click: () => this.createTab({ url: params.linkURL, spaceId: tab.spaceId, activate: false }) },
        { label: 'Copiar link', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' }
      )
    }
    if (params.selectionText) {
      template.push(
        { role: 'copy', label: 'Copiar' },
        { label: `Buscar "${params.selectionText.slice(0, 30)}" no Google`, click: () => this.createTab({ url: 'https://www.google.com/search?q=' + encodeURIComponent(params.selectionText), spaceId: tab.spaceId }) },
        { type: 'separator' }
      )
    }
    if (params.isEditable) {
      template.push({ role: 'cut', label: 'Recortar' }, { role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Colar' }, { type: 'separator' })
    }
    template.push(
      { label: 'Voltar', enabled: this.canGoBack(tab), click: () => this.goBack(tab.id) },
      { label: 'Avancar', enabled: this.canGoForward(tab), click: () => this.goForward(tab.id) },
      { label: 'Recarregar', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Inspecionar elemento', click: () => wc.inspectElement(params.x, params.y) }
    )
    Menu.buildFromTemplate(template).popup({ window: this.win })
  }

  createTab({ url, spaceId, activate = true, pinned = false, afterId } = {}) {
    const space = this.spaces.find(s => s.id === spaceId) || this.activeSpace()
    const tab = this.makeRecord({ url: url || NEWTAB_URL, pinned, spaceId: space.id })
    let index = space.tabIds.length
    if (afterId) {
      const i = space.tabIds.indexOf(afterId)
      if (i >= 0) index = i + 1
    }
    space.tabIds.splice(index, 0, tab.id)
    if (activate) this.activateTab(tab.id)
    else this.ensureView(tab)
    this.emit()
    return tab
  }

  activateTab(id) {
    const tab = this.tabs.get(id)
    if (!tab) return
    const space = this.spaceOf(tab)
    if (!space) return
    this.activeSpaceId = space.id
    space.activeTabId = tab.id
    const view = this.ensureView(tab)
    if (this.attachedView && this.attachedView !== view) {
      this.win.contentView.removeChildView(this.attachedView)
    }
    if (this.attachedView !== view) {
      this.win.contentView.addChildView(view)
      this.attachedView = view
    }
    this.layout()
    view.webContents.focus()
    this.emit()
  }

  activateSpace(id) {
    const space = this.spaces.find(s => s.id === id)
    if (!space) return
    this.activeSpaceId = space.id
    if (!space.tabIds.length) {
      this.createTab({ spaceId: space.id, activate: true })
      return
    }
    this.activateTab(space.activeTabId || space.tabIds[0])
  }

  closeTab(id) {
    const tab = this.tabs.get(id)
    if (!tab) return
    const space = this.spaceOf(tab)
    if (!isNewtab(tab.url)) {
      this.closedStack.push({ url: tab.url, title: tab.title, pinned: tab.pinned, spaceId: tab.spaceId })
      if (this.closedStack.length > 50) this.closedStack.shift()
    }
    const idx = space ? space.tabIds.indexOf(id) : -1
    if (space) space.tabIds = space.tabIds.filter(t => t !== id)
    if (tab.view) {
      if (this.attachedView === tab.view) {
        this.win.contentView.removeChildView(tab.view)
        this.attachedView = null
      }
      try { tab.view.webContents.close() } catch {}
    }
    this.tabs.delete(id)
    if (space && space.id === this.activeSpaceId && space.activeTabId === id) {
      const next = space.tabIds[Math.min(Math.max(idx, 0), space.tabIds.length - 1)]
      if (next) this.activateTab(next)
      else this.createTab({ spaceId: space.id, activate: true })
      return
    }
    if (space && space.activeTabId === id) space.activeTabId = space.tabIds[0] || null
    this.emit()
  }

  reopenClosed() {
    const item = this.closedStack.pop()
    if (!item) return
    const spaceId = this.spaces.find(s => s.id === item.spaceId) ? item.spaceId : this.activeSpaceId
    this.createTab({ url: item.url, spaceId, pinned: item.pinned, activate: true })
  }

  duplicateTab(id) {
    const tab = this.tabs.get(id)
    if (!tab) return
    this.createTab({ url: tab.url, spaceId: tab.spaceId, afterId: tab.id, activate: true })
  }

  togglePin(id) {
    const tab = this.tabs.get(id)
    if (!tab) return
    tab.pinned = !tab.pinned
    this.emit()
  }

  moveTabToSpace(id, spaceId) {
    const tab = this.tabs.get(id)
    const target = this.spaces.find(s => s.id === spaceId)
    if (!tab || !target || tab.spaceId === spaceId) return
    const source = this.spaceOf(tab)
    if (source) {
      const wasActive = source.activeTabId === id
      source.tabIds = source.tabIds.filter(t => t !== id)
      if (wasActive) {
        source.activeTabId = source.tabIds[0] || null
        if (source.id === this.activeSpaceId) {
          if (source.activeTabId) this.activateTab(source.activeTabId)
          else this.createTab({ spaceId: source.id, activate: true })
        }
      }
    }
    tab.spaceId = target.id
    target.tabIds.push(id)
    if (!target.activeTabId) target.activeTabId = id
    this.emit()
  }

  reorderTab(id, newIndex) {
    const tab = this.tabs.get(id)
    if (!tab) return
    const space = this.spaceOf(tab)
    if (!space) return
    const ids = space.tabIds.filter(t => t !== id)
    ids.splice(Math.max(0, Math.min(newIndex, ids.length)), 0, id)
    space.tabIds = ids
    this.emit()
  }

  cycleTab(direction) {
    const space = this.activeSpace()
    if (!space || space.tabIds.length < 2) return
    const idx = space.tabIds.indexOf(space.activeTabId)
    const next = (idx + direction + space.tabIds.length) % space.tabIds.length
    this.activateTab(space.tabIds[next])
  }

  activateTabAtIndex(n) {
    const space = this.activeSpace()
    if (!space || !space.tabIds.length) return
    const idx = n === 9 ? space.tabIds.length - 1 : n - 1
    if (space.tabIds[idx]) this.activateTab(space.tabIds[idx])
  }

  activateSpaceAtIndex(n) {
    if (this.spaces[n - 1]) this.activateSpace(this.spaces[n - 1].id)
  }

  cycleSpace(direction) {
    const idx = this.spaces.findIndex(s => s.id === this.activeSpaceId)
    const next = (idx + direction + this.spaces.length) % this.spaces.length
    this.activateSpace(this.spaces[next].id)
  }

  createSpace(name, color) {
    const space = {
      id: shortId(),
      name: name || `Espaco ${this.spaces.length + 1}`,
      color: color || SPACE_COLORS[this.spaces.length % SPACE_COLORS.length],
      tabIds: [],
      activeTabId: null
    }
    this.spaces.push(space)
    this.activateSpace(space.id)
    return space
  }

  renameSpace(id, name) {
    const space = this.spaces.find(s => s.id === id)
    if (space && name && name.trim()) {
      space.name = name.trim()
      this.emit()
    }
  }

  setSpaceColor(id, color) {
    const space = this.spaces.find(s => s.id === id)
    if (space) {
      space.color = color
      this.emit()
    }
  }

  deleteSpace(id) {
    if (this.spaces.length < 2) return
    const space = this.spaces.find(s => s.id === id)
    if (!space) return
    for (const tabId of [...space.tabIds]) this.closeSilently(tabId)
    this.spaces = this.spaces.filter(s => s.id !== id)
    if (this.activeSpaceId === id) this.activateSpace(this.spaces[0].id)
    else this.emit()
  }

  closeSilently(id) {
    const tab = this.tabs.get(id)
    if (!tab) return
    if (tab.view) {
      if (this.attachedView === tab.view) {
        this.win.contentView.removeChildView(tab.view)
        this.attachedView = null
      }
      try { tab.view.webContents.close() } catch {}
    }
    this.tabs.delete(id)
  }

  navigate(id, url) {
    const tab = this.tabs.get(id)
    if (!tab) return
    tab.url = url
    this.ensureView(tab)
    tab.view.webContents.loadURL(url).catch(() => {})
    this.emit()
  }

  canGoBack(tab) {
    const wc = tab && tab.view && tab.view.webContents
    if (!wc) return false
    return wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack()
  }

  canGoForward(tab) {
    const wc = tab && tab.view && tab.view.webContents
    if (!wc) return false
    return wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward()
  }

  goBack(id) {
    const tab = this.tabs.get(id || (this.activeTab() || {}).id)
    if (tab && this.canGoBack(tab)) {
      const wc = tab.view.webContents
      wc.navigationHistory ? wc.navigationHistory.goBack() : wc.goBack()
    }
  }

  goForward(id) {
    const tab = this.tabs.get(id || (this.activeTab() || {}).id)
    if (tab && this.canGoForward(tab)) {
      const wc = tab.view.webContents
      wc.navigationHistory ? wc.navigationHistory.goForward() : wc.goForward()
    }
  }

  reload(hard = false) {
    const tab = this.activeTab()
    if (tab && tab.view) {
      hard ? tab.view.webContents.reloadIgnoringCache() : tab.view.webContents.reload()
    }
  }

  toggleSidebar() {
    this.sidebarOpen = !this.sidebarOpen
    this.layout()
    this.emit()
  }

  layout() {
    const [w, h] = this.win.getContentSize()
    const x = this.sidebarOpen ? SIDEBAR_WIDTH : PAD
    this.contentBounds = {
      x,
      y: PAD,
      width: Math.max(0, w - x - PAD),
      height: Math.max(0, h - PAD * 2)
    }
    if (this.attachedView) this.attachedView.setBounds(this.contentBounds)
  }

  recordVisit(url, title) {
    if (!url || isNewtab(url) || url.startsWith('devtools://') || url.startsWith('about:')) return
    const now = Date.now()
    const existing = this.history.find(h => h.url === url)
    if (existing) {
      existing.count = (existing.count || 1) + 1
      existing.last = now
      if (title && !title.startsWith('http')) existing.title = title
    } else {
      this.history.unshift({ url, title: title || url, count: 1, last: now })
      if (this.history.length > 3000) this.history.length = 3000
    }
  }

  serialize() {
    return {
      sidebarOpen: this.sidebarOpen,
      activeSpaceId: this.activeSpaceId,
      history: this.history.slice(0, 3000),
      spaces: this.spaces.map(s => ({
        id: s.id,
        name: s.name,
        color: s.color,
        activeTabId: s.activeTabId,
        tabs: s.tabIds.map(id => {
          const t = this.tabs.get(id)
          return t ? { id: t.id, url: t.url, title: t.title, favicon: t.favicon, pinned: t.pinned } : null
        }).filter(Boolean)
      }))
    }
  }

  uiState() {
    const active = this.activeTab()
    return {
      sidebarOpen: this.sidebarOpen,
      activeSpaceId: this.activeSpaceId,
      spaces: this.spaces.map(s => ({
        id: s.id,
        name: s.name,
        color: s.color,
        active: s.id === this.activeSpaceId,
        tabs: s.tabIds.map(id => {
          const t = this.tabs.get(id)
          if (!t) return null
          return {
            id: t.id,
            title: isNewtab(t.url) ? 'Nova aba' : t.title,
            url: isNewtab(t.url) ? '' : t.url,
            host: isNewtab(t.url) ? '' : hostOf(t.url),
            favicon: t.favicon,
            pinned: t.pinned,
            loading: t.loading,
            active: s.activeTabId === t.id
          }
        }).filter(Boolean)
      })),
      active: active ? {
        id: active.id,
        url: isNewtab(active.url) ? '' : active.url,
        host: isNewtab(active.url) ? '' : hostOf(active.url),
        secure: (active.url || '').startsWith('https://'),
        loading: active.loading,
        canGoBack: this.canGoBack(active),
        canGoForward: this.canGoForward(active)
      } : null
    }
  }

  emit() {
    clearTimeout(this.emitTimer)
    this.emitTimer = setTimeout(() => {
      if (this.onChange) this.onChange()
    }, 25)
  }
}

module.exports = { TabManager, NEWTAB_URL, SPACE_COLORS, SIDEBAR_WIDTH }
