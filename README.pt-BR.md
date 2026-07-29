# Galho

[![CI](https://github.com/arvoreeducacao/galho-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/arvoreeducacao/galho-browser/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Browser Arc-like e agent-native, construido sobre Electron (engine Chromium real). Sidebar de vidro colorida pelo space, spaces, command palette com busca por site, split view redimensionavel, pastas (incluindo live folders), extensoes da Chrome Web Store, find in page, auto-archive — e CDP + API HTTP de agente embutidos de fabrica, com overlay de takeover visivel para voce sempre saber quando um agente esta dirigindo.

English documentation: [README.md](README.md)

## Screenshots

| | |
|---|---|
| ![Sidebar de vidro tingida pela cor do space, com live folder e abas](docs/sidebar.png) | ![Command palette com abas abertas e acoes](docs/palette.png) |
| ![Split view redimensionavel](docs/split.png) | ![Overlay de agente: cursor, veu pontilhado e pill de takeover](docs/agent-cursor.png) |

![Peek da sidebar sobre a pagina quando a sidebar esta recolhida](docs/peek.png)

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

A UI vem em ingles por padrao e muda para portugues (pt-BR) quando o locale do sistema e `pt`. `GALHO_LANG` sobrescreve a deteccao.

O Galho se registra como handler de `http`/`https`, entao da para defini-lo como browser padrao — links clicados em outros apps abrem como abas na janela focada.

## Conceitos

- **Spaces**: grupos de abas com cor e icone proprios. A sidebar inteira e um vidro tingido pela cor do space ativo (vibrancy real no macOS). Clique direito no pill: renomear, icone, cor, limpar, excluir. O space **Agentes** e criado automaticamente quando um agente abre aba via API — o agente trabalha ali sem roubar seu foco, usando a mesma sessao logada.
- **Nao existe pagina de nova aba**: `Cmd+T` abre o command palette, como no Arc. Space vazio mostra so o fundo.
- **Favoritos**: `Cmd+D` fixa a aba como tile no grid do topo da sidebar.
- **Pastas**: clique direito na aba > Mover para pasta. Arrastar aba sobre a pasta tambem funciona. **Live folders** sao pastas alimentadas por script/agente via API (ex: seus PRs abertos) — aparecem com ponto laranja.
- **Split view**: `Cmd+Shift+D` (ou clique direito na aba > Abrir em split view). Duas abas lado a lado, com **divisor arrastavel** para redimensionar os paineis e acao no palette para inverter os lados.
- **Arquivo, nao fechar**: `Cmd+W` arquiva (recuperavel no palette > "Ver abas arquivadas"). Abas paradas sao arquivadas sozinhas (estilo Arc) — 12h por padrao, configuravel por space (24h, 7 dias ou nunca) no clique direito do pill. Botao de vassoura ou `Cmd+Shift+K` limpa o space inteiro (menos favoritos).
- **Command palette** (`Cmd+T`): busca fuzzy em abas abertas, historico (frecency), arquivadas, acoes do browser, URL direta ou busca no Google. `Cmd+L` abre em modo "abrir aqui". **Busca por site** com prefixos que vao direto na busca do site: `g` (Google), `yt` (YouTube), `gh` (GitHub), `npm`, `wiki` (Wikipedia), `mdn` (MDN), `maps` (Google Maps), `gpt` (ChatGPT) — ex: `gh split view`.
- **Peek da sidebar**: `Cmd+S` recolhe a sidebar (animado). Recolhida, passar o mouse na borda esquerda mostra um peek flutuante sobre a pagina — sem relayout.
- **Extensoes Chrome**: instale direto da Chrome Web Store (acao "Instalar extensoes" no palette, ou `POST /extensions` com o id da store). Dark Reader validado de ponta a ponta. Browser actions das extensoes aparecem na sidebar e itens de extensao no menu de contexto da pagina. Via `electron-chrome-extensions`.
- **Downloads**: silenciosos — arquivos vao para `~/Downloads` (nomes deduplicados), sem dialogo. `GET /downloads` lista; o palette tem a acao "Abrir pasta de downloads".
- **Boosts**: CSS/JS por host injetados em toda pagina daquele host, gerenciados pela API (`PUT /boosts/:host`) — boosts estilo Arc para agentes e scripts.

## Atalhos

| Atalho | Acao |
|---|---|
| `Cmd+T` | Command palette (nova aba) |
| `Cmd+L` | Palette em modo URL (navega na aba atual) |
| `Cmd+W` | Arquivar aba |
| `Cmd+Shift+T` | Reabrir aba fechada |
| `Cmd+D` | Fixar/desafixar favorito |
| `Cmd+F` | Buscar na pagina |
| `Cmd+Shift+D` | Split view (arraste o divisor para redimensionar) |
| `Cmd+Shift+P` | Picture-in-Picture |
| `Cmd+Shift+K` | Limpar abas do space |
| `Cmd+N` | Nova janela |
| `Cmd+Ctrl+N` | Novo space |
| `Cmd+S` | Mostrar/ocultar sidebar (hover na borda esquerda faz peek) |
| `Cmd+R` / `Cmd+Shift+R` | Recarregar / sem cache |
| `Cmd+[` / `Cmd+]` | Voltar / avancar |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Proxima / aba anterior |
| `Cmd+1..9` | Aba por indice (9 = ultima) |
| `Ctrl+1..9` | Space por indice |
| `Cmd+Alt+Left/Right` | Space anterior / proximo |
| `Cmd+Shift+C` | Copiar URL |
| `Cmd+Alt+I` | DevTools da aba |

Clique duplo renomeia space/pasta. Clique do meio arquiva aba. Arrastar reordena e move pra pastas.

## Performance

Medido num MacBook M2, 16 GB de RAM — mediana de 3 execucoes, 28-29/07/2026. "Empacotado" e um build real de `electron-builder`; RSS e o agregado de todos os processos via `ps` (superconta paginas compartilhadas, mas e a mesma metrica dos baselines, entao e comparavel entre apps).

```
Cold start (empacotado)   API pronta       ██████░░░░░░  316 ms
                          primeira pintura █████████░░░  ~0,5 s
```

| Metrica | Valor | Contexto |
|---|---:|---|
| Cold start → API de agente respondendo | **316 ms** | 355 ms em modo dev |
| Cold start → primeira pintura | **~0,5 s** | primeira execucao de um build novo paga 2-3 s uma vez (Gatekeeper) |
| `POST /tabs` (abrir aba) | **~12 ms** | o load da pagina depois disso e tempo do site, nao do Galho |
| `GET /tabs` | **< 1 ms** | com 10 abas abertas |
| Screenshot de aba (aba ativa) | **~28 ms** | abas em background hoje ~480 ms |
| Memoria, 0 abas | **235 MB** | 3 processos |
| Memoria por aba, sites pesados | **~250 MB** | portais de noticia cheios de ads; docs e paginas leves bem menos |

O custo por aba e dominado pelo site isolation do Chromium: cada iframe cross-origin (ads, principalmente) ganha processo proprio, entao 15 abas de noticia podem virar 70+ processos. Isso e a engine, nao o shell — como referencia, na mesma maquina o Arc estava em **~3,5 GB em 21 processos** com uma sessao normal. Um adblock instalado pelo suporte a extensoes achata essa curva mais que qualquer outra coisa.

## CLI

```
galho                          abre (ou foca) o browser
galho open <url> [-s space] [-f]   abre aba (padrao: space Agentes, sem foco)
galho tabs / spaces            listas
galho shot <id> [-o out.png]   screenshot da aba
galho text <id>                innerText da pagina
galho eval <id> <expr>         roda JS na pagina
galho click <id> <x> <y>       clica com o overlay de agente visivel
galho type <id> <texto>        digita (eventos reais de teclado)
galho press <id> <tecla>       Return, Tab, Escape...
galho close <id>               fecha a aba
galho folder <space> <nome> <links.json>   cria/atualiza live folder
```

## Integracao com agentes

O transporte primario e um **unix domain socket** em `<userData>/agent.sock` (macOS: `~/Library/Application Support/Galho/agent.sock`), modo `0600` — so o seu usuario fala com ele, sem token. Tambem existe um listener TCP em `127.0.0.1:9224` (`GALHO_API_PORT`), mas ele exige bearer token lido de `<userData>/agent-token`.

Quando um agente age numa aba (click/type/navigate/eval), a pagina mostra um overlay de takeover monocromatico: um **cursor de seta** que se move ate cada acao, um **veu pontilhado** sobre a pagina e uma pill dizendo **"Agente no controle"** (com o label da acao, quando informado), com botoes **Assumir** e **Parar** — um humano sempre pode interromper. A aba tambem ganha um badge pulsante na sidebar. Screenshots funcionam para abas em background e com a tela bloqueada.

```bash
SOCK=~/Library/Application\ Support/Galho/agent.sock
curl --unix-socket "$SOCK" http://galho/          # manifest + endpoints
curl --unix-socket "$SOCK" -X POST http://galho/tabs -d '{"url":"https://mail.google.com"}'
curl --unix-socket "$SOCK" http://galho/tabs/ID/screenshot -o shot.png
curl --unix-socket "$SOCK" -X POST http://galho/tabs/ID/click -d '{"x":500,"y":300,"label":"Abrindo a inbox"}'
curl --unix-socket "$SOCK" -X POST http://galho/tabs/ID/type -d '{"text":"ola"}'
curl --unix-socket "$SOCK" -X POST http://galho/folders -d '{"space":"Trabalho","name":"PRs","links":[{"title":"...","url":"..."}]}'
curl --unix-socket "$SOCK" -X PUT http://galho/boosts/github.com -d '{"css":"header { display: none }"}'
curl --unix-socket "$SOCK" http://galho/extensions
curl --unix-socket "$SOCK" http://galho/downloads
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
  main.js               janelas (multi-window), sessao (UA Chrome), IPC, permissoes,
                        downloads, boosts, peek da sidebar, URLs de browser padrao
  tab-manager.js        spaces, abas, pastas, split (ratio + swap), archive,
                        WebContentsView por aba
  palette-controller.js command palette (overlay transparente) + acoes + modos + busca por site
  find-controller.js    barra de find in page
  agent-api.js          API de agente (unix socket + TCP com token) + overlay de takeover
  menu.js               menu nativo + atalhos
  state.js              persistencia JSON debounced
  i18n.js               strings (en / pt-BR)
  preload.js            bridge IPC com whitelist de canais
ui/
  index.html/app.js/style.css   sidebar (vidro tingido pela cor do space; tambem renderiza o peek)
  palette.html/palette.js       command palette
  findbar.html                  barra de busca na pagina
  drag.html                     overlay de arrasto do divisor do split
  error.html                    pagina de erro de load
bin/
  galho.js              CLI
```

Cada janela tem seu TabManager; so a aba ativa (ou o par do split) fica attachada — as outras continuam rodando destacadas, entao Slack/Gmail seguem recebendo. Historico e compartilhado entre janelas. Sem framework, sem build step.

## Roadmap

- UI de downloads (hoje: silencioso para `~/Downloads` + API)
- Prompts de permissao por site (hoje: allowlist fixa - media/notificacoes sim, geolocalizacao nao)
- Auto-update (electron-updater)
- Assinatura/notarizacao macOS
- Restaurar sessao apos crash de renderer (hoje: recarregar a aba)
- Sleep de abas (derrubar o renderer de abas paradas ha muito tempo para devolver memoria)

## Licenca

O codigo do Galho e [MIT](LICENSE). O app depende de [electron-chrome-extensions](https://github.com/samuelmaddock/electron-browser-shell), que e GPL-3.0 — distribuicoes binarias que a incluem ficam sujeitas aos termos da GPL-3.0.
