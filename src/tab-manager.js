const { WebContentsView, Menu, clipboard, nativeTheme } = require('electron')
const crypto = require('crypto')
const path = require('path')
const { t } = require('./i18n')

const SPACE_COLORS = ['#8B5CF6', '#0EA5E9', '#10B981', '#F59E0B', '#EF4444', '#EC4899', '#14B8A6', '#6366F1']
const SPACE_ICONS = ['leaf', 'home', 'briefcase', 'robot', 'book', 'bolt', 'star', 'heart', 'code', 'rocket', 'music', 'chat']
const SIDEBAR_WIDTH = 300
const PAD = 8
const SPLIT_GAP = 8
const ARCHIVE_AFTER_MS = 12 * 60 * 60 * 1000

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

class TabManager {
  constructor(win, data, sharedHistory, onChange, hooks, boosts) {
    this.win = win
    this.onChange = onChange
    this.hooks = hooks || {}
    this.boosts = boosts || {}
    this.history = sharedHistory
    this.tabs = new Map()
    this.spaces = []
    this.closedStack = []
    this.attachedViews = []
    this.split = null
    this.splitRatio = 0.5
    this.emitTimer = null

    this.sidebarOpen = data.sidebarOpen !== false

    for (const s of data.spaces || []) {
      const space = {
        id: s.id || shortId(),
        name: s.name || t('spaceFallback'),
        color: s.color || SPACE_COLORS[0],
        icon: s.icon || null,
        archiveAfterMs: typeof s.archiveAfterMs === 'number' ? s.archiveAfterMs : null,
        folders: (s.folders || []).map(f => ({
          id: f.id || shortId(),
          name: f.name || t('folder'),
          collapsed: !!f.collapsed,
          live: !!f.live,
          links: Array.isArray(f.links) ? f.links : []
        })),
        archived: Array.isArray(s.archived) ? s.archived : [],
        tabIds: [],
        activeTabId: null
      }
      for (const t of s.tabs || []) {
        if (!t.url || t.url.startsWith('file://')) continue
        const tab = this.makeRecord({
          id: t.id,
          url: t.url,
          title: t.title,
          favicon: t.favicon,
          pinned: t.pinned,
          pinnedUrl: t.pinnedUrl,
          customTitle: t.customTitle,
          folderId: t.folderId,
          spaceId: space.id
        })
        space.tabIds.push(tab.id)
      }
      if (s.activeTabId && space.tabIds.includes(s.activeTabId)) space.activeTabId = s.activeTabId
      else space.activeTabId = space.tabIds[0] || null
      this.spaces.push(space)
    }

    if (!this.spaces.length) this.seed()

    const wanted = data.activeSpaceId
    this.activeSpaceId = this.spaces.find(s => s.id === wanted) ? wanted : this.spaces[0].id
  }

  restoreActive() {
    this.activateSpace(this.activeSpaceId)
  }

  seed() {
    this.spaces.push(
      { id: shortId(), name: t('seedPersonal'), color: '#8B5CF6', icon: 'leaf', archiveAfterMs: null, folders: [], archived: [], tabIds: [], activeTabId: null },
      { id: shortId(), name: t('seedWork'), color: '#14B8A6', icon: 'briefcase', archiveAfterMs: null, folders: [], archived: [], tabIds: [], activeTabId: null }
    )
  }

