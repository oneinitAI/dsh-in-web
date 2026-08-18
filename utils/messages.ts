/**
 * 共享消息协议：MAIN world ↔ isolated bridge ↔ SW ↔ Side Panel 全链路。
 * 独立于各运行时，纯类型 + 常量，可在四端安全 import。
 */

/** window.postMessage 信封的命名空间，避免与页面自身消息冲突 */
export const BRIDGE_NS = 'dsh-in-web'

/**
 * MAIN world ↔ isolated bridge 之间的 window.postMessage 信封。
 * - dir: 'up'   页面 → 扩展（MAIN world 发出，bridge 监听）
 * - dir: 'down' 扩展 → 页面（bridge 发出，MAIN world 监听）
 */
export interface PageEnvelope {
  ns: typeof BRIDGE_NS
  dir: 'up' | 'down'
  topic: string
  payload?: unknown
}

/** 判断是否为我们的信封 */
export function isPageEnvelope(data: unknown): data is PageEnvelope {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { ns?: unknown }).ns === BRIDGE_NS
  )
}

// ── up topics（页面 → 扩展）───────────────────────────────

/** MAIN world 注入完成，上报页面上下文快照 */
export const TOPIC_PAGE_READY = 'page-ready'
export interface PageReadyPayload {
  /** 页面是否已登录（localStorage 里是否存在 userToken） */
  authPresent: boolean
  /** localStorage.userToken 的值（JSON 包装解出），未登录为 null */
  token: string | null
  /** 当前页面 URL */
  url: string
}

/** MAIN world 拦截到 chat.deepseek.com 的 SSE 事件（Wave 1 起使用） */
export const TOPIC_SSE_EVENT = 'sse-event'

/** MAIN world 拦截到页面发出的 fetch 请求（Wave 1 起使用，用于漂移检测） */
export const TOPIC_PAGE_FETCH = 'page-fetch'

// ── down topics（扩展 → 页面）─────────────────────────────

/** 扩展向页面注入命令（Wave 1 起使用：发消息、停止流等） */
export const TOPIC_PAGE_COMMAND = 'page-command'
export interface PageCommandPayload {
  cmd: string
  args?: unknown
}

// ── chrome.runtime 消息（bridge ↔ SW ↔ side panel）─────────

/**
 * 扩展内部消息。bridge 与 SW / side panel 之间用 chrome.runtime.sendMessage 或 Port。
 * topic 复用上面的常量，额外加扩展内部 topic。
 */
export interface ExtMessage {
  topic: string
  payload?: unknown
}

/** 长连接 port 名称：side panel ↔ SW */
export const PANEL_PORT = 'dsh-panel-port'

/** bridge → SW：页面上报 */
export const EXT_TOPIC_PAGE_EVENT = 'page-event'

/** SW → side panel：页面状态更新 */
export const EXT_TOPIC_PAGE_STATE = 'page-state'

/** SW → side panel：桥接流事件（thinking/text/finish/error） */
export const EXT_TOPIC_BRIDGE_EVENT = 'bridge-event'
export interface BridgeEventMessage {
  kind: 'thinking' | 'text' | 'finish' | 'error'
  text?: string
  error?: string
}

// ── 命令枚举（Wave 1 起使用）──────────────────────────────

export const CMD_SEND_MESSAGE = 'send-message'
export const CMD_STOP_STREAM = 'stop-stream'
export const CMD_READ_TOKEN = 'read-token'
export const CMD_OPEN_PANEL = 'open-panel'

// ── chat-stream：SW ↔ content script 的 LLM 流式桥（Wave 1.5 起使用）────────
// content script（isolated world）持有 DeepSeekWebClient —— 其 fetch 以页面
// origin 发出，Origin/Referer/Cookie 天然正确（SW 的 fetch 无法伪造这些头）。

/** SW → content script：发起一次流式聊天 */
export const EXT_TOPIC_CHAT_STREAM_START = 'chat-stream-start'
export interface ChatStreamStartPayload {
  requestId: string
  messages: { role: 'system' | 'user' | 'assistant' | 'tool'; content: string }[]
  reasoning?: boolean
  /** 复用已有会话；缺省由 content script 自动创建 */
  chatSessionId?: string
}

/** content script → SW：流式事件（thinking/text），与 requestId 关联 */
export const EXT_TOPIC_CHAT_STREAM_EVENT = 'chat-stream-event'
export interface ChatStreamEventPayload {
  requestId: string
  event: { kind: 'thinking' | 'text'; text: string }
}

/** content script → SW：流结束（finish 或 abort） */
export const EXT_TOPIC_CHAT_STREAM_DONE = 'chat-stream-done'
export interface ChatStreamDonePayload {
  requestId: string
}

/** content script → SW：流失败 */
export const EXT_TOPIC_CHAT_STREAM_ERROR = 'chat-stream-error'
export interface ChatStreamErrorPayload {
  requestId: string
  error: string
}

/** SW → content script：中止指定流 */
export const EXT_TOPIC_CHAT_STREAM_STOP = 'chat-stream-stop'
export interface ChatStreamStopPayload {
  requestId: string
}
