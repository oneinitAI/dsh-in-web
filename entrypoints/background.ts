/**
 * Background service worker —— 扩展中枢。
 * Wave 0 职责：
 * 1. 维护页面状态（authPresent / url），从 bridge 收 page-event
 * 2. 与 side panel 建立长 port（PANEL_PORT），把页面状态推给 UI
 * 3. 三种入口打开 side panel（工具图标 / 键盘命令 / bridge 请求）
 * Wave 1+ 在此扩展：桥接层调用、agent 状态机、任务队列。
 */
export default defineBackground(() => {
  // ── 页面状态（MAIN world → bridge → SW）────────────────
  let pageState = {
    authPresent: false,
    url: '',
    connected: false,
  }

  /** 通知所有已连接的 side panel */
  function broadcastState() {
    chrome.runtime.sendMessage({ topic: 'page-state', payload: pageState }).catch(() => {
      // side panel 可能未打开，静默忽略
    })
  }

  // bridge 上报（MAIN world 的 page-ready / 后续 sse-event 等）
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (typeof message !== 'object' || message === null) return
    const { topic } = message as { topic?: unknown }
    if (topic === 'page-event') {
      const payload = (message as { payload?: unknown }).payload as
        | { topic: string; payload?: unknown }
        | undefined
      if (payload?.topic === 'page-ready') {
        const p = payload.payload as { authPresent: boolean; url: string }
        pageState = {
          authPresent: Boolean(p?.authPresent),
          url: typeof p?.url === 'string' ? p.url : '',
          connected: true,
        }
        broadcastState()
      }
      // 支持来自 bridge 的异步响应（后续桥接层调用）
      sendResponse({ ok: true })
      return true
    }
    if (topic === 'open-panel') {
      void openSidePanel(sender.tab?.id)
      sendResponse({ ok: true })
      return
    }
  })

  async function openSidePanel(tabId?: number) {
    try {
      if (tabId != null) {
        await chrome.sidePanel.open({ tabId })
      } else {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
        if (tab?.id != null) await chrome.sidePanel.open({ tabId: tab.id })
      }
    } catch {
      // 非用户手势上下文会拒绝，静默
    }
  }

  // 工具图标点击 → 打开 side panel
  chrome.action.onClicked.addListener((tab) => {
    void openSidePanel(tab.id)
  })

  // 键盘命令 → 打开 side panel
  chrome.commands.onCommand.addListener((command) => {
    if (command === 'open-side-panel') {
      void openSidePanel()
    }
  })

  // ── 长 port：side panel ↔ SW 保活 + 推送通道 ──────────
  const panelPorts = new Set<chrome.runtime.Port>()
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'dsh-panel-port') return
    panelPorts.add(port)
    port.onMessage.addListener((message) => {
      // Wave 1+：SW 收到的面板命令（如 send-message）在此路由
      void message
    })
    port.onDisconnect.addListener(() => {
      panelPorts.delete(port)
    })
    // 连接建立即推送当前状态
    port.postMessage({ topic: 'page-state', payload: pageState })
  })

  // 供 side panel 主动拉取（若 port 尚未建立）
  chrome.runtime.onConnect.addListener(() => {})
})
