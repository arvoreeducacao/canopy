---
name: canopy
description: Drive the user's real browser (Arc/Chrome) through the Canopy daemon — open tabs in parallel that never steal focus, act with a visible AI cursor the user can watch in a live cockpit, mine the page's API calls to build cheap automations, and replay every session. Use whenever a task involves a website, the user's logged-in sessions, form filling, scraping, or testing a web app. Triggers: "open it in the browser", "use my login", "fill in the form", "grab the data from that site", "automate this", any browser task.
metadata:
  version: "0.1.0"
---

# canopy

MCP server `canopy` at `http://127.0.0.1:4664/mcp` (add once: `claude mcp add --transport http canopy http://127.0.0.1:4664/mcp`). If `browser_status` fails the daemon is not running: start it with `canopy --launch-chrome &`, or `node <path-to-canopy>/bin/canopy.js --launch-chrome &` if it is not linked globally — ask the user where the repo lives rather than guessing. The user can watch everything at `http://127.0.0.1:4664/`.

## Golden rules

1. **One session per task**: `session_start {label}` → open tabs with that session id → `session_end` when done. The label shows up in the user's cockpit and in the recorded replay — write it in the user's language, describing the task ("Cotando passagens GRU→LIS").
2. **Always pass `label`** on `browser_open` / `browser_act` — it is what the user sees in the tab overlay ("Agent in control · <label>") and the cockpit. Describe the *step*, not the tool, in the user's language.
3. **Never activate tabs**. Tabs open in background by design; the user keeps working. If the user should look, tell them to open the cockpit.
4. **Respect control**: if a tool errors with "user clicked STOP" or "user TOOK OVER", halt actions on that tab and check in with the user. Do not clear control yourself.
5. **Parallelize**: independent subtasks = separate tabs in the same session, acted on in sequence of tool calls but loading in parallel. 10 lead pages? Open 10 tabs, then read them one by one.

## Do not debug blind

The browser is the most expensive and most opaque tool you have. Reach for it last, and never trust that a step worked because the call returned.

- **Check the cheap layer first.** Before driving a UI to reach an API, verify the thing exists: `curl -sI https://host/`, `dig +short host`. A dead host or a 401 shows up in one second in the terminal and as a page that mysteriously "does nothing" in the browser. If a login or a form silently fails, that is the first hypothesis, not the last.
- **Every action already reports what changed.** `browser_act` returns an `after:` line. `NO CHANGE DETECTED` means the page did not react — stop and investigate instead of firing the next click. Do not chain three actions and assume all three landed.
- **`browser_console` is the answer to "it just doesn't work".** Swallowed `catch` blocks, failed fetches, 401/404/500 and uncaught exceptions all land there. Errors are also injected into every snapshot and act result automatically, so if you see a `⚠` block, read it before doing anything else.
- **A ref that is hidden or covered is refused**, with the name of whatever is on top. That error means your model of the page is wrong (a modal that never opened, an overlay you did not notice) — take a new snapshot rather than passing `force:true`.

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
- `browser_screenshot {tab, fullPage?}` to visually verify when the DOM is ambiguous (returns an image)
- `browser_read {tab}` for the page text
- `browser_console {tab, level?}` for console errors, exceptions and failed/4xx requests
- `browser_resize {tab, preset: phone|tablet|desktop|wide}` (or `width`/`height`) to test responsive layouts; `reset:true` restores

**Read with `eval`, act with `act`.** `browser_eval` is for extraction, measuring (`getBoundingClientRect`) and replaying APIs. It is *not* for clicking: `element.click()` and assigning `.value` are synthetic, and component libraries that listen for pointer/keyboard events ignore them — the DOM changes, the app state does not. Clicking and typing go through `browser_act`, which dispatches real input events.

**Coordinates are CSS pixels, everywhere.** Screenshots are captured 1:1, so a position measured on the image is a valid `browser_act {x, y}`. If a capture ever comes back at a different scale, the tool result says so and gives you the multiplier — read it instead of assuming. Prefer refs over coordinates anyway; use `browser_resize` when you need a deterministic viewport.

## Gotchas

- Snapshot caps at ~180 elements (form fields always included). Long pages: `scroll` + re-snapshot, or go code mode.
- Snapshots list only what is really on screen — elements inside a closed modal, an `aria-hidden` container or a zero-opacity wrapper are omitted on purpose. If the button you want is missing, the thing that holds it is not open yet.
- `browser_eval` runs in the page's main world; results must be JSON-serializable.
- Everything is recorded: the user can replay your session frame by frame in the cockpit. Act accordingly.
- The user's own tabs are invisible to you: you only see tabs you opened. That is by design, don't fight it.
