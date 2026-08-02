// Page snapshot with stable refs: an injected walker tags interactive elements
// with data-canopy-ref and returns a compact list the model can act on.
// Act-by-ref without needing the accessibility domain, so it
// works identically through the port and extension transports.

const SEL = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="option"], [role="combobox"], [role="switch"], [role="searchbox"], [role="textbox"], [contenteditable="true"], [onclick], [tabindex]:not([tabindex="-1"])'

export const SNAPSHOT_JS = `(() => {
  const SEL = ${JSON.stringify(SEL)}
  const seen = new Set()
  const els = []
  const isField = el => /^(input|select|textarea)$/i.test(el.tagName) || el.isContentEditable
  const visible = el => {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return null
    if (!isField(el) && (r.bottom < -window.innerHeight || r.top > window.innerHeight * 2)) return null
    const st = getComputedStyle(el)
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) return null
    // The element's own style is not enough: a closed modal usually lives in a
    // portal whose WRAPPER is opacity:0 / visibility:hidden / inert, while the
    // buttons inside it look perfectly normal. Listing those is how an agent
    // ends up clicking a dialog that is not on screen.
    if (el.closest('[aria-hidden="true"], [inert], [hidden]')) return null
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return null
    return r
  }
  const nameOf = el => {
    const aria = el.getAttribute('aria-label')
    if (aria) return aria
    if (el.labels && el.labels.length) return el.labels[0].innerText
    const ph = el.getAttribute('placeholder')
    if (ph) return ph
    const alt = el.querySelector && el.querySelector('img[alt]')
    if (alt && alt.alt) return alt.alt
    // An unlabelled password box has no innerText, so el.value would become its
    // accessible name and the password would ship in the snapshot — the one
    // thing we promise never to capture. The value check below is not enough on
    // its own; the name is a second way out.
    if (el.type === 'password') return 'password'
    const txt = (el.innerText || el.value || el.title || '').trim()
    if (txt) return txt
    const parentTxt = el.parentElement ? (el.parentElement.innerText || '').trim() : ''
    return parentTxt.length && parentTxt.length <= 60 ? parentTxt : ''
  }
  let n = 0
  const pill = document.getElementById('__canopy_pill')
  for (const el of document.querySelectorAll(SEL)) {
    if (seen.has(el)) continue
    seen.add(el)
    // Our own Take over / Stop buttons are not part of the page — listing them
    // invites the agent to click Stop on itself.
    if (pill && pill.contains(el)) continue
    const r = visible(el)
    if (!r) continue
    n += 1
    el.setAttribute('data-canopy-ref', String(n))
    const tag = el.tagName.toLowerCase()
    const entry = {
      ref: n,
      tag,
      role: el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'input' ? (el.type || 'text') : tag),
      name: nameOf(el).slice(0, 90).replace(/\\s+/g, ' '),
      box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
    }
    if (tag === 'a' && el.href) entry.href = el.href.slice(0, 160)
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (el.type !== 'password' && el.value) entry.value = String(el.value).slice(0, 60)
      if (el.checked !== undefined && (el.type === 'checkbox' || el.type === 'radio')) entry.checked = el.checked
      if (el.disabled) entry.disabled = true
    }
    if (els.length < 180 || isField(el)) els.push(entry)
  }
  return JSON.stringify({
    url: location.href,
    title: document.title,
    scrollY: Math.round(window.scrollY),
    scrollMax: Math.max(0, Math.round((document.documentElement.scrollHeight || 0) - window.innerHeight)),
    viewport: [window.innerWidth, window.innerHeight],
    elements: els
  })
})()`

// Shared prelude for the ref helpers: describe an element in one line, and
// answer "if I click this point, what actually receives the event?".
const HIT_JS = `
  const describe = el => {
    if (!el) return 'nothing'
    let s = '<' + el.tagName.toLowerCase()
    if (el.id) s += '#' + el.id
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/)[0] : ''
    if (cls) s += '.' + cls
    s += '>'
    const txt = (el.getAttribute && el.getAttribute('aria-label')) || (el.innerText || '').trim()
    if (txt) s += ' "' + txt.replace(/\\s+/g, ' ').slice(0, 40) + '"'
    return s
  }
  // elementFromPoint stops at a shadow host and never sees our own overlay as
  // a target (it is pointer-events:none), except the control pill, which is
  // ours and must not be mistaken for the page covering the element.
  const hitAt = (x, y) => {
    let node = document.elementFromPoint(x, y)
    while (node && node.shadowRoot) {
      const inner = node.shadowRoot.elementFromPoint(x, y)
      if (!inner || inner === node) break
      node = inner
    }
    if (node && node.closest && node.closest('#__canopy_pill, #__canopy_cursor, #__canopy_veil, #__canopy_glow, #__canopy_keys')) return null
    return node
  }
  const probe = el => {
    const r = el.getBoundingClientRect()
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2)
    const out = { x, y, desc: describe(el) }
    const shown = el.checkVisibility
      ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })
      : !!(r.width && r.height)
    if (!shown || !r.width || !r.height || el.closest('[aria-hidden="true"], [inert], [hidden]')) out.hidden = true
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) out.blocked = 'a point outside the viewport'
    else {
      const hit = hitAt(x, y)
      if (hit && !el.contains(hit) && !hit.contains(el)) out.blocked = describe(hit)
    }
    return out
  }`

