/**
 * Add an MIT license header to every source file that lacks one.
 *
 * dsh-in-web embeds the official DeepSeek Harness (dsh) frontend, which is MIT
 * licensed — MIT requires the copyright notice to be included in copies /
 * substantial portions of the software. This script prepends a header block to
 * all .ts / .tsx / .mjs sources under entrypoints/, utils/, tests/, scripts/
 * and user-plugins/ that do not already carry a copyright / SPDX notice.
 *
 * Idempotent + self-healing:
 *  - files already containing "SPDX-License-Identifier" or "Copyright" in the
 *    first 20 lines are left untouched;
 *  - duplicate dsh-in-web header blocks (e.g. from earlier buggy runs) are
 *    collapsed to a single one;
 *  - a `#!/usr/bin/env node` shebang is always kept on line 1 (headers go
 *    below it), so node scripts survive header re-runs.
 *
 * Run: node scripts/add-license-headers.mjs
 */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..')

const HEADER = [
  '/**',
  ' * dsh-in-web — DeepSeek Harness (dsh) in the browser.',
  ' *',
  ' * This file embeds/adapts code from deepseek-ai/DeepSeek-Harness (dsh),',
  ' * distributed under the MIT License.',
  ' *',
  ' * Copyright (c) 2026 DeepSeek (dsh / DeepSeek-Harness)',
  ' * Copyright (c) 2026 oneinitAI',
  ' *',
  ' * SPDX-License-Identifier: MIT',
  ' */',
  '',
].join('\n')

// Matches a complete dsh-in-web header block we may have added in past runs
// (any number of times), so duplicates can be stripped and re-added once.
const DSH_HEADER_RE = /\/\*\*\n \* dsh-in-web — DeepSeek Harness \(dsh\) in the browser\.\n[\s\S]*?\n \*\/\n*/g

const EXTENSIONS = new Set(['.ts', '.tsx', '.mjs'])
const ROOTS = ['entrypoints', 'utils', 'tests', 'scripts', 'user-plugins']

/** Recursively collect source files under dir matching EXTENSIONS. */
async function collect(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) await collect(full, out)
    else if (EXTENSIONS.has(e.name.slice(e.name.lastIndexOf('.')))) out.push(full)
  }
  return out
}

/** Whether the file already carries a license notice near the top. */
function hasNotice(head) {
  return /SPDX-License-Identifier|Copyright/i.test(head)
}

/**
 * Normalize one file's header state:
 *  - strip every dsh-in-web header block (dedupe);
 *  - hoist a shebang (wherever it ended up) back to line 1;
 *  - re-add exactly one header when no other notice exists in the top 20 lines.
 * Returns { content, added, stripped }.
 */
function normalizeLicense(content) {
  let stripped = content.replace(DSH_HEADER_RE, '')
  const duplicated = content !== stripped

  let shebang = ''
  stripped = stripped.replace(/^#![^\n]*\n?/, (m) => {
    shebang = m
    return ''
  })
  if (!shebang) {
    stripped = stripped.replace(/^\s*#![^\n]*\n?/, (m) => {
      shebang = m.replace(/^\s*/, '')
      return ''
    })
  }

  const head = stripped.split('\n').slice(0, 20).join('\n')
  if (hasNotice(head)) {
    return { content: shebang + stripped, added: false, stripped: duplicated }
  }
  return { content: shebang + HEADER + '\n' + stripped, added: true, stripped: duplicated }
}

async function main() {
  const files = []
  for (const root of ROOTS) files.push(...await collect(join(REPO_ROOT, root)))

  let added = 0
  let skipped = 0
  let deduped = 0
  for (const file of files) {
    const original = await readFile(file, 'utf8')
    const { content, added: didAdd, stripped: didStrip } = normalizeLicense(original)
    if (content === original) {
      skipped += 1
      continue
    }
    await writeFile(file, content, 'utf8')
    if (didAdd) added += 1
    if (didStrip) deduped += 1
    if (didAdd || didStrip) console.log(`[license] ~ ${file.replace(REPO_ROOT + '\\', '')}${didStrip ? ' (deduped)' : ''}`)
  }
  console.log(`[license] done: ${added} header added, ${deduped} deduped, ${skipped} untouched`)
}

main().catch((error) => {
  console.error('[license] failed:', error)
  process.exitCode = 1
})
