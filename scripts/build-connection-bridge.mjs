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
 * build-connection-bridge.mjs
 *
 * Bundles scripts/dsh-bridge/connection-entry.ts (plus its imports
 * bridge-api-client.ts, bridge-rpc.ts) into a standalone custom replacement for
 * the DeepSeek Harness "dsh-client-connection" extension plugin bundle, wrapped
 * in the loader's closure format:
 *
 *   window.__ModuleLoader__.load({
 *     id: "@deepseek-ai/dsh-client-connection",
 *     factory: (require) => {
 *       var module = { exports: {} };
 *       var exports = module.exports;
 *       ...bundle body...
 *       return module.exports;
 *     }
 *   });
 *
 * The banner/footer are byte-copies of the wrapper found in the original
 * bundle (public/dsh-web/plugins/@deepseek-ai/dsh-client-connection/client.js,
 * lines 1-5 and 10208-10210) and of the tsdown preset that produced it
 * (packages/client/tsdown.client.ts, clientConfig outputOptions). esbuild's
 * build() API has no `intro` option, so the tsdown intro text (var
 * module / var exports) is folded into the banner.
 *
 * Bare specifiers (@deepseek-ai/dsh-host-apiproxy/*, @dsh-bridge/*, zod) are
 * mapped by an onResolve plugin to compiled harness files; everything is
 * inlined (zod 4.4.3 is embedded, mirroring the original 349 KB standalone
 * bundle). Any other bare import fails the build loudly.
 *
 * Run: node scripts/build-connection-bridge.mjs   (from the repo root)
 */
import { build } from 'esbuild'
import { existsSync, statSync } from 'node:fs'

const REPO_ROOT = 'F:/dsh/dsh-in-web'
const HARNESS_ROOT = 'F:/dsh/deepseek-harness'

const ENTRY = `${REPO_ROOT}/scripts/dsh-bridge/connection-entry.ts`
const OUTFILE = `${REPO_ROOT}/public/dsh-web/plugins/@deepseek-ai/dsh-client-connection/client.js`

// Compiled harness sources the TS files import (all plain ESM .js with relative
// imports and no non-zod external deps).
const API_PROXY_LIB = `${HARNESS_ROOT}/packages/host/apiproxy/lib/types`
const CONNECTION_LIB = `${HARNESS_ROOT}/packages/client/connection/lib/types`
const HARNESS_NODE_MODULES = `${HARNESS_ROOT}/node_modules`
const ZOD_INDEX = `${HARNESS_NODE_MODULES}/zod/index.js` // zod 4.4.3 ESM entry (exports "." -> import "./index.js")

const PLUGIN_ID = '@deepseek-ai/dsh-client-connection'

// ---------------------------------------------------------------------------
// Guard: the TS sources are written by a parallel task and may not exist yet.
// ---------------------------------------------------------------------------
if (!existsSync(ENTRY)) {
  console.error(`[build-connection-bridge] entry not found: ${ENTRY}`)
  console.error('[build-connection-bridge] the dsh-bridge TS sources are being written by a parallel task; re-run once they exist.')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Pre-agreed module map (esbuild plugin, not the `alias` option — the wildcard
// `@deepseek-ai/dsh-host-apiproxy/api/*` rule needs onResolve).
// ---------------------------------------------------------------------------
function mapSpecifier(specifier) {
  if (specifier === '@deepseek-ai/dsh-host-apiproxy/client') return `${API_PROXY_LIB}/fetch/client.js`
  if (specifier === '@deepseek-ai/dsh-host-apiproxy/api') return `${API_PROXY_LIB}/api/index.js`
  if (specifier.startsWith('@deepseek-ai/dsh-host-apiproxy/api/')) {
    // Generic rule: strip the prefix -> lib/types/api/<sub>.js (append .js if missing).
    let sub = specifier.slice('@deepseek-ai/dsh-host-apiproxy/api/'.length)
    if (!sub.endsWith('.js')) sub += '.js'
    return `${API_PROXY_LIB}/api/${sub}`
  }
  if (specifier === '@dsh-bridge/connection-controller') return `${CONNECTION_LIB}/client/connection.js`
  if (specifier === '@dsh-bridge/loopback-hostname') return `${CONNECTION_LIB}/loopback-hostname.js`
  return null
}

/** Pin zod (+ any zod/* subpath) to the harness node_modules copy (4.4.3). */
function resolveZod(specifier) {
  if (specifier === 'zod') return ZOD_INDEX
  const base = `${HARNESS_NODE_MODULES}/zod/${specifier.slice('zod/'.length)}`
  if (existsSync(`${base}.js`)) return `${base}.js`
  if (existsSync(`${base}/index.js`)) return `${base}/index.js`
  return base
}

const resolvePlugin = {
  name: 'dsh-bridge-resolve',
  setup(build) {
    build.onResolve({ filter: /^(@deepseek-ai\/dsh-host-apiproxy|@dsh-bridge)(\/|$)/ }, (args) => {
      const resolved = mapSpecifier(args.path)
      if (!resolved) {
        return {
          errors: [{
            text: `unmapped specifier "${args.path}" (imported from ${args.importer}); update mapSpecifier in build-connection-bridge.mjs`,
          }],
        }
      }
      return { path: resolved }
    })
    // zod is the only real external dependency of the graph; bundle it in,
    // exactly like the original client.js embeds zod/v4/core/*.
    build.onResolve({ filter: /^zod(\/|$)/ }, (args) => ({ path: resolveZod(args.path) }))
    // Anything else bare (not relative, not mapped above) is a contract
    // violation — fail loudly instead of emitting a runtime require().
    // The entry point itself is an absolute path (F:/...), not a bare import:
    // esbuild reports it with args.kind === 'entry-point', so let it through.
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.kind === 'entry-point') return undefined
      return {
        errors: [{
          text: `unexpected bare import "${args.path}" (imported from ${args.importer}); the connection-bridge graph may only use relative specifiers, the mapped @deepseek-ai/dsh-host-apiproxy + @dsh-bridge specifiers, and zod`,
        }],
      }
    })
  },
}

