import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { Workspace, resolvePath } from '@/utils/fs/workspace'
import type { SandboxMode } from '@/utils/fs/workspace'

async function freshWorkspace(mode: SandboxMode = 'read-only') {
  const ws = new Workspace({ sandboxMode: mode, dbName: `test-db-${Math.random()}` })
  await ws.init()
  return ws
}

describe('resolvePath', () => {
  it('normalizes dot segments and keeps leading slash', () => {
    expect(resolvePath('/a/./b/../c')).toBe('/a/c')
    expect(resolvePath('a/b')).toBe('/a/b')
    expect(resolvePath('/')).toBe('/')
  })

  it('rejects traversal escaping the root', () => {
    expect(() => resolvePath('/../etc/passwd')).toThrow(/escape/i)
    expect(() => resolvePath('../../x')).toThrow(/escape/i)
  })

  it('rejects empty and non-string input', () => {
    expect(() => resolvePath('')).toThrow(/empty/i)
    expect(() => resolvePath('   ')).toThrow(/empty/i)
    // @ts-expect-error deliberate bad input
    expect(() => resolvePath(42)).toThrow()
  })
})

describe('Workspace read/write', () => {
  let ws: Workspace

  beforeEach(async () => {
    ws = await freshWorkspace('workspace-write')
  })

  it('readText returns undefined for missing file', async () => {
    expect(await ws.readText('/nope.txt')).toBeUndefined()
  })

  it('writeText then readText roundtrips with version bump', async () => {
    const v1 = await ws.writeText('/docs/a.txt', 'hello')
    expect(v1.version).toBe(1)
    expect(await ws.readText('/docs/a.txt')).toBe('hello')

    const v2 = await ws.writeText('/docs/a.txt', 'world')
    expect(v2.version).toBe(2)
    expect(await ws.readText('/docs/a.txt')).toBe('world')
  })

  it('writeText auto-creates parent dirs and lists entries', async () => {
    await ws.writeText('/x/y/z.txt', 'deep')
    const entries = await ws.list('/')
    expect(entries.map((e) => e.path)).toContain('/x')
    expect(entries.map((e) => e.path)).not.toContain('/y') // not a direct child
    const inner = await ws.list('/x/y')
    expect(inner).toContainEqual(expect.objectContaining({ path: '/x/y/z.txt', kind: 'file' }))
  })

  it('editText replaces single occurrence and returns before/after/version', async () => {
    await ws.writeText('/note.md', 'foo bar foo')
    const res = await ws.editText('/note.md', { oldString: 'bar', newString: 'BAZ' })
    expect(res.before).toBe('foo bar foo')
    expect(res.after).toBe('foo BAZ foo')
    expect(res.version).toBe(2)
    expect(await ws.readText('/note.md')).toBe('foo BAZ foo')
  })

  it('editText replaceAll replaces every occurrence', async () => {
    await ws.writeText('/note.md', 'foo bar foo bar')
    const res = await ws.editText('/note.md', { oldString: 'bar', newString: 'X', replaceAll: true })
    expect(res.after).toBe('foo X foo X')
  })

  it('editText throws when oldString not found', async () => {
    await ws.writeText('/note.md', 'abc')
    await expect(ws.editText('/note.md', { oldString: 'zzz', newString: 'q' })).rejects.toThrow(/not found/i)
  })

  it('stat reports kind, size and version', async () => {
    await ws.writeText('/docs/a.txt', 'hello')
    const st = await ws.stat('/docs/a.txt')
    expect(st).toMatchObject({ path: '/docs/a.txt', kind: 'file', size: 5, version: 1 })
    const dir = await ws.stat('/docs')
    expect(dir).toMatchObject({ path: '/docs', kind: 'dir' })
  })

  it('stat returns undefined for missing', async () => {
    expect(await ws.stat('/missing')).toBeUndefined()
  })
})

describe('SandboxMode enforcement', () => {
  it('read-only blocks all writes', async () => {
    const ro = await freshWorkspace('read-only')
    await expect(ro.writeText('/x.txt', 'data')).rejects.toThrow(/read-only/i)
    await expect(ro.editText('/x.txt', { oldString: 'a', newString: 'b' })).rejects.toThrow(/read-only/i)
  })

  it('workspace-write allows writes but read-only default blocks', async () => {
    const rw = await freshWorkspace('workspace-write')
    await expect(rw.writeText('/x.txt', 'ok')).resolves.toMatchObject({ version: 1 })
    // default mode is read-only
    const def = await freshWorkspace()
    await expect(def.writeText('/x.txt', 'no')).rejects.toThrow(/read-only/i)
  })
})
