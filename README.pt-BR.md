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
- **Extensoes Chrome**: instale direto da Chrome Web Store (acao "Instalar extensoes" no palette, ou `POST /extensions` com o id da store). Browser actions das extensoes aparecem na sidebar e itens de extensao no menu de contexto da pagina. Via `electron-chrome-extensions`.

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

O transporte primario e um **unix domain socket** em `<userData>/agent.sock` (macOS: `~/Library/Application Support/Galho/agent.sock`), modo `0600` — so o seu usuario fala com ele, sem token. Tambem existe um listener TCP em `127.0.0.1:9224` (`GALHO_API_PORT`), mas ele exige bearer token lido de `<userData>/agent-token`.

Quando um agente age numa aba (click/type/navigate/eval), a pagina mostra **cursor animado + borda de glow** e a aba ganha um badge pulsante na sidebar. Screenshots funcionam para abas em background e com a tela bloqueada.

```bash
SOCK=~/Library/Application\ Support/Galho/agent.sock
curl --unix-socket "$SOCK" http://galho/          # manifest + endpoints
curl --unix-socket "$SOCK" -X POST http://galho/tabs -d '{"url":"https://mail.google.com"}'
curl --unix-socket "$SOCK" http://galho/tabs/ID/screenshot -o shot.png
curl --unix-socket "$SOCK" -X POST http://galho/tabs/ID/click -d '{"x":500,"y":300}'
curl --unix-socket "$SOCK" -X POST http://galho/tabs/ID/type -d '{"text":"ola"}'
curl --unix-socket "$SOCK" -X POST http://galho/folders -d '{"space":"Trabalho","name":"PRs","links":[{"title":"...","url":"..."}]}'
curl --unix-socket "$SOCK" http://galho/extensions
```

Via TCP (para clientes que nao falam unix socket):

```bash
TOKEN=$(cat ~/Library/Application\ Support/Galho/agent-token)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9224/tabs
```

**CDP vem desligado por padrao.** Suba com `GALHO_CDP=1` (ou `GALHO_CDP_PORT` explicito) para expor o Chrome DevTools Protocol completo em `127.0.0.1:9223`. Com CDP ligado, o `GET /tabs` inclui `targetId`/`cdpUrl` por aba, e Playwright funciona:

```js
const { chromium } = require('playwright')
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223')
```

### Seguranca

Objetivo: **nenhuma superficie local sem autenticacao**. Um browser carrega suas sessoes logadas; uma porta localhost aberta e alcancavel por qualquer processo de qualquer usuario da maquina, entao qualquer app ou malware local poderia dirigir o browser.

- **Unix socket com modo 0600** — permissao de filesystem e a autenticacao (mesmo modelo do `docker.sock`). E o transporte padrao e preferido.
- **TCP exige bearer token** — aleatorio por instalacao, salvo em `<userData>/agent-token` (modo 0600). Sem ele, `401`.
- **CDP e opt-in** — o protocolo DevTools nao tem autenticacao nenhuma, entao a porta simplesmente nao existe a menos que voce suba com `GALHO_CDP=1`. A API de alto nivel (click/type/eval/screenshot) nao depende dele.

Nao exponha nada disso na rede. A sidebar e o chrome da janela ficam fora do alcance das paginas (WebContentsView separada) — pagina nao consegue falsificar a UI do browser.

## Distribuicao

`pnpm dist` gera `dist/Galho-<versao>-arm64.dmg` e `.zip` (macOS). `pnpm dist:win` / `pnpm dist:linux` geram NSIS installer / AppImage+deb (rodar em CI ou na plataforma alvo de preferencia). Sem assinatura/notarizacao por enquanto — primeiro open exige clique direito > Abrir.

## Arquitetura

```
src/
  main.js               janelas (multi-window), sessao (UA Chrome), IPC, permissoes
  tab-manager.js        spaces, abas, pastas, split, archive, WebContentsView por aba
  palette-controller.js command palette (overlay transparente) + acoes + modos
  find-controller.js    barra de find in page
  agent-api.js          API de agente (unix socket + TCP com token) + cursor de IA injetado
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
- Auto-update (electron-updater)
- Assinatura/notarizacao macOS
- Restaurar sessao apos crash de renderer (hoje: recarregar a aba)

## Licenca

O codigo do Galho e [MIT](LICENSE). O app depende de [electron-chrome-extensions](https://github.com/samuelmaddock/electron-browser-shell), que e GPL-3.0 — distribuicoes binarias que a incluem ficam sujeitas aos termos da GPL-3.0.
