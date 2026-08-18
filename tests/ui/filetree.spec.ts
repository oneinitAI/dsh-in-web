import { describe, it, expect } from 'vitest'
import { buildFileTree, filterTree, type TreeNode } from '@/utils/ui/filetree'
import type { FsEntry } from '@/utils/fs/workspace'

const entries: FsEntry[] = [
  { path: '/docs', kind: 'dir' },
  { path: '/docs/a.txt', kind: 'file', size: 5, version: 1 },
  { path: '/docs/b.md', kind: 'file', size: 3, version: 2 },
  { path: '/src', kind: 'dir' },
  { path: '/src/index.ts', kind: 'file', size: 10, version: 3 },
  { path: '/package.json', kind: 'file', size: 20, version: 4 },
]

describe('buildFileTree', () => {
  it('nests entries into a tree preserving order', () => {
    const tree = buildFileTree(entries)
    const root = tree.find((n) => n.path === '/')!
    expect(root.kind).toBe('dir')
    const docs = root.children!.find((n) => n.path === '/docs')!
    expect(docs.children!.map((c) => c.path)).toEqual(['/docs/a.txt', '/docs/b.md'])
    const src = root.children!.find((n) => n.path === '/src')!
    expect(src.children!.map((c) => c.path)).toEqual(['/src/index.ts'])
    expect(root.children!.map((c) => c.path)).toEqual(['/docs', '/src', '/package.json'])
  })

  it('creates implicit parent dirs for orphan paths', () => {
    const tree = buildFileTree([{ path: '/x/y/z.txt', kind: 'file', size: 1, version: 1 }])
    const root = tree.find((n) => n.path === '/')!
    const x = root.children!.find((n) => n.path === '/x')!
    expect(x.kind).toBe('dir')
    const y = x.children!.find((n) => n.path === '/x/y')!
    expect(y.children!.map((c) => c.path)).toEqual(['/x/y/z.txt'])
  })

  it('returns empty root for no entries', () => {
    const tree = buildFileTree([])
    expect(tree).toEqual([{ path: '/', name: '/', kind: 'dir', children: [] }])
  })

  it('sets name to last path segment', () => {
    const tree = buildFileTree([{ path: '/docs/a.txt', kind: 'file', size: 1, version: 1 }])
    const docs = tree[0]!.children![0]!
    expect(docs.name).toBe('docs')
    const a = docs.children![0]!
    expect(a.name).toBe('a.txt')
  })
})

describe('filterTree', () => {
  it('keeps nodes whose path matches query and prunes non-matching branches', () => {
    const tree = buildFileTree(entries)
    const filtered = filterTree(tree, 'docs')
    const flat: string[] = []
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        flat.push(n.path)
        if (n.children) walk(n.children)
      }
    }
    walk(filtered)
    expect(flat).toContain('/docs')
    expect(flat).toContain('/docs/a.txt')
    expect(flat).not.toContain('/src')
    expect(flat).not.toContain('/package.json')
  })

  it('returns all when query empty', () => {
    const tree = buildFileTree(entries)
    expect(filterTree(tree, '').length).toBe(1) // root only
  })

  it('returns empty when nothing matches', () => {
    const tree = buildFileTree(entries)
    expect(filterTree(tree, 'zzz')).toEqual([])
  })
})