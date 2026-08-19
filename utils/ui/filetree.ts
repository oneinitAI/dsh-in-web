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
 * File tree view-model — flatten workspace entries into a nested tree
 * for the Side Panel file browser. Pure + testable.
 */
import type { FsEntry } from '@/utils/fs/workspace'

export interface TreeNode {
  path: string
  name: string
  kind: 'file' | 'dir'
  size?: number
  version?: number
  children?: TreeNode[]
}

/** Flatten a list of workspace entries into a nested tree rooted at '/'. */
export function buildFileTree(entries: readonly FsEntry[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>()
  const root: TreeNode = { path: '/', name: '/', kind: 'dir', children: [] }
  nodes.set('/', root)

  const ensureDir = (path: string): TreeNode => {
    const existing = nodes.get(path)
    if (existing) return existing
    const node: TreeNode = { path, name: basename(path), kind: 'dir', children: [] }
    nodes.set(path, node)
    return node
  }

  for (const e of entries) {
    if (e.path === '/') continue
    const parts = e.path.split('/').filter(Boolean)
    // walk/create parent dirs
    let current = root
    let acc = ''
    for (let i = 0; i < parts.length; i++) {
      acc += '/' + parts[i]
      const isLeaf = i === parts.length - 1
      if (isLeaf && e.kind === 'file') {
        const node: TreeNode = {
          path: e.path,
          name: parts[i]!,
          kind: 'file',
          size: e.size,
          version: e.version,
        }
        current.children!.push(node)
      } else {
        const dir = ensureDir(acc)
        if (!current.children!.some((c) => c.path === dir.path)) {
          current.children!.push(dir)
        }
        current = dir
      }
    }
  }
  return [root]
}

function basename(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx >= 0 ? path.slice(idx + 1) : path
}

/** Filter tree by substring match on path; prunes branches without matches. */
export function filterTree(nodes: readonly TreeNode[], query: string): TreeNode[] {
  const q = query.trim().toLowerCase()
  if (!q) return nodes.map((n) => ({ ...n }))
  const result: TreeNode[] = []
  for (const n of nodes) {
    const self = n.path.toLowerCase().includes(q)
    const kids = n.children ? filterTree(n.children, q) : []
    if (self || kids.length > 0) {
      result.push({ ...n, children: kids.length > 0 ? kids : n.children ? [] : undefined })
    }
  }
  return result
}