/**
 * DeepSeekWebClient —— 调用 chat.deepseek.com 网页版内部 API 的浏览器客户端。
 * 契约来源：yinshuo-thu/deepseek-cli 的 dswebClient.ts（ds2api Go 参考的镜像）。
 *
 * 流程：
 *   1. 可选 currentUser() 用 userToken 换 accessToken（~24h）
 *   2. createChatSession() 拿 chat_session_id
 *   3. streamChat() POST /chat/completion，解析 SSE，PoW 自动重试
 * 所有网络操作允许注入 fetcher（测试用）。
 */

import {
  API_HOST,
  buildCompletionBody,
  buildContinueBody,
  buildCreateSessionBody,
  buildHeaders,
  buildPowChallengeBody,
  ENDPOINTS,
  flattenMessagesToPrompt,
  type Message,
} from './protocol'
import { solveAndBuildPowHeader, type PowChallenge } from './pow'
import { parseDeepSeekChunk } from './sse-parser'

export type BridgeEvent =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'finish' }

/** DDoS-Guard / Cloudflare challenge —— 提示用户刷新登录态 */
export class DSWebChallengeError extends Error {
  constructor(
    message = 'DDoS-Guard / Cloudflare challenge — 请在 chat.deepseek.com 刷新页面后重试。',
  ) {
    super(message)
    this.name = 'DSWebChallengeError'
  }
}

export class DSWebAuthError extends Error {
  constructor(message = '登录态已过期，请重新登录 chat.deepseek.com。') {
    super(message)
    this.name = 'DSWebAuthError'
  }
}

export class DSWebProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DSWebProtocolError'
  }
}

export interface WebSession {
  /** localStorage.userToken（JSON 包装里的 value）或 cookie 里的 userToken */
  userToken: string
}

export interface ClientOptions {
  /** 注入网络层（测试用）；默认全局 fetch */
  fetcher?: typeof fetch
  signal?: AbortSignal
}

export interface StreamChatOptions extends ClientOptions {
  reasoning?: boolean
  search?: boolean
  /** 复用已有会话；缺省自动创建 */
  chatSessionId?: string
  /** 用现成 accessToken 作为 Bearer（若已换取） */
  accessToken?: string
}

const COMPLETION_TARGET_PATH = ENDPOINTS.chatCompletion

export class DeepSeekWebClient {
  constructor(private readonly session: WebSession) {}

  private get fetcher(): typeof fetch {
    // 默认浏览器全局 fetch
    return globalThis.fetch.bind(globalThis)
  }

  private bearer(accessToken?: string): string {
    return `Bearer ${accessToken ?? this.session.userToken}`
  }

  private async guard(resp: Response): Promise<void> {
    const cf = resp.headers.get('cf-mitigated') ?? resp.headers.get('CF-Mitigated')
    if (cf) throw new DSWebChallengeError()
    if (resp.status === 401) throw new DSWebAuthError()
    if (resp.status === 403) {
      const ct = (resp.headers.get('content-type') ?? '').toLowerCase()
      if (!ct.includes('application/json')) throw new DSWebChallengeError()
      throw new DSWebAuthError()
    }
  }

  /** GET /api/v0/users/current → biz_data.token（真正的 Bearer，~24h 有效） */
  async currentUser(opts: ClientOptions = {}): Promise<string> {
    const fetcher = opts.fetcher ?? this.fetcher
    const resp = await fetcher(`${API_HOST}${ENDPOINTS.usersCurrent}`, {
      method: 'GET',
      headers: buildHeaders({ authorization: this.bearer(), contentType: null }),
      signal: opts.signal,
      credentials: 'include',
    })
    await this.guard(resp)
    if (!resp.ok) throw new DSWebProtocolError(`users/current: HTTP ${resp.status}`)
    let data: unknown
    try {
      data = await resp.json()
    } catch {
      throw new DSWebProtocolError('users/current: invalid JSON')
    }
    const token = extractString(data, 'data.biz_data.token')
    if (!token) throw new DSWebProtocolError('users/current: missing biz_data.token')
    return token
  }

