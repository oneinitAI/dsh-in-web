/**
 * Background service worker —— 扩展中枢。
 * Wave 1 职责：
 * 1. 维护页面状态与 userToken（MAIN world → bridge → SW）
 * 2. 与 side panel 建立长 port，把页面状态与桥接流事件推给 UI
 * 3. 编排 DeepSeekWebClient：收到 send-message → 流式调用 → 事件推送；stop-stream → abort
 * 4. 三种入口打开 side panel（工具图标 / 键盘命令 / bridge 请求）
 */
import { DeepSeekWebClient } from '@/utils/bridge/client'
import type { Message } from '@/utils/bridge/protocol'
import { PANEL_PORT, type BridgeEventMessage } from '@/utils/messages'

interface PageState {
  authPresent: boolean
  token: string | null
  url: string
  connected: boolean
}

const INITIAL_STATE: PageState = { authPresent: false, token: null, url: '', connected: false }

export default defineBackground(() => {
  let pageState: PageState = { ...INITIAL_STATE }
  // 会话内复用的 chat_session_id（多轮连续）
  let currentSessionId: string | undefined
  let activeStream: AbortController | null = null

  const panelPorts = new Set<chrome.runtime.Port>()

  /** 通知所有已连接 side panel */
  function broadcast(topic: string, payload: unknown) {
    for (const port of panelPorts) {
      try {
        port.postMessage({ topic, payload })
      } catch {
        // port 可能已断开
      }
    }
    // 也通过 sendMessage 兜底（panel 可能只挂 onMessage）
    chrome.runtime.sendMessage({ topic, payload }).catch(() => {
      // 无监听者，静默
    })
  }

  function pushBridgeEvent(ev: BridgeEventMessage) {
    broadcast('bridge-event', ev)
  }

  // ── 页面消息（bridge 上报 MAIN world 的 page-ready 等）──
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (typeof message !== 'object' || message === null) return
    const { topic } = message as { topic?: unknown }

    if (topic === 'page-event') {
      const payload = (message as { payload?: unknown }).payload as
        | { topic: string; payload?: unknown }
        | undefined
      if (payload?.topic === 'page-ready') {
        const p = payload.payload as { authPresent: boolean; token: string | null; url: string }
        pageState = {
          authPresent: Boolean(p?.authPresent),
          token: typeof p?.token === 'string' && p.token ? p.token : null,
          url: typeof p?.url === 'string' ? p.url : '',
          connected: true,
        }
        broadcast('page-state', pageState)
      }
      sendResponse({ ok: true })
      return true
    }

    if (topic === 'open-panel') {
      void openSidePanel(sender.tab?.id)
      sendResponse({ ok: true })
      return
    }

    // ── side panel 命令 ──────────────────────────────
    if (topic === 'send-message') {
      const { messages, reasoning } =
        (message as { payload?: { messages: Message[]; reasoning?: boolean } }).payload ?? {}
      void runStream(messages ?? [], reasoning ?? false)
      sendResponse({ ok: true })
      return
    }
    if (topic === 'stop-stream') {
      activeStream?.abort()
      activeStream = null
      pushBridgeEvent({ kind: 'error', error: 'stopped' })
      sendResponse({ ok: true })
      return
    }
    if (topic === 'clear-session') {
      currentSessionId = undefined
      sendResponse({ ok: true })
      return
    }
  })

  /** 流式聊天编排 */
  async function runStream(messages: Message[], reasoning: boolean) {
    if (!pageState.token) {
      pushBridgeEvent({ kind: 'error', error: '未检测到登录态，请先登录 chat.deepseek.com' })
      return
    }
    activeStream = new AbortController()
    const client = new DeepSeekWebClient({ userToken: pageState.token })
    try {
      const stream = client.streamChat(messages, {
        reasoning,
        signal: activeStream.signal,
        chatSessionId: currentSessionId,
      })
      for await (const ev of stream) {
        if (ev.kind === 'thinking') {
          pushBridgeEvent({ kind: 'thinking', text: ev.text })
        } else if (ev.kind === 'text') {
          pushBridgeEvent({ kind: 'text', text: ev.text })
        } else if (ev.kind === 'finish') {
          pushBridgeEvent({ kind: 'finish' })
        }
      }
    } catch (err) {
      if (activeStream?.signal.aborted) {
        pushBridgeEvent({ kind: 'error', error: '已停止' })
      } else {
        pushBridgeEvent({ kind: 'error', error: err instanceof Error ? err.message : String(err) })
      }
    } finally {
      activeStream = null
    }
  }

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
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PANEL_PORT) return
    panelPorts.add(port)
    port.onDisconnect.addListener(() => {
      panelPorts.delete(port)
    })
    port.postMessage({ topic: 'page-state', payload: pageState })
  })
})