  makeRecord({ id, url, title, favicon, pinned, pinnedUrl, customTitle, folderId, spaceId }) {
    const tab = {
      id: id || shortId(),
      url,
      title: title || hostOf(url) || url,
      customTitle: customTitle || null,
      favicon: favicon || null,
      pinned: !!pinned,
      pinnedUrl: pinnedUrl || null,
      folderId: folderId || null,
      spaceId,
      loading: false,
      lastActiveAt: Date.now(),
      agentUntil: 0,
      agentLabel: null,
      agentTakenOver: false,
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
        preload: path.join(__dirname, 'tab-preload.js')
      }
    })
    view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1B1B22' : '#FFFFFF')
    if (typeof view.setBorderRadius === 'function') {
      try { view.setBorderRadius(10) } catch {}
    }
    tab.view = view
    this.wire(tab)
    if (this.hooks.viewCreated) this.hooks.viewCreated(tab, this.win)
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
      if (url.includes('/ui/error.html')) return
      tab.url = url
      this.recordVisit(url, tab.title)
      this.emit()
    })

    wc.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3 || !failedUrl || failedUrl.includes('/ui/error.html')) return
      const errorUrl = 'file://' + path.join(__dirname, '..', 'ui', 'error.html') +
        '?u=' + encodeURIComponent(failedUrl) + '&d=' + encodeURIComponent(desc || String(code))
      wc.loadURL(errorUrl).catch(() => {})
      tab.url = failedUrl
      this.emit()
    })

    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) {
        tab.url = url
        this.emit()
      }
    })

    wc.on('did-finish-load', () => {
      const boost = this.boosts[hostOf(tab.url)]
      if (boost) {
        if (boost.css) wc.insertCSS(boost.css).catch(() => {})
        if (boost.js) wc.executeJavaScript(boost.js, true).catch(() => {})
      }
    })

    wc.on('focus', () => {
      tab.lastActiveAt = Date.now()
    })

    wc.setWindowOpenHandler(details => {
      const activate = details.disposition !== 'background-tab'
      this.createTab({ url: details.url, spaceId: tab.spaceId, activate })
      return { action: 'deny' }
    })

    wc.on('context-menu', (_e, params) => {
      this.showPageContextMenu(tab, params)
    })
  }

  showPageContextMenu(tab, params) {
    const wc = tab.view.webContents
    const template = []
    if (params.linkURL) {
      template.push(
        { label: t('openLinkNewTab'), click: () => this.createTab({ url: params.linkURL, spaceId: tab.spaceId, activate: false }) },
        { label: t('openLinkSplit'), click: () => { const created = this.createTab({ url: params.linkURL, spaceId: tab.spaceId, activate: false }); this.openSplit(tab.id, created.id) } },
        { label: t('copyLink'), click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' }
      )
    }
    if (params.selectionText) {
      template.push(
        { role: 'copy', label: t('copy') },
        { label: t('searchSelection', params.selectionText.slice(0, 30)), click: () => this.createTab({ url: 'https://www.google.com/search?q=' + encodeURIComponent(params.selectionText), spaceId: tab.spaceId }) },
        { type: 'separator' }
      )
    }
    if (params.isEditable) {
      template.push({ role: 'cut', label: t('cut') }, { role: 'copy', label: t('copy') }, { role: 'paste', label: t('paste') }, { type: 'separator' })
    }
    if (params.mediaType === 'video') {
      template.push({ label: t('pip'), click: () => this.togglePip() }, { type: 'separator' })
    }
    template.push(
      { label: t('back'), enabled: this.canGoBack(tab), click: () => this.goBack(tab.id) },
      { label: t('forward'), enabled: this.canGoForward(tab), click: () => this.goForward(tab.id) },
      { label: t('reload'), click: () => wc.reload() },
      { type: 'separator' },
      { label: t('inspect'), click: () => wc.inspectElement(params.x, params.y) }
    )
    const menu = Menu.buildFromTemplate(template)
    if (this.hooks.contextMenuItems) {
      try {
        const items = this.hooks.contextMenuItems(wc, params)
        if (items && items.length) {
          menu.insert(0, new (require('electron').MenuItem)({ type: 'separator' }))
          items.reverse().forEach(item => menu.insert(0, item))
        }
      } catch {}
    }
    menu.popup({ window: this.win })
  }

  createTab({ url, spaceId, activate = true, pinned = false, folderId = null, afterId } = {}) {
    if (!url) return null
    const space = this.spaces.find(s => s.id === spaceId) || this.activeSpace()
    const tab = this.makeRecord({ url, pinned, folderId, spaceId: space.id })
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
    if (space.id !== this.activeSpaceId) {
      this.activeSpaceId = space.id
      if (this.split) this.split = null
    }
    if (this.split) {
      if (id !== this.split.mainId && id !== this.split.sideId) {
        this.split.mainId = id
      }
    }
    space.activeTabId = id
    tab.lastActiveAt = Date.now()
    this.syncViews()
    tab.view.webContents.focus()
    if (this.hooks.tabActivated) this.hooks.tabActivated(tab, this.win)
    this.emit()
  }

  activateSpace(id) {
    const space = this.spaces.find(s => s.id === id)
    if (!space) return
    if (this.activeSpaceId !== id && this.split) this.split = null
    this.activeSpaceId = id
    if (space.activeTabId || space.tabIds.length) {
      this.activateTab(space.activeTabId || space.tabIds[0])
      return
    }
    this.syncViews()
    this.emit()
  }

  syncViews() {
    const space = this.activeSpace()
    const needed = []
    if (space) {
      if (this.split) {
        const main = this.tabs.get(this.split.mainId)
        const side = this.tabs.get(this.split.sideId)
        if (main) needed.push(this.ensureView(main))
        if (side) needed.push(this.ensureView(side))
      } else if (space.activeTabId) {
        const tab = this.tabs.get(space.activeTabId)
        if (tab) needed.push(this.ensureView(tab))
      }
    }
    for (const view of this.attachedViews) {
      if (!needed.includes(view)) this.win.contentView.removeChildView(view)
    }
    for (const view of needed) {
      if (!this.attachedViews.includes(view)) this.win.contentView.addChildView(view)
    }
    this.attachedViews = needed
    this.layout()
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
    const b = this.contentBounds
    if (this.split && this.attachedViews.length === 2) {
      const left = Math.floor((b.width - SPLIT_GAP) * this.splitRatio)
      this.attachedViews[0].setBounds({ x: b.x, y: b.y, width: left, height: b.height })
      this.attachedViews[1].setBounds({ x: b.x + left + SPLIT_GAP, y: b.y, width: b.width - left - SPLIT_GAP, height: b.height })
    } else if (this.attachedViews.length) {
      this.attachedViews[0].setBounds(b)
    }
  }

  setSplitRatio(ratio) {
    if (!this.split) return
    this.splitRatio = Math.min(0.8, Math.max(0.2, ratio))
    this.layout()
    this.emit()
  }

  swapSplit() {
    if (!this.split) return
    this.split = { mainId: this.split.sideId, sideId: this.split.mainId }
    const space = this.activeSpace()
    if (space && (space.activeTabId === this.split.sideId)) space.activeTabId = this.split.mainId
    this.syncViews()
    this.emit()
  }

  openSplit(mainId, sideId) {
    const main = this.tabs.get(mainId)
    const side = this.tabs.get(sideId)
    if (!main || !side || mainId === sideId) return
    if (side.spaceId !== main.spaceId) this.moveTabToSpace(sideId, main.spaceId)
    this.splitRatio = 0.5
    this.split = { mainId, sideId }
    const space = this.spaceOf(main)
    this.activeSpaceId = space.id
    space.activeTabId = mainId
    this.syncViews()
    this.emit()
  }

  closeSplit() {
    if (!this.split) return
    this.split = null
    this.syncViews()
    this.emit()
  }

  closeTab(id) {
    const tab = this.tabs.get(id)
    if (!tab) return
    const space = this.spaceOf(tab)
    this.closedStack.push({ url: tab.url, title: tab.title, pinned: tab.pinned, spaceId: tab.spaceId })
    if (this.closedStack.length > 50) this.closedStack.shift()
    this.removeTab(tab, { destroy: true })
    if (space && space.id === this.activeSpaceId && !space.activeTabId) {
      const next = space.tabIds[space.tabIds.length - 1]
      if (next) {
        this.activateTab(next)
        return
      }
    }
    this.syncViews()
    this.emit()
  }

  removeTab(tab, { destroy }) {
    const space = this.spaceOf(tab)
    if (this.split && (this.split.mainId === tab.id || this.split.sideId === tab.id)) this.split = null
    if (space) {
      const idx = space.tabIds.indexOf(tab.id)
      space.tabIds = space.tabIds.filter(t => t !== tab.id)
      if (space.activeTabId === tab.id) {
        space.activeTabId = space.tabIds[Math.min(Math.max(idx - 1, 0), space.tabIds.length - 1)] || null
      }
    }
    if (tab.view) {
      if (this.attachedViews.includes(tab.view)) {
        this.win.contentView.removeChildView(tab.view)
        this.attachedViews = this.attachedViews.filter(v => v !== tab.view)
      }
      if (destroy) {
        try { tab.view.webContents.close() } catch {}
      }
    }
    this.tabs.delete(tab.id)
  }

  archiveTab(id) {
    const tab = this.tabs.get(id)
    if (!tab) return
    const space = this.spaceOf(tab)
    if (space) {
      space.archived.unshift({ url: tab.url, title: tab.title, favicon: tab.favicon, archivedAt: Date.now() })
      if (space.archived.length > 200) space.archived.length = 200
    }
    this.removeTab(tab, { destroy: true })
    if (space && space.id === this.activeSpaceId && !space.activeTabId && space.tabIds.length) {
      this.activateTab(space.tabIds[space.tabIds.length - 1])
      return
    }
    this.syncViews()
    this.emit()
  }

  archiveAllUnpinned(spaceId) {
    const space = this.spaces.find(s => s.id === spaceId) || this.activeSpace()
    if (!space) return
    for (const id of [...space.tabIds]) {
      const tab = this.tabs.get(id)
      if (tab && !tab.pinned) this.archiveTab(id)
    }
  }

  sleepIdleViews(maxIdleMs = 45 * 60 * 1000) {
    const now = Date.now()
    for (const tab of this.tabs.values()) {
      if (!tab.view || tab.pinned) continue
      if (this.attachedViews.includes(tab.view)) continue
      if (now - tab.lastActiveAt < maxIdleMs) continue
      if (now < tab.agentUntil + 10 * 60 * 1000) continue
      try {
        if (tab.view.webContents.isCurrentlyAudible()) continue
      } catch {}
      try { tab.view.webContents.close() } catch {}
      tab.view = null
      tab.loading = false
    }
  }

  autoArchive() {
    const now = Date.now()
    for (const space of this.spaces) {
      if (space.name === 'Agentes') continue
      if (space.archiveAfterMs === 0) continue
      const maxAge = space.archiveAfterMs || ARCHIVE_AFTER_MS
      for (const id of [...space.tabIds]) {
        const tab = this.tabs.get(id)
        if (!tab || tab.pinned) continue
        if (space.activeTabId === id && space.id === this.activeSpaceId) continue
        if (now - tab.lastActiveAt > maxAge) this.archiveTab(id)
      }
    }
  }

  restoreArchived(spaceId, index) {
    const space = this.spaces.find(s => s.id === spaceId)
    if (!space || !space.archived[index]) return
    const item = space.archived.splice(index, 1)[0]
    this.createTab({ url: item.url, spaceId: space.id, activate: true })
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
    const tab = this.tabs.get(id || (this.activeTab() || {}).id)
    if (!tab) return
    tab.pinned = !tab.pinned
    if (tab.pinned) {
      tab.folderId = null
      tab.pinnedUrl = tab.url
    } else {
      tab.pinnedUrl = null
    }
    this.emit()
  }

  favClick(id) {
    const tab = this.tabs.get(id)
    if (!tab) return
    const isActive = this.activeTab() === tab
    if (isActive && tab.pinnedUrl && tab.url !== tab.pinnedUrl) {
      this.navigate(id, tab.pinnedUrl)
      return
    }
    this.activateTab(id)
  }

  renameTab(id, name) {
    const tab = this.tabs.get(id)
    if (!tab) return
    tab.customTitle = name && name.trim() ? name.trim() : null
    this.emit()
  }

  setSpaceArchiveAfter(id, ms) {
    const space = this.spaces.find(s => s.id === id)
    if (space) {
      space.archiveAfterMs = ms
      this.emit()
    }
  }

  togglePip() {
    const tab = this.activeTab()
    if (!tab || !tab.view) return
    tab.view.webContents.executeJavaScript(`(async () => {
      if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return 'exit' }
      const videos = [...document.querySelectorAll('video')]
      const video = videos.find(v => !v.paused) || videos[0]
      if (!video) return 'no-video'
      await video.requestPictureInPicture()
      return 'ok'
    })()`, true).catch(() => {})
  }

  moveTabToSpace(id, spaceId) {
    const tab = this.tabs.get(id)
    const target = this.spaces.find(s => s.id === spaceId)
    if (!tab || !target || tab.spaceId === spaceId) return
    if (this.split && (this.split.mainId === id || this.split.sideId === id)) this.split = null
    const source = this.spaceOf(tab)
    if (source) {
      const wasActive = source.activeTabId === id
      source.tabIds = source.tabIds.filter(t => t !== id)
      if (wasActive) source.activeTabId = source.tabIds[0] || null
    }
    tab.spaceId = target.id
    tab.folderId = null
    target.tabIds.push(id)
    if (!target.activeTabId) target.activeTabId = id
    if (source && source.id === this.activeSpaceId) this.syncViews()
    this.emit()
  }

  reorderTab(id, index, folderId = null) {
    const tab = this.tabs.get(id)
    if (!tab) return
    const space = this.spaceOf(tab)
    if (!space) return
    if (folderId && !space.folders.find(f => f.id === folderId)) folderId = null
    tab.folderId = folderId
    if (tab.pinned) tab.pinned = false
    const siblings = space.tabIds.filter(tid => {
      const t = this.tabs.get(tid)
      return t && tid !== id && !t.pinned && (t.folderId || null) === (folderId || null)
    })
    const anchor = siblings[Math.max(0, Math.min(index, siblings.length))]
    const rest = space.tabIds.filter(t => t !== id)
    let pos = anchor ? rest.indexOf(anchor) : rest.length
    if (index >= siblings.length) pos = anchor ? rest.indexOf(anchor) + 1 : rest.length
    rest.splice(pos, 0, id)
    space.tabIds = rest
    this.emit()
  }

  createFolder(spaceId, name, { live = false, links = [] } = {}) {
    const space = this.spaces.find(s => s.id === spaceId) || this.activeSpace()
    if (!space) return null
    const folder = { id: shortId(), name: name || t('folder'), collapsed: false, live, links }
    space.folders.push(folder)
    this.emit()
    return folder
  }

  findFolder(folderId) {
    for (const space of this.spaces) {
      const folder = space.folders.find(f => f.id === folderId)
      if (folder) return { space, folder }
    }
    return null
  }

  renameFolder(folderId, name) {
    const found = this.findFolder(folderId)
    if (found && name && name.trim()) {
      found.folder.name = name.trim()
      this.emit()
    }
  }

  toggleFolderCollapse(folderId) {
    const found = this.findFolder(folderId)
    if (found) {
      found.folder.collapsed = !found.folder.collapsed
      this.emit()
    }
  }

  setFolderLinks(folderId, links) {
    const found = this.findFolder(folderId)
    if (found && Array.isArray(links)) {
      found.folder.links = links.slice(0, 100)
      found.folder.live = true
      this.emit()
    }
  }

  deleteFolder(folderId, { closeTabs = false } = {}) {
    const found = this.findFolder(folderId)
    if (!found) return
    const { space, folder } = found
    for (const id of [...space.tabIds]) {
      const tab = this.tabs.get(id)
      if (tab && tab.folderId === folderId) {
        if (closeTabs) this.closeTab(id)
        else tab.folderId = null
      }
    }
    space.folders = space.folders.filter(f => f.id !== folderId)
    this.emit()
  }

  moveTabToFolder(tabId, folderId) {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    if (folderId) {
      const found = this.findFolder(folderId)
      if (!found || found.space.id !== tab.spaceId) return
      tab.pinned = false
    }
    tab.folderId = folderId
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

  createSpace(name, color, icon) {
    const usedColors = new Set(this.spaces.map(s => s.color))
    const usedIcons = new Set(this.spaces.map(s => s.icon))
    const freeColor = SPACE_COLORS.find(c => !usedColors.has(c)) || SPACE_COLORS[this.spaces.length % SPACE_COLORS.length]
    const freeIcon = SPACE_ICONS.find(i => !usedIcons.has(i)) || SPACE_ICONS[this.spaces.length % SPACE_ICONS.length]
    const space = {
      id: shortId(),
      name: name || `${t('spaceFallback')} ${this.spaces.length + 1}`,
      color: color || freeColor,
      icon: icon || freeIcon,
      folders: [],
      archived: [],
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

  setSpaceIcon(id, icon) {
    const space = this.spaces.find(s => s.id === id)
    if (space) {
      space.icon = icon
      this.emit()
    }
  }

  deleteSpace(id) {
    if (this.spaces.length < 2) return
    const space = this.spaces.find(s => s.id === id)
    if (!space) return
    for (const tabId of [...space.tabIds]) {
      const tab = this.tabs.get(tabId)
      if (tab) this.removeTab(tab, { destroy: true })
    }
    this.spaces = this.spaces.filter(s => s.id !== id)
    if (this.activeSpaceId === id) this.activateSpace(this.spaces[0].id)
    else this.emit()
  }

  navigate(id, url) {
    const tab = this.tabs.get(id)
    if (!tab) return
    tab.url = url
    this.ensureView(tab)
    tab.view.webContents.loadURL(url).catch(() => {})
    this.emit()
  }

  agentPulse(id, label) {
    const tab = this.tabs.get(id)
    if (!tab) return
    tab.agentUntil = Date.now() + 15000
    if (label) tab.agentLabel = label
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
    this.animateLayout()
    this.emit()
  }

  animateLayout(duration = 190) {
    clearInterval(this.animTimer)
    const [w, h] = this.win.getContentSize()
    const fromX = this.contentBounds ? this.contentBounds.x : (this.sidebarOpen ? PAD : SIDEBAR_WIDTH)
    const toX = this.sidebarOpen ? SIDEBAR_WIDTH : PAD
    if (fromX === toX) {
      this.layout()
      return
    }
    const start = Date.now()
    this.animTimer = setInterval(() => {
      const raw = Math.min(1, (Date.now() - start) / duration)
      const eased = 1 - Math.pow(1 - raw, 3)
      const x = Math.round(fromX + (toX - fromX) * eased)
      this.contentBounds = { x, y: PAD, width: Math.max(0, w - x - PAD), height: Math.max(0, h - PAD * 2) }
      const b = this.contentBounds
      if (this.split && this.attachedViews.length === 2) {
        const half = Math.floor((b.width - SPLIT_GAP) / 2)
        this.attachedViews[0].setBounds({ x: b.x, y: b.y, width: half, height: b.height })
        this.attachedViews[1].setBounds({ x: b.x + half + SPLIT_GAP, y: b.y, width: b.width - half - SPLIT_GAP, height: b.height })
      } else if (this.attachedViews.length) {
        this.attachedViews[0].setBounds(b)
      }
      if (raw >= 1) {
        clearInterval(this.animTimer)
        this.layout()
      }
    }, 16)
  }

  recordVisit(url, title) {
    if (!url || url.startsWith('file://') || url.startsWith('devtools://') || url.startsWith('about:')) return
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

  destroy() {
    for (const tab of this.tabs.values()) {
      if (tab.view) {
        try { tab.view.webContents.close() } catch {}
      }
    }
    this.tabs.clear()
  }

  serialize() {
    return {
      sidebarOpen: this.sidebarOpen,
      activeSpaceId: this.activeSpaceId,
      spaces: this.spaces.map(s => ({
        id: s.id,
        name: s.name,
        color: s.color,
        icon: s.icon,
        archiveAfterMs: s.archiveAfterMs,
        folders: s.folders,
        archived: s.archived,
        activeTabId: s.activeTabId,
        tabs: s.tabIds.map(id => {
          const t = this.tabs.get(id)
          return t ? { id: t.id, url: t.url, title: t.title, customTitle: t.customTitle, favicon: t.favicon, pinned: t.pinned, pinnedUrl: t.pinnedUrl, folderId: t.folderId } : null
        }).filter(Boolean)
      }))
    }
  }

  uiState() {
    const active = this.activeTab()
    const now = Date.now()
    const tabInfo = t => ({
      id: t.id,
      title: t.customTitle || t.title,
      url: t.url,
      host: hostOf(t.url),
      favicon: t.favicon,
      pinned: t.pinned,
      folderId: t.folderId,
      loading: t.loading,
      agentActive: now < t.agentUntil,
      active: this.spaceOf(t) && this.spaceOf(t).activeTabId === t.id
    })
    return {
      sidebarOpen: this.sidebarOpen,
      activeSpaceId: this.activeSpaceId,
      split: this.split ? { ...this.split, ratio: this.splitRatio } : null,
      contentBounds: this.contentBounds || null,
      spaces: this.spaces.map(s => ({
        id: s.id,
        name: s.name,
        color: s.color,
        icon: s.icon,
        active: s.id === this.activeSpaceId,
        agentActive: s.tabIds.some(id => {
          const t = this.tabs.get(id)
          return t && now < t.agentUntil
        }),
        archivedCount: s.archived.length,
        folders: s.folders.map(f => ({ id: f.id, name: f.name, collapsed: f.collapsed, live: f.live, links: f.links })),
        tabs: s.tabIds.map(id => {
          const t = this.tabs.get(id)
          return t ? tabInfo(t) : null
        }).filter(Boolean)
      })),
      active: active ? {
        id: active.id,
        wcId: active.view ? active.view.webContents.id : null,
        url: active.url,
        host: hostOf(active.url),
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

module.exports = { TabManager, SPACE_COLORS, SPACE_ICONS, SIDEBAR_WIDTH }
