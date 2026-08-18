/**
 * 诊断：扩展是否成功加载 + content script 是否注入。
 */
import { chromium } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const EXT_PATH = resolve('F:/dsh/dsh-in-web/.output/chrome-mv3')
const TARGET = 'https://chat.deepseek.com/'

async function tryMode(headless) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'dsh-diag-'))
  console.log(`\n=== headless=${headless} ===`)
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
      '--disable-popup-blocking',
    ],
  })
  try {
    const page = await context.newPage()
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text()}`)
    })
    page.on('pageerror', (e) => console.log(`[pageerror] ${e}`))

    // chrome://extensions 需要特殊处理，直接查 SW
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(8000)

    const sws = context.serviceWorkers().map((w) => w.url())
    console.log('SWs:', sws.length ? sws : '(none)')

    // 页面里是否有扩展 content script 痕迹
    const markers = await page.evaluate(() => {
      // 我们的 bridge 会在页面收 message；检查注入脚本是否定义了全局（WXT 可能不改全局）
      // 改为：检查是否有 chrome-extension 资源被加载（content script 注入会触发扩展请求）
      const out = { urls: [...document.querySelectorAll('script')].map((s) => s.src || s.text.slice(0, 40)) }
      return out
    })
    console.log('页面 script 数:', markers.urls.length)

    // 直接访问扩展页验证扩展可访问
    if (sws[0]) {
      const extId = sws[0].split('/')[2]
      const extPage = await context.newPage()
      await extPage.goto(`chrome-extension://${extId}/sidepanel.html`, { timeout: 15000 })
      await extPage.waitForTimeout(2000)
      const title = await extPage.title()
      console.log('sidepanel 标题:', title)
      await extPage.screenshot({ path: `.omo/evidence/diag-headless-${headless}.png` })
      await extPage.close()
    }
  } catch (e) {
    console.log('异常:', String(e))
  } finally {
    await context.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

await tryMode(true)
await tryMode(false)
