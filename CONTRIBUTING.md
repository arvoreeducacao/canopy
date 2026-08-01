# Contributing to Canopy

Thanks for looking. Canopy is early and small, so contributions land quickly.

## Getting set up

```bash
pnpm install
node bin/canopy.js --launch-chrome     # daemon + Chrome for Testing with the extension loaded
```

Install the test browser once with:

```bash
pnpm dlx @puppeteer/browsers install chrome@stable --path ~/.canopy/browsers
```

Develop against that profile rather than your real browser — see [SECURITY.md](SECURITY.md) for why.

`CANOPY_DEBUG=1` makes the daemon log raw tab refs, which is usually what you want when a transport
is misbehaving.

## Trying things out

The scripts in `test/` are runnable probes, not a test suite — each one drives a live daemon and
prints what came back:

```bash
node bin/canopy.js &          # daemon must be up
node test/mcp-client.mjs      # end-to-end MCP round trip
node test/mcp-matrix.mjs      # every tool once
node test/mcp-key.mjs         # keyboard dispatch
node test/mcp-cross.mjs       # both transports
```

A real test suite is very welcome; there isn't one yet.

## Where help is most useful

Roughly in order:

1. **Hardening the daemon** — auth token, `Origin`/`Host` validation, dropping the CORS wildcard.
   See the known issues in [SECURITY.md](SECURITY.md). This is the release blocker.
2. **Windows and Linux support** in `bin/canopy.js` — the daemon is portable, the launcher is not
   (it shells out to macOS `open -g` and hardcodes macOS Chrome paths).
3. **Arc end-to-end** — the extension connects and drives tabs, but the long tail is unverified.
   Tab grouping in particular returns `-1`.
4. **A test suite** worth the name.

## House style

Match the surrounding code rather than a config file — there is no linter yet.

- ES modules, `node:` prefixed builtins, no build step, no transpiler.
- No semicolons; two-space indent; single quotes.
- Dependencies are deliberately few (`@modelcontextprotocol/sdk`, `ws`, `zod`). Adding one needs a
  reason in the PR description.
- Comments explain *why*, especially where the code works around a browser quirk — several
  non-obvious lines exist because of CDP behaviour, and those comments are load-bearing. Keep them.
- Everything user-facing is in **English**: log lines, errors, tool descriptions, UI strings.

## Pull requests

Small and focused beats large and sweeping. In the description, say what you changed, how you
verified it, and which browser you tested in — "tested in Arc" is valuable information here.

By contributing you agree your work is licensed under the [MIT License](LICENSE).
