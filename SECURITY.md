# Security Policy

Canopy drives a browser that holds your live logged-in sessions. Security reports are
genuinely welcome and will be treated as high priority.

## Reporting a vulnerability

**Please do not open a public issue for a vulnerability.**

Use GitHub's private reporting: **Security → Advisories → Report a vulnerability** on
[this repository](https://github.com/arvoreeducacao/canopy/security/advisories/new).

Useful things to include: the version or commit, your platform and browser, what an attacker can
reach, and a proof of concept if you have one.

We aim to acknowledge within 5 business days. Since the project has a single maintainer, please
treat timelines as best-effort rather than a guarantee.

## Supported versions

Only `main` is supported. There are no backports.

## Threat model

Canopy is built for a single user driving their own browser. It assumes:

- The user is present and can see the cockpit.
- Every page an agent visits is untrusted input.
- Loopback is **not** a trust boundary. Every process on your machine can reach
  `127.0.0.1:4664`, so the daemon authenticates callers rather than trusting the interface.

In scope: anything that lets code outside Canopy reach the daemon's API or the extension bridge;
anything that lets an agent drive a tab without the visible overlay, title and cockpit tile;
leakage of credentials or recordings beyond the local machine.

Out of scope: an agent doing something you asked it to do; the fact that `browser_eval` runs
arbitrary JavaScript (that is the feature); prompt injection from a visited page as a *category* —
see below.

## How access is controlled

**Token.** A 24-byte secret in `~/.canopy/token` (mode `0600`), or `CANOPY_TOKEN`. Every route and
both WebSockets require it — the only exception is the cockpit shell at `/`, which contains no data.
It is accepted as `Authorization: Bearer`, as the `canopy_token` cookie, or as `?token=`, and
compared in constant time. The daemon never prints it: startup logs the *path*, not the value.

**Cookie, not localStorage.** The cockpit receives the token as an `HttpOnly; SameSite=Strict`
cookie, so page JavaScript cannot read it, it never lands in a proxy access log, and the browser
will not attach it to a cross-site request. Visiting `/?token=…` sets the cookie and redirects, so
the token leaves the address bar and the history.

**Origin.** WebSockets are exempt from CORS, so `/ws` additionally requires that any `Origin`
present match the `Host` the request came in on. That is what stops a page you have open from
dialing `127.0.0.1` and subscribing to the screencast. Non-browser clients (the CLI, an agent) send
no `Origin` and are held to the token. `/ext` refuses web origins outright.

**Host.** A spoofed `Host` is rejected (`403`), which blocks DNS rebinding. No CORS header is ever
sent.

**Extension pairing.** The extension and the daemon share a secret (`~/.canopy/ext-secret`, printed
by `canopy pair`, pasted into the extension's options once). Each proves it to the other over a
nonce with HMAC-SHA256; the secret itself never crosses the wire. The daemon proving itself is the
important half: without it, any unprivileged local process that grabs port 4664 — squatting it
before Canopy starts, or during a restart — would inherit `chrome.debugger` over every tab in your
real browser.

**URL allowlist.** Agents navigate `http(s)` only. `file:`, `chrome:`, `devtools:` and
`view-source:` are refused, so "open a page" cannot become a file read. Set
`CANOPY_ALLOW_SCHEMES=file:` to opt back in locally.

## Running Canopy beyond your own machine

Binding past loopback (`CANOPY_BIND`) puts a logged-in browser on a network. This is supported —
see `docker-compose.cloud.yml` — but it changes the exposure meaningfully:

- Everything requires the token; `CANOPY_NO_AUTH=1` is refused outright on a non-loopback bind.
- Private and link-local destinations are blocked (RFC1918, loopback, `169.254.169.254`, bare
  single-label hostnames), so the browser is not usable as an SSRF pivot into the network it sits
  in. This is best-effort: a public hostname that *resolves* into private space still gets through,
  so egress filtering in front of the container is the real control.
- Anyone holding the token drives that browser and sees those sessions. The token is a single
  static credential with no rotation, expiry or per-user identity.
- Chromium runs with `--no-sandbox` in the container (Docker's seccomp profile blocks the namespace
  it needs), so a renderer bug is code execution next to the logged-in profile on `/data`.
- Front it with a proxy that terminates TLS and authenticates users. If you point `CANOPY_SSO_HOST`
  at an SSO-protected hostname, you **must** also set `CANOPY_SSO_SECRET` and have the proxy inject
  it as `X-Canopy-SSO-Secret`: identity headers are only trustworthy on traffic that actually went
  through the proxy, and the shared secret is what establishes that. Without it Canopy leaves SSO
  off rather than accept a weaker path to authentication.

## Known issues

### Prompt injection

An agent reading a page with your cookies can be instructed by that page. Canopy does not and
cannot prevent this; it makes it *observable* — the live cockpit, the action log and the
frame-by-frame replay exist so that you can see it happen and stop it. Use dedicated profiles for
sensitive work.

### Snapshots record what you type into ordinary fields

`browser_snapshot` skips the value of a `type="password"` field, but it does emit the value of
other inputs. A one-time code typed into a plain text field lands in the snapshot and the action
log under `~/.canopy/sessions/`.

### Same-user local processes

The token file is `0600`, but any process running as you can read it, and the cockpit shell hands
the cookie to any local caller. Canopy defends the boundary that a browser page cannot cross; it
does not defend against code already running as your user.

## What Canopy does not do

No telemetry. No network calls to any server we control. Recordings stay in `~/.canopy/sessions/`.

One caveat worth naming: the cockpit currently pulls its typeface from Google Fonts, so opening it
discloses your IP to Google. It is the only outbound request Canopy makes, it carries nothing about
your session, and self-hosting the font would remove it.
