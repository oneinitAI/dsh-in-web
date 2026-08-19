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
 * Wave 0 SURFACE 验证（CDP 直连版）：
 * 直接以子进程启动 chrome.exe（完全控制命令行，绕开 Playwright 默认 --disable-extensions），
 * 通过 --remote-debugging-port + DevToolsActivePort 连接。
 *
 * 用法: node scripts/verify-wave0.mjs
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const EXT_PATH = resolve('F:/dsh/dsh-in-web/.output/chrome-mv3')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const TARGET = 'https://chat.deepseek.com/'

function assert(cond, msg) {
  if (!cond) {
    console.error(`✗ FAIL: ${msg}`)
    process.exitCode = 1
  } else {
    console.log(`✓ PASS: ${msg}`)
  }
}

async function waitForPort(userDataDir, timeoutMs = 20000) {
  const portFile = join(userDataDir, 'DevToolsActivePort')
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (existsSync(portFile)) {
      try {
        const [port] = readFileSync(portFile, 'utf8').split('\n')
        if (port) return Number(port.trim())
      } catch { /* retry */ }
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`DevToolsActivePort 未生成 (${timeoutMs}ms)`)
}

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'dsh-cdp-'))
  const chrome = spawn(CHROME, [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
    '--headless=new',
  ], { stdio: 'ignore' })

  let context
  try {
    const port = await waitForPort(userDataDir)
    console.log(`ℹ Chrome 已启动，CDP port=${port}`)
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    context = browser.contexts()[0]
    if (!context) throw new Error('CDP 无默认 context')
    console.log('ℹ CDP 已连接，开始验证…')

    const page = await context.newPage()
    const pageErrors = []
    const consoleLog = []
    page.on('pageerror', (err) => pageErrors.push(String(err)))
    page.on('console', (msg) => {
      if (msg.type() === 'error') pageErrors.push(`console: ${msg.text()}`)
      consoleLog.push(`[${msg.type()}] ${msg.text()}`)
    })

    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(6000)

    // 2. 扩展 SW 已注册并运行
    const sw = context.serviceWorkers().find((w) => w.url().includes('chrome-extension://')) ?? null
    assert(Boolean(sw), `扩展 Service Worker 已注册并运行 (${sw?.url() ?? '无'})`)

    // 3. MAIN world 注入生效：页面消息流里有 page-ready
    const bridgeProbe = await page.evaluate(() => {
      const received = []
      const handler = (e) => {
        const d = e.data
        if (d && typeof d === 'object' && d.ns === 'dsh-in-web' && d.dir === 'up') {
          received.push({ topic: d.topic, payload: d.payload })
        }
      }
      window.addEventListener('message', handler)
      return new Promise((resolvePromise) => {
        setTimeout(() => {
          window.removeEventListener('message', handler)
          resolvePromise(received.slice(-3))
        }, 4000)
      })
    })
    assert(
      Array.isArray(bridgeProbe) && bridgeProbe.some((m) => m.topic === 'page-ready'),
      `MAIN world → 页面消息流包含 page-ready (${JSON.stringify(bridgeProbe.map((m) => m.topic))})`,
    )
    const readyPayload = (bridgeProbe.find((m) => m.topic === 'page-ready') ?? {}).payload
    assert(
      readyPayload && typeof readyPayload.authPresent === 'boolean',
      `page-ready 携带 authPresent 探测字段 (authPresent=${readyPayload?.authPresent})`,
    )

    // 4. bridge → SW 链路
    let swSeen = null
    if (sw) {
      await sw.evaluate(async () => {
        globalThis.__dshSeen = []
        chrome.runtime.onMessage.addListener((m) => {
          globalThis.__dshSeen.push(m?.topic)
        })
      })
      await page.waitForTimeout(3500)
      swSeen = await sw.evaluate(() => globalThis.__dshSeen ?? null)
    }
    assert(
      Array.isArray(swSeen) && swSeen.includes('page-event'),
      `bridge 已将页面事件转发到 SW (SW 收到: ${JSON.stringify(swSeen)})`,
    )

    // 5. 无未捕获页面错误
    assert(pageErrors.length === 0, `无未捕获页面错误 (${pageErrors.join('; ') || '无'})`)

    // 5.5 console 转储（检查 content script 注入标记）
    const dshLogs = consoleLog.filter((l) => l.includes('[dsh]'))
    console.log(`ℹ 页面 console 中 dsh 标记: ${dshLogs.length ? dshLogs.join(' | ') : '(无)'}`)

    await page.screenshot({ path: '.omo/evidence/wave0-page.png' })
    console.log('📸 页面截图 → .omo/evidence/wave0-page.png')
  } catch (err) {
    console.error('✗ 验证主体异常:', err)
    throw err
  } finally {
    if (context) await context.close().catch(() => {})
    // 等 Chrome 完全退出后再清理，避免 EPERM 掩盖真实错误
    const exited = new Promise((r) => chrome.once('exit', r))
    chrome.kill()
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
    try {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
    } catch {
      // 清理失败不阻塞结果
    }
  }
}

main().catch((err) => {
  console.error('✗ 验证脚本异常:', err)
  process.exit(1)
})
