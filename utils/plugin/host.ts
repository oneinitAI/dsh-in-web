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
export type LlmStreamEvent =
  | { kind: 'thinking'; text?: string }
  | { kind: 'text'; text?: string }
  | { kind: 'finish' }
  | { kind: 'error'; error?: string }
  | { kind: 'tool_call'; callId: string; name: string; arguments: string }
  | { kind: 'tool_result'; callId: string; name: string; arguments: string; output: string; ok: boolean }

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