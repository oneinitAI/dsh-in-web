import { describe, it, expect } from 'vitest'
import {
  parseSkillMd,
  renderAvailableSkills,
  matchSkillCommand,
  listSkills,
} from '@/utils/skills/skill'

const SAMPLE = `---
name: my-skill
description: 我的测试技能
---

## Usage

When the user asks for X, do Y.

## Examples

\`\`\`js
console.log('hi')
\`\`\`
`

const NO_FRONTMATTER = `# Not a skill

just a doc
`

const MINIMAL = `---
name: minimal
description: bare
---
body
`

describe('parseSkillMd', () => {
  it('parses frontmatter name + description and body', () => {
    const s = parseSkillMd('my-skill', SAMPLE)
    expect(s.name).toBe('my-skill')
    expect(s.description).toBe('我的测试技能')
    expect(s.body).toContain('## Usage')
    expect(s.body).toContain('do Y')
  })

  it('throws when frontmatter missing', () => {
    expect(() => parseSkillMd('bad', NO_FRONTMATTER)).toThrow(/frontmatter/i)
  })

  it('accepts minimal frontmatter', () => {
    const s = parseSkillMd('minimal', MINIMAL)
    expect(s.name).toBe('minimal')
    expect(s.description).toBe('bare')
  })
})

describe('renderAvailableSkills', () => {
  it('renders <available_skills> block from list', () => {
    const skills = [
      { name: 'a', description: 'A desc' },
      { name: 'b', description: 'B desc' },
    ]
    const out = renderAvailableSkills(skills)
    expect(out).toContain('<available_skills>')
    expect(out).toContain('</available_skills>')
    expect(out).toContain('a')
    expect(out).toContain('A desc')
    expect(out).toContain('b')
  })

  it('renders empty placeholder when no skills', () => {
    const out = renderAvailableSkills([])
    expect(out).toContain('<available_skills>')
    expect(out).toContain('无可用技能')
  })
})

describe('listSkills + matchSkillCommand', () => {
  const skills = [
    { name: 'read-file', description: '读文件' },
    { name: 'write-file', description: '写文件' },
    { name: 'shell', description: '终端' },
  ]

  it('lists skill names for /handlers', () => {
    expect(listSkills(skills)).toEqual(['read-file', 'write-file', 'shell'])
  })

  it('matches /name exact', () => {
    expect(matchSkillCommand('/read-file', skills)).toEqual({ name: 'read-file', args: '' })
  })

  it('matches /name with args', () => {
    expect(matchSkillCommand('/shell ls -la', skills)).toEqual({ name: 'shell', args: 'ls -la' })
  })

  it('matches fuzzy prefix', () => {
    expect(matchSkillCommand('/read', skills)).toEqual({ name: 'read-file', args: '' })
  })

  it('returns null when no match', () => {
    expect(matchSkillCommand('/nope', skills)).toBeNull()
    expect(matchSkillCommand('plain text', skills)).toBeNull()
  })
})
