let state = null
let dragTabId = null
let editingSpaceId = null
let editingFolderId = null
let editingTabId = null

const IS_PEEK = location.hash === '#peek'
if (IS_PEEK) document.body.classList.add('peek')

const el = id => document.getElementById(id)

const SPACE_ICON_PATHS = {
  leaf: 'M8 14V7M8 7c0-2.5 1.5-4.5 4.5-5-.5 3-2 4.5-4.5 5zM8 9c0-2-1.2-3.5-3.5-4 .4 2.3 1.5 3.5 3.5 4z',
  home: 'M3 8l5-5 5 5M4.5 7v6h7V7',
  briefcase: 'M3 5.5h10v7H3zM6 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M3 8.5h10',
  robot: 'M4 6h8v6H4zM8 6V3.5M6.5 9h0M9.5 9h0M2.5 8v2M13.5 8v2',
  book: 'M3 3.5h4a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 0 7 11.5H3zM13 3.5H9A1.5 1.5 0 0 0 7.5 5v8A1.5 1.5 0 0 1 9 11.5h4z',
  bolt: 'M9 2L4 9h3.5L7 14l5-7H8.5L9 2z',
  star: 'M8 2.5l1.6 3.4 3.6.5-2.6 2.5.6 3.6L8 10.8l-3.2 1.7.6-3.6L2.8 6.4l3.6-.5L8 2.5z',
  heart: 'M8 13S2.5 9.5 2.5 6a2.8 2.8 0 0 1 5.5-.8A2.8 2.8 0 0 1 13.5 6c0 3.5-5.5 7-5.5 7z',
  code: 'M5.5 5L2.5 8l3 3M10.5 5l3 3-3 3',
  rocket: 'M8 12c-1-3-1-6 0-9 3 1.5 4 4.5 3 7.5L8 12zM8 12l-2-1.5M8 12l1 2.5M6 10.5l-2.5.5L5 8.5',
  music: 'M6 12.5V4l6-1.5v8.5M6 12.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zM12 11a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z',
  chat: 'M2.5 3.5h11v7h-6L4 13.5v-3H2.5z'
}

function spaceIconSvg(name, size = 13) {
  const d = SPACE_ICON_PATHS[name]
  if (!d) return null
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', size)
  svg.setAttribute('height', size)
  const path = document.createElementNS(ns, 'path')
  path.setAttribute('d', d)
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.4')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  svg.appendChild(path)
  return svg
}

function send(type, data) {
  window.galho.send('ui', { type, ...data })
}

function letterOf(tab) {
  const source = tab.host || tab.title || '?'
  return source.replace(/^www\./, '').charAt(0).toUpperCase()
}

function faviconEl(tab, size) {
  const wrap = document.createElement('div')
  wrap.className = 'icon'
  if (tab.loading) {
    const spinner = document.createElement('div')
    spinner.className = 'spinner'
    wrap.appendChild(spinner)
    return wrap
  }
  if (tab.favicon) {
    const img = document.createElement('img')
    img.src = tab.favicon
    img.onerror = () => {
      img.remove()
      wrap.appendChild(letterEl(tab))
    }
    wrap.appendChild(img)
  } else {
    wrap.appendChild(letterEl(tab))
  }
  return wrap
}

function letterEl(tab) {
  const letter = document.createElement('div')
  letter.className = 'letter'
  letter.textContent = letterOf(tab)
  return letter
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
        tile.appendChild(letterEl(tab))
      }
      tile.appendChild(img)
    } else {
      tile.appendChild(letterEl(tab))
    }
    tile.onclick = () => send('fav:click', { id: tab.id })
    tile.oncontextmenu = e => {
      e.preventDefault()
      send('tab:context', { id: tab.id })
    }
    container.appendChild(tile)
  }
}

