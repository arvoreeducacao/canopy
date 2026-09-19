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

// document.activeElement stops at the iframe element, so on a page that hosts
// its form in a subframe it always answers IFRAME and never the field the text
// actually went into. Following it down is also how a keystroke swallowed by an
// autofill menu shows up: the menu is another extension's frame, so the walk
// throws and the answer comes back empty instead of confidently wrong.
export const DEEP_ACTIVE_VALUE = `(() => {
  const find = win => {
    let el = null
    try { el = win.document.activeElement } catch (e) { return null }
    if (el && el.tagName === 'IFRAME') {
      try { return find(el.contentWindow) } catch (e) { return null }
    }
    return el
  }
  const el = find(window)
  if (!el) return null
  return { tag: el.tagName, value: typeof el.value === 'string' ? el.value : null }
})()`