  /** POST /api/v0/chat_session/create → chat_session_id */
  async createChatSession(opts: ClientOptions = {}): Promise<string> {
    const fetcher = opts.fetcher ?? this.fetcher
    const resp = await fetcher(`${API_HOST}${ENDPOINTS.chatSessionCreate}`, {
      method: 'POST',
      headers: buildHeaders({ authorization: this.bearer() }),
      body: buildCreateSessionBody(),
      signal: opts.signal,
      credentials: 'include',
    })
    await this.guard(resp)
    if (!resp.ok) throw new DSWebProtocolError(`create_session: HTTP ${resp.status}`)
    let data: unknown
    try {
      data = await resp.json()
    } catch {
      throw new DSWebProtocolError('create_session: invalid JSON')
    }
    const id = extractChatSessionId(data)
    if (!id) throw new DSWebProtocolError(`create_session: missing session id (response: ${summarizeJson(data)})`)
    return id
  }

  /**
   * 流式聊天。把 messages 拼成单 prompt，POST /chat/completion，解析 SSE 按序产出事件。
   * 遇 PoW required（412 或 JSON 含 pow）自动取挑战、求解、带 x-ds-pow-response 重试一次。
   */
  async *streamChat(
    messages: readonly Message[],
    opts: StreamChatOptions = {},
  ): AsyncGenerator<BridgeEvent> {
    const fetcher = opts.fetcher ?? this.fetcher
    const flatPrompt = flattenMessagesToPrompt(messages)
    const chatSessionId = opts.chatSessionId ?? (await this.createChatSession({ fetcher, signal: opts.signal }))

    let powHeader: string | undefined
    let attempts = 0
    while (attempts < 2) {
      attempts++
      const resp = await this.postCompletion(fetcher, chatSessionId, flatPrompt, opts, powHeader)
      const needsPow = await this.detectPowRequired(resp)
      if (needsPow) {
        if (powHeader) {
          throw new DSWebProtocolError('pow_required after retry — solver may be stale')
        }
        const challenge = await this.fetchPowChallenge(fetcher, opts)
        powHeader = solveAndBuildPowHeader(challenge, opts.signal)
        continue
      }
      yield* this.consumeSSE(resp, opts)
      return
    }
  }

  private async postCompletion(
    fetcher: typeof fetch,
    chatSessionId: string,
    prompt: string,
    opts: StreamChatOptions,
    powHeader: string | undefined,
  ): Promise<Response> {
    const headers = buildHeaders({
      authorization: this.bearer(opts.accessToken),
      accept: 'text/event-stream',
      powResponse: powHeader,
    })
    const payload = {
      chat_session_id: chatSessionId,
      model_type: 'default',
      parent_message_id: null,
      prompt,
      ref_file_ids: [] as string[],
      thinking_enabled: opts.reasoning ?? false,
      search_enabled: opts.search ?? false,
    }
    const resp = await fetcher(`${API_HOST}${ENDPOINTS.chatCompletion}`, {
      method: 'POST',
      headers,
      body: buildCompletionBody(payload),
      signal: opts.signal,
      credentials: 'include',
    })
    await this.guard(resp)
    return resp
  }

  /** 区分正常流与"PoW required"响应 */
  private async detectPowRequired(resp: Response): Promise<boolean> {
    const ct = (resp.headers.get('content-type') ?? '').toLowerCase()
    if (resp.status === 412) return true
    if (resp.ok && ct.includes('text/event-stream')) return false
    if (ct.includes('application/json')) {
      const text = await resp.text()
      const lower = text.toLowerCase()
      if (lower.includes('pow_required') || lower.includes('pow challenge') || lower.includes('"biz_code":40010')) {
        return true
      }
      throw new DSWebProtocolError(`completion: unexpected JSON body (HTTP ${resp.status}) — ${summarizeJsonSafe(text)}`)
    }
    if (!resp.ok) throw new DSWebProtocolError(`completion: HTTP ${resp.status}`)
    return false
  }

  private async fetchPowChallenge(fetcher: typeof fetch, opts: ClientOptions): Promise<PowChallenge> {
    const resp = await fetcher(`${API_HOST}${ENDPOINTS.createPowChallenge}`, {
      method: 'POST',
      headers: buildHeaders({ authorization: this.bearer() }),
      body: buildPowChallengeBody(COMPLETION_TARGET_PATH),
      signal: opts.signal,
      credentials: 'include',
    })
    await this.guard(resp)
    if (!resp.ok) throw new DSWebProtocolError(`create_pow_challenge: HTTP ${resp.status}`)
    let data: unknown
    try {
      data = await resp.json()
    } catch {
      throw new DSWebProtocolError('create_pow_challenge: invalid JSON')
    }
    const challenge = extractPowChallenge(data)
    if (!challenge) throw new DSWebProtocolError('create_pow_challenge: missing challenge')
    return challenge
  }

