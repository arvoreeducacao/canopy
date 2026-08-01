import fs from 'node:fs'
import path from 'node:path'

// Every session is a folder on disk: actions.jsonl (audit trail) + frames/
// (screencast jpegs) — enough to replay any run in the cockpit, grep it, or
// delete it. Nothing leaves the machine.
export class Recorder {
  constructor(baseDir) {
    this.baseDir = baseDir
    fs.mkdirSync(baseDir, { recursive: true })
    this.lastFrameAt = new Map()
  }

  sessionDir(sessionId) {
    const dir = path.join(this.baseDir, sessionId)
    fs.mkdirSync(path.join(dir, 'frames'), { recursive: true })
    return dir
  }

  writeMeta(session) {
    fs.writeFileSync(path.join(this.sessionDir(session.id), 'meta.json'), JSON.stringify(session, null, 2))
  }

  action(sessionId, entry) {
    const line = JSON.stringify({ ts: Date.now(), ...entry })
    fs.appendFileSync(path.join(this.sessionDir(sessionId), 'actions.jsonl'), line + '\n')
  }

  frame(sessionId, tabId, base64) {
    const key = `${sessionId}:${tabId}`
    const now = Date.now()
    if (now - (this.lastFrameAt.get(key) || 0) < 400) return
    this.lastFrameAt.set(key, now)
    const file = path.join(this.sessionDir(sessionId), 'frames', `${tabId}-${now}.jpg`)
    fs.writeFile(file, Buffer.from(base64, 'base64'), () => {})
  }

  listSessions() {
    if (!fs.existsSync(this.baseDir)) return []
    return fs.readdirSync(this.baseDir)
      .filter(d => fs.existsSync(path.join(this.baseDir, d, 'meta.json')))
      .map(d => {
        try { return JSON.parse(fs.readFileSync(path.join(this.baseDir, d, 'meta.json'), 'utf8')) } catch { return null }
      })
      .filter(Boolean)
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  replay(sessionId) {
    const dir = path.join(this.baseDir, sessionId)
    if (!fs.existsSync(dir)) return null
    let actions = []
    try {
      actions = fs.readFileSync(path.join(dir, 'actions.jsonl'), 'utf8')
        .split('\n').filter(Boolean).map(l => JSON.parse(l))
    } catch {}
    let frames = []
    const framesDir = path.join(dir, 'frames')
    if (fs.existsSync(framesDir)) {
      frames = fs.readdirSync(framesDir).map(f => {
        const m = f.match(/^(.+)-(\d+)\.jpg$/)
        return m ? { tab: m[1], ts: Number(m[2]), file: f } : null
      }).filter(Boolean).sort((a, b) => a.ts - b.ts)
    }
    let meta = null
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) } catch {}
    return { meta, actions, frames }
  }

  framePath(sessionId, file) {
    if (file.includes('..') || file.includes('/')) return null
    const p = path.join(this.baseDir, sessionId, 'frames', file)
    return fs.existsSync(p) ? p : null
  }
}
