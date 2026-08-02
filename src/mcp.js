import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

// MCP server over streamable HTTP (stateless): each request gets a fresh
// server wired to the shared controller. Connect from Claude Code with:
//   claude mcp add --transport http canopy http://127.0.0.1:4664/mcp

const PRESETS = {
  phone: { width: 390, height: 844, mobile: true },
  tablet: { width: 820, height: 1180, mobile: true },
  desktop: { width: 1440, height: 900 },
  wide: { width: 1920, height: 1080 }
}

function buildServer(controller) {
  const server = new McpServer({ name: 'canopy', version: '0.1.0' })
  const text = s => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] })

  server.registerTool('browser_status', {
    description: 'State of the Canopy bridge: connected browser, sessions, open agent tabs, cockpit URL. Call this first.',
    inputSchema: {}
  }, async () => text({ ...controller.status(), cockpit: 'http://127.0.0.1:4664/' }))

  server.registerTool('session_start', {
    description: 'Start a named agent session (its own group of tabs, recorded for replay). Use one session per task.',
    inputSchema: { label: z.string().describe('Short human-readable task name, shown in the cockpit') }
  }, async ({ label }) => text(controller.startSession(label)))

  server.registerTool('session_end', {
    description: 'End a session: closes its tabs and finalizes the recording.',
    inputSchema: { session: z.string() }
  }, async ({ session }) => text(await controller.endSession(session)))

  server.registerTool('browser_open', {
    description: 'Open a new tab (background — never steals the user focus) and return its id plus a snapshot of interactive elements with [ref] numbers.',
    inputSchema: {
      url: z.string(),
      session: z.string().optional().describe('Session id from session_start; defaults to "default"'),
      label: z.string().optional().describe('What you are doing, shown to the user in the tab overlay')
    }
  }, async ({ url, session, label }) => {
    const tab = await controller.openTab(url, { session, label })
    await controller.waitFor(tab.id, { until: 'load', timeoutMs: 12000 }).catch(() => {})
    let snap = await controller.snapshot(tab.id)
    if (snap.snap.elements.length < 3 && !tab.navError) {
      // This snapshot is about to be discarded — its errors must not be, or a
      // page with few controls silently loses everything its console said.
      controller.rewindProblems(tab.id, snap.problems)
      await new Promise(r => setTimeout(r, 1500))
      snap = await controller.snapshot(tab.id)
    }
    // A page that never loaded still snapshots fine — as Chrome's error page.
    // Say so up front instead of letting the agent debug a phantom UI.
    const head = tab.navError
      ? `tab: ${tab.id}\n\n⚠ THE PAGE DID NOT LOAD: ${tab.navError} (${tab.navErrorUrl || tab.url}) — check the host/DNS before trying anything in the UI\n`
      : `tab: ${tab.id}\n`
    return text(`${head}\n${snap.text}`)
  })

  server.registerTool('browser_tabs', {
    description: 'List agent tabs (id, url, title, session, control state).',
    inputSchema: { session: z.string().optional() }
  }, async ({ session }) => text(controller.listTabs(session)))

  server.registerTool('browser_navigate', {
    description: 'Navigate an existing tab to a URL.',
    inputSchema: { tab: z.string(), url: z.string(), label: z.string().optional() }
  }, async ({ tab, url, label }) => {
    await controller.navigate(tab, url, { label })
    await controller.waitFor(tab, { until: 'load', timeoutMs: 12000 }).catch(() => {})
    const { text: snapText } = await controller.snapshot(tab)
    const navError = controller.getTab(tab).navError
    return text(navError ? `⚠ THE PAGE DID NOT LOAD: ${navError} — check the host/DNS first\n\n${snapText}` : snapText)
  })

  server.registerTool('browser_snapshot', {
    description: 'Fresh snapshot of a tab: url, title and interactive elements as [ref] lines. Refs go stale after navigation — re-snapshot then.',
    inputSchema: { tab: z.string() }
  }, async ({ tab }) => text((await controller.snapshot(tab)).text))

  server.registerTool('browser_act', {
    description: 'Act on a tab with the animated AI cursor the user can watch — this is the ONLY reliable way to click or type (a synthetic .click() via browser_eval does not fire pointer-event handlers used by most component libraries). action=click needs ref (or x/y); fill needs ref+text (replaces the field content); press needs key (Enter, Tab, Escape, ArrowDown…); scroll takes dy. Always pass label describing the step in Portuguese. The result includes an "after" line saying what actually changed — if it says NO CHANGE DETECTED, do not assume the step worked. Refs that are hidden or covered by an overlay are refused; pass force:true to act anyway.',
    inputSchema: {
      tab: z.string(),
      action: z.enum(['click', 'fill', 'press', 'scroll']),
      ref: z.number().optional().describe('[ref] number from the latest snapshot'),
      x: z.number().optional().describe('CSS pixels, same scale as browser_screenshot'), y: z.number().optional(),
      text: z.string().optional(), key: z.string().optional(),
      dy: z.number().optional(),
      button: z.enum(['left', 'right']).optional(), double: z.boolean().optional(),
      force: z.boolean().optional().describe('Act even if the element looks hidden or covered'),
      verify: z.boolean().optional().describe('Set false to skip the post-action change check (default true)'),
      label: z.string().optional()
    }
  }, async args => text(await controller.act(args.tab, args)))

  server.registerTool('browser_resize', {
    description: 'Resize the tab viewport (emulated — the user\'s window is untouched). Use to test responsive layouts or to get a deterministic viewport before working from coordinates. Pass reset:true to go back to the real window size.',
    inputSchema: {
      tab: z.string(),
      width: z.number().optional(), height: z.number().optional(),
      preset: z.enum(['phone', 'tablet', 'desktop', 'wide']).optional(),
      deviceScaleFactor: z.number().optional().describe('Default 1 — keep it at 1 so screenshot pixels stay 1:1 with click coordinates'),
      mobile: z.boolean().optional().describe('Mobile viewport + touch emulation'),
      reset: z.boolean().optional()
    }
  }, async ({ tab, preset, ...opts }) => {
    const p = preset ? PRESETS[preset] : null
    return text(await controller.resize(tab, { ...p, ...opts }))
  })

  server.registerTool('browser_read', {
    description: 'Read the visible text of the page (innerText, truncated).',
    inputSchema: { tab: z.string(), maxChars: z.number().optional() }
  }, async ({ tab, maxChars }) => text(await controller.readPage(tab, maxChars)))

  server.registerTool('browser_eval', {
    description: 'Code mode: run JavaScript in the page and return the JSON-serializable result. Prefer this over many small acts for READING — extraction, measuring, locating elements (getBoundingClientRect) — and for replaying the page\'s own API with fetch(). Await is allowed (the expression may be an async IIFE). Do NOT drive the UI from here: element.click() and setting .value are synthetic and are ignored by components that listen for pointer/keyboard events — use browser_act for that.',
    inputSchema: { tab: z.string(), code: z.string(), label: z.string().optional() }
  }, async ({ tab, code, label }) => text({ result: await controller.eval(tab, code, { label }) }))

  server.registerTool('browser_wait', {
    description: 'Wait until the page settles: until=load | selector (value=CSS) | text (value=substring) | js (value=expression).',
    inputSchema: {
      tab: z.string(),
      until: z.enum(['load', 'selector', 'text', 'js']).optional(),
      value: z.string().optional(),
      timeoutMs: z.number().optional()
    }
  }, async ({ tab, until, value, timeoutMs }) => {
    await controller.waitFor(tab, { until, value, timeoutMs })
    return text({ ok: true })
  })

  server.registerTool('browser_screenshot', {
    description: 'PNG screenshot of the tab (works for background tabs). Use to visually verify a step. The image is 1:1 with CSS pixels, so coordinates measured on it can be passed straight to browser_act x/y.',
    inputSchema: { tab: z.string(), fullPage: z.boolean().optional().describe('Capture the whole scrollable page instead of the viewport') }
  }, async ({ tab, fullPage }) => {
    const { data, size, viewport } = await controller.screenshot(tab, { fullPage })
    const note = size && viewport && (size.width !== viewport[0] || size.height !== viewport[1])
      ? `image ${size.width}x${size.height} px covering a ${viewport[0]}x${viewport[1]} CSS-pixel area — MULTIPLY image coordinates by ${(viewport[0] / size.width).toFixed(3)} before passing them to browser_act`
      : `image ${size ? `${size.width}x${size.height}` : '?'} px · 1 image pixel = 1 CSS pixel, coordinates map directly to browser_act x/y`
    return { content: [{ type: 'image', data, mimeType: 'image/png' }, { type: 'text', text: note }] }
  })

  server.registerTool('browser_console', {
    description: 'Console messages, uncaught exceptions and failed/4xx-5xx requests captured on the tab. Call this the moment something "just does not happen" — a swallowed catch, a dead API host or a 401 is invisible in the DOM but obvious here. Errors also appear automatically in snapshots and act results.',
    inputSchema: {
      tab: z.string(),
      level: z.enum(['error', 'warn', 'all']).optional().describe('Default error'),
      limit: z.number().optional(),
      clear: z.boolean().optional().describe('Empty the buffer after reading, to isolate what the next step produces')
    }
  }, async ({ tab, level, limit, clear }) => {
    const { messages, omitted } = controller.consoleMessages(tab, { level, limit, clear })
    if (!messages.length) return text('no messages captured at this level')
    const head = omitted ? `showing the ${messages.length} most recent of ${messages.length + omitted} — raise limit to see the older ones\n` : ''
    return text(`${head}${JSON.stringify(messages, null, 2)}`)
  })

  server.registerTool('browser_requests', {
    description: 'List the XHR/Fetch requests the page made (method, url, status, postData). This is the key to cheap automation: perform a UI action once, inspect which API call it triggered, then replay that API directly with browser_eval fetch() — same cookies, no clicking, far fewer tokens. Filter by substring of the URL, method or mime type.',
    inputSchema: { tab: z.string(), filter: z.string().optional(), limit: z.number().optional() }
  }, async ({ tab, filter, limit }) => text(controller.listRequests(tab, { filter, limit })))

  server.registerTool('browser_request_body', {
    description: 'Fetch the full request metadata + response body of a captured request (id from browser_requests). Use it to learn an API\'s shape, then automate via browser_eval fetch().',
    inputSchema: { tab: z.string(), request: z.string().describe('request id from browser_requests') }
  }, async ({ tab, request }) => text(await controller.requestBody(tab, request)))

  server.registerTool('browser_close', {
    description: 'Close an agent tab.',
    inputSchema: { tab: z.string() }
  }, async ({ tab }) => {
    await controller.closeTab(tab)
    return text({ ok: true })
  })

  return server
}

export function mcpHandler(controller) {
  return async (req, res) => {
    const server = buildServer(controller)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      transport.close()
      server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  }
}
