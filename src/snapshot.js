// Page snapshot with stable refs: an injected walker tags interactive elements
// with data-canopy-ref and returns a compact list the model can act on.
// Stagehand-style act-by-ref without needing the accessibility domain, so it
// works identically through the port and extension transports.

export const SNAPSHOT_JS = `(() => {
  const SEL = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="option"], [role="combobox"], [role="switch"], [role="searchbox"], [role="textbox"], [contenteditable="true"], [onclick], [tabindex]:not([tabindex="-1"])'
  const seen = new Set()
  const els = []
  const isField = el => /^(input|select|textarea)$/i.test(el.tagName) || el.isContentEditable
  const visible = el => {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return null
    if (!isField(el) && (r.bottom < -window.innerHeight || r.top > window.innerHeight * 2)) return null
    const st = getComputedStyle(el)
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) return null
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
    const txt = (el.innerText || el.value || el.title || '').trim()
    if (txt) return txt
    const parentTxt = el.parentElement ? (el.parentElement.innerText || '').trim() : ''
    return parentTxt.length && parentTxt.length <= 60 ? parentTxt : ''
  }
  let n = 0
  for (const el of document.querySelectorAll(SEL)) {
    if (seen.has(el)) continue
    seen.add(el)
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

// Center of a ref's element in viewport coords, scrolling it into view first.
export const refCenterJs = ref => `(() => {
  const el = document.querySelector('[data-canopy-ref="${Number(ref)}"]')
  if (!el) return JSON.stringify({ error: 'ref ${Number(ref)} not found — take a new snapshot' })
  const r0 = el.getBoundingClientRect()
  if (r0.top < 0 || r0.bottom > window.innerHeight) el.scrollIntoView({ block: 'center', behavior: 'instant' })
  const r = el.getBoundingClientRect()
  return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
})()`

export const focusRefJs = ref => `(() => {
  const el = document.querySelector('[data-canopy-ref="${Number(ref)}"]')
  if (!el) return JSON.stringify({ error: 'ref ${Number(ref)} not found — take a new snapshot' })
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
  const r = el.getBoundingClientRect()
  return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
})()`

export function formatSnapshot(snap) {
  const lines = [
    `# ${snap.title}`,
    `url: ${snap.url}`,
    `viewport: ${snap.viewport[0]}x${snap.viewport[1]}  scroll: ${snap.scrollY}/${snap.scrollMax}`,
    `interactive elements (${snap.elements.length}):`
  ]
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
