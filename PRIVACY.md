# Privacy Policy — Canopy Bridge

_Last updated: 1 August 2026_

Canopy Bridge is the browser half of [Canopy](https://github.com/arvoreeducacao/canopy), an
open-source tool that lets AI coding agents drive the browser you already use. This policy covers
the Chrome extension and the local daemon it talks to.

## The short version

**Nothing Canopy Bridge reads ever leaves your computer.** The extension has exactly one network
destination: `ws://127.0.0.1:4664`, a daemon running on your own machine. There is no server
operated by Árvore Educação for this extension to talk to, and no data is sold or shared with
anyone.

To do its job the extension does read your browsing data — tab URLs and titles, and the content
of the pages an agent drives — and the daemon writes some of it to disk as session recordings.
That is disclosed as "web history" and "website content" on the Chrome Web Store listing. The
section below says exactly what is read and where it goes.

## What the extension handles

To do its job, the extension has access to and passes to the local daemon:

- **Tab metadata** — the id, URL, title, active state and tab-group of your open tabs, so agent
  tabs can be created, labelled, grouped and closed, and so the daemon knows when you take over.
- **Page content of agent-driven tabs** — via `chrome.debugger`, the daemon reads the DOM,
  screenshots and network activity of the tabs an agent is driving, so it can act on the page and
  show you what happened in the cockpit.

This data is relayed to the local daemon and used only to carry out the actions your agent
requests and to render the local cockpit at `http://127.0.0.1:4664/`.

## What is stored, and where

The daemon writes session recordings — an action log and JPEG frames — to `~/.canopy/sessions/`
on your own disk. You can delete that directory at any time. The extension itself stores only the
ids of tabs it opened, in `chrome.storage.session`, which the browser clears when it closes.

`browser_snapshot` never captures the value of a `type="password"` field.

Console output and network errors of agent-driven tabs are captured so the agent can see why a
page failed — the last 200 messages per tab, held in memory only and discarded when the tab
closes. If a page logs a token to its own console, that text is visible to the agent. The one
exception written to disk is a failed page load (its URL and the network error), which is recorded
in the action log like any other step.

## What is never done

- No telemetry, analytics, crash reporting or usage statistics.
- No transmission of browsing data, page content or credentials to any remote server.
- No sale or transfer of data to third parties.
- No use of data for advertising, credit scoring, or any purpose unrelated to the extension's
  single purpose.
- No remote code execution: the extension ships all of its code in the package.

## Third parties

None. One caveat, disclosed for completeness: the local cockpit page currently loads its typeface
from Google Fonts, which discloses your IP address to Google when you open the cockpit in a
browser tab. That request is made by the cockpit web page, not by this extension, it carries
nothing about your session, and self-hosting the font will remove it.

## Permissions and why they exist

See [the permission justifications](docs/chrome-web-store.md#permission-justifications).

## Contact

Questions or concerns: open an issue at
<https://github.com/arvoreeducacao/canopy/issues>, or report a security problem privately via
[GitHub Security Advisories](https://github.com/arvoreeducacao/canopy/security/advisories/new).