// ---------------------------------------------------------------------------
// Loader closure — exact text copied from the original bundle:
//   line 1-5:    window.__ModuleLoader__.load({ ... var exports = module.exports;
//   line 10208:  return module.exports;  }  });
// (the rolldown-generated "Object.defineProperty(exports, Symbol.toStringTag…)"
// interop line is not part of the tsdown banner/footer, so it is not
// reproduced; esbuild emits its own cjs interop instead.)
//
// NOTE: esbuild's build() API has no `intro` option (transform-only), so the
// tsdown intro text (`var module`/`var exports`) is folded into the banner —
// it still lands verbatim between the factory opening and the bundle body.
// ---------------------------------------------------------------------------
const banner = `window.__ModuleLoader__.load({
\tid: "${PLUGIN_ID}",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
`
const footer = `\t\treturn module.exports;
\t}
});
`

// ---------------------------------------------------------------------------
// esbuild options — mirrors tsdown.client.ts clientConfig:
// format cjs, platform browser, banner/intro/footer, and the env defines.
// ---------------------------------------------------------------------------
const options = {
  entryPoints: [ENTRY],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  outfile: OUTFILE,
  banner: { js: banner },
  footer: { js: footer },
  // Same node-idiom env substitutions the original tsdown config applies, so no
  // bundle code ever dereferences process/import.meta at runtime.
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
  console.log(`[build-connection-bridge] input  (${Object.keys(result.metafile.inputs).length} files) = ${inputBytes} bytes`)
  console.log(`[build-connection-bridge] output ${OUTFILE} = ${outputBytes} bytes`)
} catch (error) {
  console.error('[build-connection-bridge] build failed:', error.message ?? error)
  process.exit(1)
}