  private async *consumeSSE(resp: Response, opts: StreamChatOptions): AsyncGenerator<BridgeEvent> {
    if (!resp.body) throw new DSWebProtocolError('completion: missing response body')
    const reader = resp.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buf = ''
    let finished = false
    let currentType: 'text' | 'thinking' = opts.reasoning ? 'thinking' : 'text'

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const rawLine = buf.slice(0, nl).replace(/\r$/, '')
          buf = buf.slice(nl + 1)
          const line = rawLine.trim()
          if (!line.startsWith('data:')) continue
          const dataStr = line.slice(5).trim()
          if (!dataStr) continue
          if (dataStr === '[DONE]') {
            finished = true
            continue
          }
          let chunk: unknown
          try {
            chunk = JSON.parse(dataStr)
          } catch {
            continue // 跳过畸形行（与 ds2api 行为一致）
          }
          if (typeof chunk !== 'object' || chunk === null) continue
          const parsed = parseDeepSeekChunk(chunk as Record<string, unknown>, {
            thinkingEnabled: opts.reasoning ?? false,
            currentType,
          })
          for (const ev of parsed.events) {
            yield ev
            if (ev.kind === 'finish') finished = true
          }
          currentType = parsed.nextType
        }
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        /* ignore */
      }
    }
    if (!finished) yield { kind: 'finish' }
  }
}

// ---- 通用提取辅助 ----------------------------------------------------------

function extractString(raw: unknown, dottedPath: string): string | undefined {
  let cur: unknown = raw
  for (const key of dottedPath.split('.')) {
    if (cur && typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[key]
    } else {
      return undefined
    }
  }
  return typeof cur === 'string' && cur.trim() ? cur.trim() : undefined
}

/**
 * 提取 chat_session_id。服务端响应结构存在两种形态（参考 deepseek-cli/ds2api）：
 *   1. { data: { biz_data: { id: "..." } } }
 *   2. { data: { biz_data: { chat_session: { id: "..." } } } }
 * 两种都兜底到对象根部的 id 字段。
 */
function extractChatSessionId(raw: unknown): string | undefined {
  const direct = extractString(raw, 'data.biz_data.id')
  if (direct) return direct
  const nested = extractString(raw, 'data.biz_data.chat_session.id')
  if (nested) return nested
  // 兜底：任意层的 biz_data.id
  if (raw && typeof raw === 'object') {
    const data = ((raw as Record<string, unknown>).data ?? raw) as Record<string, unknown>
    const bizData = (data.biz_data ?? data) as Record<string, unknown>
    if (typeof bizData.id === 'string' && bizData.id.trim()) return bizData.id.trim()
  }
  return undefined
}

/** 把响应 JSON 截断成单行摘要，用于错误诊断（避免泄漏超长内容） */
function summarizeJson(raw: unknown): string {
  let text: string
  try {
    text = JSON.stringify(raw)
  } catch {
    text = String(raw)
  }
  return summarizeJsonSafe(text)
}

/** 截断任意字符串为单行诊断摘要 */
function summarizeJsonSafe(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim()
  if (single.length <= 200) return single
  return `${single.slice(0, 200)}…`
}

function extractPowChallenge(raw: unknown): PowChallenge | null {
  if (!raw || typeof raw !== 'object') return null
  const data = ((raw as Record<string, unknown>).data ?? raw) as Record<string, unknown>
  const bizData = (data.biz_data ?? data) as Record<string, unknown>
  const challenge = (bizData.challenge ?? bizData) as Record<string, unknown>
  const algorithm = String(challenge.algorithm ?? '')
  const ch = String(challenge.challenge ?? '')
  const salt = String(challenge.salt ?? '')
  const expireAt = Number(challenge.expire_at ?? 0)
  const difficulty = Number(challenge.difficulty ?? 0)
  const signature = String(challenge.signature ?? '')
  const targetPath = String(challenge.target_path ?? '')
  if (!algorithm || !ch || !salt || !expireAt) return null
  return {
    algorithm,
    challenge: ch,
    salt,
    expire_at: expireAt,
    difficulty,
    signature,
    target_path: targetPath,
  }
}
