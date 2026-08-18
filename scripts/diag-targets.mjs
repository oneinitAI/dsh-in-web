/**
 * 深挖扩展加载：CDP Target.getTargets 枚举所有 target（含扩展 SW/页面），
 * 并打印 Chrome 版本 + 命令行。
 */
import { chromium } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const EXT_PATH = resolve('F:/dsh/dsh-in-web/.output/chrome-mv3')

const userDataDir = mkdtempSync(join(tmpdir(), 'dsh-diag4-'))
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chrome',
  headless: true,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    '--no-first-run',
  ],
})
try {
  const browserSession = await context.browser().newBrowserCDPSession()
  await browserSession.send('Target.setDiscoverTargets', { discover: true })

  const page = await context.newPage()
  await page.goto('chrome://version/', { timeout: 30000 })
  await page.waitForTimeout(1000)
  const text = await page.evaluate(() => document.body?.innerText ?? '')
  const ver = text.split('\n').find((l) => l.includes('版本')) ?? ''
  const cmdLine = text.split('\n').find((l) => l.includes('--disable-extensions')) ?? '(无 disable-extensions)'
  console.log('Chrome:', ver.trim())
  console.log('命令行含 disable-extensions?', cmdLine.includes('--disable-extensions') ? '是(仍有)' : '否(已移除)')

  // 打开 chat.deepseek.com
  await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(8000)

  const { targetInfos } = await browserSession.send('Target.getTargets')
  console.log('\n=== 全部 targets ===')
  for (const t of targetInfos) {
    console.log(`  [${t.type}] ${t.url}`)
  }
  console.log('=== 结束 ===')
} finally {
  await context.close()
  rmSync(userDataDir, { recursive: true, force: true })
}
