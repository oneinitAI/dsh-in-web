/**
 * Basic agent loop primitives — DSML tool-call parsing + execution.
 * The full loop (multi-turn chat with bridge) is wired in the extension
 * runtime; this module keeps the parse/execute core pure and testable.
 *
 * DSML (dsh tool syntax) tool_call blocks:
 *   <tool_call>
 *   <tool_name>name</tool_name>
 *   <parameters>
 *   <path>/a</path>
 *   <content>x</content>
 *   </parameters>
 *   </tool_call>
 */

export interface ToolCall {
  name: string
  args: Record<string, unknown>
}

export interface ToolResult {
  ok: boolean
  output?: string
  error?: string
}

export interface ToolDef {
  description: string
  run(args: Record<string, unknown>): Promise<ToolResult> | ToolResult
}

export type ToolRegistry = Record<string, ToolDef>

export interface AgentContext {
  tools: ToolRegistry
}

const TOOL_CALL_RE = /<tool_call>\s*<tool_name>([^<]+)<\/tool_name>\s*<parameters>([\s\S]*?)<\/parameters>\s*<\/tool_call>/g
const PARAM_RE = /<(\w+)>([\s\S]*?)<\/\1>/g

/** Parse all <tool_call> blocks from model output text. */
export function parseToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = []
  for (const m of text.matchAll(TOOL_CALL_RE)) {
    const name = (m[1] ?? '').trim()
    const paramsBody = m[2] ?? ''
    const args: Record<string, unknown> = {}
    const counts = new Map<string, number>()
    for (const p of paramsBody.matchAll(PARAM_RE)) {
      const key = p[1] ?? ''
      const value = (p[2] ?? '').trim()
      const n = (counts.get(key) ?? 0) + 1
      counts.set(key, n)
      args[n > 1 ? `${key}_${n}` : key] = value
    }
    calls.push({ name, args })
  }
  return calls
}

/** Execute a single tool call against the registry. */
export async function executeToolCall(
  ctx: AgentContext,
  call: ToolCall,
): Promise<ToolResult> {
  const tool = ctx.tools[call.name]
  if (!tool) return { ok: false, error: `unknown tool: ${call.name}` }
  try {
    return await tool.run(call.args)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}