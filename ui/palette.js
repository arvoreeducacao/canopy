let items = []
let selected = 0
let mode = 'default'
let queryToken = 0

const input = document.getElementById('query')
const resultsEl = document.getElementById('results')
const modeChip = document.getElementById('mode-chip')

const ICONS = {
  globe: '<svg viewBox="0 0 20 20" width="16" height="16"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 10h14M10 3c-2.5 2.3-2.5 11.7 0 14M10 3c2.5 2.3 2.5 11.7 0 14" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  search: '<svg viewBox="0 0 20 20" width="16" height="16"><circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M13.2 13.2L17 17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  tab: '<svg viewBox="0 0 20 20" width="16" height="16"><rect x="2.5" y="4" width="15" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2.5 8h15" stroke="currentColor" stroke-width="1.3"/></svg>',
  action: '<svg viewBox="0 0 20 20" width="16" height="16"><path d="M11 2.5L4 11h5l-1 6.5L15 9h-5l1-6.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  history: '<svg viewBox="0 0 20 20" width="16" height="16"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 6v4.5l3 1.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
}

function render() {
  resultsEl.innerHTML = ''
  items.forEach((item, i) => {
    const row = document.createElement('div')
    row.className = 'result' + (i === selected ? ' selected' : '')

    const icon = document.createElement('div')
    icon.className = 'r-icon'
    if (item.favicon) {
      const img = document.createElement('img')
      img.src = item.favicon
      img.onerror = () => {
        img.remove()
        icon.innerHTML = ICONS[item.kind] || ICONS.globe
      }
      icon.appendChild(img)
    } else {
      icon.innerHTML = ICONS[item.kind] || ICONS.globe
    }
    row.appendChild(icon)

    const body = document.createElement('div')
    body.className = 'r-body'
    const title = document.createElement('div')
    title.className = 'r-title'
    title.textContent = item.title
    body.appendChild(title)
    if (item.subtitle) {
      const sub = document.createElement('div')
      sub.className = 'r-sub'
      sub.textContent = item.subtitle
      body.appendChild(sub)
    }
    row.appendChild(body)

    const hint = document.createElement('div')
    hint.className = 'r-hint'
    hint.textContent = 'Enter'
    row.appendChild(hint)

    row.onmouseenter = () => {
      selected = i
      updateSelection()
    }
    row.onclick = () => run(item)

    resultsEl.appendChild(row)
  })
}

function updateSelection() {
  const rows = resultsEl.querySelectorAll('.result')
  rows.forEach((row, i) => row.classList.toggle('selected', i === selected))
  const active = rows[selected]
  if (active) active.scrollIntoView({ block: 'nearest' })
}

async function query() {
  const token = ++queryToken
  const result = await window.galho.invoke('palette:query', input.value)
  if (token !== queryToken) return
  items = result || []
  selected = 0
  render()
}

function run(item) {
  window.galho.send('palette:run', { item, mode })
}

function close() {
  window.galho.send('palette:hide')
}

input.addEventListener('input', () => query())

input.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selected = Math.min(selected + 1, items.length - 1)
    updateSelection()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    selected = Math.max(selected - 1, 0)
    updateSelection()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (items[selected]) run(items[selected])
    else if (input.value.trim()) run({ type: 'search', url: 'https://www.google.com/search?q=' + encodeURIComponent(input.value.trim()) })
  } else if (e.key === 'Escape') {
    e.preventDefault()
    close()
  }
})

document.getElementById('backdrop').addEventListener('mousedown', e => {
  if (e.target === e.currentTarget) close()
})

window.galho.on('palette:open', data => {
  mode = data.mode || 'default'
  document.documentElement.style.setProperty('--space-color', data.color || '#8B5CF6')
  modeChip.style.display = mode === 'url' ? '' : 'none'
  input.value = data.prefill || ''
  input.focus()
  if (data.prefill) input.select()
  query()
})
