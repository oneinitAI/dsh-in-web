/**
 * Background service worker —— 扩展中枢。
 * Wave 1.5 架构：
 * 1. 维护页面状态（MAIN world → bridge → SW）
 * 2. 与 side panel 建立长 port，把页面状态与桥接流事件推给 UI
 * 3. 编排 agent loop：LLM 网络层在 content script（页面 origin fetch，Origin/Cookie 正确），
 *    SW 经 chat-stream 消息桥发起流式调用并收集事件
 * 4. 三种入口打开 side panel（工具图标 / 键盘命令 / bridge 请求）
 */
import type { Message } from '@/utils/bridge/protocol'
import {
  EXT_TOPIC_CHAT_STREAM_DONE,
  EXT_TOPIC_CHAT_STREAM_ERROR,
  EXT_TOPIC_CHAT_STREAM_EVENT,
  EXT_TOPIC_CHAT_STREAM_START,
  EXT_TOPIC_CHAT_STREAM_STOP,
  PANEL_PORT,
  type BridgeEventMessage,
  type ChatStreamEventPayload,
  type ChatStreamStartPayload,
} from '@/utils/messages'
import { runAgentLoop } from '@/utils/agent/loop'
import { buildAgentTools } from '@/utils/agent/tools'
import { Workspace } from '@/utils/fs/workspace'
import type { Skill } from '@/utils/skills/skill'
import type { LlmStreamEvent } from '@/utils/plugin/host'

interface PageState {
  authPresent: boolean
  token: string | null
  url: string
  connected: boolean
}

const INITIAL_STATE: PageState = { authPresent: false, token: null, url: '', connected: false }

/** 简单异步队列：把消息事件流转换成 async iterable */
class AsyncQueue<T> {
  private items: T[] = []
  private waiters: ((v: T) => void)[] = []

  push(item: T): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(item)
    else this.items.push(item)
  }

  async next(): Promise<T> {
    const item = this.items.shift()
    if (item !== undefined) return item
    return new Promise<T>((resolve) => this.waiters.push(resolve))
  }
}

type StreamSignal =
  | { kind: 'event'; event: LlmStreamEvent }
  | { kind: 'done' }
  | { kind: 'error'; error: string }

