// In-page agent overlay, ported from an earlier Electron prototype's agent-api.js cursorSetup().
// Injected via Runtime.evaluate on every driven tab. The pill's Take over / Stop
// buttons call the CDP binding __canopyControl (Runtime.addBinding) so the daemon
// hears them in both port mode and extension (chrome.debugger) mode.

export const OVERLAY_SETUP = `(() => {
  // Navigations from about:blank reuse the window but replace the document —
  // rebuild whenever our elements are no longer connected to the live DOM.
  if (window.__canopyCursor && window.__canopyCursor.el && window.__canopyCursor.el.isConnected) return
  delete window.__canopyCursor
  const cursor = document.createElement('div')
  cursor.id = '__canopy_cursor'
  cursor.style.cssText = 'position:fixed;z-index:2147483647;width:24px;height:24px;pointer-events:none;left:50%;top:40%;transition:left 0.4s cubic-bezier(0.2,0.7,0.3,1),top 0.4s cubic-bezier(0.2,0.7,0.3,1),opacity 0.3s;opacity:0'
  const halo = document.createElement('div')
  halo.style.cssText = 'position:absolute;left:-9px;top:-9px;width:30px;height:30px;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,0.55),transparent 70%);filter:blur(7px);opacity:0.7'
  const arrow = document.createElement('div')
  arrow.style.cssText = 'position:absolute;left:0;top:0;width:19px;height:24px;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.4))'
  const svgNs = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(svgNs, 'svg')
  svg.setAttribute('viewBox', '0 0 19 24')
  svg.setAttribute('width', '19')
  svg.setAttribute('height', '24')
  const arrowPath = document.createElementNS(svgNs, 'path')
  arrowPath.setAttribute('d', 'M1 1v17.5l4.6-4.2 3 7.2 3.4-1.4-3-7.1h6.5z')
  arrowPath.setAttribute('fill', '#FFFFFF')
  arrowPath.setAttribute('stroke', '#1B1B22')
  arrowPath.setAttribute('stroke-width', '1.4')
  arrowPath.setAttribute('stroke-linejoin', 'round')
  svg.appendChild(arrowPath)
  arrow.appendChild(svg)
  cursor.appendChild(halo)
  cursor.appendChild(arrow)
  const veil = document.createElement('div')
  veil.id = '__canopy_veil'
  veil.style.cssText = 'position:fixed;inset:0;z-index:2147483645;pointer-events:none;background-color:rgba(12,8,24,0.28);opacity:0;transition:opacity 0.5s'
  // Presence glow, Dia/Apple-Intelligence style: a huge conic gradient slowly
  // rotating behind an edge-band mask, blurred and breathing — light flowing
  // around the viewport border instead of anything blinking in unison.
  const glow = document.createElement('div')
  glow.id = '__canopy_glow'
  glow.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;opacity:0;transition:opacity 0.6s;overflow:hidden;padding:16px;' +
    'mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0);' +
    '-webkit-mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0)'
  const swirl = document.createElement('div')
  swirl.style.cssText = 'position:absolute;left:50%;top:50%;width:220vmax;height:220vmax;margin:-110vmax 0 0 -110vmax;border-radius:50%;filter:blur(18px);' +
    'background:conic-gradient(from 0deg,rgba(255,178,36,0.85),rgba(255,207,107,0.35) 12%,transparent 30%,rgba(61,220,133,0.6) 44%,transparent 58%,rgba(255,178,36,0.75) 72%,transparent 88%,rgba(255,178,36,0.85));' +
    'animation:__canopy_swirl 9s linear infinite,__canopy_breathe 3.6s ease-in-out infinite'
  const ring = document.createElement('div')
  ring.style.cssText = 'position:absolute;inset:0;box-shadow:inset 0 0 0 1px rgba(255,255,255,0.20),inset 0 0 34px rgba(255,178,36,0.10)'
  glow.appendChild(swirl)
  glow.appendChild(ring)
  const pill = document.createElement('div')
  pill.id = '__canopy_pill'
  pill.style.cssText = 'position:fixed;z-index:2147483647;left:50%;bottom:26px;transform:translateX(-50%) translateY(8px);display:flex;align-items:center;gap:12px;padding:10px 12px 10px 16px;border-radius:15px;border:1px solid rgba(255,255,255,0.16);background:rgba(22,20,32,0.96);box-shadow:0 12px 40px rgba(0,0,0,0.45);font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;opacity:0;pointer-events:none;transition:opacity 0.4s,transform 0.4s'
  const spinner = document.createElement('div')
  spinner.style.cssText = 'width:14px;height:14px;border-radius:50%;border:2px solid rgba(255,255,255,0.85);border-top-color:transparent;animation:__canopy_spin 0.9s linear infinite'
  const KEYFRAMES = '@keyframes __canopy_spin{to{transform:rotate(360deg)}}' +
    '@keyframes __canopy_swirl{to{transform:rotate(360deg)}}' +
    '@keyframes __canopy_breathe{0%,100%{opacity:0.55}50%{opacity:1}}' +
    '@keyframes __canopy_keypop{0%{transform:translateY(8px) scale(.9);opacity:0}12%{transform:translateY(0) scale(1);opacity:1}82%{opacity:1}100%{opacity:0}}' +
    '@keyframes __canopy_pillpulse{0%,100%{transform:translateX(-50%) translateY(0) scale(1)}50%{transform:translateX(-50%) translateY(0) scale(1.05)}}'
  // A <style> element is subject to the page's CSP (style-src) and silently
  // dies on strict sites, killing every animation. Constructed stylesheets are
  // CSSOM and bypass CSP; keep the <style> path only as a fallback.
  let styleEl = null
  try {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(KEYFRAMES)
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
  } catch {
    styleEl = document.createElement('style')
    styleEl.textContent = KEYFRAMES
  }
  const textWrap = document.createElement('div')
  const labelEl = document.createElement('div')
  labelEl.style.cssText = 'font-size:13px;font-weight:600;color:rgba(250,248,255,0.95);max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
  labelEl.textContent = 'Agent'
  const subEl = document.createElement('div')
  subEl.style.cssText = 'font-size:11px;color:rgba(250,248,255,0.55)'
  subEl.textContent = 'Agent in control'
  textWrap.appendChild(labelEl)
  textWrap.appendChild(subEl)
  const notify = action => {
    try { window.__canopyControl && window.__canopyControl(JSON.stringify({ action })) } catch {}
  }
  const btn = (label, color, action) => {
    const b = document.createElement('button')
    b.textContent = label
    b.style.cssText = 'border:none;border-radius:9px;padding:7px 12px;font-size:12px;font-weight:600;font-family:inherit;background:rgba(255,255,255,0.12);color:' + color + ';cursor:pointer'
    b.onmouseenter = () => { b.style.background = 'rgba(255,255,255,0.2)' }
    b.onmouseleave = () => { b.style.background = 'rgba(255,255,255,0.12)' }
    b.onclick = e => {
      e.stopPropagation()
      notify(action)
      window.__canopyCursor.hide()
    }
    return b
  }
  pill.appendChild(spinner)
  pill.appendChild(textWrap)
  pill.appendChild(btn('Take over', 'rgba(250,248,255,0.95)', 'takeover'))
  pill.appendChild(btn('Stop', '#F87171', 'stop'))
  const keys = document.createElement('div')
  keys.id = '__canopy_keys'
  keys.style.cssText = 'position:fixed;z-index:2147483647;right:22px;bottom:26px;display:flex;flex-direction:column-reverse;gap:8px;pointer-events:none;font-family:ui-monospace,SF Mono,Menlo,monospace'
  if (document.documentElement) {
    if (styleEl) document.documentElement.appendChild(styleEl)
    document.documentElement.appendChild(veil)
    document.documentElement.appendChild(glow)
    document.documentElement.appendChild(cursor)
    document.documentElement.appendChild(pill)
    document.documentElement.appendChild(keys)
  }
  // While the agent owns the tab, human input is blocked to avoid conflicts —
  // the daemon opens __canopyAllow only around its own CDP dispatches. The pill
  // stays interactive so the human can always Take over / Stop.
  const guardHandler = e => {
    if (!window.__canopyCursor || !window.__canopyCursor.guarding) return
    if (window.__canopyAllow) return
    if (pill.contains(e.target)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    pill.style.animation = 'none'
    void pill.offsetWidth
    pill.style.animation = '__canopy_pillpulse 0.45s ease'
  }
  for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'wheel', 'keydown', 'keypress', 'keyup', 'touchstart']) {
    window.addEventListener(type, guardHandler, { capture: true, passive: false })
  }
  window.__canopyCursor = {
    el: cursor,
    glow,
    veil,
    pill,
    labelEl,
    keys,
    guarding: false,
    timer: null,
    // KeyCastr-style HUD: shows what the agent typed/pressed, bottom-right.
    key(txt) {
      const cap = document.createElement('div')
      cap.textContent = txt
      cap.style.cssText = 'padding:8px 14px;border-radius:10px;background:rgba(22,20,32,0.96);border:1px solid rgba(255,255,255,0.2);color:rgba(250,248,255,0.95);font-size:13px;font-weight:600;box-shadow:0 8px 30px rgba(0,0,0,0.5),inset 0 -2px 0 rgba(255,255,255,0.08);animation:__canopy_keypop 1.4s ease forwards;max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;align-self:flex-end'
      keys.appendChild(cap)
      while (keys.children.length > 3) keys.firstChild.remove()
      setTimeout(() => cap.remove(), 1450)
    },
    // While the agent owns the tab, veil + glow + pill stay on permanently —
    // the whole tab visibly belongs to the AI. The cursor surfaces on actions.
    presence(label) {
      if (label) labelEl.textContent = label
      this.guarding = true
      veil.style.opacity = '1'
      glow.style.opacity = '1'
      pill.style.opacity = '1'
      pill.style.pointerEvents = 'auto'
      pill.style.transform = 'translateX(-50%) translateY(0)'
    },
    show(label) {
      this.presence(label)
      cursor.style.opacity = '1'
      clearTimeout(this.timer)
      this.timer = setTimeout(() => {
        cursor.style.opacity = '0'
      }, 2600)
    },
    hide() {
      this.guarding = false
      cursor.style.opacity = '0'
      glow.style.opacity = '0'
      veil.style.opacity = '0'
      pill.style.opacity = '0'
      pill.style.pointerEvents = 'none'
      pill.style.transform = 'translateX(-50%) translateY(8px)'
    },
    move(x, y, label) {
      this.show(label)
      cursor.style.left = x + 'px'
      cursor.style.top = y + 'px'
    },
    ripple(x, y) {
      const r = document.createElement('div')
      r.style.cssText = 'position:fixed;z-index:2147483647;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;pointer-events:none;border:2.5px solid rgba(255,255,255,0.85);left:' + x + 'px;top:' + y + 'px;transform:scale(1);opacity:1;transition:transform 0.45s ease-out,opacity 0.45s ease-out'
      document.documentElement.appendChild(r)
      requestAnimationFrame(() => {
        r.style.transform = 'scale(3.2)'
        r.style.opacity = '0'
      })
      setTimeout(() => r.remove(), 500)
    }
  }
})()`

