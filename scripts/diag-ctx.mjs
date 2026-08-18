/**
 * 深挖 content script 注入：CDP Runtime 观察所有 execution context（含 isolated world），
 * 并收集所有 console/exception/log 事件。
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const EXT_PATH = resolve('F:/dsh/dsh-in-web/.output/chrome-mv3')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

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
  throw new Error('DevToolsActivePort 未生成')
}

const userDataDir = mkdtempSync(join(tmpdir(), 'dsh-diag5-'))
const chrome = spawn(CHROME, [
  `--user-data-dir=${userDataDir}`,
  '--remote-debugging-port=0',
  `--disable-extensions-except=${EXT_PATH}`,
  `--load-extension=${EXT_PATH}`,
  '--no-first-run',
  '--headless=new',
], { stdio: 'ignore' })

let browser
try {
  const port = await waitForPort(userDataDir)
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const page = await browser.contexts()[0].newPage()

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')

  cdp.on('Runtime.executionContextCreated', (e) => {
    const c = e.context
    console.log(`[ctx] id=${c.id} name=${c.name || '(unnamed)'} origin=${c.origin} default=${c.auxData?.isDefault} type=${c.auxData?.type || ''} frame=${c.auxData?.frameId?.slice(0,8)}`)
  })
  cdp.on('Runtime.exceptionThrown', (e) => {
    console.log('[exception]', e.exceptionDetails?.text, e.exceptionDetails?.exception?.description?.slice(0, 300))
  })
  cdp.on('Log.entryAdded', (e) => {
    if (e.entry.level === 'error' || e.entry.level === 'warning')
      console.log(`[log:${e.entry.level}]`, e.entry.text?.slice(0, 300))
  })
  cdp.on('Runtime.consoleAPICalled', (e) => {
    const args = e.args.map((a) => a.value ?? a.description).join(' ')
    console.log(`[console:${e.type}]`, args.slice(0, 300))
  })

  await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(6000)
  console.log('--- 等待结束 ---')
} finally {
  if (browser) await browser.close().catch(() => {})
  chrome.kill()
  await new Promise((r) => setTimeout(r, 1000))
  try { rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch {}
}