// Center of a ref's element in viewport coords, scrolling it into view first.
export const refCenterJs = ref => `(() => {
  const el = document.querySelector('[data-canopy-ref="${Number(ref)}"]')
  if (!el) return JSON.stringify({ error: 'ref ${Number(ref)} not found — take a new snapshot' })
  ${HIT_JS}
  const r0 = el.getBoundingClientRect()
  if (r0.top < 0 || r0.bottom > window.innerHeight) el.scrollIntoView({ block: 'center', behavior: 'instant' })
  return JSON.stringify(probe(el))
})()`

export const focusRefJs = ref => `(() => {
  const el = document.querySelector('[data-canopy-ref="${Number(ref)}"]')
  if (!el) return JSON.stringify({ error: 'ref ${Number(ref)} not found — take a new snapshot' })
  ${HIT_JS}
  el.scrollIntoView({ block: 'center', behavior: 'instant' })
  el.focus()
  if (el.select) el.select()
  else if (el.isContentEditable) {
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
  }
  const out = probe(el)
  out.focused = document.activeElement === el
  return JSON.stringify(out)
})()`

// Fingerprint used before/after an action to answer "did the page react?".
// The text is hashed, not just measured: swapping "nada ainda" for "salvo" is
// a real reaction that a length comparison alone would call "no change".
export const PROBE_JS = `(() => {
  const a = document.activeElement
  const body = document.body ? document.body.innerText : ''
  let sig = 0
  for (let i = 0; i < body.length; i++) sig = (Math.imul(sig, 31) + body.charCodeAt(i)) | 0
  // A modal that opens by flipping a class changes no text and no nodes — the
  // only thing that moves is how many controls are actually actionable.
  let acts = 0
  for (const el of document.querySelectorAll(${JSON.stringify(SEL)})) {
    if (el.closest('#__canopy_pill, [aria-hidden="true"], [inert], [hidden]')) continue
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) continue
    const r = el.getBoundingClientRect()
    if (r.width >= 2 && r.height >= 2) acts += 1
  }
  return JSON.stringify({
    acts,
    url: location.href,
    title: document.title.replace(/^AI \\u00B7 /, ''),
    len: body.length,
    sig,
    nodes: document.body ? document.body.getElementsByTagName('*').length : 0,
    dialogs: document.querySelectorAll('dialog[open], [role="dialog"]:not([aria-hidden="true"]), [role="alertdialog"]:not([aria-hidden="true"])').length,
    active: a && a !== document.body ? a.tagName.toLowerCase() + (a.id ? '#' + a.id : '') : null
  })
})()`

// Console errors and dead requests, printed where the agent cannot miss them.
export function formatProblems(problems = []) {
  if (!problems.length) return ''
  const lines = [`⚠ ${problems.length} error(s) since the last check (browser_console for the full log):`]
  for (const p of problems.slice(-8)) {
    lines.push(`  [${p.source || 'console'}] ${p.text}${p.count > 1 ? ` (x${p.count})` : ''}`)
  }
  return lines.join('\n')
}

export function formatSnapshot(snap, problems = []) {
  const lines = [
    `# ${snap.title}`,
    `url: ${snap.url}`,
    `viewport: ${snap.viewport[0]}x${snap.viewport[1]}  scroll: ${snap.scrollY}/${snap.scrollMax}`
  ]
  if (problems.length) lines.push('', formatProblems(problems), '')
  lines.push(`interactive elements (${snap.elements.length}):`)
  for (const el of snap.elements) {
    let line = `[${el.ref}] ${el.role}`
    if (el.name) line += ` "${el.name}"`
    if (el.value !== undefined) line += ` value="${el.value}"`
    if (el.checked !== undefined) line += el.checked ? ' checked' : ' unchecked'
    if (el.disabled) line += ' disabled'
    if (el.href) line += ` -> ${el.href}`
    lines.push(line)
  }
  return lines.join('\n')
}
