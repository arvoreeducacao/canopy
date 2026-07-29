---
name: galho
description: Galho is an Arc-inspired, agent-native browser built on Electron (real Chromium). Agents drive it through a local HTTP API and work in their own "Agentes" space, reusing the user's logged-in sessions (Google, Slack, GitHub) without stealing focus — every agent action shows a visible takeover overlay so the human can interrupt. Use this skill whenever the user wants to interact with a website through Galho or their real browser session - opening pages, filling forms, clicking buttons, taking screenshots, extracting page text, testing web apps, creating live folders, installing Chrome extensions, or injecting boosts (per-site CSS/JS). Triggers include "open in galho", "abre no galho", "open a tab", "screenshot this page", "use my browser session", "live folder", "boost", or any browser automation task where the user's login state matters.
metadata:
  version: "0.1.0"
---

# Galho

Galho exposes a local agent API. Prefer the `galho` CLI for simple actions and `curl` over the unix socket for anything else. Agent tabs open in the **Agentes** space by default, unfocused — the user keeps browsing while you work, with their cookies and logins.

## CLI (fastest path)

```bash
galho                          # opens (or focuses) the browser, prints the transport
galho open github.com          # opens a tab in the Agentes space, unfocused
galho open app.com -s Work -f  # specific space, focused
galho tabs                     # id, space, title, url per tab
galho spaces
galho shot <id> -o out.png     # screenshot (works for background tabs)
galho text <id>                # page innerText
galho eval <id> 'document.title'
galho click <id> <x> <y>       # animated cursor + takeover overlay
galho type <id> 'hello'        # real keyboard events
galho press <id> Return        # Return, Tab, Escape...
galho close <id>
galho folder <space> <name> links.json   # create/update a live folder
```

The CLI auto-launches the app if it is not running (`/Applications/Galho.app`, or dev mode via electron).

## HTTP API

Primary transport: unix socket at `~/Library/Application Support/Galho/agent.sock` (mode 0600, no token). TCP fallback on `127.0.0.1:9224` requires `Authorization: Bearer $(cat ~/Library/Application\ Support/Galho/agent-token)`.

```bash
SOCK=~/Library/Application\ Support/Galho/agent.sock
curl -s --unix-socket "$SOCK" http://galho/            # manifest with all endpoints
curl -s --unix-socket "$SOCK" -X POST http://galho/tabs -d '{"url":"https://mail.google.com","label":"Checking inbox"}'
curl -s --unix-socket "$SOCK" http://galho/tabs/ID/screenshot -o shot.png
curl -s --unix-socket "$SOCK" -X POST http://galho/tabs/ID/click -d '{"x":500,"y":300,"label":"Opening thread"}'
```

Endpoints: `GET/POST /tabs`, `GET/DELETE /tabs/:id`, `POST /tabs/:id/{navigate,activate,eval,click,type,press,scroll,control}`, `GET /tabs/:id/{screenshot,text}`, `GET /spaces`, `PUT /spaces/:id`, `GET/POST /folders`, `PUT/DELETE /folders/:id`, `GET/POST /extensions`, `GET /downloads`, `GET /boosts`, `PUT/DELETE /boosts/:host`.

Notes:
- Pass a human-readable `label` on actions — it shows in the takeover pill ("Agent is in control · <label>").
- `POST /tabs` defaults to `activate: false` and the Agentes space. Only pass `activate: true` when the user asked to see the page.
- `GET /tabs/:id` returns `takenOver` / `stopRequested`. If either is true, the user clicked Take over or Stop — halt actions on that tab and tell the user.
- `POST /extensions {"id":"<chrome-web-store-id>"}` installs a Chrome Web Store extension (e.g. Dark Reader).
- `PUT /boosts/:host {"css":"...","js":"..."}` injects per-host CSS/JS on every page of that host.
- Live folders: `POST /folders {"space":"Work","name":"PRs","links":[{"title":"...","url":"..."}]}` — they show an orange dot in the sidebar.

## CDP (opt-in)

CDP is off by default. Launch the app with `GALHO_CDP=1` to expose DevTools protocol on `127.0.0.1:9223`; then `GET /tabs` includes `targetId`/`cdpUrl` per tab and Playwright connects via `chromium.connectOverCDP('http://127.0.0.1:9223')`. The high-level API does not need CDP.

## Gotchas

- Screenshots of the active tab are fast (~30ms); background tabs are slower (~500ms).
- `eval` runs in the page's main world; results must be JSON-serializable.
- After `click`/`type`, the page may still be loading — check `loading` in `GET /tabs/:id` or poll `text` before reading results.
- Never expose the socket, TCP port, or CDP port to the network — they drive the user's logged-in browser.
- Isolated profile for tests: `GALHO_PROFILE=/tmp/galho-test galho` (fresh cookies, own socket).
