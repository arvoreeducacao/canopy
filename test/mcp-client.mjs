// E2E test of the MCP surface, acting exactly like Claude Code would.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const client = new Client({ name: 'canopy-test', version: '0.0.1' })
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:4664/mcp')))

const tools = await client.listTools()
console.log('tools:', tools.tools.map(t => t.name).join(', '))

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args })
  const first = res.content[0]
  return first.type === 'text' ? first.text : `<${first.type} ${String(first.data).length}b>`
}

const session = JSON.parse(await call('session_start', { label: 'Teste MCP: busca no HN' }))
console.log('session:', session.id)

const openOut = await call('browser_open', {
  url: 'https://news.ycombinator.com',
  session: session.id,
  label: 'Abrindo o Hacker News'
})
const tab = openOut.match(/tab: (t\d+)/)[1]
console.log('tab:', tab, '| snapshot lines:', openOut.split('\n').length)

// find the search field ref on the page bottom
const snap = await call('browser_snapshot', { tab })
const searchRef = snap.split('\n').find(l => /search/i.test(l))
console.log('search line:', searchRef)
const ref = Number(searchRef.match(/^\[(\d+)\]/)[1])

await call('browser_act', { tab, action: 'fill', ref, text: 'browser agents', label: 'Buscando browser agents' })
await call('browser_act', { tab, action: 'press', key: 'Enter', label: 'Enviando busca' })
await call('browser_wait', { tab, until: 'js', value: 'location.host.includes("algolia")', timeoutMs: 15000 }).catch(() => {})

const read = await call('browser_read', { tab, maxChars: 400 })
console.log('page text after search:\n', read.slice(0, 300))

const evalOut = await call('browser_eval', {
  tab,
  code: `(() => JSON.stringify(location.href))()`,
  label: 'Conferindo URL'
})
console.log('eval:', evalOut)

const shot = await call('browser_screenshot', { tab })
console.log('screenshot:', shot)

console.log('status:', (await call('browser_status', {})).slice(0, 120))
await call('session_end', { session: session.id })
console.log('session ended ok')
process.exit(0)
