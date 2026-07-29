# Galho

[![CI](https://github.com/Joao208/galho/actions/workflows/ci.yml/badge.svg)](https://github.com/Joao208/galho/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Browser Arc-like e agent-native, construido sobre Electron (engine Chromium real). Spaces, command palette, split view, pastas (incluindo live folders), find in page, auto-archive — e CDP + API HTTP de agente embutidos de fabrica, com cursor de IA animado para acompanhar agentes trabalhando.

English documentation: [README.md](README.md)

## Screenshots

| | |
|---|---|
| ![Sidebar com favoritos, live folder e abas](docs/sidebar.png) | ![Command palette](docs/palette.png) |
| ![Split view](docs/split.png) | ![Cursor de IA durante um clique de agente](docs/agent-cursor.png) |

## Rodar

```bash
pnpm install
pnpm start          # dev
pnpm dist           # gera Galho.app + DMG (macOS) em dist/
```

CLI global:

```bash
pnpm link --global  # instala o comando `galho`
galho               # abre (ou foca) o browser
galho open github.com
```

Perfil persistente (cookies, logins, localStorage) fica em `~/Library/Application Support/Galho` (macOS). Logue no Google, Slack etc. uma vez e a sessao fica. O user agent e o de um Chrome normal, entao login Google funciona.

Use `GALHO_PROFILE=/caminho/do/perfil` para rodar uma instancia isolada (util para testes e demos).

## Conceitos

- **Spaces**: grupos de abas com cor e icone proprios. Clique direito no pill: renomear, icone, cor, limpar, excluir. O space **Agentes** e criado automaticamente quando um agente abre aba via API — o agente trabalha ali sem roubar seu foco, usando a mesma sessao logada.
- **Nao existe pagina de nova aba**: `Cmd+T` abre o command palette, como no Arc. Space vazio mostra so o fundo.
- **Favoritos**: `Cmd+D` fixa a aba como tile no grid do topo da sidebar.
- **Pastas**: clique direito na aba > Mover para pasta. Arrastar aba sobre a pasta tambem funciona. **Live folders** sao pastas alimentadas por script/agente via API (ex: seus PRs abertos) — aparecem com ponto laranja.
- **Split view**: `Cmd+Shift+D` (ou clique direito na aba > Abrir em split view). Duas abas lado a lado.
- **Arquivo, nao fechar**: `Cmd+W` arquiva (recuperavel no palette > "Ver abas arquivadas"). Abas paradas ha 12h+ sao arquivadas sozinhas (estilo Arc). Botao de vassoura ou `Cmd+Shift+K` limpa o space inteiro (menos favoritos).
- **Command palette** (`Cmd+T`): busca fuzzy em abas abertas, historico (frecency), arquivadas, acoes do browser, URL direta ou busca no Google. `Cmd+L` abre em modo "abrir aqui".

## Atalhos

| Atalho | Acao |
|---|---|
| `Cmd+T` | Command palette (nova aba) |
| `Cmd+L` | Palette em modo URL (navega na aba atual) |
| `Cmd+W` | Arquivar aba |
| `Cmd+Shift+T` | Reabrir aba fechada |
| `Cmd+D` | Fixar/desafixar favorito |
| `Cmd+F` | Buscar na pagina |
| `Cmd+Shift+D` | Split view |
| `Cmd+Shift+P` | Picture-in-Picture |
| `Cmd+Shift+K` | Limpar abas do space |
| `Cmd+N` | Nova janela |
| `Cmd+Ctrl+N` | Novo space |
| `Cmd+S` | Mostrar/ocultar sidebar |
| `Cmd+R` / `Cmd+Shift+R` | Recarregar / sem cache |
| `Cmd+[` / `Cmd+]` | Voltar / avancar |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Proxima / aba anterior |
| `Cmd+1..9` | Aba por indice (9 = ultima) |
| `Ctrl+1..9` | Space por indice |
| `Cmd+Alt+Left/Right` | Space anterior / proximo |
| `Cmd+Shift+C` | Copiar URL |
| `Cmd+Alt+I` | DevTools da aba |

Clique duplo renomeia space/pasta. Clique do meio arquiva aba. Arrastar reordena e move pra pastas.

## CLI

```
galho                          abre (ou foca) o browser
galho open <url> [-s space] [-f]   abre aba (padrao: space Agentes, sem foco)
galho tabs / spaces            listas
galho shot <id> [-o out.png]   screenshot da aba
galho text <id>                innerText da pagina
galho eval <id> <expr>         roda JS na pagina
galho click <id> <x> <y>       clica com cursor de IA animado
galho type <id> <texto>        digita (eventos reais de teclado)
galho press <id> <tecla>       Return, Tab, Escape...
galho close <id>               fecha a aba
galho folder <space> <nome> <links.json>   cria/atualiza live folder
```

## Integracao com agentes

Duas portas, ambas so em `127.0.0.1` (customizaveis via `GALHO_CDP_PORT` / `GALHO_API_PORT`):

- **9223 — CDP** completo: `http://127.0.0.1:9223/json`
- **9224 — API HTTP** de alto nivel

Quando um agente age numa aba (click/type/navigate/eval), a pagina mostra **cursor laranja animado + borda de glow** e a aba ganha um badge pulsante na sidebar. Screenshots funcionam para abas em background e com a tela bloqueada.

```bash
curl http://127.0.0.1:9224/                     # manifest + endpoints
curl -X POST http://127.0.0.1:9224/tabs -d '{"url":"https://mail.google.com"}'
curl http://127.0.0.1:9224/tabs/ID/screenshot -o shot.png
curl -X POST http://127.0.0.1:9224/tabs/ID/click -d '{"x":500,"y":300}'
curl -X POST http://127.0.0.1:9224/tabs/ID/type -d '{"text":"ola"}'
curl -X POST http://127.0.0.1:9224/folders -d '{"space":"Trabalho","name":"PRs","links":[{"title":"...","url":"..."}]}'
```

Playwright / CDP direto:

```js
const { chromium } = require('playwright')
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223')
```

Ou conecte no `cdpUrl` retornado por `GET /tabs` para uma aba especifica.

### Seguranca

Qualquer processo local acessa as duas portas (mesmo modelo do `--remote-debugging-port` do Chrome). Nao exponha na rede. A sidebar e o chrome da janela ficam fora do alcance das paginas (WebContentsView separada) — pagina nao consegue falsificar a UI do browser.

## Distribuicao

`pnpm dist` gera `dist/Galho-<versao>-arm64.dmg` e `.zip` (macOS). `pnpm dist:win` / `pnpm dist:linux` geram NSIS installer / AppImage+deb (rodar em CI ou na plataforma alvo de preferencia). Sem assinatura/notarizacao por enquanto — primeiro open exige clique direito > Abrir.

## Arquitetura

```
src/
  main.js               janelas (multi-window), sessao (UA Chrome), IPC, permissoes
  tab-manager.js        spaces, abas, pastas, split, archive, WebContentsView por aba
  palette-controller.js command palette (overlay transparente) + acoes + modos
  find-controller.js    barra de find in page
  agent-api.js          servidor HTTP 9224 + cursor de IA injetado
  menu.js               menu nativo + atalhos
  state.js              persistencia JSON debounced
  preload.js            bridge IPC com whitelist de canais
ui/
  index.html/app.js/style.css   sidebar (vibrancy)
  palette.html/palette.js       command palette
  findbar.html                  barra de busca na pagina
bin/
  galho.js              CLI
```

Cada janela tem seu TabManager; so a aba ativa (ou o par do split) fica attachada — as outras continuam rodando destacadas, entao Slack/Gmail seguem recebendo. Historico e compartilhado entre janelas. Sem framework, sem build step.

## Roadmap

- UI de downloads
- Prompts de permissao por site (hoje: allowlist fixa - media/notificacoes sim, geolocalizacao nao)
- Suporte a extensoes Chrome (Electron suporta um subconjunto via `session.loadExtension`)
- Auto-update (electron-updater)
- Assinatura/notarizacao macOS
- Restaurar sessao apos crash de renderer (hoje: recarregar a aba)

## Licenca

[MIT](LICENSE)
