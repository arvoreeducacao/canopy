# Canopy

**A copa para o browser que você já usa.** Um daemon local (MCP + CDP) + extensão que deixa agentes de IA (Claude Code, Codex, Cursor) dirigirem o Arc/Chrome **em paralelo com você** — abas próprias que nunca roubam seu foco, cursor de IA visível, cockpit ao vivo com replay, e captura de rede para transformar cliques em automações de API.

Nasceu de um protótipo anterior em Electron, portado para a arquitetura "duas pistas": você navega no seu browser, os agentes trabalham nas abas deles, tudo observável.

## Quick start

```bash
pnpm install
pnpm dlx @puppeteer/browsers install chrome@stable --path ~/.canopy/browsers  # 1x: Chrome for Testing (carrega a extensão)
node bin/canopy.js --launch-chrome     # daemon + browser de teste (segundo plano, não rouba o foco)
claude mcp add --transport http canopy http://127.0.0.1:4664/mcp
```

O browser de teste abre com a extensão carregada: abas de agente entram agrupadas no grupo âmbar "AI", com favicon de sparkle e título "AI ·". Enquanto a IA é dona de uma aba, um véu cintilante cobre a página, **input humano fica bloqueado** (os botões Take over/Stop da pill continuam clicáveis) e um HUD mostra as teclas que a IA digita.

Abra o cockpit em **http://127.0.0.1:4664/** e peça algo ao Claude Code que envolva um site.

### No Arc (seu browser de verdade)

1. `arc://extensions` → ativar *Developer mode* → *Load unpacked* → pasta `extension/`
2. O ícone da extensão mostra `on` quando conecta no daemon — pronto: agentes dirigem o Arc via `chrome.debugger`, sem `--remote-debugging-port`, com seus logins.
3. Quando você **foca uma aba de agente**, o agente pausa automaticamente (você assumiu). Devolva pelo cockpit.

## O que tem dentro

| Peça | O quê |
|---|---|
| `src/daemon.js` | HTTP em `127.0.0.1:4664`: cockpit `/`, MCP `/mcp`, REST, WS `/ws` (cockpit) e `/ext` (extensão) |
| `src/core.js` | Sessões, abas, ações com cursor animado, snapshot com refs, captura de rede, screencast + replay |
| `src/cdp/*` | Dois transportes: porta CDP direta e ponte via extensão (`chrome.debugger`) — mesma API |
| `extension/` | MV3: cria/gerencia abas de agente, CDP sem porta, pausa-ao-focar |
| `cockpit/` | Tiles ao vivo de cada aba de agente, feed de ações, assumir/parar/devolver, replay scrubbable |
| `skills/canopy/` | Skill para Claude Code (padrões code-mode e API mining) |
| `examples/stagehand.mjs` | Stagehand/Playwright/puppeteer plugam no mesmo endpoint CDP |

## Ferramentas MCP

`browser_status` · `session_start/end` · `browser_open` · `browser_tabs` · `browser_navigate` · `browser_snapshot` (refs `[n]`) · `browser_act` (click/fill/press/scroll com cursor visível) · `browser_read` · `browser_eval` (code mode) · `browser_wait` · `browser_screenshot` · `browser_requests` + `browser_request_body` (minerar as chamadas de API da página e reexecutá-las via `fetch` — automação barata em tokens) · `browser_close`

## Segurança

- Tudo escuta **somente em 127.0.0.1**. Não exponha as portas: elas dirigem um browser logado.
- Gravações (ações + frames) ficam em `~/.canopy/sessions/` — suas, grep-áveis, deletáveis.
- Toda aba dirigida mostra overlay persistente ("Agente no controle") com **Assumir/Parar**; título e favicon são marcados.
- Agente lê páginas com seus cookies → risco de prompt injection existe. O cockpit ao vivo + replay é a mitigação: assista, e use perfis/sessões dedicados para tarefas sensíveis.

## Limitações conhecidas

- Screencast de abas em background usa polling (~1,5s); com a aba visível o stream é fluido.
- No modo extensão, o Chrome mostra a barra "está sendo depurado" — é o custo de dirigir o browser real sem porta CDP.
- Reiniciar o daemon órfã as abas de agente abertas (feche-as manualmente).
