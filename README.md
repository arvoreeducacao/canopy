# Canopy

**Let AI agents drive the browser you already use — in their own tabs, next to yours, where you can watch every move.**

[![License: MIT](https://img.shields.io/badge/License-MIT-F59E0B.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-3C873A.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-streamable%20http-6366F1.svg)](https://modelcontextprotocol.io)

Canopy is a local daemon (MCP + CDP) plus a browser extension. Agents like Claude Code, Codex
and Cursor open their own tabs in your real browser — with your logins — while you keep working
in yours. Every action shows a visible AI cursor on the page, streams to a live cockpit, and is
recorded frame by frame so you can replay it later.

![The Canopy cockpit: four agent tabs streaming live, with the action log on the right](docs/cockpit.png)

## Why

Headless automation throws away the thing that makes browser agents useful: **your session**.
You are already logged into the admin panel, the CRM, the ticketing system. Canopy drives *that*
browser instead of a clean-room Chromium — and pays for the privilege with observability, because
an agent acting with your cookies is something you should be able to see and stop.

Three properties it is built around:

- **Two lanes.** Agent tabs open in the background and never steal focus. You are not handing
  over the machine — you are working alongside it.
- **Nothing invisible.** Driven tabs get a dimming veil with light flowing around its edge, a
  persistent "Agent in control" pill, an `AI ·` title prefix and a sparkle favicon. The cockpit
  mirrors it live.
- **Reversible.** Every driven tab has *Take over* and *Stop* one click away, in the page itself
  and in the cockpit.

## Quick start

Requires Node ≥ 20. The daemon itself is portable; the `--launch-chrome` helper in Option A is
macOS-only for now (see [Limitations](#limitations)).

```bash
npx @arvoretech/canopy setup   # mints the token, registers the MCP server in Claude Code, installs the skill
npx @arvoretech/canopy         # starts the daemon
```

`setup` is idempotent; add `--launchd` (macOS) to also start the daemon at login. If you don't
use Claude Code, `setup` prints the equivalent `claude mcp add` command so you can adapt it to
your agent — the MCP endpoint is `http://127.0.0.1:4664/mcp` with
`Authorization: Bearer $(cat ~/.canopy/token)`. (Or from a clone: `pnpm install && node bin/canopy.js`.)

The daemon mints a token at `~/.canopy/token` on first run and requires it on every control
surface (see [Security model](#security-model)). Then open the cockpit at
**http://127.0.0.1:4664/** and ask your agent to do something on a website.

If the browser is closed when an agent asks for a tab, the daemon launches it in the background
(Arc or Chrome, macOS) and waits for the bridge to come up — no manual step.

The same binary is also a small CLI against a running daemon:

```bash
canopy setup                 # one-shot install: token, Claude Code MCP + skill (--launchd: start at login)
canopy status                # connected browser + open agent tabs
canopy open https://example.com --label "checking something"
canopy tabs
canopy screenshot t1 out.png
canopy close t1
```

The daemon reaches a browser two ways and accepts both at once. When the extension is connected it
wins, because only that path can group tabs and work without a CDP port.

### Option A — a dedicated test browser

Branded Chrome 137+ ignores `--load-extension`, so the dev browser is Chrome for Testing:

```bash
pnpm dlx @puppeteer/browsers install chrome@stable --path ~/.canopy/browsers   # once
node bin/canopy.js --launch-chrome
```

This launches in the background (`open -g`, so it does not steal focus) with the extension loaded
and a separate profile under `~/.canopy/chrome-profile`. Best for trying Canopy out without
pointing it at your logged-in session.

### Option B — your real browser (Arc, Chrome)

1. Go to `arc://extensions` (or `chrome://extensions`) → enable **Developer mode** → **Load unpacked** → pick `extension/`
2. The extension badge reads `on` once it reaches the daemon.
3. That's it. Agents now drive your real browser through `chrome.debugger` — no
   `--remote-debugging-port`, no separate profile, your logins intact.

The extension path is the interesting one: because it uses `chrome.debugger` rather than a CDP
port, it works in browsers that never expose one — which is how Canopy runs inside Arc.

## What you see while an agent works

Agent tabs are grouped into an amber **AI** tab group, titled `AI · <page title>`, with a sparkle
favicon. On the page itself: a frosted veil with a slowly drifting dot lattice, an aurora of warm
light breathing along the viewport edges, the AI cursor visible the whole time the agent owns the
tab (not just during actions), and a pill naming the current task:

![A Wikipedia page under agent control, dimmed, with the "Agent in control" pill](docs/overlay.png)

While the agent owns a tab, **human input on that page is blocked** — clicks and keystrokes are
swallowed so you can read over the agent's shoulder without fighting it for the cursor. The pill's
*Take over* and *Stop* buttons stay clickable, and they are how control changes hands:

- **Take over** — the agent's next tool call on that tab fails with an explicit "the user took
  over" error, telling it to stop and check in with you.
- **Stop** — same, but signals you want the whole task halted.
- Hand control back from the cockpit whenever you want.

Merely *focusing* an agent tab does not pause it. That is deliberate: the input guard already
makes watching safe, so control only moves when you actually ask for it.

## MCP tools

| Tool | What it does |
|---|---|
| `browser_status` | Connected browser, sessions, open agent tabs, cockpit URL. Call it first. |
| `session_start` / `session_end` | One named session per task — its own tab group and its own recording. |
| `browser_open` | Open a background tab; returns its id plus a snapshot with `[ref]` numbers. |
| `browser_tabs` | List the agent's tabs (never yours). |
| `browser_navigate` | Navigate an existing tab. |
| `browser_snapshot` | Interactive elements as numbered refs — the cheap alternative to screenshots. |
| `browser_act` | `click` · `fill` · `press` · `scroll`, each with the animated cursor and keystroke HUD. |
| `browser_read` | Page text. |
| `browser_eval` | Run JS in the page — *code mode*, see below. |
| `browser_wait` | Wait `until` a selector, text, JS expression or `load`. |
| `browser_screenshot` | PNG, for when the DOM is ambiguous. |
| `browser_requests` / `browser_request_body` | Inspect the XHR/Fetch the page made, and their responses. |
| `browser_close` | Close a tab. |

A REST mirror of the same surface lives on the daemon (`/status`, `/tabs`, `/tabs/:id/act`, …) if
you would rather drive it with `curl`. `skills/canopy/` packages the usage patterns below as a
Claude Code skill.

## The cheap path: code mode and API mining

Clicking through a UI burns tokens — a snapshot per step, a screenshot when you are unsure. Two
patterns are roughly an order of magnitude cheaper, and Canopy is shaped to make them easy.

**Code mode** — one `browser_eval` replaces ten `browser_act`s:

```js
(async () => {
  const rows = [...document.querySelectorAll('tr.item')]
  return rows.map(r => ({
    name: r.querySelector('.name')?.innerText,
    price: r.querySelector('.price')?.innerText
  }))
})()
```

**API mining** — the page is already talking to an API with your cookies. So: do the UI action
*once*, find the call it triggered, then skip the UI entirely.

1. `browser_requests { tab, filter: "api" }` — what XHR/Fetch did this page make?
2. `browser_request_body { tab, request }` — what does the response look like?
3. `browser_eval` with `fetch(url, { credentials: 'include', … })` — same session, no clicks.

For anything repetitive — pagination, bulk edits, polling a job — this turns a 40-step click
sequence into one request. Canopy enables `Network` on `about:blank` *before* the real
navigation, so the page's very first API calls are captured too.

## Architecture

| Piece | Role |
|---|---|
| `src/daemon.js` | HTTP on `127.0.0.1:4664`: cockpit `/`, MCP `/mcp`, REST, WebSockets `/ws` (cockpit) and `/ext` (extension) |
| `src/core.js` | Sessions, tabs, actions with the animated cursor, ref snapshots, network capture, screencast |
| `src/cdp/*` | Two interchangeable transports: a direct CDP port, and a bridge through the extension |
| `src/overlay.js` | In-page presence: veil, pill, AI cursor, keystroke HUD, title and favicon badging |
| `src/snapshot.js` | DOM → numbered interactive refs (password values are never captured) |
| `src/recorder.js` | Append-only action log + JPEG frames per session |
| `extension/` | MV3 service worker: tab lifecycle, CDP without a port |
| `cockpit/` | Live Feed (tiles + action log) and Flight Recorder (scrubbable replay) |

Screencast only runs while someone is actually watching the cockpit; otherwise frames are sampled
sparsely, because `captureScreenshot` on N tabs is the one real background CPU cost.

## Recordings and replay

Every session writes to `~/.canopy/sessions/<id>/` — a JSONL action log plus JPEG frames. They are
plain files: grep them, diff them, delete them. The cockpit's **Flight Recorder** tab replays a
session on a scrubbable timeline, filterable by tab, so "what did the agent actually do at 14:32"
has an answer.

## Security model

Canopy deliberately gives an agent a lot: a browser holding your live sessions. Please read this
section before pointing it at a profile that matters.

What the design gives you:

- **Token auth by default.** The daemon mints a random token at `~/.canopy/token` (mode `0600`)
  on first run and requires `Authorization: Bearer <token>` on `/mcp`, on every mutating REST
  route and on routes that read live page content (screenshots, text, snapshots, network).
  Loopback is not a security boundary — any local process can reach `127.0.0.1` — so control of
  your logged-in browser is gated on being able to read that file. `CANOPY_NO_AUTH=1` opts out.
- **No CORS, Host validated.** REST responses carry no `Access-Control-Allow-Origin`, and
  requests with a non-loopback `Host` header are refused (DNS-rebinding guard), so a web page you
  have open cannot reach the daemon even for the unauthenticated cockpit feeds.
- **Loopback only.** Nothing listens on a routable interface. Do not port-forward or tunnel it.
- **Your data stays local.** Recordings are files in your home directory. Canopy ships no
  telemetry and talks to no server of ours. (The cockpit's own read feeds — live frames, the
  action log, replays — stay tokenless so the UI works, which means other *local* processes can
  view them; treat recordings as screenshots of whatever the agent saw.)
- **Passwords are skipped.** `browser_snapshot` records the value of every field except
  `type="password"`.
- **Visible by construction.** An agent cannot drive a tab without the veil, the pill, the marked
  title and the cockpit tile. There is no silent mode, on purpose.
- **Prompt injection is the real risk.** An agent reading a page with your cookies can be
  instructed *by that page*. Nothing here prevents that. The live cockpit and the replay are the
  mitigation — watch what happens, and use a dedicated profile for anything sensitive.

The extension requests `debugger` and `<all_urls>`, which is the maximum a Chrome extension can
ask for. That is inherent to the goal — driving arbitrary pages in a browser that exposes no CDP
port — and it is why the extension is loaded unpacked from source you can read (~170 lines)
rather than shipped through the Web Store.

Found a vulnerability? See [SECURITY.md](SECURITY.md).

## Project status

Early, honest about it: `0.1.0`, one contributor, built on top of an earlier Electron prototype
and ported to this two-lane architecture.

**Works and is exercised:** the MCP and REST surfaces, both transports, the overlay and input
guard, network capture and replay of API calls, session recording, multi-tab replay filtering,
the cockpit's live feed, token auth, the CLI. Exercised end-to-end inside Arc (open, navigate,
act, background-tab keyboard, screenshots) and against Chrome for Testing.

Two reliability details worth knowing: the daemon pings the extension every 20 s because MV3
service workers idle out after ~30 s and would otherwise drop the bridge; and agent tabs survive
short bridge drops (60 s grace) while tabs left over from a *dead* daemon are swept closed on
reconnect (the extension remembers them in `chrome.storage.session`).

**Known-thin, help welcome:**

- Tab grouping in Arc returns `-1`; Arc may not render Chrome tab groups at all (degrades cleanly).
- The Windows/Linux launcher paths are written but only macOS has been run.
- No Web Store package yet — `dist/canopy-extension.zip` is built, publishing is pending.

## Limitations

- **macOS is the tested platform.** The launcher and CLI carry Windows/Linux paths, but only
  macOS has actually been run; auto-launching a closed browser is macOS-only (`open -g`).
- Background tabs cannot screencast, so their feed falls back to ~1.5 s polling. Foreground tabs stream smoothly.
- In extension mode Chrome shows its "is being debugged" banner. That is the cost of driving a
  real browser without a CDP port.
- Snapshots cap at ~180 elements (form fields always included). Long pages: scroll and re-snapshot, or go code mode.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). The security items above are the
most useful place to start.

## License

MIT © Árvore Educação. See [LICENSE](LICENSE).
