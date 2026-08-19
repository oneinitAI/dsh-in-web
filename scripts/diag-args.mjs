/**
 * dsh-in-web — DeepSeek Harness (dsh) in the browser.
 *
 * This file embeds/adapts code from deepseek-ai/DeepSeek-Harness (dsh),
 * distributed under the MIT License.
 *
 * Copyright (c) 2026 DeepSeek (dsh / DeepSeek-Harness)
 * Copyright (c) 2026 oneinitAI
 *
 * SPDX-License-Identifier: MIT
 */

/**
 * 检查 Chrome 实际启动命令行：是否被 Playwright 默认参数禁用了扩展。
 */
import { chromium } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const EXT_PATH = resolve('F:/dsh/dsh-in-web/.output/chrome-mv3')

const userDataDir = mkdtempSync(join(tmpdir(), 'dsh-diag3-'))
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
  const page = await context.newPage()
  await page.goto('chrome://version/', { timeout: 30000 })
  await page.waitForTimeout(1000)
  const text = await page.evaluate(() => document.body?.innerText ?? '')
  const cmdLine = text.split('\n').find((l) => l.includes('--')) ?? '(无命令行)'
  console.log('=== chrome://version 命令行 ===')
  console.log(cmdLine.slice(0, 3000))
  console.log('=== 结束 ===')
} finally {
  await context.close()
  rmSync(userDataDir, { recursive: true, force: true })
}
