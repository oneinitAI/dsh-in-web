import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { Context } from '@deepseek-ai/cordis'
import '@/utils/plugin/host'
import { Workspace } from '@/utils/fs/workspace'
import type { SkillMeta } from '@/utils/skills/skill'
import { browserHost } from '@/utils/plugin/browser-host'

describe('browserHost ctx.fs adapter', () => {
  let ctx: Context
  let ws: Workspace

  beforeEach(async () => {
    ws = new Workspace({ sandboxMode: 'workspace-write', dbName: `host-db-${Math.random()}` })
    await ws.init()
    ctx = new Context()
    await ctx.plugin(browserHost, { fs: ws })
  })

  it('registers ctx.fs readable/writable', async () => {
    await ctx.fs.writeText('/a.txt', 'hello')
    expect(await ctx.fs.readText('/a.txt')).toBe('hello')
  })

  it('registers ctx.skills list/register', () => {
    expect(ctx.skills.list()).toEqual([])
    const skill: SkillMeta = { name: 'demo', description: 'demo skill' }
    ctx.skills.register(skill)
    expect(ctx.skills.list()).toEqual([skill])
  })

  it('ctx.llm.stream is available as service', async () => {
    // the real llm adapter requires the web bridge; service presence is enough here
    expect(typeof ctx.llm.stream).toBe('function')
  })

  it('fiber dispose cleans up services', async () => {
    await ctx.fiber.dispose()
    // after dispose, plugin services are gone from this context
    expect((ctx as unknown as { fs?: unknown }).fs).toBeUndefined()
  })
})