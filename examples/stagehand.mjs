// Stagehand driving the SAME browser Canopy manages — the agent lane is a
// standard CDP endpoint, so the whole ecosystem (Stagehand, Playwright,
// puppeteer, browser-use) plugs into it. Overlay/badges/cockpit keep working
// because the daemon observes the same tabs.
//
//   pnpm add -D @browserbasehq/stagehand
//   node examples/stagehand.mjs
//
// Needs a Chromium with an open CDP port (the one `canopy --launch-chrome`
// starts). ANTHROPIC_API_KEY enables the LLM extract step; without it the
// example still proves the CDP plumbing (connect + navigate + read title).
import { Stagehand } from '@browserbasehq/stagehand'
import { z } from 'zod'

const CDP = process.env.CANOPY_CDP_URL || 'http://127.0.0.1:9222'

// Chrome only accepts WS upgrades on the exact per-instance debugger path.
const { webSocketDebuggerUrl } = await (await fetch(`${CDP}/json/version`)).json()

const stagehand = new Stagehand({
  env: 'LOCAL',
  localBrowserLaunchOptions: { cdpUrl: webSocketDebuggerUrl },
  modelName: 'claude-sonnet-5',
  modelClientOptions: { apiKey: process.env.ANTHROPIC_API_KEY }
})

await stagehand.init()
const page = stagehand.context.pages()[0] || await stagehand.context.newPage()

await page.goto('https://news.ycombinator.com')
console.log('connected via CDP, page title:', await page.title())

if (process.env.ANTHROPIC_API_KEY) {
  const { headlines } = await stagehand.extract({
    instruction: 'extract the top 5 headlines',
    schema: z.object({ headlines: z.array(z.string()) })
  })
  console.log(headlines)
} else {
  console.log('ANTHROPIC_API_KEY não definido — pulei o extract com LLM')
}

await stagehand.close()
