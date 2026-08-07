# Publishing Canopy Bridge to the Chrome Web Store

Everything the Developer Dashboard asks for, in the order it asks for it. Copy the blocks
verbatim — the justification fields in particular are read by a human reviewer, and `debugger`
plus `tabs` is the highest-scrutiny combination the store has.

## 0. Build the package

```bash
./scripts/build-extension.sh   # → dist/canopy-extension.zip
```

The zip has `manifest.json` at its root. Bump `version` in `extension/manifest.json` before every
upload — the store rejects a re-upload of a version it has already seen.

## 1. Create the item

Dashboard → **Items** → **Add new item** → upload `dist/canopy-extension.zip`.

A one-time US$5 developer registration fee applies to the account if it has never published.

## 2. Store listing

| Field | Value |
| --- | --- |
| Name | `Canopy Bridge` |
| Summary (132 max) | `Lets AI agents drive this browser through the local Canopy daemon — visible AI cursor, tab badges and a live cockpit.` |
| Category | Developer Tools |
| Language | English |

**Description:**

```
Canopy lets AI coding agents — Claude Code, Codex, Cursor — drive the browser you already use,
in their own tabs, right next to yours, where you can watch every move.

This extension is the browser half of Canopy. The other half is an open-source daemon you run
locally with `npx @arvoretech/canopy`. The extension is useless on its own: with no daemon
listening on 127.0.0.1:4664 it does nothing at all.

WHY IT EXISTS

Headless browser automation throws away the thing that makes browser agents useful: your
session. You are already logged into the admin panel, the CRM, the ticketing system. Canopy
drives that browser instead of a clean-room Chromium — and pays for the privilege with
observability, because an agent acting with your cookies is something you should be able to see
and stop.

WHAT YOU GET

• Two lanes. Agent tabs open in the background and never steal focus. You keep working in yours.
• Nothing invisible. Driven tabs get a dimming veil, a persistent "Agent in control" pill, an
  "AI ·" title prefix and a sparkle favicon. A live cockpit at http://127.0.0.1:4664/ mirrors
  every tab as it happens.
• Reversible. Every driven tab has Take over and Stop one click away, in the page itself and in
  the cockpit.
• Replayable. Every session is recorded frame by frame, on your disk, so you can scrub back
  through what an agent did.
• Works in Arc. Because it drives tabs through chrome.debugger rather than a remote debugging
  port, it works in browsers that never expose one.

PRIVACY

No telemetry. No analytics. No remote server. The extension's only network destination is a
WebSocket to 127.0.0.1:4664 on your own machine. Recordings stay in ~/.canopy/sessions/.

Open source (MIT): https://github.com/arvoreeducacao/canopy
```

**Graphic assets** — already generated in `docs/store/`:

| Asset | File | Size |
| --- | --- | --- |
| Store icon | `extension/icons/icon-128.png` | 128×128 |
| Screenshot 1 | `docs/store/screenshot-1-cockpit.png` | 1280×800 |
| Screenshot 2 | `docs/store/screenshot-2-overlay.png` | 1280×800 |
| Small promo tile | `docs/store/promo-tile-440x280.png` | 440×280 |

Also fill **Official URL** / **Homepage** with `https://github.com/arvoreeducacao/canopy` and
**Support URL** with `https://github.com/arvoreeducacao/canopy/issues`.

## 3. Privacy tab

**Single purpose** (one field, one sentence — reviewers reject vague ones):

```
Canopy Bridge relays browser-automation commands between tabs in this browser and a Canopy
daemon running on the user's own machine (127.0.0.1:4664), so that AI coding agents can open and
drive tabs visibly, in the user's existing logged-in session.
```

### Permission justifications

**`debugger`**

```
This is the core mechanism of the extension. Canopy drives agent tabs through the Chrome
DevTools Protocol — navigation, input dispatch, DOM snapshots, screenshots — by calling
chrome.debugger.attach and chrome.debugger.sendCommand on tabs the extension itself opened for
an agent. The alternative, launching the browser with --remote-debugging-port, requires a
separate profile without the user's logins and does not work in Arc at all; chrome.debugger is
the only API that offers CDP against the browser the user is already using. The extension only
attaches to tabs it created in response to an explicit request from the local daemon, never to
tabs the user opened themselves.
```

**`tabs`**

