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

import { describe, it, expect } from 'vitest'
import { parseToolCalls, executeToolCall } from '@/utils/agent/agent'
import type { AgentContext, ToolResult } from '@/utils/agent/agent'

/** Fake tool registry for tests */
const tools = {
  read_file: {
    description: 'read a file',
    async run(args: Record<string, unknown>): Promise<ToolResult> {
      return { ok: true, output: `content of ${String(args.path)}` }
    },
  },
  write_file: {
    description: 'write a file',
    async run(args: Record<string, unknown>): Promise<ToolResult> {
      return { ok: true, output: `wrote ${String(args.path)}` }
    },
  },
  bad_tool: {
    description: 'always fails',
    async run(): Promise<ToolResult> {
      return { ok: false, error: 'boom' }
    },
  },
}

describe('parseToolCalls', () => {
  it('parses a single tool call block', () => {
    const out = parseToolCalls(`<tool_call>
<tool_name>read_file</tool_name>
<parameters>
<path>/a.txt</path>
</parameters>
</tool_call>`)
    expect(out).toEqual([{ name: 'read_file', args: { path: '/a.txt' } }])
  })

  it('parses multiple tool calls', () => {
    const out = parseToolCalls(`<tool_call>
<tool_name>read_file</tool_name>
<parameters>
<path>/a.txt</path>
</parameters>
</tool_call>
<tool_call>
<tool_name>write_file</tool_name>
<parameters>
<path>/b.txt</path>
<content>hello</content>
</parameters>
</tool_call>`)
    expect(out).toHaveLength(2)
    expect(out[1]).toEqual({ name: 'write_file', args: { path: '/b.txt', content: 'hello' } })
  })

  it('parses numbered arguments', () => {
    const out = parseToolCalls(`<tool_call>
<tool_name>read_file</tool_name>
<parameters>
<path>file1</path>
<path>file2</path>
</parameters>
</tool_call>`)
    expect(out[0]!.args).toEqual({ path: 'file1', path_2: 'file2' })
  })

  it('returns [] for plain text without tool calls', () => {
    expect(parseToolCalls('just a normal answer')).toEqual([])
  })
})

describe('executeToolCall', () => {
  it('runs a registered tool with args', async () => {
    const ctx: AgentContext = { tools }
    const res = await executeToolCall(ctx, { name: 'read_file', args: { path: '/a.txt' } })
    expect(res.ok).toBe(true)
    expect(res.output).toBe('content of /a.txt')
  })

  it('returns not-found error for unknown tool', async () => {
    const ctx: AgentContext = { tools }
    const res = await executeToolCall(ctx, { name: 'ghost', args: {} })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/unknown tool/i)
  })

  it('propagates tool runtime failure', async () => {
    const ctx: AgentContext = { tools }
    const res = await executeToolCall(ctx, { name: 'bad_tool', args: {} })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('boom')
  })
})