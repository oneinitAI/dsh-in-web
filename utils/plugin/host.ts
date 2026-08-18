/**
 * Browser host surface — the ctx.* services we provide to Cordis plugins.
 *
 * dsh plugins consume a rich host ctx (fs/skills/llm/terminal/sandbox...) that
 * in the native harness is backed by Node. In dsh-in-web those services are
 * backed by browser equivalents (virtual workspace / skill library / web bridge).
 * This module declares the module augmentation so plugins can read them with
 * full typing, and defines the BrowserHost plugin that registers them.
 */
import type { Context, Service } from '@deepseek-ai/cordis'
import type { Workspace } from '@/utils/fs/workspace'
import type { SkillMeta } from '@/utils/skills/skill'

/** ctx.llm — stream completion through the deepseek web bridge. */
export interface LlmStreamEvent {
  kind: 'thinking' | 'text' | 'finish' | 'error'
  text?: string
  error?: string
}

export interface BrowserHostSurface {
  fs: Workspace
  skills: {
    list(): SkillMeta[]
    register(skill: SkillMeta): void
  }
  llm: {
    stream(messages: { role: string; content: string }[]): AsyncGenerator<LlmStreamEvent>
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context extends BrowserHostSurface {}
}