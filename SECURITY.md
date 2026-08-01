# Security Policy

Canopy drives a browser that holds your live logged-in sessions. Security reports are
genuinely welcome and will be treated as high priority.

## Reporting a vulnerability

**Please do not open a public issue for a vulnerability.**

Use GitHub's private reporting: **Security → Advisories → Report a vulnerability** on
[this repository](https://github.com/arvoreeducacao/canopy/security/advisories/new).

Useful things to include: the version or commit, your platform and browser, what an attacker can
reach, and a proof of concept if you have one.

We aim to acknowledge within 5 business days. Since the project is pre-1.0 with a single
maintainer, please treat timelines as best-effort rather than a guarantee.

## Supported versions

Only `main` is supported. There are no backports.

## Threat model

Canopy is a **local, single-user tool**. It assumes:

- The daemon is reachable only from the machine it runs on (`127.0.0.1`).
- The user is present and can see the cockpit.
- Every page an agent visits is untrusted input.

In scope: anything that lets code outside Canopy reach the daemon's API or the extension bridge;
anything that lets an agent drive a tab without the visible overlay, title and cockpit tile;
leakage of credentials or recordings beyond the local machine.

Out of scope: an agent doing something you asked it to do; the fact that `browser_eval` runs
arbitrary JavaScript (that is the feature); prompt injection from a visited page as a *category* —
see below.

## Known issues

### WebSocket upgrades are not authenticated

`0.2.0` gates the HTTP control surfaces — `/mcp` and REST — on a bearer token minted at
`~/.canopy/token` (mode `0600`), validates the `Host` header against loopback to block DNS
rebinding, and no longer sends CORS headers at all. What is still open:

- The `/ext` and `/ws` WebSocket upgrades check `Host` but not `Origin` or the token. WebSockets
  are exempt from CORS, so a page you have open can still connect: to `/ws` to subscribe to the
  live frame stream, or to `/ext` to impersonate the extension bridge.
- Any process running as your user can read the token file and therefore drive your browser. That
  is inherent to a local single-user tool and is accepted by the threat model.

Until the WebSocket paths are token-gated, prefer **a dedicated browser profile** for sensitive
work.

### Prompt injection

An agent reading a page with your cookies can be instructed by that page. Canopy does not and
cannot prevent this; it makes it *observable* — the live cockpit, the action log and the
frame-by-frame replay exist so that you can see it happen and stop it. Use dedicated profiles for
sensitive work.

## What Canopy does not do

No telemetry. No network calls to any server we control. Recordings stay in `~/.canopy/sessions/`.
`browser_snapshot` never captures the value of a `type="password"` field.

One caveat worth naming: the cockpit currently pulls its typeface from Google Fonts, so opening it
discloses your IP to Google. It is the only outbound request Canopy makes, it carries nothing about
your session, and self-hosting the font would remove it.
