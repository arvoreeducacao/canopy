import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const client = new Client({ name: 'canopy-cross', version: '0.0.1' })
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:4664/mcp')))
const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args })
  return res.content[0].type === 'text' ? res.content[0].text : '<img>'
}
const rest = (path, body) => fetch('http://127.0.0.1:4664' + path, {
  method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined
}).then(r => r.json())

// tab opened+filled via MCP, Enter via REST
const out = await call('browser_open', { url: 'https://news.ycombinator.com' })
const tab = out.match(/tab: (t\d+)/)[1]
const ref = Number(out.split('\n').find(l => /Search:/.test(l)).match(/^\[(\d+)\]/)[1])
await call('browser_act', { tab, action: 'fill', ref, text: 'via-mcp-press-rest' })
console.log('press via REST:', await rest(`/tabs/${tab}/act`, { action: 'press', key: 'Enter' }))
await new Promise(r => setTimeout(r, 2500))
console.log('url:', await rest(`/tabs/${tab}/eval`, { expression: 'location.href' }))
await rest(`/tabs/${tab}/control`, {})
await call('browser_close', { tab }).catch(() => {})

// tab opened+filled via REST, Enter via MCP
const t2 = await rest('/tabs', { url: 'https://news.ycombinator.com' })
await new Promise(r => setTimeout(r, 4000))
await rest(`/tabs/${t2.id}/snapshot`)
await rest(`/tabs/${t2.id}/act`, { action: 'fill', ref: 228, text: 'via-rest-press-mcp' })
console.log('press via MCP:', (await call('browser_act', { tab: t2.id, action: 'press', key: 'Enter' })).replace(/\n/g, ' '))
await new Promise(r => setTimeout(r, 2500))
console.log('url:', await rest(`/tabs/${t2.id}/eval`, { expression: 'location.href' }))
await rest(`/tabs/${t2.id}/control`, {})
process.exit(0)
