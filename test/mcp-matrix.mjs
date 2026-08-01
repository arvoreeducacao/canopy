import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const client = new Client({ name: 'canopy-matrix', version: '0.0.1' })
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:4664/mcp')))
const mcp = async (name, args) => {
  const res = await client.callTool({ name, arguments: args })
  return res.content[0].type === 'text' ? res.content[0].text : '<img>'
}
const rest = (path, body) => fetch('http://127.0.0.1:4664' + path, {
  method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined
}).then(r => r.json())
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function scenario(name, openVia, fillVia) {
  let tab
  if (openVia === 'mcp') {
    const out = await mcp('browser_open', { url: 'https://news.ycombinator.com' })
    tab = out.match(/tab: (t\d+)/)[1]
  } else {
    tab = (await rest('/tabs', { url: 'https://news.ycombinator.com' })).id
    await sleep(4000)
  }
  await rest(`/tabs/${tab}/snapshot`)
  const env = (await rest(`/tabs/${tab}/eval`, { expression: 'JSON.stringify({focus: document.hasFocus(), vis: document.visibilityState})' })).result
  if (fillVia === 'mcp') await mcp('browser_act', { tab, action: 'fill', ref: 228, text: name })
  else await rest(`/tabs/${tab}/act`, { action: 'fill', ref: 228, text: name })
  await rest(`/tabs/${tab}/act`, { action: 'press', key: 'Enter' })
  await sleep(2500)
  const url = (await rest(`/tabs/${tab}/eval`, { expression: 'location.href' })).result
  console.log(`${name} | env=${env} | ${url && url.includes('algolia') ? 'NAVEGOU ✅' : 'FALHOU ❌'} (${url})`)
  await rest(`/tabs/${tab}/control`, {})
}

await scenario('open-mcp_fill-mcp', 'mcp', 'mcp')
await scenario('open-mcp_fill-rest', 'mcp', 'rest')
await scenario('open-rest_fill-mcp', 'rest', 'mcp')
await scenario('open-rest_fill-rest', 'rest', 'rest')
process.exit(0)
