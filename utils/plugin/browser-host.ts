/**
 * BrowserHost plugin — registers the browser host surface services
 * (ctx.fs / ctx.skills / ctx.llm) into a Cordis context so dsh plugins
 * can consume them through the standard inject mechanism.
 *
 * Object plugin with apply(ctx, config); config carries the concrete
 * Workspace instance and an optional llm bridge function.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Workspace } from '@/utils/fs/workspace'
import type { SkillMeta } from '@/utils/skills/skill'
import type { LlmStreamEvent } from '@/utils/plugin/host'

export type LlmBridge = (messages: { role: string; content: string }[]) => AsyncGenerator<LlmStreamEvent>

export interface BrowserHostConfig {
  /** Concrete workspace (already initialized). Optional — plugin without it still loads. */
  fs?: Workspace
  /** Web-bridge stream function for ctx.llm. Optional — errors when absent. */
  llm?: LlmBridge
}

class FsService extends Service {
  constructor(ctx: Context, public impl?: Workspace) {
    super(ctx, 'fs')
  }
  /** Delegate to the underlying Workspace (which shares the same method names). */
  readText(path: string): Promise<string | undefined> {
    if (!this.impl) throw new Error('ctx.fs not configured')
    return this.impl.readText(path)
  }
  writeText(path: string, content: string) {
    if (!this.impl) throw new Error('ctx.fs not configured')
    return this.impl.writeText(path, content)
  }
  editText(path: string, spec: { oldString: string; newString: string; replaceAll?: boolean }) {
    if (!this.impl) throw new Error('ctx.fs not configured')
    return this.impl.editText(path, spec)
  }
  list(path: string) {
    if (!this.impl) throw new Error('ctx.fs not configured')
    return this.impl.list(path)
  }
  stat(path: string) {
    if (!this.impl) throw new Error('ctx.fs not configured')
    return this.impl.stat(path)
  }
}

class SkillsService extends Service {
  private items: SkillMeta[] = []
  constructor(ctx: Context) {
    super(ctx, 'skills')
  }
  list(): SkillMeta[] {
    return [...this.items]
  }
  register(skill: SkillMeta): void {
    this.items.push(skill)
  }
}

class LlmService extends Service {
  constructor(ctx: Context, private bridge?: LlmBridge) {
    super(ctx, 'llm')
  }
  async *stream(messages: { role: string; content: string }[]): AsyncGenerator<LlmStreamEvent> {
    if (!this.bridge) {
      yield { kind: 'error', error: 'llm bridge not configured' }
      return
    }
    yield* this.bridge(messages)
  }
}

export const browserHost = {
  name: 'dsh-in-web:browser-host',
  apply(ctx: Context, config: BrowserHostConfig = {}) {
    void ctx.plugin(FsService, config.fs)
    void ctx.plugin(SkillsService)
    void ctx.plugin(LlmService, config.llm)
  },
}