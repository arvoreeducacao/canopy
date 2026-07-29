const GALHO_LANG = (navigator.language || 'en').toLowerCase().startsWith('pt') ? 'pt' : 'en'

const GALHO_STRINGS = {
  en: {
    searchOrOpen: 'Search or open URL...',
    newTab: 'New tab',
    back: 'Back',
    forward: 'Forward',
    reload: 'Reload',
    cleanTabs: 'Clean tabs (Cmd+Shift+K)',
    newSpace: 'New space',
    openUrlTip: 'Open URL (Cmd+L)',
    emptyHint: 'to open a tab',
    archived: n => `Archived (${n})`,
    tabOptions: 'Tab options',
    archiveTab: 'Archive tab',
    inSplit: 'In split view',
    agentOnTab: 'Agent working on this tab',
    agentOnSpace: 'Agent working in this space',
    splitView: 'Split view',
    paletteDefault: 'Search, open URL or run an action...',
    findPlaceholder: 'Find in page...',
    findPrev: 'Previous',
    findNext: 'Next',
    close: 'Close',
    errorTitle: 'This page failed to load',
    retry: 'Try again'
  },
  pt: {
    searchOrOpen: 'Buscar ou abrir URL...',
    newTab: 'Nova aba',
    back: 'Voltar',
    forward: 'Avançar',
    reload: 'Recarregar',
    cleanTabs: 'Limpar abas (Cmd+Shift+K)',
    newSpace: 'Novo espaço',
    openUrlTip: 'Abrir URL (Cmd+L)',
    emptyHint: 'pra abrir uma aba',
    archived: n => `Arquivadas (${n})`,
    tabOptions: 'Opções da aba',
    archiveTab: 'Arquivar aba',
    inSplit: 'Em split view',
    agentOnTab: 'Agente trabalhando nesta aba',
    agentOnSpace: 'Agente trabalhando neste espaço',
    splitView: 'Split view',
    paletteDefault: 'Buscar, abrir URL ou executar ação...',
    findPlaceholder: 'Buscar na página...',
    findPrev: 'Anterior',
    findNext: 'Próximo',
    close: 'Fechar',
    errorTitle: 'Essa página não carregou',
    retry: 'Tentar de novo'
  }
}

function T(key, ...args) {
  const dict = GALHO_STRINGS[GALHO_LANG]
  const value = dict[key] !== undefined ? dict[key] : GALHO_STRINGS.en[key]
  if (typeof value === 'function') return value(...args)
  return value !== undefined ? value : key
}
