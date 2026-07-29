# Contributing

Thanks for your interest in Galho.

## Setup

```bash
pnpm install
pnpm start
```

Node 22+ and pnpm are required. There is no build step and no framework: `src/` runs in the Electron main process, `ui/` runs in the sidebar and overlay renderers.

Use `GALHO_PROFILE=/tmp/galho-dev GALHO_CDP_PORT=9333 GALHO_API_PORT=9334 pnpm start` to develop against an isolated profile without touching your daily browser instance.

## Guidelines

- Keep changes small and focused. One topic per pull request.
- No code comments: names should make the code self-explanatory.
- No emojis in code, UI strings, or docs.
- Follow the existing style: plain CommonJS, no semicolon-free/style rewrites, no new dependencies unless strictly necessary.
- Test manually before opening a PR: `pnpm start`, exercise the affected flows, and check the agent API with `curl http://127.0.0.1:9224/` when relevant.

## Reporting issues

Open a GitHub issue with steps to reproduce, expected vs. actual behavior, and your OS. Screenshots of the composed window help a lot.
