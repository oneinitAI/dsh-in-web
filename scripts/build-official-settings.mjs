#!/usr/bin/env node
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
 * build-official-settings.mjs
 *
 * Bundles the official DeepSeek Harness user-settings seam into one
 * browser-safe script that the dsh-in-web Service Worker loads via
 * `importScripts(chrome.runtime.getURL('dsh-official/settings-runtime.js'))`.
 *
 * Included graph (all pure ESM JS, no Node APIs — verified: no process/Buffer/
 * require/node: references):
 *
 *   - @deepseek-ai/cordis      (Context / Service; root Context is fully
 *                              self-contained: fiber/registry/events/logger)
 *   - @deepseek-ai/cosmokit    (cordis/schemastery dependency)
 *   - @deepseek-ai/schemastery (pure JS ESM schema validator)
 *   - @deepseek-ai/dsh-settings official source (SettingsProvider abstract
 *     class + redaction + conflict semantics)
 *
 * Output format is an IIFE assigned to the global `DshOfficialSettings`
 * (classic script global, readable from the classic Service Worker's scope).
 *
 * Run: node scripts/build-official-settings.mjs   (from the repo root)
 */
import { build } from 'esbuild'
import { existsSync, statSync } from 'node:fs'

const REPO_ROOT = 'F:/dsh/dsh-in-web'
const HARNESS_ROOT = 'F:/dsh/deepseek-harness'

const ENTRY = `${REPO_ROOT}/scripts/dsh-official-settings/entry.ts`
const OUTFILE = `${REPO_ROOT}/public/dsh-official/settings-runtime.js`

const MODULE_MAP = {
  '@deepseek-ai/cordis': `${HARNESS_ROOT}/node_modules/@deepseek-ai/cordis/lib/index.js`,
  '@deepseek-ai/cosmokit': `${HARNESS_ROOT}/node_modules/@deepseek-ai/cosmokit/lib/index.js`,
  '@deepseek-ai/schemastery': `${HARNESS_ROOT}/node_modules/@deepseek-ai/schemastery/lib/index.mjs`,
  // Official source of truth (esbuild resolves the relative ./redact.ts and
  // ./types.ts imports itself; both only type-import schemastery/dsh-brand).
  '@deepseek-ai/dsh-settings': `${HARNESS_ROOT}/packages/settings/settings/src/index.ts`,
  // Type-only in the settings source graph, mapped anyway for safety.
  '@deepseek-ai/dsh-brand': `${HARNESS_ROOT}/node_modules/@deepseek-ai/dsh-brand/lib/index.js`,
}

if (!existsSync(ENTRY)) {
  console.error(`[build-official-settings] entry not found: ${ENTRY}`)
  process.exit(1)
}

const resolvePlugin = {
  name: 'dsh-official-settings-resolve',
  setup(build) {
    build.onResolve({ filter: /^@deepseek-ai\/(cordis|cosmokit|schemastery|dsh-settings|dsh-brand)$/ }, (args) => {
      const resolved = MODULE_MAP[args.path]
      if (!resolved) {
        return {
          errors: [{
            text: `unmapped specifier "${args.path}" (imported from ${args.importer}); update MODULE_MAP in build-official-settings.mjs`,
          }],
        }
      }
      return { path: resolved }
    })
    // Anything else bare (not relative, not mapped) is a contract violation —
    // fail loudly instead of emitting a runtime require().
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.kind === 'entry-point') return undefined
      return {
        errors: [{
          text: `unexpected bare import "${args.path}" (imported from ${args.importer}); the official-settings graph may only use relative specifiers and the mapped @deepseek-ai/* modules`,
        }],
      }
    })
  },
}

const options = {
  entryPoints: [ENTRY],
  bundle: true,
  format: 'iife',
  globalName: 'DshOfficialSettings',
  platform: 'browser',
  target: 'es2022',
  outfile: OUTFILE,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.MODE': JSON.stringify('production'),
    'import.meta.env': JSON.stringify({ MODE: 'production' }),
  },
  plugins: [resolvePlugin],
  metafile: true,
  logLevel: 'info',
}

try {
  const result = await build(options)
  const inputBytes = Object.values(result.metafile.inputs).reduce((total, info) => total + info.bytes, 0)
  const outputBytes = statSync(OUTFILE).size
  console.log(`[build-official-settings] input  (${Object.keys(result.metafile.inputs).length} files) = ${inputBytes} bytes`)
  console.log(`[build-official-settings] output ${OUTFILE} = ${outputBytes} bytes`)
} catch (error) {
  console.error('[build-official-settings] build failed:', error.message ?? error)
  process.exit(1)
}
