# Galho

Browser Arc-like e agent-native, construido sobre Electron (engine Chromium real). Spaces, command palette, sidebar com favoritos — e CDP + API HTTP de agente embutidos de fabrica, sem gambiarra.

## Rodar

```bash
pnpm install
pnpm start
```

Perfil persistente (cookies, logins, localStorage) fica em `~/Library/Application Support/Galho` (macOS). Logue no Google, Slack etc. uma vez e a sessao fica.

## Conceitos

- **Spaces**: grupos de abas com cor propria (Pessoal, Trabalho, ...). Cada space tem sua aba ativa. O space **Agentes** e criado automaticamente quando um agente abre uma aba via API — o agente trabalha ali sem roubar seu foco, usando a mesma sessao logada.
- **Favoritos**: abas fixadas viram tiles no grid do topo da sidebar (clique direito na aba > Fixar como favorito).
- **Command palette** (`Cmd+T`): busca fuzzy em abas abertas, historico (com frecency), acoes do browser, URL direta ou busca no Google. `Cmd+L` abre em modo "abrir aqui" com a URL atual preenchida.

## Atalhos

| Atalho | Acao |
|---|---|
| `Cmd+T` | Command palette (nova aba) |
| `Cmd+L` | Palette em modo URL (navega na aba atual) |
| `Cmd+W` / `Cmd+Shift+T` | Fechar / reabrir aba |
| `Cmd+S` | Mostrar/ocultar sidebar |
| `Cmd+R` / `Cmd+Shift+R` | Recarregar / sem cache |
| `Cmd+[` / `Cmd+]` | Voltar / avancar |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Proxima / aba anterior |
| `Cmd+1..9` | Aba por indice (9 = ultima) |
| `Ctrl+1..9` | Space por indice |
| `Cmd+Alt+Left/Right` | Space anterior / proximo |
| `Cmd+Shift+N` | Novo space |
| `Cmd+Shift+C` | Copiar URL |
| `Cmd+Alt+I` | DevTools da aba |

Clique duplo no nome do space renomeia. Clique direito em aba/space abre menu (fixar, mover de space, cor, excluir). Arrastar reordena abas. Clique do meio fecha.

## Integracao com agentes

Duas portas, ambas só em `127.0.0.1`:

- **9223 — CDP** (Chrome DevTools Protocol) completo: `http://127.0.0.1:9223/json`
- **9224 — API HTTP** de alto nivel

Portas customizaveis via `GALHO_CDP_PORT` e `GALHO_API_PORT`.

### API HTTP (9224)

```bash
curl http://127.0.0.1:9224/                     # manifest + endpoints
curl http://127.0.0.1:9224/tabs                 # lista abas (com targetId e cdpUrl)
curl http://127.0.0.1:9224/spaces               # lista spaces

curl -X POST http://127.0.0.1:9224/tabs \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://mail.google.com"}'        # abre no space Agentes, sem roubar foco
                                                # {"space":"Trabalho","activate":true} para outros

curl http://127.0.0.1:9224/tabs/ID/screenshot -o shot.png
curl http://127.0.0.1:9224/tabs/ID/text         # innerText da pagina
curl -X POST http://127.0.0.1:9224/tabs/ID/eval \
  -d '{"expression":"document.title"}'          # roda JS na pagina
curl -X POST http://127.0.0.1:9224/tabs/ID/navigate -d '{"url":"..."}'
curl -X POST http://127.0.0.1:9224/tabs/ID/activate
curl -X DELETE http://127.0.0.1:9224/tabs/ID
```

Screenshots funcionam para abas em background e com a tela bloqueada (fallback via CDP interno).

### Playwright / CDP direto

```js
const { chromium } = require('playwright')
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223')
const page = browser.contexts()[0].pages().find(p => p.url().includes('gmail'))
```

Ou conecte no websocket de uma aba especifica usando o `cdpUrl` retornado por `GET /tabs`.

Fluxo recomendado para agentes: `POST /tabs` para abrir a pagina no space Agentes (ja logada com seus cookies), pegar o `cdpUrl` da resposta e dirigir por CDP/Playwright, ou usar direto os endpoints de screenshot/text/eval.

### Seguranca

Qualquer processo local acessa as duas portas (mesmo modelo do `--remote-debugging-port` do Chrome). Nao exponha as portas na rede.

## Arquitetura

```
src/
  main.js               entry: janela, sessao (UA Chrome), IPC, permissoes
  tab-manager.js        spaces, abas, WebContentsView por aba, layout, historico
  palette-controller.js command palette (view transparente overlay) + acoes
  agent-api.js          servidor HTTP 9224
  menu.js               menu nativo + atalhos
  state.js              persistencia JSON debounced
  preload.js            bridge IPC com whitelist de canais
ui/
  index.html/app.js/style.css   sidebar (chrome da janela, com vibrancy)
  palette.html/palette.js       overlay do command palette
  newtab.html                   pagina de nova aba
```

Uma `BrowserWindow` com vibrancy renderiza a sidebar; cada aba e uma `WebContentsView` filha (so a ativa fica attachada — as outras continuam rodando destacadas, entao Slack/Gmail seguem recebendo). O palette e outra `WebContentsView` transparente por cima. Sem framework, sem build step.

## Roadmap

- Find in page (`Cmd+F`)
- Split view
- Downloads UI
- Multiplas janelas
- Auto-archive de abas antigas (estilo Arc)
- Build empacotado (electron-builder) para macOS/Windows/Linux
