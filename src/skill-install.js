const fs = require('fs')
const path = require('path')
const os = require('os')

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(from, to)
    else fs.writeFileSync(to, fs.readFileSync(from))
  }
}

function installSkill() {
  const source = path.join(__dirname, '..', 'skill')
  const sourceManifest = path.join(source, 'SKILL.md')
  if (!fs.existsSync(sourceManifest)) return false

  const claudeDir = path.join(os.homedir(), '.claude')
  if (!fs.existsSync(claudeDir)) return false

  const target = path.join(claudeDir, 'skills', 'galho')
  const targetManifest = path.join(target, 'SKILL.md')
  if (fs.existsSync(targetManifest)) {
    const current = fs.readFileSync(targetManifest, 'utf8')
    const next = fs.readFileSync(sourceManifest, 'utf8')
    if (current === next) return false
  }

  copyDir(source, target)
  return true
}

module.exports = { installSkill }

if (require.main === module) {
  try {
    const installed = installSkill()
    if (installed) console.log('galho: skill instalada em ~/.claude/skills/galho')
  } catch (err) {
    console.error('galho: falha ao instalar skill:', err.message)
  }
}
