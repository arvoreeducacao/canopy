import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const client = new Client({ name: 'canopy-key', version: '0.0.1' })
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:4664/mcp')))
const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args })
  return res.content[0].type === 'text' ? res.content[0].text : '<img>'
}

const out = await call('browser_open', { url: 'https://news.ycombinator.com' })
const tab = out.match(/tab: (t\d+)/)[1]
const ref = Number(out.split('\n').find(l => /Search:/.test(l)).match(/^\[(\d+)\]/)[1])
console.log('tab', tab, 'ref', ref)

console.log('listener:', await call('browser_eval', { tab, code: 'window.addEventListener("keydown", e => { window.__k = e.key + ":" + (document.activeElement && document.activeElement.name) }) || "on"' }))
console.log('fill:', (await call('browser_act', { tab, action: 'fill', ref, text: 'abc' })).replace(/\n/g, ' '))
console.log('press:', (await call('browser_act', { tab, action: 'press', key: 'Enter' })).replace(/\n/g, ' '))
await new Promise(r => setTimeout(r, 2500))
console.log('check:', await call('browser_eval', { tab, code: 'JSON.stringify({k: window.__k || null, url: location.href, ae: document.activeElement && (document.activeElement.name || document.activeElement.tagName)})' }))
await call('browser_close', { tab })
process.exit(0)
