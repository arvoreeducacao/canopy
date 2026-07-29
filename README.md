# Galho

[![CI](https://github.com/Joao208/galho/actions/workflows/ci.yml/badge.svg)](https://github.com/Joao208/galho/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Arc-inspired, agent-native browser built on Electron (real Chromium engine). Spaces, command palette, split view, folders (including live folders), find in page, auto-archive — and CDP plus a high-level HTTP agent API built in, with an animated AI cursor so you can watch agents work.

Documentação em português: [README.pt-BR.md](README.pt-BR.md)

## Screenshots

| | |
|---|---|
| ![Sidebar with favorites, live folder and tabs](docs/sidebar.png) | ![Command palette](docs/palette.png) |
| ![Split view](docs/split.png) | ![AI cursor during an agent click](docs/agent-cursor.png) |

## Running

```bash
pnpm install
pnpm start          # dev
pnpm dist           # builds Galho.app + DMG (macOS) into dist/
```

Global CLI:

```bash
pnpm link --global  # installs the `galho` command
galho               # opens (or focuses) the browser
galho open github.com
```

The persistent profile (cookies, logins, localStorage) lives in `~/Library/Application Support/Galho` on macOS. Log in to Google, Slack etc. once and the session sticks. The user agent matches a regular Chrome, so Google login works.

Set `GALHO_PROFILE=/path/to/profile` to run an isolated instance (useful for tests and demos).

## Concepts

- **Spaces**: groups of tabs with their own color and icon. Right-click the pill to rename, change icon or color, clean, or delete. The **Agentes** space is created automatically when an agent opens a tab through the API — the agent works there without stealing your focus, reusing your logged-in session.
- **No new tab page**: `Cmd+T` opens the command palette, like Arc. An empty space shows only the background.
- **Favorites**: `Cmd+D` pins the tab as a tile in the grid at the top of the sidebar.
- **Folders**: right-click a tab > Move to folder. Dragging a tab onto a folder also works. **Live folders** are folders fed by a script or agent through the API (for example, your open PRs) — they show an orange dot.
- **Split view**: `Cmd+Shift+D` (or right-click a tab > Open in split view). Two tabs side by side.
- **Archive, not close**: `Cmd+W` archives (recoverable from the palette > "Ver abas arquivadas"). Tabs idle for 12h+ are archived automatically (Arc style). The broom button or `Cmd+Shift+K` cleans the whole space (except favorites).
- **Command palette** (`Cmd+T`): fuzzy search across open tabs, history (frecency), archived tabs, browser actions, direct URLs, or Google search. `Cmd+L` opens it in "open here" mode.
- **Chrome extensions**: install straight from the Chrome Web Store (palette action "Instalar extensoes", or `POST /extensions` with the store id). Extension browser actions show up in the sidebar and extension items in the page context menu. Powered by `electron-chrome-extensions`.

## Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+T` | Command palette (new tab) |
| `Cmd+L` | Palette in URL mode (navigates the current tab) |
| `Cmd+W` | Archive tab |
| `Cmd+Shift+T` | Reopen closed tab |
| `Cmd+D` | Pin/unpin favorite |
| `Cmd+F` | Find in page |
| `Cmd+Shift+D` | Split view |
| `Cmd+Shift+P` | Picture-in-Picture |
| `Cmd+Shift+K` | Clean space tabs |
| `Cmd+N` | New window |
| `Cmd+Ctrl+N` | New space |
| `Cmd+S` | Show/hide sidebar |
| `Cmd+R` / `Cmd+Shift+R` | Reload / reload without cache |
| `Cmd+[` / `Cmd+]` | Back / forward |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Cmd+1..9` | Tab by index (9 = last) |
| `Ctrl+1..9` | Space by index |
| `Cmd+Alt+Left/Right` | Previous / next space |
| `Cmd+Shift+C` | Copy URL |
| `Cmd+Alt+I` | Tab DevTools |

Double-click renames a space or folder. Middle-click archives a tab. Dragging reorders and moves into folders.

## CLI

```
galho                          opens (or focuses) the browser
galho open <url> [-s space] [-f]   opens a tab (default: Agentes space, unfocused)
galho tabs / spaces            lists
galho shot <id> [-o out.png]   tab screenshot
galho text <id>                page innerText
galho eval <id> <expr>         runs JS in the page
galho click <id> <x> <y>       clicks with the animated AI cursor
galho type <id> <text>         types (real keyboard events)
galho press <id> <key>         Return, Tab, Escape...
galho close <id>               closes the tab
galho folder <space> <name> <links.json>   creates/updates a live folder
```

## Agent integration

The primary transport is a **unix domain socket** at `<userData>/agent.sock` (macOS: `~/Library/Application Support/Galho/agent.sock`), mode `0600` — only your user can talk to it, no token needed. A TCP listener on `127.0.0.1:9224` (`GALHO_API_PORT`) is also available but requires a bearer token from `<userData>/agent-token`.

When an agent acts on a tab (click/type/navigate/eval), the page shows an **animated cursor plus a glow border** and the tab gets a pulsing badge in the sidebar. Screenshots work for background tabs and with the screen locked.

```bash
SOCK=~/Library/Application\ Support/Galho/agent.sock
curl --unix-socket "$SOCK" http://galho/          # manifest + endpoints
curl --unix-socket "$SOCK" -X POST http://galho/tabs -d '{"url":"https://mail.google.com"}'
curl --unix-socket "$SOCK" http://galho/tabs/ID/screenshot -o shot.png
curl --unix-socket "$SOCK" -X POST http://galho/tabs/ID/click -d '{"x":500,"y":300}'
curl --unix-socket "$SOCK" -X POST http://galho/tabs/ID/type -d '{"text":"hello"}'
curl --unix-socket "$SOCK" -X POST http://galho/folders -d '{"space":"Work","name":"PRs","links":[{"title":"...","url":"..."}]}'
curl --unix-socket "$SOCK" http://galho/extensions
```

Over TCP (for clients that cannot use unix sockets):

```bash
TOKEN=$(cat ~/Library/Application\ Support/Galho/agent-token)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9224/tabs
```

**CDP is off by default.** Launch with `GALHO_CDP=1` (or an explicit `GALHO_CDP_PORT`) to expose full Chrome DevTools Protocol on `127.0.0.1:9223`. With CDP on, `GET /tabs` includes `targetId`/`cdpUrl` per tab, and Playwright works:

```js
const { chromium } = require('playwright')
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223')
```

### Security

Goal: **no unauthenticated local surface**. A browser holds your logged-in sessions; a plain localhost port is reachable by any process running as any user on the machine, so it would let any local app or malware drive the browser.

- **Unix socket, mode 0600** — filesystem permissions are the authentication (same model as `docker.sock`). This is the default and preferred transport.
- **TCP requires a bearer token** — random per install, stored at `<userData>/agent-token` (mode 0600). Requests without it get `401`.
- **CDP is opt-in** — the DevTools protocol has no authentication at all, so the port simply does not exist unless you launch with `GALHO_CDP=1`. The high-level API (click/type/eval/screenshot) does not depend on it.

Do not expose any of these to the network. The sidebar and window chrome are out of reach of web pages (separate WebContentsView) — a page cannot spoof the browser UI.

## Distribution

`pnpm dist` produces `dist/Galho-<version>-arm64.dmg` and `.zip` (macOS). `pnpm dist:win` / `pnpm dist:linux` produce an NSIS installer / AppImage+deb (preferably run in CI or on the target platform). No signing/notarization yet — the first open requires right-click > Open on macOS.

## Architecture

```
src/
  main.js               windows (multi-window), session (Chrome UA), IPC, permissions
  tab-manager.js        spaces, tabs, folders, split, archive, one WebContentsView per tab
  palette-controller.js command palette (transparent overlay) + actions + modes
  find-controller.js    find in page bar
  agent-api.js          agent API (unix socket + TCP with token) + injected AI cursor
  menu.js               native menu + shortcuts
  state.js              debounced JSON persistence
  preload.js            IPC bridge with channel whitelist
ui/
  index.html/app.js/style.css   sidebar (vibrancy)
  palette.html/palette.js       command palette
  findbar.html                  find in page bar
bin/
  galho.js              CLI
```

Each window has its own TabManager; only the active tab (or the split pair) stays attached — the others keep running detached, so Slack/Gmail keep receiving. History is shared across windows. No framework, no build step.

## Roadmap

- Downloads UI
- Per-site permission prompts (today: fixed allowlist - media/notifications yes, geolocation no)
- Auto-update (electron-updater)
- macOS signing/notarization
- Session restore after a renderer crash (today: reload the tab)

## License

Galho's own source code is [MIT](LICENSE). The app depends on [electron-chrome-extensions](https://github.com/samuelmaddock/electron-browser-shell), which is licensed under GPL-3.0 — binary distributions that bundle it are governed by GPL-3.0 terms.
