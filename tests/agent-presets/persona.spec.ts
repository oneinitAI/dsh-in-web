import { describe, expect, it } from 'vitest'
import { presetSystemPrompt } from '@/utils/agent-presets/persona'

describe('presetSystemPrompt（Agent 预设 persona 注入）', () => {
  it('standard：折叠块 persona + 标准模式能力说明', () => {
    const prompt = presetSystemPrompt('standard', { cwd: '<dsh-in-web>' })
    expect(prompt).toContain('You are using the "标准模式" agent preset')
    expect(prompt).toContain('功能完整的编码 Agent')
    expect(prompt).toContain('You are a coding agent powered by the deepseek-chat model. Your working directory is <dsh-in-web>.')
    // 折叠块 `>-` 单行 persona 不应残留占位符
    expect(prompt).not.toContain('{{')
  })

  it('code：与 standard 同款 persona，能力说明指向 PTC 模式', () => {
    const prompt = presetSystemPrompt('code')
    expect(prompt).toContain('You are using the "PTC 模式" agent preset')
    expect(prompt).toContain('Code Mode SDK')
    expect(prompt).toContain('You are a coding agent powered by the deepseek-chat model. Your working directory is 网页对话.')
  })

  it('minimal：内联标量 persona（完整 system prompt 形态）', () => {
    const prompt = presetSystemPrompt('minimal')
    expect(prompt).toContain('You are using the "极简模式" agent preset')
    expect(prompt).toContain('持久 bash 与 str_replace_editor')
    expect(prompt).toContain('You are a helpful software engineer assistant.')
  })

  it('cordis：字面块多段 persona + 创造模式能力说明', () => {
    const prompt = presetSystemPrompt('cordis')
    expect(prompt).toContain('You are using the "创造模式" agent preset')
    expect(prompt).toContain('创建自定义 Agent preset')
    expect(prompt).toContain('You are a coding agent powered by the deepseek-chat model, running on the DeepSeek Harness.')
    expect(prompt).toContain('Cordis')
    expect(prompt).toContain('AGENT PRESET')
    expect(prompt).not.toContain('{{')
  })

  it('无预设 → 「网页对话」通用 persona', () => {
    const prompt = presetSystemPrompt(undefined)
    expect(prompt).toContain('helpful assistant')
    expect(prompt).not.toContain('agent preset')
  })

  it('未知预设 → 回退通用 persona', () => {
    expect(presetSystemPrompt('nope')).toBe(presetSystemPrompt(undefined))
  })
})
