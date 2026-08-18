/**
 * chat.deepseek.com SSE chunk 解析器。
 * 契约来源：yinshuo-thu/deepseek-cli 的 dswebClient.ts parseDeepSeekChunk
 * （ds2api Go 参考的镜像），覆盖两种 chunk 形态 + 跳过路径 + fragments。
 * 纯 TS、零依赖、浏览器安全。
 */

export type SseEvent =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'finish' }

export interface ParseOptions {
  thinkingEnabled?: boolean
  currentType?: 'text' | 'thinking'
}

export interface ParseResult {
  events: SseEvent[]
  nextType: 'text' | 'thinking'
}

/** 命中即整帧跳过（准状态/耗时/搜索状态等噪声路径） */
const SKIP_CONTAINS = [
  'quasi_status',
  'elapsed_secs',
  'pending_fragment',
  'conversation_mode',
  'fragments/-1/status',
  'fragments/-2/status',
  'fragments/-3/status',
]
const SKIP_EXACT = new Set(['response/search_status'])

function shouldSkipPath(path: string): boolean {
  if (!path) return false
  if (SKIP_EXACT.has(path)) return true
  for (const p of SKIP_CONTAINS) if (path.includes(p)) return true
  return false
}

function isStatusPath(path: string): boolean {
  return path === 'response/status' || path === 'status'
}

function pushTextLike(events: SseEvent[], text: string, type: 'text' | 'thinking'): void {
  if (!text) return
  events.push(type === 'thinking' ? { kind: 'thinking', text } : { kind: 'text', text })
}

/**
 * 解析一个 SSE chunk JSON 为零或多个事件。
 * 处理两种形态：
 *   1. {"v": <string|object|array>, "p": "<path>", "o": "<op>"}
 *   2. {"v": [{nested...}, ...], "p": "<root>"}（批处理，递归）
 */
export function parseDeepSeekChunk(
  chunk: Record<string, unknown>,
  opts: ParseOptions = {},
): ParseResult {
  const thinkingEnabled = opts.thinkingEnabled ?? false
  const events: SseEvent[] = []
  let nextType: 'text' | 'thinking' = opts.currentType ?? 'text'

  if (!('v' in chunk)) return { events, nextType }
  const v = chunk.v
  const path = typeof chunk.p === 'string' ? chunk.p : ''

  if (shouldSkipPath(path)) return { events, nextType }

  // status 路径：response/status === "FINISHED" → finish
  if (isStatusPath(path)) {
    if (typeof v === 'string' && v.trim().toUpperCase() === 'FINISHED') {
      events.push({ kind: 'finish' })
    }
    return { events, nextType }
  }

  // 路径驱动的类型切换
  if (path === 'response/content') nextType = 'text'
  else if (path === 'response/thinking_content') {
    nextType = thinkingEnabled || nextType !== 'text' ? 'thinking' : 'text'
  }

  // 字符串值（对齐 OmniRoute：任意 string v 都按当前路径发送，
  // 除 FINISHED 状态与已处理的 status 路径外）
  if (typeof v === 'string') {
    if (v === 'FINISHED') {
      events.push({ kind: 'finish' })
      return { events, nextType }
    }
    if (path === 'response/content') {
      pushTextLike(events, v, 'text')
    } else if (path === 'response/thinking_content') {
      pushTextLike(events, v, thinkingEnabled ? 'thinking' : 'text')
    } else {
      pushTextLike(events, v, nextType)
    }
    return { events, nextType }
  }

  // 数组值（批处理）→ 递归
  if (Array.isArray(v)) {
    for (const item of v) {
      if (!item || typeof item !== 'object') continue
      const sub = parseDeepSeekChunk(item as Record<string, unknown>, {
        thinkingEnabled,
        currentType: nextType,
      })
      events.push(...sub.events)
      nextType = sub.nextType
    }
    return { events, nextType }
  }

  // 对象值（fragments 包装等）
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>
    const wrapped = (obj.response && typeof obj.response === 'object'
      ? (obj.response as Record<string, unknown>)
      : obj)
    // thinking_enabled 驱动路径切换（对齐 OmniRoute）：
    //   true → thinking；false → text
    if (typeof wrapped.thinking_enabled === 'boolean') {
      nextType = wrapped.thinking_enabled ? 'thinking' : 'text'
    }
    const inlineText = typeof obj.text === 'string'
      ? obj.text
      : typeof obj.content === 'string'
        ? obj.content
        : typeof wrapped.text === 'string'
          ? wrapped.text
          : typeof wrapped.content === 'string'
            ? wrapped.content
            : ''
    if (inlineText) {
      const ty: 'text' | 'thinking' =
        (path === 'response/thinking_content' || nextType === 'thinking')
          && thinkingEnabled ? 'thinking' : nextType
      pushTextLike(events, inlineText, ty)
    }
    if (Array.isArray(wrapped.fragments)) {
      for (const frag of wrapped.fragments as unknown[]) {
        if (!frag || typeof frag !== 'object') continue
        const f = frag as Record<string, unknown>
        const typeName = String(f.type ?? '').toUpperCase()
        const content = String(f.content ?? '')
        if (!content) continue
        // fragment 类型权威驱动路径（对齐 OmniRoute applyFragmentType）：
        //   THINK → thinking；ANSWER / RESPONSE → text；未知沿用 nextType
        if (typeName === 'THINK' || typeName === 'THINKING') {
          nextType = 'thinking'
          events.push({ kind: 'thinking', text: content })
        } else if (typeName === 'ANSWER' || typeName === 'RESPONSE') {
          nextType = 'text'
          events.push({ kind: 'text', text: content })
        } else {
          events.push({ kind: nextType === 'thinking' ? 'thinking' : 'text', text: content })
        }
      }
    }
  }
  return { events, nextType }
}
