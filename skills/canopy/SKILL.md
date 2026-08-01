---
name: canopy
description: Drive the user's real browser (Arc/Chrome) through the Canopy daemon — open tabs in parallel that never steal focus, act with a visible AI cursor the user can watch in a live cockpit, mine the page's API calls to build cheap automations, and replay every session. Use whenever a task involves a website, the user's logged-in sessions, form filling, scraping, or testing a web app. Triggers: "abre no browser", "usa meu login", "preenche o form", "pega os dados do site", "automatiza isso", any browser task.
metadata:
  version: "0.1.0"
---

# canopy

MCP server `canopy` at `http://127.0.0.1:4664/mcp` (add once: `claude mcp add --transport http canopy http://127.0.0.1:4664/mcp`). If `browser_status` fails, start it: `node ~/Arvore/canopy/bin/canopy.js --launch-chrome &` — the user can also watch everything at `http://127.0.0.1:4664/`.

## Golden rules

1. **One session per task**: `session_start {label}` → open tabs with that session id → `session_end` when done. The label shows up in the user's cockpit and in the recorded replay — write it in the user's language, describing the task ("Cotando passagens GRU→LIS").
2. **Always pass `label`** on `browser_open` / `browser_act` — it is what the user sees in the tab overlay ("Agent in control · <label>") and the cockpit. Describe the *step*, not the tool, in the user's language.
3. **Never activate tabs**. Tabs open in background by design; the user keeps working. If the user should look, tell them to open the cockpit.
4. **Respect control**: if a tool errors with "user clicked STOP" or "user TOOK OVER", halt actions on that tab and check in with the user. Do not clear control yourself.
5. **Parallelize**: independent subtasks = separate tabs in the same session, acted on in sequence of tool calls but loading in parallel. 10 lead pages? Open 10 tabs, then read them one by one.

## The cheap way: code mode + API mining

UI clicking costs tokens. Two patterns that are 10x cheaper:

**Code mode** — one `browser_eval` beats ten `browser_act`s. The expression may be an async IIFE; return JSON-serializable data:

```js
(async () => {
  const rows = [...document.querySelectorAll('tr.item')]
  return rows.map(r => ({ name: r.querySelector('.name')?.innerText, price: r.querySelector('.price')?.innerText }))
})()
```

**API mining** — the page already talks to an API with the user's cookies. Perform the UI action ONCE (or just load the page), then:

1. `browser_requests {tab, filter: "api"}` → see what XHR/Fetch calls the page made
2. `browser_request_body {tab, request}` → learn the response shape
3. Replay directly: `browser_eval` with `fetch(url, {credentials: 'include', ...})` — same session, no clicks, no snapshots

Prefer this for anything repetitive (pagination, bulk actions, polling).

## Acting on pages

- `browser_open {url, session, label}` → returns tab id + snapshot with `[ref]` numbers
- `browser_act {tab, action: click|fill|press|scroll, ref, label}` — refs come from the latest snapshot; after navigation refs are stale → `browser_snapshot` again
- `fill` replaces the whole field; `press` supports Enter, Tab, Escape, arrows, PageDown…
- `browser_wait {until: selector|text|js|load, value}` after actions that trigger loads
- `browser_screenshot {tab}` to visually verify when the DOM is ambiguous (returns an image)
- `browser_read {tab}` for the page text

## Gotchas

- Snapshot caps at ~180 elements (form fields always included). Long pages: `scroll` + re-snapshot, or go code mode.
- `browser_eval` runs in the page's main world; results must be JSON-serializable.
- Everything is recorded: the user can replay your session frame by frame in the cockpit. Act accordingly.
- The user's own tabs are invisible to you: you only see tabs you opened. That is by design, don't fight it.
