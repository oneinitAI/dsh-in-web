/**
 * isolated world bridge —— MAIN world 与扩展后台之间的桥。
 * 职责：
 * 1. 监听 MAIN world 的 window.postMessage（up 方向）→ 转发给 SW（chrome.runtime.sendMessage）
 * 2. 接收 SW 下发（chrome.runtime.onMessage）→ 转发给 MAIN world（down 方向 window.postMessage）
 *
 * isolated world 拥有 chrome.runtime，但看不到页面 JS；MAIN world 反之。二者靠 postMessage 对接。
 */
export default defineContentScript({
  matches: ['https://chat.deepseek.com/*'],
  runAt: 'document_start',
  main() {
    const NS = 'dsh-in-web'
    console.log('[dsh] bridge 注入完成 (isolated world)')

    // MAIN world（up）→ SW
    window.addEventListener('message', (event: MessageEvent) => {
      const data = event.data
      if (
        typeof data === 'object' &&
        data !== null &&
        (data as { ns?: unknown }).ns === NS &&
        (data as { dir?: unknown }).dir === 'up'
      ) {
        const { topic, payload } = data as { topic: string; payload?: unknown }
        void chrome.runtime.sendMessage({ topic: 'page-event', payload: { topic, payload } })
      }
    })

    // SW → MAIN world（down）
    chrome.runtime.onMessage.addListener((message) => {
      if (typeof message === 'object' && message !== null) {
        const { topic } = message as { topic?: unknown }
        if (topic === 'page-command') {
          const payload = (message as { payload?: unknown }).payload
          window.postMessage({ ns: NS, dir: 'down', topic: 'page-command', payload }, '*')
        }
      }
    })
  },
})
