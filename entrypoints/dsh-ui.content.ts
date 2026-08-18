/**
 * dsh-ui.content.ts —— 页面内嵌 dsh 风格 UI 的开关注入器。
 *
 * 设置 dshMode：
 *   - 'on'  在 chat.deepseek.com 页面注入全屏 iframe（加载 sidepanel.html），
 *          复用整个 dsh Side Panel（会话/文件/技能/提示词/终端），样式天然隔离。
 *   - 'off' 移除 iframe，页面恢复普通 DeepSeek 对话。
 *
 * 监听 chrome.storage.onChanged（settings 键）实时切换，无需刷新页面。
 */

import { getSettings, subscribeSettings, type DshSettings } from '@/utils/settings/settings'

const FRAME_ID = 'dsh-in-web-frame'
const FRAME_URL = chrome.runtime.getURL('sidepanel.html')
/** iframe 与 Side Panel 打开方式共用同一页面；嵌入时用 ?embed=1 标记以便 UI 显示退出按钮 */
const EMBED_URL = `${FRAME_URL}?embed=1`

function existingFrame(): HTMLIFrameElement | null {
  return document.getElementById(FRAME_ID) as HTMLIFrameElement | null
}

function injectFrame(): void {
  if (existingFrame()) return
  const frame = document.createElement('iframe')
  frame.id = FRAME_ID
  // 全屏覆盖页面，z-index 极高确保压过页面所有元素
  frame.style.cssText = [
    'position: fixed',
    'inset: 0',
    'width: 100vw',
    'height: 100vh',
    'border: none',
    'z-index: 2147483647',
    'background: #0f1115',
  ].join(';')
  // 不设 sandbox：iframe 加载的是扩展自身页面（chrome-extension:// origin），
  // 需要完整 chrome.runtime API 与 SW 通信；跨源页面脚本无法访问 iframe 内容
  frame.src = EMBED_URL
  document.documentElement.appendChild(frame)
}

function removeFrame(): void {
  existingFrame()?.remove()
}

/** 根据设置切换注入状态 */
function applySettings(s: DshSettings): void {
  if (s.dshMode === 'on') injectFrame()
  else removeFrame()
}

export default defineContentScript({
  matches: ['https://chat.deepseek.com/*'],
  runAt: 'document_idle',
  main() {
    // 初始状态
    void getSettings().then(applySettings)
    // 实时监听设置变更（storage.onChanged 驱动）
    const unsubscribe = subscribeSettings(applySettings)
    // content script 卸载时清理（页面导航/重载时 WXT 会重建实例）
    window.addEventListener('pagehide', () => unsubscribe(), { once: true })
  },
})
