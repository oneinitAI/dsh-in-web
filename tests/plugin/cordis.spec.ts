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
import { Context, Service } from '@deepseek-ai/cordis'
import '@/utils/plugin/host'

/** Cordis kernel browser smoke test — verify apply(ctx) + plugin injection
 *  works in a pure-JS environment (no Node globals needed). */

describe('Cordis kernel in browser context', () => {
  it('creates a Context and applies a plugin with ctx injection', async () => {
    const ctx = new Context()
    const calls: string[] = []

    // a "browser-host" service (e.g. our ctx.fs adapter)
    class FsService extends Service {
      constructor(c: Context) {
        super(c, 'fs')
      }
      async readText(path: string): Promise<string | undefined> {
        return path === '/hello.txt' ? 'file content' : undefined
      }
    }

    await ctx.plugin(FsService)

    // a plugin that consumes ctx.fs (must declare inject)
    const reader = Object.assign(
      async (inner: Context) => {
        const content = await inner.fs.readText('/hello.txt')
        calls.push(`plugin-read:${content}`)
      },
      { inject: ['fs'] as const },
    )
    await ctx.plugin(reader)

    expect(calls).toEqual(['plugin-read:file content'])
    await ctx.fiber.dispose()
  })

  it('supports declarative plugin apply() with config', async () => {
    const ctx = new Context()
    const applied: string[] = []

    function plugin(inner: Context, config: { prefix?: string }) {
      applied.push(`${config.prefix ?? ''}ready`)
    }

    await ctx.plugin(plugin, { prefix: 'cfg:' })
    expect(applied).toEqual(['cfg:ready'])
    await ctx.fiber.dispose()
  })

  it('supports inject-based service dependency ordering', async () => {
    const ctx = new Context()
    const seen: string[] = []

    class Counter extends Service {
      constructor(c: Context) {
        super(c, 'counter')
      }
    }
    class Consumer extends Service {
      constructor(c: Context) {
        super(c, 'consumer')
        seen.push('consumer-ready')
      }
    }

    await ctx.plugin(Counter)
    await ctx.plugin(Consumer)
    expect(seen).toEqual(['consumer-ready'])
    await ctx.fiber.dispose()
  })
})