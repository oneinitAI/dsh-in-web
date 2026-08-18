/**
 * Prompt management — dsh-aligned system prompt assembly.
 * Sections are "Header:"-prefixed blocks assembled in order (dsh order
 * convention), {{variable}} interpolation, and persona preset prepend.
 */

export type Variables = Record<string, string>

/** Replace {{key}} placeholders; unknown variables left untouched. */
export function interpolate(template: string, vars: Variables): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? (vars[key] ?? match) : match,
  )
}

export interface PromptSection {
  header: string
  body: string
}

/** Split a prompt source into "Header: body" sections (order preserved). */
export function parseSections(src: string): PromptSection[] {
  const sections: PromptSection[] = []
  let current: PromptSection | null = null
  for (const line of src.split('\n')) {
    const m = /^([A-Za-z][\w\s]*):\s*(.*)$/.exec(line)
    if (m && current) {
      // new section header mid-file
      current = null
    }
    if (m) {
      sections.push({ header: (m[1] ?? '').trim(), body: m[2] ?? '' })
      current = sections[sections.length - 1]!
    } else if (current) {
      current.body += (current.body ? '\n' : '') + line
    }
  }
  return sections
}

/** Assemble sections in order with interpolation applied. */
export function renderSections(
  sections: PromptSection[],
  vars: Variables = {},
): string {
  return sections
    .map((s) => {
      const body = interpolate(s.body, vars)
      return `${s.header}: ${body}`.trim()
    })
    .join('\n\n')
}

/** Prepend a persona preset line to the first System section. */
export function applyPersona(systemPrompt: string, persona: string): string {
  const trimmed = persona.trim()
  if (!trimmed) return systemPrompt
  return `System: ${trimmed}\n\n${systemPrompt}`
}