export default defineBackground(() => {
  let pageState: PageState = { ...INITIAL_STATE }
  /** 页面所在 tab（向 content script 发消息用） */
  let pageTabId: number | undefined
  // 会话内复用的 chat_session_id（多轮连续）
  let currentSessionId: string | undefined
  // agent 循环的会话消息历史（含 tool 结果回填）
  let sessionMessages: Message[] = []
  // skill 库（运行时经插件加载器填充）
  let skills: Skill[] = []

  const panelPorts = new Set<chrome.runtime.Port>()
  let requestSeq = 0

  /** 供 panel-query 使用的共享工作区（懒加载） */
  let queryWs: Workspace | null = null
  async function getQueryWs(): Promise<Workspace> {
    if (!queryWs) {
      queryWs = new Workspace({ sandboxMode: 'workspace-write', dbName: 'dsh-in-web-workspace' })
      await queryWs.init()
    }
    return queryWs
  }

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

  /** 向 content script 发消息（页面 origin 的 LLM 网络宿主） */
  async function sendToPage(message: Record<string, unknown>): Promise<void> {
    if (pageTabId == null) throw new Error('页面未连接（请打开 chat.deepseek.com）')
    await chrome.tabs.sendMessage(pageTabId, message)
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
        if (sender.tab?.id != null) pageTabId = sender.tab.id
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
      if (currentRequestId) {
        void sendToPage({ topic: EXT_TOPIC_CHAT_STREAM_STOP, payload: { requestId: currentRequestId } }).catch(
          () => {},
        )
        currentRequestId = undefined
      }
      pushBridgeEvent({ kind: 'error', error: 'stopped' })
      sendResponse({ ok: true })
      return
    }
    if (topic === 'clear-session') {
      currentSessionId = undefined
      sendResponse({ ok: true })
      return
    }

    // ── Side Panel 数据查询（文件树 / skill 库）────────────────
    if (topic === 'panel-query') {
      const { cmd, path } = (message as { payload?: { cmd?: string; path?: string } }).payload ?? {}
      void (async () => {
        try {
          if (cmd === 'list-files') {
            const ws = await getQueryWs()
            const root = await ws.list('/')
            sendResponse({ ok: true, entries: root })
          } else if (cmd === 'read-file' && path) {
            const ws = await getQueryWs()
            const content = await ws.readText(path)
            sendResponse({ ok: true, content: content ?? null })
          } else if (cmd === 'list-skills') {
            sendResponse({ ok: true, skills })
          } else {
            sendResponse({ ok: false, error: `unknown query: ${cmd}` })
          }
        } catch (err) {
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })()
      return true // 异步 sendResponse
    }
  })

  let currentRequestId: string | undefined

  /** LLM 桥：把 agent loop 的 LLM 调用转成 content script 的流式聊天 */
  async function* llmBridge(hist: Message[]): AsyncGenerator<LlmStreamEvent> {
    const requestId = `req-${Date.now()}-${requestSeq++}`
    currentRequestId = requestId
    const queue = new AsyncQueue<StreamSignal>()
    const listener = (msg: unknown) => {
      if (typeof msg !== 'object' || msg === null) return
      const m = msg as { topic?: unknown; payload?: unknown }
      const p = m.payload as { requestId?: string } | undefined
      if (p?.requestId !== requestId) return
      if (m.topic === EXT_TOPIC_CHAT_STREAM_EVENT) {
        const ev = (m.payload as ChatStreamEventPayload).event
        queue.push({ kind: 'event', event: ev })
      } else if (m.topic === EXT_TOPIC_CHAT_STREAM_DONE) {
        queue.push({ kind: 'done' })
      } else if (m.topic === EXT_TOPIC_CHAT_STREAM_ERROR) {
        queue.push({ kind: 'error', error: (m.payload as { error: string }).error })
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    try {
      const payload: ChatStreamStartPayload = {
        requestId,
        messages: hist,
        reasoning: currentReasoning,
        chatSessionId: currentSessionId,
      }
      await sendToPage({ topic: EXT_TOPIC_CHAT_STREAM_START, payload })
      while (true) {
        const sig = await queue.next()
        if (sig.kind === 'done') return
        if (sig.kind === 'error') throw new Error(sig.error)
        yield sig.event
      }
    } finally {
      chrome.runtime.onMessage.removeListener(listener)
      if (currentRequestId === requestId) currentRequestId = undefined
    }
  }

  let currentReasoning = false

  /** 流式聊天编排 —— agent loop 驱动（多轮工具调用回填） */
  async function runStream(messages: Message[], reasoning: boolean) {
    currentReasoning = reasoning
    const ws = new Workspace({ sandboxMode: 'workspace-write', dbName: 'dsh-in-web-workspace' })
    try {
      await ws.init()
    } catch (err) {
      pushBridgeEvent({ kind: 'error', error: `工作区初始化失败: ${err instanceof Error ? err.message : String(err)}` })
      return
    }

    try {
      const tools = buildAgentTools(ws, skills)
      const result = await runAgentLoop({
        llm: llmBridge,
        tools,
        messages,
        maxTurns: 8,
        onEvent: (ev) => {
          if (ev.kind === 'thinking') pushBridgeEvent({ kind: 'thinking', text: ev.text })
          else if (ev.kind === 'text') pushBridgeEvent({ kind: 'text', text: ev.text })
        },
      })
      pushBridgeEvent({ kind: 'finish' })
      // 更新会话内消息历史供下一轮连续对话（保留 tool 结果）
      sessionMessages = result.messages
    } catch (err) {
      pushBridgeEvent({ kind: 'error', error: err instanceof Error ? err.message : String(err) })
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