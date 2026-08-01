import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

// MCP server over streamable HTTP (stateless): each request gets a fresh
// server wired to the shared controller. Connect from Claude Code with:
//   claude mcp add --transport http canopy http://127.0.0.1:4664/mcp

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
    if (snap.snap.elements.length < 3) {
      await new Promise(r => setTimeout(r, 1500))
      snap = await controller.snapshot(tab.id)
    }
    return text(`tab: ${tab.id}\n\n${snap.text}`)
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
    return text(snapText)
  })

  server.registerTool('browser_snapshot', {
    description: 'Fresh snapshot of a tab: url, title and interactive elements as [ref] lines. Refs go stale after navigation — re-snapshot then.',
    inputSchema: { tab: z.string() }
  }, async ({ tab }) => text((await controller.snapshot(tab)).text))

  server.registerTool('browser_act', {
    description: 'Act on a tab with the animated AI cursor the user can watch. action=click needs ref (or x/y); fill needs ref+text (replaces the field content); press needs key (Enter, Tab, Escape, ArrowDown…); scroll takes dy. Always pass label describing the step in Portuguese.',
    inputSchema: {
      tab: z.string(),
      action: z.enum(['click', 'fill', 'press', 'scroll']),
      ref: z.number().optional().describe('[ref] number from the latest snapshot'),
      x: z.number().optional(), y: z.number().optional(),
      text: z.string().optional(), key: z.string().optional(),
      dy: z.number().optional(),
      button: z.enum(['left', 'right']).optional(), double: z.boolean().optional(),
      label: z.string().optional()
    }
  }, async args => text(await controller.act(args.tab, args)))

  server.registerTool('browser_read', {
    description: 'Read the visible text of the page (innerText, truncated).',
    inputSchema: { tab: z.string(), maxChars: z.number().optional() }
  }, async ({ tab, maxChars }) => text(await controller.readPage(tab, maxChars)))

  server.registerTool('browser_eval', {
    description: 'Code mode: run JavaScript in the page and return the JSON-serializable result. Prefer this over many small acts for extraction and multi-step flows — write one snippet that does the whole job. Await is allowed (the expression may be an async IIFE).',
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
    description: 'PNG screenshot of the tab (works for background tabs). Use to visually verify a step.',
    inputSchema: { tab: z.string() }
  }, async ({ tab }) => ({
    content: [{ type: 'image', data: await controller.screenshot(tab), mimeType: 'image/png' }]
  }))

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
