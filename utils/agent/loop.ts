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
 * Agent loop core — multi-turn conversation with tool execution.
 *
 * Runs the bridge LLM until the model stops emitting tool calls:
 *  1. send messages to the LLM bridge, collect the streamed text
 *  2. parse <tool_call> blocks from the accumulated text
 *  3. if any → execute each tool, append results as `tool` messages, loop
 *  4. otherwise → done, return the final text + full message history
 *
 * Pure and testable; the real bridge (DeepSeekWebClient) is injected by the
 * caller (SW / panel runtime).
 */
import { parseToolCalls, executeToolCall } from '@/utils/agent/agent'
import type { ToolRegistry } from '@/utils/agent/agent'
import type { Message } from '@/utils/bridge/protocol'
import type { LlmStreamEvent } from '@/utils/plugin/host'

export interface AgentLoopOptions {
  /** LLM bridge: yields stream events for the given messages. */
  llm: (messages: Message[]) => AsyncGenerator<LlmStreamEvent> | AsyncIterable<LlmStreamEvent>
  tools: ToolRegistry
  messages: Message[]
  /** Maximum LLM rounds (tool-call iterations). Default 8. */
  maxTurns?: number
  /** Called for each stream event (for UI live updates). Optional. */
  onEvent?: (ev: LlmStreamEvent, round: number) => void
}

export interface AgentLoopResult {
  /** Final assistant text (last non-tool round). */
  finalText: string
  /** Full accumulated message history. */
  messages: Message[]
  /** Number of LLM rounds performed. */
  turns: number
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const maxTurns = opts.maxTurns ?? 8
  const history: Message[] = [...opts.messages]
  let finalText = ''
  let turns = 0

  const emit = (ev: LlmStreamEvent): void => opts.onEvent?.(ev, turns)

  while (turns < maxTurns) {
    turns++
    // round 1: stream the LLM
    let text = ''
    let thinking = ''
    for await (const ev of opts.llm(history)) {
      opts.onEvent?.(ev, turns)
      if (ev.kind === 'thinking') thinking += ev.text ?? ''
      else if (ev.kind === 'text') text += ev.text ?? ''
      else if (ev.kind === 'error') throw new Error(ev.error ?? 'llm stream error')
    }

    // record the assistant reply (text only; thinking stays out of history)
    const reply = text.trim()
    finalText = reply
    history.push({ role: 'assistant', content: reply })

    const calls = parseToolCalls(text)
    if (calls.length === 0) {
      return { finalText, messages: history, turns }
    }

    // round n: execute each tool, append results, loop
    for (const call of calls) {
      const callId = mintToolCallId()
      const argsRaw = JSON.stringify(call.args)
      emit({ kind: 'tool_call', callId, name: call.name, arguments: argsRaw })
      const result = await executeToolCall({ tools: opts.tools }, call)
      emit({
        kind: 'tool_result',
        callId,
        name: call.name,
        arguments: argsRaw,
        output: result.ok ? result.output ?? '' : result.error ?? 'unknown error',
        ok: result.ok,
      })
      const payload = result.ok
        ? `<tool_result name="${call.name}">\n${result.output ?? ''}\n</tool_result>`
        : `<tool_result name="${call.name}" error="true">\n${result.error ?? 'unknown error'}\n</tool_result>`
      history.push({ role: 'tool', content: payload })
    }
  }

  return { finalText, messages: history, turns }
}

/** 生成工具调用唯一 ID（SW / node 环境均可用；与 tool/result 的 source.callId 配对） */
function mintToolCallId(): string {
  const c = globalThis.crypto
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  return `tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}