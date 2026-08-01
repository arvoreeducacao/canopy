// Stagehand driving the SAME browser Canopy manages — the agent lane is a
// standard CDP endpoint, so the whole ecosystem (Stagehand, Playwright,
// puppeteer, browser-use) plugs into it. Overlay/badges/cockpit keep working
// because the daemon observes the same tabs.
//
//   pnpm add @browserbasehq/stagehand
//   node examples/stagehand.mjs
import { Stagehand } from '@browserbasehq/stagehand'

const stagehand = new Stagehand({
  env: 'LOCAL',
  localBrowserLaunchOptions: {
    cdpUrl: 'http://127.0.0.1:9222' // the Chrome that `canopy --launch-chrome` started
  },
  modelName: 'claude-sonnet-5',
  modelClientOptions: { apiKey: process.env.ANTHROPIC_API_KEY }
})

await stagehand.init()
const page = stagehand.page

await page.goto('https://news.ycombinator.com')
const { headlines } = await page.extract({
  instruction: 'extract the top 5 headlines',
  schema: {
    type: 'object',
    properties: { headlines: { type: 'array', items: { type: 'string' } } }
  }
})
console.log(headlines)

await stagehand.close()
