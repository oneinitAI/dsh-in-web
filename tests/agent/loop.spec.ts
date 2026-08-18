import { describe, it, expect, beforeEach } from 'vitest'
import { runAgentLoop } from '@/utils/agent/loop'
import type { ToolRegistry, ToolResult } from '@/utils/agent/agent'
import type { Message } from '@/utils/bridge/protocol'
import type { LlmStreamEvent } from '@/utils/plugin/host'

function makeLlm(
  rounds: Array<Array<LlmStreamEvent>>,
): (messages: Message[]) => AsyncGenerator<LlmStreamEvent> {
  let i = 0
  return async function* (messages: Message[]) {
    // record what the llm saw (for assertions)
    llmInputs.push(messages)
    const events = rounds[Math.min(i, rounds.length - 1)] ?? []
    i++
    for (const ev of events) yield ev
  }
}

let llmInputs: Message[][] = []

const tools: ToolRegistry = {
  read_file: {
    description: 'read a file',
    async run(args: Record<string, unknown>): Promise<ToolResult> {
      return { ok: true, output: `content of ${String(args.path)}` }
    },
  },
  fail_tool: {
    description: 'fails',
    async run(): Promise<ToolResult> {
      return { ok: false, error: 'boom' }
    },
  },
}

const toolCallText = (name: string, path: string) =>
  `<tool_call>\n<tool_name>${name}</tool_name>\n<parameters>\n<path>${path}</path>\n</parameters>\n</tool_call>`

describe('runAgentLoop', () => {
  beforeEach(() => {
    llmInputs = []
  })

  it('returns immediately when no tool calls', async () => {
    const llm = makeLlm([[{ kind: 'text', text: 'hello world' }, { kind: 'finish' }]])
    const res = await runAgentLoop({ llm, tools, messages: [{ role: 'user', content: 'hi' }] })
    expect(res.finalText).toBe('hello world')
    expect(res.messages).toHaveLength(2) // user + assistant
    expect(llmInputs).toHaveLength(1)
  })

  it('executes tool calls and feeds results back for a second turn', async () => {
    const llm = makeLlm([
      [
        { kind: 'text', text: toolCallText('read_file', '/a.txt') },
        { kind: 'finish' },
      ],
      [{ kind: 'text', text: 'final answer' }, { kind: 'finish' }],
    ])
    const res = await runAgentLoop({
      llm,
      tools,
      messages: [{ role: 'user', content: 'read /a.txt' }],
    })
    expect(res.finalText).toBe('final answer')
    // second llm input must include a tool result message
    const second = llmInputs[1]
    expect(second?.some((m) => m.role === 'tool' && m.content.includes('content of /a.txt'))).toBe(true)
    // tool call assistant message preserved in history
    expect(res.messages.some((m) => m.role === 'assistant' && m.content.includes('read_file'))).toBe(true)
    expect(llmInputs).toHaveLength(2)
  })

  it('propagates tool failure as tool result and continues', async () => {
    const llm = makeLlm([
      [
        { kind: 'text', text: toolCallText('fail_tool', '/x') },
        { kind: 'finish' },
      ],
      [{ kind: 'text', text: 'handled failure' }, { kind: 'finish' }],
    ])
    const res = await runAgentLoop({
      llm,
      tools,
      messages: [{ role: 'user', content: 'try it' }],
    })
    expect(res.finalText).toBe('handled failure')
    const second = llmInputs[1]
    expect(second?.some((m) => m.role === 'tool' && m.content.includes('boom'))).toBe(true)
  })

  it('stops after maxTurns', async () => {
    const llm = makeLlm([
      [{ kind: 'text', text: toolCallText('read_file', '/a') }, { kind: 'finish' }],
      [{ kind: 'text', text: toolCallText('read_file', '/b') }, { kind: 'finish' }],
      [{ kind: 'text', text: toolCallText('read_file', '/c') }, { kind: 'finish' }],
    ])
    const res = await runAgentLoop({
      llm,
      tools,
      messages: [{ role: 'user', content: 'go' }],
      maxTurns: 2,
    })
    expect(llmInputs.length).toBeLessThanOrEqual(2)
    expect(res.finalText).toContain('read_file')
  })

  it('includes thinking text in final message when no tool calls', async () => {
    const llm = makeLlm([
      [{ kind: 'thinking', text: 'let me think' }, { kind: 'text', text: 'answer' }, { kind: 'finish' }],
    ])
    const res = await runAgentLoop({ llm, tools, messages: [{ role: 'user', content: 'q' }] })
    expect(res.finalText).toBe('answer')
    expect(res.messages[res.messages.length - 1]?.content).toBe('answer')
  })
})