const fs = require('fs')
const path = require('path')

class Store {
  constructor(file) {
    this.file = file
    this.data = this.load()
    this.timer = null
    this.pending = null
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      return {}
    }
  }

  save(data) {
    this.pending = data
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 400)
  }

  flush() {
    if (!this.pending) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.pending))
    } catch {}
    this.pending = null
  }
}

module.exports = Store
