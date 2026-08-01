# TODO

## Não feito / não testado
- [ ] E2E completo dentro do Arc real (testei tudo no Chrome for Testing; no Arc só abrir aba + badge)
- [ ] Agrupamento de abas no Arc — retornou `-1` (Arc pode não renderizar tab groups; investigar alternativa)
- [ ] Screenshot/validação visual do cockpit "Mission Control" pós-redesign (não conferi o resultado do agente)
- [ ] Stagehand: `examples/stagehand.mjs` escrito, nunca executado
- [ ] Skill `skills/canopy/` não instalada no Claude Code (`~/.claude/skills`)
- [ ] Replay com sessões multi-aba: filtro por aba implementado, pouco testado

## Falta construir
- [ ] README de release: prints, GIF/vídeo demo, benchmarks (tokens/tempo vs Playwright MCP) — repo já é público e está sem isso
- [ ] Auth token no daemon (hoje: localhost sem auth; qualquer processo local controla o browser logado)
- [ ] Reconectar/adotar abas de agente órfãs quando o daemon reinicia (hoje ficam soltas)
- [ ] CLI de comandos (`canopy open <url>`, `canopy tabs`…) — só existe o launcher
- [ ] Empacotar extensão pra Web Store (hoje: modo dev / load unpacked)
- [ ] Suporte Windows/Linux no launcher (`open -g` e paths são macOS-only)

## Ação do usuário (30s)
- [ ] Arc: remover extensão antiga → carregar `/Users/joaobarros/Arvore/canopy/extension`
- [ ] `claude mcp remove galho ; claude mcp add --transport http canopy http://127.0.0.1:4664/mcp`