// "AI is driving this tab": title gets an "AI ·" prefix and the favicon becomes
// an animated amber spinner (canvas-drawn, ego-lite style). The interval
// re-asserts both every tick, so pages that swap their own favicon/title
// (SPAs, HN, GitHub) can't undo the badge while the agent owns the tab.
export const BADGE_ON = `(() => {
  // Same window-reuse caveat as the overlay: only skip if the badge is truly
  // alive in THIS document; otherwise rebuild from scratch.
  if (window.__canopyBadgeKeep && window.__canopyBadge && window.__canopyBadge.link && window.__canopyBadge.link.isConnected) return
  if (window.__canopyBadgeKeep) clearInterval(window.__canopyBadgeKeep)
  if (window.__canopyBadge && !(window.__canopyBadge.link && window.__canopyBadge.link.isConnected)) delete window.__canopyBadge
  if (!window.__canopyBadge) {
    window.__canopyBadge = { title: document.title, icons: [] }
    document.querySelectorAll('link[rel*="icon"]').forEach(l => {
      window.__canopyBadge.icons.push({ el: l, href: l.href })
      l.remove()
    })
    const link = document.createElement('link')
    link.rel = 'icon'
    link.id = '__canopy_favicon'
    document.head && document.head.appendChild(link)
    window.__canopyBadge.link = link
  }
  const PREFIX = 'AI \\u00B7 '
  // Static AI sparkle favicon, drawn once. Chrome throttles rapid favicon
  // swaps (animated spinners were flaky per-site), so the favicon marks
  // OWNERSHIP with the universal AI symbol; motion lives in the page overlay.
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  const sparkle = (cx, cy, r, fill) => {
    ctx.beginPath()
    ctx.moveTo(cx, cy - r)
    ctx.quadraticCurveTo(cx + r * 0.16, cy - r * 0.16, cx + r, cy)
    ctx.quadraticCurveTo(cx + r * 0.16, cy + r * 0.16, cx, cy + r)
    ctx.quadraticCurveTo(cx - r * 0.16, cy + r * 0.16, cx - r, cy)
    ctx.quadraticCurveTo(cx - r * 0.16, cy - r * 0.16, cx, cy - r)
    ctx.closePath()
    ctx.fillStyle = fill
    ctx.fill()
  }
  ctx.shadowColor = 'rgba(245,158,11,0.55)'
  ctx.shadowBlur = 7
  sparkle(28, 36, 24, '#F59E0B')
  ctx.shadowBlur = 4
  sparkle(48, 15, 11, '#FCD34D')
  const ICON = canvas.toDataURL('image/png')
  const setIcon = () => {
    const cur = document.getElementById('__canopy_favicon')
    if (cur && cur.isConnected && cur.href === ICON) return
    if (cur) cur.remove()
    const l = document.createElement('link')
    l.id = '__canopy_favicon'
    l.rel = 'icon'
    l.type = 'image/png'
    l.href = ICON
    if (document.head) document.head.appendChild(l)
    window.__canopyBadge.link = l
  }
  const assert = () => {
    if (!window.__canopyBadge) return
    // pages re-adding their own icon links would win — keep stashing them
    document.querySelectorAll('link[rel*="icon"]:not(#__canopy_favicon)').forEach(l => {
      window.__canopyBadge.icons.push({ el: l, href: l.href })
      l.remove()
    })
    setIcon()
    if (!document.title.startsWith(PREFIX)) {
      window.__canopyBadge.title = document.title
      document.title = PREFIX + document.title
    }
  }
  assert()
  window.__canopyBadgeKeep = setInterval(assert, 800)
})()`

export const BADGE_OFF = `(() => {
  if (window.__canopyBadgeKeep) clearInterval(window.__canopyBadgeKeep)
  if (window.__canopyBadge) {
    document.title = window.__canopyBadge.title.replace(/^AI \\u00B7 /, '')
    if (window.__canopyBadge.link) window.__canopyBadge.link.remove()
    for (const { el, href } of window.__canopyBadge.icons) {
      el.href = href
      document.head && document.head.appendChild(el)
    }
    delete window.__canopyBadge
    delete window.__canopyBadgeKeep
  }
  if (window.__canopyCursor) window.__canopyCursor.hide()
})()`

export function cursorCall(method, args = []) {
  return `window.__canopyCursor && window.__canopyCursor.${method}(${args.join(',')})`
}
