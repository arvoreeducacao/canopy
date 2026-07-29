const { WebContentsView } = require('electron')
const path = require('path')

const WIDTH = 412
const HEIGHT = 172

class PermissionView {
  constructor(win, tabs) {
    this.win = win
    this.tabs = tabs
    this.view = null
    this.visible = false
    this.pending = null
    this.loaded = false
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
    this.view.webContents.loadFile(path.join(__dirname, '..', 'ui', 'permission.html'))
    this.view.webContents.once('did-finish-load', () => {
      this.loaded = true
      if (this.pending) this.view.webContents.send('permission:ask', this.pending.payload)
    })
  }

  ask(payload) {
    if (this.pending) return Promise.resolve(false)
    this.ensure()
    return new Promise(resolve => {
      this.pending = { payload, resolve }
      if (!this.visible) {
        this.win.contentView.addChildView(this.view)
        this.visible = true
      }
      this.layout()
      if (this.loaded) this.view.webContents.send('permission:ask', payload)
      this.view.webContents.focus()
    })
  }

  answer(granted) {
    const current = this.pending
    this.pending = null
    if (this.visible) {
      this.win.contentView.removeChildView(this.view)
      this.visible = false
    }
    const active = this.tabs.activeTab()
    if (active && active.view) active.view.webContents.focus()
    if (current) current.resolve(!!granted)
  }

  layout() {
    if (!this.visible || !this.view) return
    const b = this.tabs.contentBounds
    if (!b) return
    this.view.setBounds({
      x: b.x,
      y: b.y,
      width: Math.min(WIDTH, b.width),
      height: HEIGHT
    })
  }

  destroy() {
    if (this.pending) this.answer(false)
  }
}

module.exports = PermissionView
