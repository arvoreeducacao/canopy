const { WebContentsView } = require('electron')
const path = require('path')

const BAR_WIDTH = 320
const BAR_HEIGHT = 48

class FindController {
  constructor(win, tabs) {
    this.win = win
    this.tabs = tabs
    this.view = null
    this.visible = false
    this.query = ''
    this.boundWc = null
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
    this.loaded = false
    this.view.webContents.loadFile(path.join(__dirname, '..', 'ui', 'findbar.html'))
    this.view.webContents.once('did-finish-load', () => {
      this.loaded = true
      if (this.visible) {
        this.view.webContents.send('find:open', {})
        this.view.webContents.focus()
      }
    })
  }

  bind(wc) {
    if (this.boundWc === wc) return
    this.unbind()
    this.boundWc = wc
    this.foundListener = (_e, result) => {
      if (this.visible && this.view) {
        this.view.webContents.send('find:result', {
          active: result.activeMatchOrdinal,
          total: result.matches
        })
      }
    }
    wc.on('found-in-page', this.foundListener)
  }

  unbind() {
    if (this.boundWc && this.foundListener) {
      this.boundWc.removeListener('found-in-page', this.foundListener)
    }
    this.boundWc = null
    this.foundListener = null
  }

  open() {
    const tab = this.tabs.activeTab()
    if (!tab || !tab.view) return
    this.ensure()
    if (!this.visible) {
      this.win.contentView.addChildView(this.view)
      this.visible = true
    }
    this.bind(tab.view.webContents)
    this.layout()
    this.view.webContents.send('find:open', {})
    this.view.webContents.focus()
  }

  close() {
    if (!this.visible) return
    if (this.boundWc) {
      try { this.boundWc.stopFindInPage('clearSelection') } catch {}
    }
    this.unbind()
    this.win.contentView.removeChildView(this.view)
    this.visible = false
    this.query = ''
    const tab = this.tabs.activeTab()
    if (tab && tab.view) tab.view.webContents.focus()
  }

  find(query, { forward = true, findNext = false } = {}) {
    if (!this.boundWc) return
    this.query = query
    if (!query) {
      try { this.boundWc.stopFindInPage('clearSelection') } catch {}
      if (this.view) this.view.webContents.send('find:result', { active: 0, total: 0 })
      return
    }
    this.boundWc.findInPage(query, { forward, findNext })
  }

  layout() {
    if (!this.visible || !this.view || !this.tabs.contentBounds) return
    const b = this.tabs.contentBounds
    this.view.setBounds({
      x: Math.max(b.x, b.x + b.width - BAR_WIDTH - 16),
      y: b.y + 10,
      width: BAR_WIDTH,
      height: BAR_HEIGHT
    })
  }
}

module.exports = FindController
