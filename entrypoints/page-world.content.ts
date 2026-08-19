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
 * MAIN world content script —— 与 chat.deepseek.com 页面共享 window 上下文。
 * 职责（Wave 0：骨架链路；Wave 1：fetch 拦截 + SSE + userToken）：
 * 1. 注入完成 → window.postMessage 上报 page-ready（含登录态探测）
 * 2. 监听 bridge 下发的命令（down 方向）
 * 3. （Wave 1）hook window.fetch / 读取 localStorage.userToken
 *
 * 注意：MAIN world 无 chrome.runtime，只能经 window.postMessage 与 isolated bridge 通信。
 * 该脚本运行在页面 origin，视页面为敌对环境：不信任页面变量、不存 secret。
 */
export default defineContentScript({
  matches: ['https://chat.deepseek.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    const NS = 'dsh-in-web'
    console.log('[dsh] page-world 注入完成 (MAIN world)')

    /** 向 isolated bridge 发送页面 → 扩展 消息 */
    function postUp(topic: string, payload?: unknown) {
      window.postMessage({ ns: NS, dir: 'up', topic, payload }, '*')
    }

    /** 探测登录态并返回 userToken：localStorage 中 JSON 包装的 value */
    function readUserToken(): string | null {
      try {
        const raw = window.localStorage.getItem('userToken')
        if (!raw) return null
        const parsed = JSON.parse(raw) as { value?: unknown }
        if (typeof parsed?.value === 'string' && parsed.value.length > 0) return parsed.value
        return null
      } catch {
        return null
      }
    }

    // 监听扩展下发的命令（down 方向）
    window.addEventListener('message', (event: MessageEvent) => {
      const data = event.data
      if (
        typeof data === 'object' &&
        data !== null &&
        (data as { ns?: unknown }).ns === NS &&
        (data as { dir?: unknown }).dir === 'down'
      ) {
        const payload = (data as { payload?: unknown }).payload as
          | { cmd?: string; args?: unknown }
          | undefined
        if (payload?.cmd === 'read-token') {
          // 应 SW 请求回传最新 token
          postUp('page-ready', { authPresent: Boolean(readUserToken()), token: readUserToken(), url: location.href })
        }
        if (payload?.cmd === 'context-invalidated') {
          // 扩展已 reload，本页面旧上下文失效 —— 停轮询，提示刷新
          clearInterval(timer)
          console.warn('[dsh] 扩展已重新加载，本页面上下文失效 —— 请刷新 chat.deepseek.com 页面。')
        }
      }
    })

    // 注入完成即上报（document_start 时 localStorage 可能尚未就绪，做一次延时确认）
    const report = () => postUp('page-ready', { authPresent: Boolean(readUserToken()), token: readUserToken(), url: location.href })
    report()
    // React 挂载 / 登录态变化后重报（简单轮询，后续用事件/MutationObserver 优化）
    const timer = setInterval(() => {
      report()
    }, 3000)
    // 避免长驻：页面卸载前清理
    window.addEventListener('pagehide', () => clearInterval(timer), { once: true })
  },
})
