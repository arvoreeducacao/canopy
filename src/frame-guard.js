// Password managers (1Password, Dashlane, Bitwarden...) draw their autofill menu
// inside a custom element whose closed shadow root holds a chrome-extension://
// iframe. Chrome refuses chrome.debugger on a tab while a frame of a *different*
// extension is in its frame tree: every CDP command then fails with
// "Cannot access a chrome-extension:// URL of different extension", and the
// session is detached outright. This runs in the page — so it keeps working
// while the debugger is gone — and takes those hosts back out, which is what
// lets the daemon re-attach. It stands down while a human is driving the tab,
// because then the autofill menu is the point.

export const FRAME_GUARD = `(() => {
  const OFFENDING_HOST = /^(com-1password|op-1password|onepassword|com-dashlane|dashlanify|com-lastpass|lastpass-|com-bitwarden|bitwarden-|keeper-|com-keeper|proton-pass|com-roboform)/
  const offends = el => {
    const tag = el.tagName ? el.tagName.toLowerCase() : ''
    if (OFFENDING_HOST.test(tag)) return true
    if (tag !== 'iframe') return false
    const src = (el.getAttribute && el.getAttribute('src')) || ''
    return src.indexOf('chrome-extension://') === 0
  }
  const sweepDoc = doc => {
    const root = doc && doc.documentElement
    if (!root) return
    const stack = [root]
    while (stack.length) {
      const node = stack.pop()
      let kids
      try { kids = node.children } catch (e) { continue }
      if (!kids) continue
      for (const el of kids) {
        if (offends(el)) { try { el.remove() } catch (e) {} ; continue }
        stack.push(el)
        if (el.shadowRoot) stack.push(el.shadowRoot)
      }
    }
  }
  const reachableDocs = (doc, acc, depth) => {
    if (!doc || depth > 4 || acc.indexOf(doc) !== -1) return acc
    acc.push(doc)
    const stack = [doc]
    while (stack.length) {
      const node = stack.pop()
      let kids
      try { kids = node.children } catch (e) { continue }
      if (!kids) continue
      for (const el of kids) {
        if (el.tagName && el.tagName.toLowerCase() === 'iframe') {
          try { if (el.contentDocument) reachableDocs(el.contentDocument, acc, depth + 1) } catch (e) {}
        }
        stack.push(el)
        if (el.shadowRoot) stack.push(el.shadowRoot)
      }
    }
    return acc
  }
  const sweep = () => {
    if (window.__canopyHumanDriving) return
    for (const doc of reachableDocs(document, [], 0)) {
      sweepDoc(doc)
      try {
        if (!doc.__canopyFrameGuardWatching && doc.documentElement) {
          doc.__canopyFrameGuardWatching = true
          new MutationObserver(() => sweep()).observe(doc.documentElement, { childList: true, subtree: true })
        }
      } catch (e) {}
    }
  }
  if (window.__canopyFrameGuard) { sweep(); return }
  window.__canopyFrameGuard = true
  const start = () => {
    sweep()
    const timer = setInterval(sweep, 400)
    if (timer && timer.unref) timer.unref()
  }
  if (document.documentElement) start()
  else document.addEventListener('readystatechange', start, { once: true })
})()`

export function humanDrivingJs(driving) {
  return `window.__canopyHumanDriving = ${driving ? 'true' : 'false'}`
}

// document.activeElement stops at the boundary of whatever hosts the field. On
// a page that keeps its form in a subframe it answers IFRAME; on a page built
// out of custom elements it answers the host and never the <input> inside its
// shadow root. Both are the ordinary case, not the exotic one — a server-driven
// ERP screen is a tree of custom elements whose real inputs all live in shadow
// roots — so the walk goes down both kinds of boundary. Stopping early is how a
// fill reads back the wrong element and reports text that was never typed.
const DEEP_ACTIVE_FN = `
  const deepActive = () => {
    let el = null
    try { el = document.activeElement } catch (e) { return null }
    for (let hops = 0; el && hops < 20; hops++) {
      if (el.tagName === 'IFRAME') {
        let inner = null
        try { inner = el.contentDocument && el.contentDocument.activeElement } catch (e) { return null }
        if (!inner || inner === el) return el
        el = inner
        continue
      }
      let shadowed = null
      try { shadowed = el.shadowRoot && el.shadowRoot.activeElement } catch (e) { shadowed = null }
      if (!shadowed || shadowed === el) return el
      el = shadowed
    }
    return el
  }
`

// Following focus down is also how a keystroke swallowed by an autofill menu
// shows up: the menu is another extension's frame, so the walk throws and the
// answer comes back empty instead of confidently wrong.
export const DEEP_ACTIVE_VALUE = `(() => {${DEEP_ACTIVE_FN}
  const el = deepActive()
  if (!el) return null
  return { tag: el.tagName, value: typeof el.value === 'string' ? el.value : null }
})()`

// Selecting what the field already holds is what makes a fill REPLACE instead
// of append. A triple click used to do it, and it also delivered a dblclick to
// the page — which a widget is free to read as its own gesture and answer by
// moving focus somewhere else entirely. Everything typed afterwards then goes
// nowhere. Selecting from script keeps the replace and delivers no gesture at
// all, and it reaches into subframes and shadow roots, where a top-document
// activeElement.select() never could.
export const DEEP_ACTIVE_SELECT = `(() => {${DEEP_ACTIVE_FN}
  const el = deepActive()
  if (!el) return null
  try {
    if (typeof el.select === 'function') el.select()
    else if (el.isContentEditable) {
      const doc = el.ownerDocument
      const range = doc.createRange()
      range.selectNodeContents(el)
      const sel = doc.defaultView.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
    }
  } catch (e) {}
  return el.tagName
})()`
