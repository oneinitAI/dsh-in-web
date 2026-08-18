/**
 * isolated world bridge —— MAIN world 与扩展后台之间的桥。
 * 职责（Wave 1.5 起扩展为 LLM 网络宿主）：
 * 1. 监听 MAIN world 的 window.postMessage（up 方向）→ 转发给 SW（chrome.runtime.sendMessage）
 * 2. 接收 SW 下发（chrome.runtime.onMessage）→ 转发给 MAIN world（down 方向 window.postMessage）
 * 3. （Wave 1.5）持有 DeepSeekWebClient —— 其 fetch 以页面 origin 发出，
 *    Origin/Referer/Cookie 天然正确（SW 的 fetch 无法伪造这些头）。
 *    接收 SW 的 chat-stream-start，执行流式聊天，事件经 chrome.runtime.sendMessage 回传。
 *
 * isolated world 拥有 chrome.runtime 且与页面共享 localStorage，但看不到页面 JS；
 * MAIN world 反之。二者靠 postMessage 对接。
 */
import { DeepSeekWebClient } from '@/utils/bridge/client'
import type { Message } from '@/utils/bridge/protocol'
import {
  BRIDGE_NS,
  EXT_TOPIC_CHAT_STREAM_DONE,
  EXT_TOPIC_CHAT_STREAM_ERROR,
  EXT_TOPIC_CHAT_STREAM_EVENT,
  EXT_TOPIC_CHAT_STREAM_START,
  EXT_TOPIC_CHAT_STREAM_STOP,
  type ChatStreamErrorPayload,
  type ChatStreamEventPayload,
  type ChatStreamStartPayload,
} from '@/utils/messages'

export default defineContentScript({
  matches: ['https://chat.deepseek.com/*'],
  runAt: 'document_start',
  main() {
    const NS = BRIDGE_NS
    console.log('[dsh] bridge 注入完成 (isolated world)')

    /** 扩展 reload 后旧上下文失效 —— 停转发并提示刷新页面 */
    let contextDead = false
    function notifyContextInvalidated() {
      if (contextDead) return
      contextDead = true
      console.warn('[dsh] 扩展上下文已失效（扩展已重新加载）—— 请刷新本页面。')
      try {
        window.postMessage({ ns: NS, dir: 'down', topic: 'page-command', payload: { cmd: 'context-invalidated' } }, '*')
      } catch {
        /* ignore */
      }
    }

    // ── 直接读页面 localStorage 的 userToken（isolated world 与页面共享存储）──
    function readUserToken(): string | null {
      try {
        const raw = localStorage.getItem('userToken')
        if (!raw) return null
        const parsed = JSON.parse(raw) as { value?: unknown }
        if (typeof parsed?.value === 'string' && parsed.value.length > 0) return parsed.value
        return null
      } catch {
        return null
      }
    }

    // ── chat-stream 宿主：SW 发起 → 本宿主执行流式 → 事件回传 ─────────
    const activeStreams = new Map<string, AbortController>()

    async function runChatStream(payload: ChatStreamStartPayload) {
      const { requestId, messages, reasoning, chatSessionId } = payload
      const token = readUserToken()
      if (!token) {
        sendError(requestId, '未检测到登录态，请先登录 chat.deepseek.com')
        return
      }
      const controller = new AbortController()
      activeStreams.set(requestId, controller)
      const client = new DeepSeekWebClient({ userToken: token })
      try {
        const stream = client.streamChat(messages as readonly Message[], {
          reasoning,
          chatSessionId,
          signal: controller.signal,
        })
        for await (const ev of stream) {
          if (ev.kind === 'thinking' || ev.kind === 'text') {
            sendEvent(requestId, ev.kind, ev.text)
          }
        }
        sendDone(requestId)
      } catch (err) {
        if (controller.signal.aborted) {
          sendDone(requestId) // 用户主动停止 → 正常结束
        } else {
          sendError(requestId, err instanceof Error ? err.message : String(err))
        }
      } finally {
        activeStreams.delete(requestId)
      }
    }

    function sendEvent(requestId: string, kind: 'thinking' | 'text', text: string) {
      if (contextDead) return
      const payload: ChatStreamEventPayload = { requestId, event: { kind, text } }
      try {
        void chrome.runtime.sendMessage({ topic: EXT_TOPIC_CHAT_STREAM_EVENT, payload })
      } catch {
        /* context invalidated，忽略 */
      }
    }

    function sendDone(requestId: string) {
      if (contextDead) return
      try {
        void chrome.runtime.sendMessage({ topic: EXT_TOPIC_CHAT_STREAM_DONE, payload: { requestId } })
      } catch {
        /* ignore */
      }
    }

    function sendError(requestId: string, error: string) {
      if (contextDead) return
      const payload: ChatStreamErrorPayload = { requestId, error }
      try {
        void chrome.runtime.sendMessage({ topic: EXT_TOPIC_CHAT_STREAM_ERROR, payload })
      } catch {
        /* ignore */
      }
    }

    // SW 命令（chrome.runtime.onMessage 在 isolated world 收到）：发起 / 中止流式聊天
    chrome.runtime.onMessage.addListener((message) => {
      if (contextDead) return
      if (typeof message !== 'object' || message === null) return
      const { topic } = message as { topic?: unknown }

      if (topic === EXT_TOPIC_CHAT_STREAM_START) {
        const payload = (message as { payload?: unknown }).payload as ChatStreamStartPayload | undefined
        if (payload?.requestId && Array.isArray(payload.messages)) {
          void runChatStream(payload)
        }
        return
      }
      if (topic === EXT_TOPIC_CHAT_STREAM_STOP) {
        const payload = (message as { payload?: unknown }).payload as { requestId?: string } | undefined
        const controller = payload?.requestId ? activeStreams.get(payload.requestId) : undefined
        controller?.abort()
        return
      }

      // SW → MAIN world（down）
      if (topic === 'page-command') {
        const payload = (message as { payload?: unknown }).payload
        window.postMessage({ ns: NS, dir: 'down', topic: 'page-command', payload }, '*')
      }
    })

    // ── 兜底：MAIN world 的 window.postMessage（up）→ SW ────────────
    window.addEventListener('message', (event: MessageEvent) => {
      const data = event.data
      if (
        typeof data === 'object' &&
        data !== null &&
        (data as { ns?: unknown }).ns === NS &&
        (data as { dir?: unknown }).dir === 'up'
      ) {
        const { topic, payload } = data as { topic: string; payload?: unknown }
        if (contextDead) return
        try {
          void chrome.runtime.sendMessage({ topic: 'page-event', payload: { topic, payload } })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes('Extension context invalidated')) notifyContextInvalidated()
          else console.error('[dsh] sendMessage 失败:', err)
        }
      }
    })
  },
})