function tabRow(tab, index, folderId) {
  const item = document.createElement('div')
  item.className = 'tab' + (tab.active ? ' active' : '') + (folderId ? ' in-folder' : '')
  item.draggable = true
  item.dataset.id = tab.id

  item.appendChild(faviconEl(tab))

  if (editingTabId === tab.id) {
    const input = document.createElement('input')
    input.className = 'rename-input'
    input.style.flex = '1'
    input.value = tab.title || ''
    input.onclick = e => e.stopPropagation()
    input.onblur = () => {
      editingTabId = null
      send('tab:rename', { id: tab.id, name: input.value })
    }
    input.onkeydown = e => {
      if (e.key === 'Enter') input.blur()
      if (e.key === 'Escape') {
        editingTabId = null
        render()
      }
    }
    item.appendChild(input)
    setTimeout(() => {
      input.focus()
      input.select()
    }, 0)
  } else {
    const title = document.createElement('div')
    title.className = 'title'
    title.textContent = tab.title || tab.host || tab.url
    title.ondblclick = e => {
      e.stopPropagation()
      editingTabId = tab.id
      render()
    }
    item.appendChild(title)
  }

  if (state.split && (state.split.mainId === tab.id || state.split.sideId === tab.id)) {
    const badge = document.createElement('div')
    badge.className = 'split-badge'
    badge.title = T('inSplit')
    badge.innerHTML = '<svg viewBox="0 0 16 16" width="11" height="11"><rect x="2" y="3" width="5" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="9" y="3" width="5" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>'
    item.appendChild(badge)
  }

  if (tab.agentActive) {
    const badge = document.createElement('div')
    badge.className = 'agent-badge'
    badge.title = T('agentOnTab')
    item.appendChild(badge)
  }

  const more = document.createElement('button')
  more.className = 'more'
  more.title = T('tabOptions')
  more.innerHTML = '<svg viewBox="0 0 16 16" width="11" height="11"><circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/></svg>'
  more.onclick = e => {
    e.stopPropagation()
    send('tab:context', { id: tab.id })
  }
  item.appendChild(more)

  const close = document.createElement('button')
  close.className = 'close'
  close.title = T('archiveTab')
  close.innerHTML = '<svg viewBox="0 0 16 16" width="10" height="10"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
  close.onclick = e => {
    e.stopPropagation()
    send('tab:archive', { id: tab.id })
  }
  item.appendChild(close)

  item.onclick = () => send('tab:activate', { id: tab.id })
  item.onauxclick = e => {
    if (e.button === 1) send('tab:archive', { id: tab.id })
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
      send('tab:reorder', { id: dragTabId, index: before ? index : index + 1, folderId: folderId || null })
    }
    dragTabId = null
  }

  return item
}

function folderRow(folder) {
  const row = document.createElement('div')
  row.className = 'folder-row'
  row.dataset.id = folder.id

  const chevron = document.createElement('div')
  chevron.className = 'chevron' + (folder.collapsed ? ' collapsed' : '')
  chevron.innerHTML = '<svg viewBox="0 0 16 16" width="10" height="10"><path d="M5.5 3.5L10 8l-4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  row.appendChild(chevron)

  const icon = document.createElement('div')
  icon.className = 'folder-icon'
  icon.innerHTML = folder.live
    ? '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="12" cy="4" r="2.4" fill="#F59E0B" stroke="none"/></svg>'
    : '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>'
  row.appendChild(icon)

  if (editingFolderId === folder.id) {
    const input = document.createElement('input')
    input.className = 'rename-input'
    input.value = folder.name
    input.onblur = () => {
      editingFolderId = null
      send('folder:rename', { id: folder.id, name: input.value })
    }
    input.onkeydown = e => {
      if (e.key === 'Enter') input.blur()
      if (e.key === 'Escape') {
        editingFolderId = null
        render()
      }
    }
    row.appendChild(input)
    setTimeout(() => {
      input.focus()
      input.select()
    }, 0)
  } else {
    const name = document.createElement('div')
    name.className = 'folder-name'
    name.textContent = folder.name
    row.appendChild(name)
  }

  row.onclick = () => {
    if (editingFolderId !== folder.id) send('folder:toggle', { id: folder.id })
  }
  row.ondblclick = () => {
    editingFolderId = folder.id
    render()
  }
  row.oncontextmenu = e => {
    e.preventDefault()
    send('folder:context', { id: folder.id })
  }
  row.ondragover = e => {
    e.preventDefault()
    row.classList.add('drag-over')
  }
  row.ondragleave = () => row.classList.remove('drag-over')
  row.ondrop = e => {
    e.preventDefault()
    row.classList.remove('drag-over')
    if (dragTabId) {
      send('tab:reorder', { id: dragTabId, index: 999, folderId: folder.id })
      dragTabId = null
    }
  }

  return row
}

function linkRow(link) {
  const item = document.createElement('div')
  item.className = 'tab link in-folder'
  const icon = document.createElement('div')
  icon.className = 'icon'
  if (link.favicon) {
    const img = document.createElement('img')
    img.src = link.favicon
    img.onerror = () => {
      img.remove()
      icon.innerHTML = linkGlyph()
    }
    icon.appendChild(img)
  } else {
    icon.innerHTML = linkGlyph()
  }
  item.appendChild(icon)
  const title = document.createElement('div')
  title.className = 'title'
  title.textContent = link.title || link.url
  item.appendChild(title)
  item.title = link.url
  item.onclick = () => send('link:open', { url: link.url })
  return item
}

function linkGlyph() {
  return '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M6.5 9.5l3-3M5 7l-1.8 1.8a2.3 2.3 0 0 0 3.2 3.2L8.2 10M8 6l1.8-1.8a2.3 2.3 0 0 1 3.2 3.2L11 9.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'
}