```
Needed to create the background tabs an agent works in, to read their url and title so the
cockpit can label them and the daemon can tell when a navigation finished, to close them when a
task ends, and to detect that the user has clicked into an agent tab — which is the signal that
pauses the agent and hands control back to the human.
```

**`tabGroups`**

```
Every agent tab is placed in a single amber tab group titled "AI", so the user can see at a
glance which tabs are being driven and can collapse them out of the way. Used only to create
that group and set its title and colour.
```

**`storage`**

```
The MV3 service worker can be suspended at any time. The ids of tabs opened for agents are
mirrored into chrome.storage.session so that a restarted worker, or a reconnecting daemon, can
still find and clean up tabs a previous run left open. Session storage only — it is cleared when
the browser closes. No user data is stored.
```

**`alarms`**

```
A periodic alarm wakes the suspended MV3 service worker so it can check that the offscreen
document holding the connection to the local daemon is still there, and recreate it after a
browser restart or a crash. Without it the bridge stays down until the user clicks the extension.
```

**`offscreen`**

```
The extension keeps one WebSocket open to a daemon on the user's own machine (127.0.0.1:4664).
An MV3 service worker is suspended after about 30 seconds of inactivity and the socket dies with
it, which drops commands mid-task; an offscreen document is not recycled that way, so it is what
holds the connection. The document renders nothing and loads no remote content — it exists only
to own that socket and pass messages to the service worker, which performs the actual work.
```

**Remote code:** answer **No, I am not using remote code.** All logic ships in `background.js`
and `offscreen.js`.

**Data usage** — tick **Web history** and **Website content**, then sign the three certifications
(no sale to third parties, no use unrelated to single purpose, no creditworthiness/lending use).

Both are read: tab URLs and titles, and page DOM and screenshots via `chrome.debugger`, which the
daemon persists to `~/.canopy/sessions/`. It never leaves the machine, but the form asks what is
obtained from the user, not what is uploaded — and declaring "no data" on an extension holding
`debugger` reads as an inaccurate disclosure, which is a policy rejection rather than a fixable
note. `PRIVACY.md` is worded to match these two categories; keep them in sync if either changes.

**Privacy policy URL:**

```
https://github.com/arvoreeducacao/canopy/blob/main/PRIVACY.md
```

## 4. Distribution

- **Visibility:** see the note below before choosing Public.
- **Regions:** all.
- No payments, no in-app purchases.

## 5. What to expect from review

`debugger` + `tabs` is a high-risk permission set: it lets an extension read and control page
content across the whole browser. Reviews of extensions carrying it routinely take **days to
several weeks**, and the two things that get them rejected are (a) the justification not
explaining why a less-powerful API would not work, and (b) the reviewer being unable to see the
feature work.

Two things help materially:

1. **Testing instructions.** There is a field for private notes to the reviewer. Give them the
   exact steps, because the extension does nothing without the daemon:

   ```
   This extension is a bridge to a local open-source daemon; it is inert without it.
   It also refuses to talk to any daemon that cannot prove a shared pairing code,
   so step 3 is required — without it the badge stays "!" and nothing connects.
   To test:
     1. Install Node 20+.
     2. Run: npx @arvoretech/canopy
     3. Run: npx @arvoretech/canopy pair
        Copy the printed code into this extension's Details -> Extension options -> Save.
     4. The toolbar badge turns to "on" once connected.
     5. Open http://127.0.0.1:4664/ to see the cockpit.
     6. Run: npx @arvoretech/canopy open https://example.com --label "review test"
        A background tab opens in an amber "AI" group, dimmed, with an "Agent in control" pill,
        and appears live in the cockpit.
   Source: https://github.com/arvoreeducacao/canopy
   ```

   The pairing step is worth calling out in the justification too: the extension will only obey a
   daemon that proves knowledge of a code the user copied by hand, which is what stops any other
   process on the machine from picking up the port and inheriting `chrome.debugger`. Versions
   before 0.3.1 connected to whatever answered on 127.0.0.1:4664 — **do not ship those.**

2. **Publishing Unlisted first.** An unlisted item is still reviewed, but it does not appear in
   search or category browsing and is installable by direct link — which is all the README needs.
   It clears review faster and with less friction, and you can flip it to Public later from the
   same dashboard without re-uploading. Given the permission set, this is the recommended first
   submission.

## 6. After it is live

Update the README's install step to point at the store URL, and keep "Load unpacked" documented
as the developer path.
