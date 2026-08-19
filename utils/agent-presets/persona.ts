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
  /** 工具可用性提示（可选） */
  toolsHint: string
  /** 从 agent.cordis.yml 提取 persona 失败时的兜底 persona */
  fallbackPersona: string
}

/** 与 background 的 DSH_AGENT_PRESETS（官方 preset.yml 元数据）保持一致 */
const PRESET_META: ReadonlyArray<PresetMeta> = [
  {
    id: 'standard',
    name: '标准模式',
    capability: '功能完整的编码 Agent，支持文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流。',
    toolsHint: 'Available tools: file editing, shell, file & web search, skills, planning, goals, subagents, and workflows.',
    fallbackPersona: 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.',
  },
  {
    id: 'code',
    name: 'PTC 模式',
    capability: '具备标准模式的全部能力，并通过 Code Mode SDK 呈现工具，让模型用一个 TypeScript 程序组合多步操作。',
    toolsHint: 'Tools are presented through a Code Mode SDK: write a TypeScript program to compose multi-step operations, then run it.',
    fallbackPersona: 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.',
  },
  {
    id: 'minimal',
    name: '极简模式',
    capability: '仅提供持久 bash 与 str_replace_editor 两个工具的最小编码 Agent。',
    toolsHint: 'Available tools: persistent bash shell and str_replace_editor.',
    fallbackPersona: 'You are a helpful software engineer assistant.',
  },
  {
    id: 'cordis',
    name: '创造模式',
    capability: '具备标准模式的全部能力，并可读取和修改当前 harness 运行时（Cordis composition），用于创建自定义 Agent preset。',
    toolsHint: 'You can read and modify the harness you run on via the Cordis toolset.',
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

  return [`You are using the "${meta.name}" agent preset: ${meta.capability}`, meta.toolsHint, resolved]
    .filter((part) => part.trim() !== '')
    .join('\n\n')
}
