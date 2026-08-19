/**
 * Tool registry builders — map the browser host surface into DSML tools
 * consumable by the agent loop (ctx.fs → read/write/edit/list tools,
 * skill library → per-skill tools). Pure + testable.
 */
import type { Workspace } from '@/utils/fs/workspace'
import type { Skill } from '@/utils/skills/skill'
import type { ToolDef, ToolRegistry } from '@/utils/agent/agent'

/** Typed fs tool surface (avoids noUncheckedIndexedAccess on registry lookups). */
export interface FsTools {
  read_file: ToolDef
  write_file: ToolDef
  edit_file: ToolDef
  list_dir: ToolDef
}

/** Build fs tools backed by a Workspace (sandbox enforced by the workspace). */
export function buildFsTools(ws: Workspace): FsTools {
  return {
    read_file: {
      description: '读取工作区文件内容。参数：path（绝对路径，如 /a.txt）',
      async run(args: Record<string, unknown>) {
        const path = String(args.path ?? '')
        if (!path) return { ok: false, error: 'missing path' }
        const content = await ws.readText(path)
        if (content === undefined) return { ok: false, error: `file not found: ${path}` }
        return { ok: true, output: content }
      },
    },
    write_file: {
      description: '写入工作区文件（自动创建父目录，覆盖已有内容）。参数：path, content',
      async run(args: Record<string, unknown>) {
        const path = String(args.path ?? '')
        const content = String(args.content ?? '')
        if (!path) return { ok: false, error: 'missing path' }
        try {
          const { version } = await ws.writeText(path, content)
          return { ok: true, output: `wrote ${path} (v${version})` }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      },
    },
    edit_file: {
      description: '编辑工作区文件（oldString/newString 替换）。参数：path, oldString, newString, replaceAll?',
      async run(args: Record<string, unknown>) {
        const path = String(args.path ?? '')
        const oldString = String(args.oldString ?? '')
        const newString = String(args.newString ?? '')
        const replaceAll = args.replaceAll === true || args.replaceAll === 'true'
        if (!path || !oldString) return { ok: false, error: 'missing path or oldString' }
        try {
          const res = await ws.editText(path, { oldString, newString, replaceAll })
          return { ok: true, output: `edited ${path} (v${res.version})\n${res.after}` }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      },
    },
    list_dir: {
      description: '列出工作区目录内容。参数：path（默认 /）',
      async run(args: Record<string, unknown>) {
        const path = String(args.path ?? '/')
        try {
          const entries = await ws.list(path)
          const lines = entries.map((e) => `${e.kind === 'dir' ? 'd' : '-'} ${e.path}`)
          return { ok: true, output: lines.join('\n') || '(empty)' }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      },
    },
  }
}

/** Build a single tool that reveals a skill's instructions to the model. */
export function buildSkillTool(skill: Skill): ToolDef {
  return {
    description: `技能 ${skill.name}：${skill.description}`,
    async run(_args: Record<string, unknown>): Promise<{ ok: true; output: string }> {
      return { ok: true, output: skill.body }
    },
  }
}

/** Build a simple web search tool (browser-safe fetch). */
function buildWebSearchTool(): ToolDef {
  return {
    description: '搜索网页获取实时信息。参数：query（搜索词）',
    async run(args: Record<string, unknown>): Promise<{ ok: boolean; output?: string; error?: string }> {
      const query = String(args.query ?? '').trim()
      if (!query) return { ok: false, error: 'missing query' }
      try {
        const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
        const html = await res.text()
        // 粗提取文本（去标签）——浏览器扩展里无法跑搜索引擎 SDK，给近似结果
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 3000)
        return { ok: true, output: text || '(no results)' }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}

/** Build the full tool registry for the agent loop, optionally scoped to a preset. */
export function buildAgentTools(ws: Workspace, skills: Skill[], preset?: string): ToolRegistry {
  const tools: ToolRegistry = { ...buildFsTools(ws) }
  // 预设区分：minimal 仅精简文件编辑；其余（standard/code/cordis）含 web 搜索 + skill。
  if (preset === 'minimal') {
    // 极简：只保留文件编辑工具（str_replace_editor 语义 ≈ edit_file）
    for (const skill of skills) tools[`skill_${skill.name}`] = buildSkillTool(skill)
    return tools
  }
  tools.web_search = buildWebSearchTool()
  for (const skill of skills) {
    tools[`skill_${skill.name}`] = buildSkillTool(skill)
  }
  return tools
}