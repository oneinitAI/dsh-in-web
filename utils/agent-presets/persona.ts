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
 * Agent 预设 persona 组装（Layer 0+1：persona + 能力注入）。
 *
 * 用户在 dsh 里给会话选择 agent 预设（standard/code/minimal/cordis）后，发消息时
 * 这里把该预设的 persona 系统提示词（+ 能力说明 + 工具可用性提示）拼成一条
 * system message，注入到发给模型的 history 最前面 —— 不同预设让模型收到不同
 * 的身份与能力设定（标准模式 / 极简模式 / 创造模式等）。
 *
 * persona text 从 @/utils/agent-presets/contents 的官方 agent.cordis.yml
 * （`- id: persona` 段的 config.text，含 `>-` / `|-` 块标量）提取；提取失败时回退
 * 到本文件内置的兜底 persona。展示名/能力描述与 background 的 DSH_AGENT_PRESETS
 * （来自官方 preset.yml）保持一致。
 */
import { DSH_AGENT_PRESET_CONTENTS } from './contents'

export interface PresetPromptContext {
  /** 插值 `{{model}}` 占位符（默认 'deepseek-chat'） */
  model?: string
  /** 插值 `{{cwd}}` 占位符（默认「网页对话」工作区） */
  cwd?: string
}

interface PresetMeta {
  id: string
  name: string
  /** 预设能力一句话说明（注入 system 的增强句，与 preset.yml description 同源） */
  capability: string
  /** 该预设的完整工具清单（name + 功能说明），注入 system 提示词 */
  tools: ReadonlyArray<{ name: string; description: string }>
  /** 从 agent.cordis.yml 提取 persona 失败时的兜底 persona */
  fallbackPersona: string
}

/** 工具名与功能说明（来自官方 agent.cordis.yml 的 tool 段，浏览器可执行/可表述者列出） */
const TOOL_BASH = { name: 'bash', description: 'Execute shell commands in a persistent bash shell' }
const TOOL_PWSH = { name: 'pwsh', description: 'Execute commands in a Windows PowerShell shell' }
const TOOL_FS = { name: 'read_file/write_file/edit_file', description: 'Read, write, and edit files in the workspace' }
const TOOL_FS_SEARCH = { name: 'fs_search', description: 'Search file contents and list directory trees' }
const TOOL_WEB = { name: 'web_search', description: 'Search the web for current information' }
const TOOL_SKILL = { name: 'skill', description: 'Invoke a loaded SKILL.md skill by name' }
const TOOL_TODO = { name: 'todo_write', description: 'Track implementation tasks as a todo list' }
const TOOL_GOAL = { name: 'goal', description: 'Create and track long-running goals' }
const TOOL_PLAN = { name: 'exit_plan_mode', description: 'Submit a decision-complete plan for approval' }
const TOOL_STR_EDITOR = { name: 'str_replace_editor', description: 'Apply targeted string-replace edits to files' }
const TOOL_CORDIS = { name: 'cordis', description: 'Read and modify the harness composition (agent presets, plugin rows)' }

/** 与 background 的 DSH_AGENT_PRESETS（官方 preset.yml 元数据）保持一致 */
const PRESET_META: ReadonlyArray<PresetMeta> = [
  {
    id: 'standard',
    name: '标准模式',
    capability: '功能完整的编码 Agent，支持文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流。',
    tools: [
      TOOL_BASH, TOOL_PWSH, TOOL_FS, TOOL_FS_SEARCH, TOOL_WEB,
      TOOL_SKILL, TOOL_TODO, TOOL_GOAL, TOOL_PLAN,
    ],
    fallbackPersona: 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.',
  },
  {
    id: 'code',
    name: 'PTC 模式',
    capability: '具备标准模式的全部能力，并通过 Code Mode SDK 呈现工具，让模型用一个 TypeScript 程序组合多步操作。',
    tools: [
      TOOL_BASH, TOOL_PWSH, TOOL_FS, TOOL_FS_SEARCH, TOOL_WEB,
      TOOL_SKILL, TOOL_TODO, TOOL_GOAL, TOOL_PLAN,
    ],
    fallbackPersona: 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.',
  },
  {
    id: 'minimal',
    name: '极简模式',
    capability: '仅提供持久 bash 与 str_replace_editor 两个工具的最小编码 Agent。',
    tools: [TOOL_BASH, TOOL_STR_EDITOR],
    fallbackPersona: 'You are a helpful software engineer assistant.',
  },
  {
    id: 'cordis',
    name: '创造模式',
    capability: '具备标准模式的全部能力，并可读取和修改当前 harness 运行时（Cordis composition），用于创建自定义 Agent preset。',
    tools: [
      TOOL_BASH, TOOL_PWSH, TOOL_FS, TOOL_FS_SEARCH, TOOL_WEB,
      TOOL_SKILL, TOOL_TODO, TOOL_GOAL, TOOL_PLAN, TOOL_CORDIS,
    ],
    fallbackPersona:
      'You are a coding agent powered by the {{model}} model, running on the DeepSeek Harness. Your working directory is {{cwd}}.',
  },
]

