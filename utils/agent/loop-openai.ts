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
 * Native function-calling agent loop (OpenAI-compatible).
 *
 * Unlike loop.ts (which parses `<tool_call>` text from the chat.deepseek.com
 * web bridge), this loop uses the LLM API's native `tools` mechanism: the
 * model returns structured `tool_calls`, we execute each against the
 * ToolRegistry, append the result as a `tool` message, and continue until the
 * model stops calling tools.
 */
import { openAiChatCompletion, type OpenAiMessage, type OpenAiToolCall, type OpenAiToolDef } from '@/utils/llm/openai-client'
import { executeToolCall, type ToolRegistry } from '@/utils/agent/agent'
import type { LlmStreamEvent } from '@/utils/plugin/host'

export interface OpenAiAgentLoopOptions {
  apiKey: string
  baseURL: string
  model: string
  tools: ToolRegistry
  messages: OpenAiMessage[]
  maxTurns?: number
  onEvent?: (ev: LlmStreamEvent, round: number) => void
  signal?: AbortSignal
}

export interface OpenAiAgentLoopResult {
  finalText: string
  messages: OpenAiMessage[]
  turns: number
}

/** Convert the ToolRegistry into OpenAI function-tool definitions. */
export function toOpenAiTools(tools: ToolRegistry): OpenAiToolDef[] {
  return Object.entries(tools).map(([name, def]) => ({
    type: 'function',
    function: {
      name,
      description: def.description,
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  }))
}

export async function runOpenAiAgentLoop(opts: OpenAiAgentLoopOptions): Promise<OpenAiAgentLoopResult> {
  const maxTurns = opts.maxTurns ?? 8
  const history: OpenAiMessage[] = [...opts.messages]
  const tools = toOpenAiTools(opts.tools)
  let turns = 0
  let finalText = ''

  while (turns < maxTurns) {
    turns++
    const result = await openAiChatCompletion(
      { apiKey: opts.apiKey, baseURL: opts.baseURL, model: opts.model },
      history,
      tools,
      opts.signal,
    )
    if (result.error) {
      opts.onEvent?.({ kind: 'error', error: result.error }, turns)
      throw new Error(result.error)
    }
    if (result.text) opts.onEvent?.({ kind: 'text', text: result.text }, turns)

    // Record the assistant reply (with any tool_calls) so the API keeps context.
    const assistantMsg: OpenAiMessage = {
      role: 'assistant',
      content: result.text || null,
      ...(result.toolCalls.length > 0 ? { tool_calls: result.toolCalls } : {}),
    }
    history.push(assistantMsg)
    finalText = result.text || finalText

    if (result.toolCalls.length === 0) {
      // Model stopped calling tools — the turn is complete.
      return { finalText, messages: history, turns }
    }

    // Execute each tool call, append its result, loop.
    for (const call of result.toolCalls) {
      const name = call.function.name
      let args: Record<string, unknown>
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {}
      } catch {
        args = { raw: call.function.arguments }
      }
      const argsRaw = call.function.arguments
      opts.onEvent?.({ kind: 'tool_call', callId: call.id, name, arguments: argsRaw }, turns)
      const toolResult = await executeToolCall({ tools: opts.tools }, { name, args })
      const output = toolResult.ok ? toolResult.output ?? '' : toolResult.error ?? 'unknown error'
      opts.onEvent?.({ kind: 'tool_result', callId: call.id, name, arguments: argsRaw, output, ok: toolResult.ok }, turns)
      history.push({
        role: 'tool',
        tool_call_id: call.id,
        name,
        content: output,
      })
    }
  }

  return { finalText, messages: history, turns }
}
