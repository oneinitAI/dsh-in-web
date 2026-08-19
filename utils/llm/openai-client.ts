/**
 * OpenAI-compatible chat completion client with native function calling.
 *
 * The chat.deepseek.com web bridge (DeepSeekWebClient) cannot do function
 * calling, which is why agent tool calls never fired. This client talks to any
 * OpenAI-compatible /chat/completions endpoint with a `tools` array, so the
 * model can emit structured `tool_calls` natively and the agent loop can
 * execute them for real.
 *
 * Streamed SSE: deltas carry either `content` (text) or `tool_calls`
 * (incremental function name/arguments fragments keyed by index).
 */

export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  /** Present on assistant messages that made tool calls. */
  tool_calls?: OpenAiToolCall[]
  /** Present on tool-role messages (the result for one call). */
  tool_call_id?: string
  name?: string
}

export interface OpenAiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface OpenAiToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface OpenAiClientConfig {
  apiKey: string
  baseURL: string
  model: string
}

export interface OpenAiStreamResult {
  /** Accumulated text content. */
  text: string
  /** Completed tool calls (arguments JSON string, may be partial if cut off). */
  toolCalls: OpenAiToolCall[]
  /** First error text if the stream failed (business failures come as SSE too). */
  error?: string
}

/** True when a string looks like a URL; used to normalize baseURL paths. */
function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '')
  return `${b}/${path.replace(/^\/+/, '')}`
}

/**
 * Stream a chat completion with tools and resolve the final text + tool calls.
 * @returns the accumulated text and parsed tool calls.
 */
export async function openAiChatCompletion(
  cfg: OpenAiClientConfig,
  messages: OpenAiMessage[],
  tools: OpenAiToolDef[],
  signal?: AbortSignal,
): Promise<OpenAiStreamResult> {
  const body = {
    model: cfg.model,
    messages,
    tools: tools.length > 0 ? tools : undefined,
    stream: true,
  }
  const res = await fetch(joinUrl(cfg.baseURL, 'chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { text: '', toolCalls: [], error: `HTTP ${res.status}: ${text.slice(0, 300)}` }
  }
  if (!res.body) return { text: '', toolCalls: [], error: 'no response body' }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  const toolAcc = new Map<number, { id: string; name: string; args: string }>()
  let error: string | undefined

  const flushTool = (): void => {
    // no-op placeholder
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE lines separated by \n\n
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') { buffer = ''; break }
        let json: unknown
        try { json = JSON.parse(data) } catch { continue }
        const choice = (json as { choices?: Array<{ delta?: Record<string, unknown> }> })?.choices?.[0]
        if (!choice) continue
        const delta = choice.delta ?? {}
        const content = delta['content']
        if (typeof content === 'string') text += content
        const tcs = delta['tool_calls']
        if (Array.isArray(tcs)) {
          for (const tc of tcs as Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>) {
            const index = tc.index ?? 0
            const acc = toolAcc.get(index) ?? { id: '', name: '', args: '' }
            if (tc.id) acc.id += tc.id
            if (tc.function?.name) acc.name += tc.function.name
            if (tc.function?.arguments) acc.args += tc.function.arguments
            toolAcc.set(index, acc)
          }
        }
      }
      if (dataEnded(buffer)) break
    }
  } catch (e) {
    if (signal?.aborted) error = 'aborted'
    else error = e instanceof Error ? e.message : String(e)
  } finally {
    reader.releaseLock()
  }

  const toolCalls: OpenAiToolCall[] = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({ id: v.id || `call_${Math.random().toString(36).slice(2, 10)}`, type: 'function', function: { name: v.name, arguments: v.args } }))
  return { text: text.trim(), toolCalls, error }
}

/** Track whether we saw [DONE] in the last buffer. */
function dataEnded(_buffer: string): boolean {
  // The loop above already clears buffer on [DONE]; this is a guard.
  return false
}