/** 无预设 / 未知预设时的「网页对话」通用 persona */
export const DEFAULT_PERSONA =
  'You are a helpful assistant on the chat.deepseek.com web interface. ' +
  'Help the user with their requests, using the available tools (file editing, shell, search, skills) when asked.'

/**
 * 从 agent.cordis.yml 提取 `- id: persona` 段的 config.text。
 * 支持三种 YAML 形态：普通标量 / `>-` 折叠块 / `|-` 字面块。
 * 提取失败返回 null（由调用方回退到兜底 persona）。
 */
function extractPersonaText(yml: string): string | null {
  // 1) 定位 persona 段（到下一个 `- id:` 或文件尾为止）
  const blockMatch = /(?:^|\n)[ \t]*-[ \t]*id:[ \t]*persona\b[\s\S]*?(?=(?:\n[ \t]*-[ \t]*id:)|$)/.exec(yml)
  if (!blockMatch) return null
  const block = blockMatch[0]

  // 2) 段内找 config.text，记录 text 键的缩进以界定块标量内容行
  const textMatch = /\n[ \t]*config:[ \t]*\n([ \t]*)text:[ \t]*(.*)/.exec(block)
  if (!textMatch) return null
  const indentGroup = textMatch[1] ?? ''
  const markerGroup = textMatch[2] ?? ''
  const keyIndent = indentGroup.length
  const marker = markerGroup.trim()
  const rest = block.slice(textMatch.index + textMatch[0].length)

  // 3) 普通标量：一行内联文本
  if (marker !== '' && !/^[|>][+-]?$/.test(marker)) return marker || null

  // 4) 块标量：收集缩进深于 text 键的行
  const lines: string[] = []
  for (const line of rest.split(/\r?\n/)) {
    if (line.trim() === '') {
      lines.push('')
      continue
    }
    const indent = /^[ \t]*/.exec(line)?.[0]?.length ?? 0
    if (indent <= keyIndent) break
    lines.push(line.trim())
  }
  while (lines.length > 0 && lines[0] === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) return null

  if (marker.startsWith('>')) {
    // 折叠块：空行之外的各内容行以单空格连接
    return lines.filter((l) => l !== '').join(' ').trim() || null
  }
  // 字面块：保留换行（空行即段落分隔）
  return lines.join('\n').trim() || null
}

/**
 * 组装 agent 预设的 system prompt：能力说明 + 工具提示 + persona（已插值）。
 * 无预设 / 未知预设 → 返回「网页对话」通用 persona。
 */
export function presetSystemPrompt(agentPreset: string | undefined, ctx: PresetPromptContext = {}): string {
  if (agentPreset === undefined) return DEFAULT_PERSONA
  const meta = PRESET_META.find((m) => m.id === agentPreset)
  if (!meta) return DEFAULT_PERSONA

  const raw = DSH_AGENT_PRESET_CONTENTS[meta.id]
  const persona = (raw !== undefined ? extractPersonaText(raw) : null) ?? meta.fallbackPersona
  const model = ctx.model?.trim() || 'deepseek-chat'
  const cwd = ctx.cwd?.trim() || '网页对话'
  const resolved = persona.replaceAll('{{model}}', model).replaceAll('{{cwd}}', cwd)

  // 完整工具清单：`name — description` 逐行列出（agent 据此知道可用工具与调用格式）
  const toolList = meta.tools.map((t) => `- ${t.name}: ${t.description}`).join('\n')

  return [
    `You are using the "${meta.name}" agent preset: ${meta.capability}`,
    'You are an agent that can call tools. To use a tool, emit it inline with the tool name, arguments, and then read the result before continuing.',
    `Available tools:\n${toolList}`,
    resolved,
  ].filter((part) => part.trim() !== '').join('\n\n')
}