function renderTabs(space) {
  const container = el('tabs')
  container.innerHTML = ''

  for (const folder of space.folders) {
    container.appendChild(folderRow(folder))
    if (!folder.collapsed) {
      for (const link of folder.links || []) {
        container.appendChild(linkRow(link))
      }
      const members = space.tabs.filter(t => !t.pinned && t.folderId === folder.id)
      members.forEach((tab, index) => container.appendChild(tabRow(tab, index, folder.id)))
    }
  }

  const loose = space.tabs.filter(t => !t.pinned && !t.folderId)
  loose.forEach((tab, index) => container.appendChild(tabRow(tab, index, null)))

  if (space.archivedCount > 0) {
    const row = document.createElement('div')
    row.id = 'archived-row'
    row.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13"><rect x="2" y="3" width="12" height="3.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3.5 6.5V12a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V6.5M6.5 9h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'
    const label = document.createElement('span')
    label.textContent = T('archived', space.archivedCount)
    row.appendChild(label)
    row.onclick = () => send('palette:open', { mode: 'archived' })
    container.appendChild(row)
  }
}

function renderSpaces() {
  const container = el('spaces')
  container.innerHTML = ''
  for (const space of state.spaces) {
    const pill = document.createElement('div')
    pill.className = 'space-pill' + (space.active ? ' active' : '')
    pill.title = space.name

    const iconWrap = document.createElement('div')
    iconWrap.className = 'space-icon'
    iconWrap.style.color = space.color
    const svg = spaceIconSvg(space.icon)
    if (svg) iconWrap.appendChild(svg)
    else {
      const dot = document.createElement('div')
      dot.className = 'dot'
      dot.style.background = space.color
      iconWrap.appendChild(dot)
    }
    pill.appendChild(iconWrap)

    if (space.agentActive && !space.active) {
      const dot = document.createElement('div')
      dot.className = 'agent-dot'
      dot.title = T('agentOnSpace')
      pill.appendChild(dot)
    }

    if (editingSpaceId === space.id) {
      const input = document.createElement('input')
      input.className = 'rename-input'
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
  if (!IS_PEEK) document.body.classList.toggle('sidebar-closed', !state.sidebarOpen)

  const chip = el('urlchip')
  const chipText = el('urlchip-text')
  const lock = el('lock-icon')
  if (state.split && space) {
    const pair = [state.split.mainId, state.split.sideId]
      .map(id => space.tabs.find(t => t.id === id))
      .filter(Boolean)
      .map(t => (t.host || '').replace(/^www\./, ''))
      .filter(Boolean)
    chip.classList.add('has-url')
    chipText.textContent = pair.join('  +  ') || T('splitView')
    lock.style.display = 'none'
  } else if (state.active && state.active.host) {
    chip.classList.add('has-url')
    chipText.textContent = state.active.host.replace(/^www\./, '')
    lock.style.display = state.active.secure ? '' : 'none'
  } else {
    chip.classList.remove('has-url')
    chipText.textContent = T('searchOrOpen')
    lock.style.display = 'none'
  }

  el('nav-back').disabled = !state.active || !state.active.canGoBack
  el('nav-forward').disabled = !state.active || !state.active.canGoForward

  const hint = el('empty-hint')
  hint.style.display = state.active || IS_PEEK ? 'none' : 'flex'
  hint.style.left = state.sidebarOpen ? '300px' : '8px'

  const actions = el('actions')
  if (actions) {
    if (state.active && state.active.wcId != null) actions.setAttribute('tab', state.active.wcId)
    else actions.removeAttribute('tab')
  }

  const divider = el('split-divider')
  if (divider) {
    if (state.split && state.contentBounds && !IS_PEEK) {
      const b = state.contentBounds
      const left = b.x + Math.floor((b.width - 8) * (state.split.ratio || 0.5))
      divider.style.display = 'flex'
      divider.style.left = left + 'px'
      divider.style.top = b.y + 'px'
      divider.style.height = b.height + 'px'
    } else {
      divider.style.display = 'none'
    }
  }

  renderFavorites(space)
  renderTabs(space)
  renderSpaces()
}

window.galho.on('state', s => {
  state = s
  render()
})

window.galho.on('space:edit', data => {
  if (data.folderId) editingFolderId = data.folderId
  else if (data.tabId) editingTabId = data.tabId
  else editingSpaceId = data.id
  render()
})

el('nav-back').onclick = () => send('nav:back')
el('nav-forward').onclick = () => send('nav:forward')
el('nav-reload').onclick = () => send('nav:reload')
el('clean-btn').onclick = () => {
  const space = state && state.spaces.find(s => s.active)
  if (space) send('space:clean', { id: space.id })
}
el('urlchip').onclick = () => send('palette:open', { mode: 'url' })
el('newtab-row').onclick = () => send('palette:open', { mode: 'default' })
el('add-space').onclick = () => send('space:new')
el('split-divider').onmousedown = e => {
  e.preventDefault()
  send('split:dragstart')
}

el('newtab-label').textContent = T('newTab')
el('empty-hint-label').textContent = T('emptyHint')
el('urlchip').title = T('openUrlTip')
el('nav-back').title = T('back')
el('nav-forward').title = T('forward')
el('nav-reload').title = T('reload')
el('clean-btn').title = T('cleanTabs')
el('add-space').title = T('newSpace')

send('state:request')
