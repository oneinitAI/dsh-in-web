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

// ── 命令枚举（Wave 1 起使用）──────────────────────────────

export const CMD_SEND_MESSAGE = 'send-message'
export const CMD_STOP_STREAM = 'stop-stream'
export const CMD_READ_TOKEN = 'read-token'
