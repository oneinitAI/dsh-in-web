/**
 * Skill library — L0: SKILL.md data direct-load.
 * Parses dsh/Claude-style SKILL.md (frontmatter name/description + body),
 * renders the <available_skills> directory block, and matches "/name"
 * command gestures (dsh skill invocation syntax).
 */

export interface SkillMeta {
  name: string
  description: string
}

export interface Skill extends SkillMeta {
  body: string
}

const FM_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/

function parseFrontmatter(src: string): Record<string, string> {
  const m = FM_RE.exec(src)
  if (!m) throw new Error('skill missing frontmatter (--- name/description ---)')
  const out: Record<string, string> = {}
  for (const line of (m[1] ?? '').split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '')
    if (key) out[key] = value
  }
  return out
}

/** Parse SKILL.md source into a Skill. Frontmatter name/description required. */
export function parseSkillMd(name: string, src: string): Skill {
  const fm = parseFrontmatter(src)
  const description = fm['description']
  if (!description) throw new Error(`skill "${name}" missing description in frontmatter`)
  const body = src.replace(FM_RE, '').trim()
  return { name, description, body }
}

/** Render the <available_skills> directory block injected into system prompt. */
export function renderAvailableSkills(skills: SkillMeta[]): string {
  if (skills.length === 0) {
    return '<available_skills>无可用技能</available_skills>'
  }
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`)
  return ['<available_skills>', ...lines, '</available_skills>'].join('\n')
}

export type SkillCommandMatch = { name: string; args: string } | null

const CMD_RE = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/

/**
 * Match a "/name" or "/name args" gesture against registered skills.
 * Exact name wins; otherwise longest-prefix fuzzy match; else null.
 */
export function matchSkillCommand(
  text: string,
  skills: SkillMeta[],
): SkillCommandMatch {
  const m = CMD_RE.exec(text.trim())
  if (!m) return null
  const token = m[1] ?? ''
  const args = (m[2] ?? '').trim()

  const exact = skills.find((s) => s.name === token)
  if (exact) return { name: exact.name, args }

  let best: SkillMeta | undefined
  for (const s of skills) {
    if (s.name.startsWith(token) && (!best || s.name.length < best.name.length)) {
      best = s
    }
  }
  return best ? { name: best.name, args } : null
}

/** List registered skill names (for /handlers style listing). */
export function listSkills(skills: SkillMeta[]): string[] {
  return skills.map((s) => s.name)
}
