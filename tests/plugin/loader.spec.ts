import { describe, it, expect } from 'vitest'
import 'fake-indexeddb/auto'
import { Context } from '@deepseek-ai/cordis'
import '@/utils/plugin/host'
import { Workspace } from '@/utils/fs/workspace'
import { loadPlugin, pluginFromSource } from '@/utils/plugin/loader'
import type { PluginManifest } from '@/utils/plugin/loader'

const SKILL_MD = `---
name: doc-writer
description: 写文档
---

## Usage
当用户要求写文档时使用。
`

async function setupWorkspaceWithPlugin(pluginName: string, manifest: PluginManifest) {
  const ws = new Workspace({ sandboxMode: 'workspace-write', dbName: `loader-db-${Math.random()}` })
  await ws.init()
  const dir = `/plugins/${pluginName}`
  await ws.writeText(`${dir}/dsh.plugin.json`, JSON.stringify(manifest, null, 2))
  await ws.writeText(`${dir}/SKILL.md`, SKILL_MD)
  return ws
}

describe('pluginFromSource', () => {
  it('parses manifest + skill into a loadable plugin', () => {
    const manifest: PluginManifest = {
      name: 'doc-writer',
      version: '1.0.0',
      entry: 'index.js',
      skills: ['SKILL.md'],
    }
    const plugin = pluginFromSource('doc-writer', manifest, SKILL_MD)
    expect(plugin.name).toBe('doc-writer')
    expect(plugin.manifest.version).toBe('1.0.0')
    expect(plugin.skill).toMatchObject({ name: 'doc-writer', description: '写文档' })
  })

  it('rejects malformed manifest', () => {
    expect(() => pluginFromSource('bad', null as unknown as PluginManifest, SKILL_MD)).toThrow(/manifest/i)
  })
})

describe('loadPlugin from workspace', () => {
  it('loads a plugin directory and registers its skill into ctx.skills', async () => {
    const manifest: PluginManifest = {
      name: 'doc-writer',
      version: '1.0.0',
      entry: 'index.js',
      skills: ['SKILL.md'],
    }
    const ws = await setupWorkspaceWithPlugin('doc-writer', manifest)

    const ctx = new Context()
    const { browserHost } = await import('@/utils/plugin/browser-host')
    await ctx.plugin(browserHost, { fs: ws })

    const loaded = await loadPlugin(ctx, ws, '/plugins/doc-writer')
    expect(loaded.name).toBe('doc-writer')
    const skills = ctx.skills.list()
    expect(skills.some((s) => s.name === 'doc-writer' && s.description === '写文档')).toBe(true)
    await ctx.fiber.dispose()
  })

  it('throws when plugin dir missing manifest', async () => {
    const ws = new Workspace({ sandboxMode: 'workspace-write', dbName: `loader-db-${Math.random()}` })
    await ws.init()
    const ctx = new Context()
    const { browserHost } = await import('@/utils/plugin/browser-host')
    await ctx.plugin(browserHost, { fs: ws })
    await expect(loadPlugin(ctx, ws, '/plugins/nope')).rejects.toThrow(/manifest/i)
    await ctx.fiber.dispose()
  })
})