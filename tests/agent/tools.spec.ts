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

import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { Workspace } from '@/utils/fs/workspace'
import { buildFsTools, buildSkillTool } from '@/utils/agent/tools'
import type { Skill } from '@/utils/skills/skill'

describe('buildFsTools', () => {
  let ws: Workspace

  beforeEach(async () => {
    ws = new Workspace({ sandboxMode: 'workspace-write', dbName: `tools-db-${Math.random()}` })
    await ws.init()
    await ws.writeText('/a.txt', 'hello world')
  })

  it('read_file returns file content', async () => {
    const tools = buildFsTools(ws)
    const res = await tools.read_file.run({ path: '/a.txt' })
    expect(res.ok).toBe(true)
    expect(res.output).toBe('hello world')
  })

  it('read_file reports missing file as failure', async () => {
    const tools = buildFsTools(ws)
    const res = await tools.read_file.run({ path: '/nope.txt' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not found|undefined/i)
  })

  it('write_file writes and read_file reads back', async () => {
    const tools = buildFsTools(ws)
    const w = await tools.write_file.run({ path: '/b.txt', content: 'new' })
    expect(w.ok).toBe(true)
    const r = await tools.read_file.run({ path: '/b.txt' })
    expect(r.output).toBe('new')
  })

  it('edit_file applies oldString/newString', async () => {
    const tools = buildFsTools(ws)
    const res = await tools.edit_file.run({
      path: '/a.txt',
      oldString: 'world',
      newString: 'WORLD',
    })
    expect(res.ok).toBe(true)
    expect(res.output).toMatch(/WORLD/)
    const r = await tools.read_file.run({ path: '/a.txt' })
    expect(r.output).toBe('hello WORLD')
  })

  it('list_dir returns entries', async () => {
    const tools = buildFsTools(ws)
    const res = await tools.list_dir.run({ path: '/' })
    expect(res.ok).toBe(true)
    expect(res.output).toContain('a.txt')
  })

  it('write is denied in read-only sandbox', async () => {
    const ro = new Workspace({ sandboxMode: 'read-only', dbName: `tools-ro-${Math.random()}` })
    await ro.init()
    const tools = buildFsTools(ro)
    const res = await tools.write_file.run({ path: '/x.txt', content: 'no' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/read-only/i)
  })
})

describe('buildSkillTool', () => {
  it('returns a working tool that exposes the skill body', async () => {
    const skill: Skill = { name: 'doc-writer', description: '写文档', body: '## Usage\n写文档时使用' }
    const tool = buildSkillTool(skill)
    expect(tool.description).toContain('doc-writer')
    const res = await tool.run({})
    expect(res.ok).toBe(true)
    expect(res.output).toContain('写文档时使用')
  })
})