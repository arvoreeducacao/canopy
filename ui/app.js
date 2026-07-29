let state = null
let dragTabId = null
let editingSpaceId = null

const el = id => document.getElementById(id)

function send(type, data) {
  window.galho.send('ui', { type, ...data })
}

function letterOf(tab) {
  const source = tab.host || tab.title || '?'
  return source.replace(/^www\./, '').charAt(0).toUpperCase()
}

function iconFor(tab) {
  const icon = document.createElement('div')
  icon.className = 'icon'
  if (tab.loading) {
    const spinner = document.createElement('div')
    spinner.className = 'spinner'
    icon.appendChild(spinner)
  } else if (tab.favicon) {
    const img = document.createElement('img')
    img.src = tab.favicon
    img.onerror = () => {
      img.remove()
      const letter = document.createElement('div')
      letter.className = 'letter'
      letter.textContent = letterOf(tab)
      icon.appendChild(letter)
    }
    icon.appendChild(img)
  } else {
    const letter = document.createElement('div')
    letter.className = 'letter'
    letter.textContent = letterOf(tab)
    icon.appendChild(letter)
  }
  return icon
}

function renderFavorites(space) {
  const container = el('favorites')
  container.innerHTML = ''
  for (const tab of space.tabs.filter(t => t.pinned)) {
    const tile = document.createElement('div')
    tile.className = 'fav-tile' + (tab.active ? ' active' : '')
    tile.title = tab.title
    if (tab.favicon) {
      const img = document.createElement('img')
      img.src = tab.favicon
      img.onerror = () => {
        img.remove()
        const letter = document.createElement('div')
        letter.className = 'letter'
        letter.textContent = letterOf(tab)
        tile.appendChild(letter)
      }
      tile.appendChild(img)
    } else {
      const letter = document.createElement('div')
      letter.className = 'letter'
      letter.textContent = letterOf(tab)
      tile.appendChild(letter)
    }
    tile.onclick = () => send('tab:activate', { id: tab.id })
    tile.oncontextmenu = e => {
      e.preventDefault()
      send('tab:context', { id: tab.id })
    }
    container.appendChild(tile)
  }
}

function renderTabs(space) {
  const container = el('tabs')
  container.innerHTML = ''
  const list = space.tabs.filter(t => !t.pinned)
  list.forEach((tab, index) => {
    const item = document.createElement('div')
    item.className = 'tab' + (tab.active ? ' active' : '')
    item.draggable = true
    item.dataset.id = tab.id
    item.dataset.index = index

    item.appendChild(iconFor(tab))

    const title = document.createElement('div')
    title.className = 'title'
    title.textContent = tab.title || tab.host || 'Nova aba'
    item.appendChild(title)

    const close = document.createElement('button')
    close.className = 'close'
    close.innerHTML = '<svg viewBox="0 0 16 16" width="10" height="10"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
    close.onclick = e => {
      e.stopPropagation()
      send('tab:close', { id: tab.id })
    }
    item.appendChild(close)

    item.onclick = () => send('tab:activate', { id: tab.id })
    item.onauxclick = e => {
      if (e.button === 1) send('tab:close', { id: tab.id })
    }
    item.oncontextmenu = e => {
      e.preventDefault()
      send('tab:context', { id: tab.id })
    }

    item.ondragstart = () => { dragTabId = tab.id }
    item.ondragover = e => {
      e.preventDefault()
      const rect = item.getBoundingClientRect()
      const before = e.clientY < rect.top + rect.height / 2
      item.classList.toggle('drag-over-before', before)
      item.classList.toggle('drag-over-after', !before)
    }
    item.ondragleave = () => {
      item.classList.remove('drag-over-before', 'drag-over-after')
    }
    item.ondrop = e => {
      e.preventDefault()
      const rect = item.getBoundingClientRect()
      const before = e.clientY < rect.top + rect.height / 2
      item.classList.remove('drag-over-before', 'drag-over-after')
      if (dragTabId && dragTabId !== tab.id) {
        send('tab:reorder', { id: dragTabId, index: before ? index : index + 1 })
      }
      dragTabId = null
    }

    container.appendChild(item)
  })
}

function renderSpaces() {
  const container = el('spaces')
  container.innerHTML = ''
  for (const space of state.spaces) {
    const pill = document.createElement('div')
    pill.className = 'space-pill' + (space.active ? ' active' : '')
    pill.title = space.name

    const dot = document.createElement('div')
    dot.className = 'dot'
    dot.style.background = space.color
    pill.appendChild(dot)

    if (editingSpaceId === space.id) {
      const input = document.createElement('input')
      input.value = space.name
      input.onblur = () => {
        editingSpaceId = null
        send('space:rename', { id: space.id, name: input.value })
      }
      input.onkeydown = e => {
        if (e.key === 'Enter') input.blur()
        if (e.key === 'Escape') {
          editingSpaceId = null
          render()
        }
      }
      pill.appendChild(input)
      setTimeout(() => {
        input.focus()
        input.select()
      }, 0)
    } else {
      const name = document.createElement('span')
      name.className = 'name'
      name.textContent = space.name
      pill.appendChild(name)
    }

    pill.onclick = () => {
      if (editingSpaceId !== space.id) send('space:switch', { id: space.id })
    }
    pill.ondblclick = () => {
      editingSpaceId = space.id
      render()
    }
    pill.oncontextmenu = e => {
      e.preventDefault()
      send('space:context', { id: space.id })
    }

    container.appendChild(pill)
  }
}

function render() {
  if (!state) return
  const space = state.spaces.find(s => s.active) || state.spaces[0]
  if (!space) return

  document.documentElement.style.setProperty('--space-color', space.color)

  const chip = el('urlchip')
  const chipText = el('urlchip-text')
  const lock = el('lock-icon')
  if (state.active && state.active.host) {
    chip.classList.add('has-url')
    chipText.textContent = state.active.host.replace(/^www\./, '')
    lock.style.display = state.active.secure ? '' : 'none'
  } else {
    chip.classList.remove('has-url')
    chipText.textContent = 'Buscar ou abrir URL...'
    lock.style.display = 'none'
  }

  el('nav-back').disabled = !state.active || !state.active.canGoBack
  el('nav-forward').disabled = !state.active || !state.active.canGoForward

  renderFavorites(space)
  renderTabs(space)
  renderSpaces()
}

window.galho.on('state', s => {
  state = s
  render()
})

window.galho.on('space:edit', ({ id }) => {
  editingSpaceId = id
  render()
})

el('nav-back').onclick = () => send('nav:back')
el('nav-forward').onclick = () => send('nav:forward')
el('nav-reload').onclick = () => send('nav:reload')
el('urlchip').onclick = () => send('palette:open', { mode: 'url' })
el('newtab-row').onclick = () => send('palette:open', { mode: 'default' })
el('add-space').onclick = () => send('space:new')

send('state:request')
