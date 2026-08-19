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
import {
  interpolate,
  renderSections,
  parseSections,
  applyPersona,
} from '@/utils/prompts/prompt'

describe('interpolate', () => {
  it('replaces {{variable}} placeholders', () => {
    expect(interpolate('Hello {{name}}!', { name: 'World' })).toBe('Hello World!')
  })

  it('leaves unknown variables as-is', () => {
    expect(interpolate('Hi {{name}}', {})).toBe('Hi {{name}}')
  })

  it('handles repeated variables', () => {
    expect(interpolate('{{a}}/{{a}}', { a: 'x' })).toBe('x/x')
  })
})

describe('parseSections + renderSections', () => {
  const src = `System: 你是 {{name}}。

Skills:
<available_skills>{{skills}}</available_skills>

User: 用户消息`
  const sections = parseSections(src)

  it('parses header-prefixed sections', () => {
    expect(sections.map((s) => s.header)).toEqual(['System', 'Skills', 'User'])
  })

  it('renders ordered sections with interpolation', () => {
    const out = renderSections(sections, {
      name: 'dsh',
      skills: '- a: A\n- b: B',
    })
    expect(out).toContain('你是 dsh。')
    expect(out).toContain('<available_skills>- a: A\n- b: B</available_skills>')
    expect(out.indexOf('System:')).toBeLessThan(out.indexOf('Skills:'))
    expect(out.indexOf('Skills:')).toBeLessThan(out.indexOf('User:'))
  })
})

describe('applyPersona', () => {
  it('prepends persona preset line', () => {
    const persona = 'You are a helpful coding agent.'
    const base = 'System: base'
    const out = applyPersona(base, persona)
    expect(out).toBe(`System: ${persona}\n\n${base}`)
  })
})