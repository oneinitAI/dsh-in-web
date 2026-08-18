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

    /** 探测登录态：localStorage 中是否存在 userToken（JSON 包装） */
    function detectAuth(): boolean {
      try {
        const raw = window.localStorage.getItem('userToken')
        if (!raw) return false
        const parsed = JSON.parse(raw) as { value?: unknown }
        return typeof parsed?.value === 'string' && parsed.value.length > 0
      } catch {
        return false
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
        // Wave 1 在此路由 CMD_SEND_MESSAGE / CMD_STOP_STREAM / CMD_READ_TOKEN
        void payload
      }
    })

    // 注入完成即上报（document_start 时 localStorage 可能尚未就绪，做一次延时确认）
    const report = () => postUp('page-ready', { authPresent: detectAuth(), url: location.href })
    report()
    // React 挂载 / 登录态变化后重报（简单轮询，Wave 1 用事件/MutationObserver 优化）
    const timer = setInterval(() => {
      report()
    }, 3000)
    // 避免长驻：页面卸载前清理
    window.addEventListener('pagehide', () => clearInterval(timer), { once: true })
  },
})
