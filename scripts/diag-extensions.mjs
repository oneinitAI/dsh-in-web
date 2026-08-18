/**
 * 诊断 chrome://extensions：扩展是否成功加载。
 * 决定性证据：chrome://extensions 页面 DOM。
 */
import { chromium } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const EXT_PATH = resolve('F:/dsh/dsh-in-web/.output/chrome-mv3')

const userDataDir = mkdtempSync(join(tmpdir(), 'dsh-diag2-'))
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chrome',
  headless: true,
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    '--no-first-run',
  ],
})
try {
  // 打开 chrome://extensions
  const page = await context.newPage()
  page.on('console', (m) => console.log(`[console:${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => console.log('[pageerror]', String(e)))
  await page.goto('chrome://extensions/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(3000)

  // 强制开发者模式 UI 可见（chrome://extensions 在无 UI 模式可能渲染受限）
  const bodyText = await page.evaluate(() => document.body?.innerText ?? '')
  console.log('=== chrome://extensions 页面文本 ===')
  console.log(bodyText.slice(0, 2000))
  console.log('=== 结束 ===')

  // 同时尝试访问一个已知的扩展资源，检查加载是否成功
  // 先拿到所有 service worker
  await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(6000)
  const sws = context.serviceWorkers().map((w) => w.url())
  console.log('SWs:', sws.length ? sws : '(none)')
} finally {
  await context.close()
  rmSync(userDataDir, { recursive: true, force: true })
}
