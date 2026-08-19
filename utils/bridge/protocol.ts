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
 * chat.deepseek.com 网页版协议层 —— 端点 / 请求头 / 请求体 / 消息拼装。
 * 契约来源：yinshuo-thu/deepseek-cli 的 dswebClient.ts（ds2api Go 参考的镜像），
 * 请求头版本对齐当前 web 客户端（x-client-version: 2.0.0 + x-client-bundle-id）。
 * 纯 TS、零依赖、浏览器安全。
 */

export const API_HOST = 'https://chat.deepseek.com'

export const ENDPOINTS = {
  usersCurrent: '/api/v0/users/current',
  chatCompletion: '/api/v0/chat/completion',
  chatContinue: '/api/v0/chat/continue',
  chatStopStream: '/api/v0/chat/stop_stream',
  chatSessionCreate: '/api/v0/chat_session/create',
  chatHistoryMessages: '/api/v0/chat/history_messages',
  createPowChallenge: '/api/v0/chat/create_pow_challenge',
  clientSettings: '/api/v0/client/settings',
} as const

/** 当前 web 客户端身份头（与 chat.deepseek.com 2.0.x 对齐） */
export const CLIENT_IDENTITY = {
  'x-client-platform': 'web',
  'x-client-version': '2.0.0',
  'x-client-bundle-id': 'com.deepseek.chat',
  'x-client-locale': 'en-US',
} as const

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

/**
 * 把 messages[] 拼成单个 role-tagged prompt。
 * 格式：`System: ...\n\nUser: ...\n\nAssistant: ...\n\nTool: ...`
 * 网页版只接受单字符串 prompt，多轮历史必须自行拼装。
 */
export function flattenMessagesToPrompt(messages: readonly Message[]): string {
  const parts: string[] = []
  for (const m of messages) {
    const text = m.content.trim()
    if (!text) continue
    switch (m.role) {
      case 'system':
        parts.push(`System: ${text}`)
        break
      case 'user':
        parts.push(`User: ${text}`)
        break
      case 'assistant':
        parts.push(`Assistant: ${text}`)
        break
      case 'tool':
        parts.push(`Tool: ${text}`)
        break
      default:
        parts.push(text)
    }
  }
  return parts.join('\n\n')
}

/** 客户端时区偏移（秒）：`-getTimezoneOffset() * 60`，UTC+8 → 28800 */
export function buildClientTimezoneOffset(now: Date = new Date()): number {
  return -now.getTimezoneOffset() * 60
}

export interface BuildHeadersOptions {
  /** Bearer accessToken */
  authorization: string
  /** 默认用 buildClientTimezoneOffset() */
  timezoneOffset?: number
  /** PoW 解算后的 x-ds-pow-response */
  powResponse?: string
  /** 默认 'application/json, text/event-stream' */
  accept?: string
  /** null 表示不发 content-type（如 GET）；默认 'application/json' */
  contentType?: string | null
  /** 覆盖默认 locale */
  locale?: string
  /** 额外覆盖头（用于版本漂移时按需替换） */
  overrides?: Record<string, string>
}

/** 构造完整请求头（小写键，浏览器 fetch 允许） */
export function buildHeaders(opts: BuildHeadersOptions): Record<string, string> {
  const h: Record<string, string> = {
    accept: opts.accept ?? 'application/json, text/event-stream',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    origin: API_HOST,
    referer: `${API_HOST}/`,
    authorization: opts.authorization,
    'x-client-platform': CLIENT_IDENTITY['x-client-platform'],
    'x-client-version': CLIENT_IDENTITY['x-client-version'],
    'x-client-bundle-id': CLIENT_IDENTITY['x-client-bundle-id'],
    'x-client-locale': opts.locale ?? CLIENT_IDENTITY['x-client-locale'],
    'x-client-timezone-offset': String(opts.timezoneOffset ?? buildClientTimezoneOffset()),
  }
  if (opts.contentType !== null) {
    h['content-type'] = opts.contentType ?? 'application/json'
  }
  if (opts.powResponse) h['x-ds-pow-response'] = opts.powResponse
  if (opts.overrides) {
    for (const [k, v] of Object.entries(opts.overrides)) h[k] = v
  }
  return h
}

export interface CompletionBody {
  chat_session_id: string
  model_type: string
  parent_message_id: string | null
  prompt: string
  ref_file_ids: string[]
  thinking_enabled: boolean
  search_enabled: boolean
  preempt: boolean
}

export function buildCompletionBody(body: CompletionBody): string {
  return JSON.stringify(body)
}

/** 长答案续传：INCOMPLETE / auto_continue 时调用 */
export function buildContinueBody(chat_session_id: string, message_id: number): string {
  return JSON.stringify({ chat_session_id, message_id, fallback_to_resume: true })
}

export function buildCreateSessionBody(): string {
  return JSON.stringify({ agent: 'chat' })
}

export function buildPowChallengeBody(targetPath: string): string {
  return JSON.stringify({ target_path: targetPath })
}
