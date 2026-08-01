import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const client = new Client({ name: 'canopy-debug', version: '0.0.1' })
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:4664/mcp')))
const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args })
  return res.content[0].type === 'text' ? res.content[0].text : '<img>'
}

const out = await call('browser_open', { url: 'https://news.ycombinator.com', label: 'debug mcp' })
const tab = out.match(/tab: (t\d+)/)[1]
const line = out.split('\n').find(l => /Search:/.test(l))
console.log('tab', tab, '| line:', line)
const ref = Number(line.match(/^\[(\d+)\]/)[1])

const fillOut = await call('browser_act', { tab, action: 'fill', ref, text: 'browser agents', label: 'debug fill' })
console.log('fill result:', fillOut)
console.log('value after fill:', await call('browser_eval', { tab, code: 'JSON.stringify({v: document.querySelector("input[name=q]").value, ae: document.activeElement && document.activeElement.name})' }))
const pressOut = await call('browser_act', { tab, action: 'press', key: 'Enter' })
console.log('press result:', pressOut)
await new Promise(r => setTimeout(r, 2500))
console.log('url:', await call('browser_eval', { tab, code: 'location.href' }))
await call('browser_close', { tab })
process.exit(0)
