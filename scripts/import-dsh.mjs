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
 * Import the dsh web frontend (shell + client plugin bundles) from a local
 * deepseek-harness checkout into public/dsh-web/.
 *
 * Produces:
 *   public/dsh-web/index.html        — shell page (absolute /assets paths rewritten
 *                                      to relative; boot-manifest script injected)
 *   public/dsh-web/assets/*          — Vite build output (JS/CSS/fonts/langs)
 *   public/dsh-web/boot-manifest.js  — sets window.__DSH_BOOT__ = { rev, entries }
 *   public/dsh-web/plugins/<id>/client.js — one closure-factory bundle per
 *                                      `dsh.client` package, URL-addressable at
 *                                      ./plugins/<id>/client.js?rev=…
 *
 * The side panel embeds dsh-web/index.html in an iframe (same extension origin),
 * so every resource reference must resolve relative to the page URL.
 *
 * Run: node scripts/import-dsh.mjs  (from the repo root)
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cp, mkdir, readFile, readdir, rm, writeFile,
} from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, sep } from 'node:path'
import { patchDshWeb } from './patch-dsh-web.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..')
const HARNESS = process.env.DSH_HARNESS ?? 'F:/dsh/deepseek-harness'
const HARNESS_PACKAGES = join(HARNESS, 'packages')
const HARNESS_DIST = join(HARNESS, 'apps', 'web', 'dist')

const OUT_DIR = join(REPO_ROOT, 'public', 'dsh-web')
const OUT_PLUGINS = join(OUT_DIR, 'plugins')

/** Rewrite absolute Vite asset references to page-relative ones. */
function rewriteHtml(html) {
  return html
    .replaceAll('"/assets/', '"./assets/')
    .replaceAll("'/assets/", "'./assets/")
    .replaceAll('"/favicon.svg"', '"./favicon.svg"')
    .replaceAll('"/manifest.webmanifest"', '"./manifest.webmanifest"')
}

/** Inject the boot-manifest script ahead of the first module script. */
function injectBootScript(html) {
  const marker = '<script type="module"'
  const at = html.indexOf(marker)
  if (at === -1) throw new Error('import-dsh: no <script type="module"> found in dist index.html')
  const boot = '<script src="./boot-manifest.js"></script>\n    '
  return html.slice(0, at) + boot + html.slice(at)
}

function shortHash(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 8)
}

/** 从 bundle 源码提取插件 id（load({ id: '...' })）。 */
function extractBundleId(content) {
  const match = /load\(\s*\{\s*id\s*:\s*['"]([^'"]+)['"]/.exec(content)
  return match ? match[1] : null
}

/** 递归收集 user-plugins/ 下的 .js 文件（scoped 包可用子目录：user-plugins/@scope/pkg.js） */
async function findUserPluginFiles(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) await findUserPluginFiles(full, out)
    else if (e.isFile() && e.name.endsWith('.js')) out.push(full)
  }
  return out
}

/**
 * 合并 user-plugins/ 目录下的用户插件 bundle 到扩展包内。
 *
 * MV3 打包扩展的 extension_pages CSP 被 Chrome 锁定为最小 `script-src 'self'`，
 * 不允许 blob:/data:/unsafe-eval —— 运行时动态注入代码不可行。因此用户插件改为
 * 构建期合并：仓库根 user-plugins/<id>.js → dsh-web/user-plugins/<id>.js，
 * 与官方 client bundle 同走 'self' 相对路径（./user-plugins/<id>.js?rev=…）
 * 经 <script src> 加载，CSP 完全合规。
 *
 * 同时生成 dsh-web/user-plugins.json 清单（side panel「插件」页读取展示）。
 */
async function collectUserPlugins(outDir) {
  const srcDir = join(REPO_ROOT, 'user-plugins')
  const files = await findUserPluginFiles(srcDir)
  files.sort((a, b) => a.localeCompare(b))

  const entries = []
  const list = []
  for (const src of files) {
    const content = await readFile(src, 'utf8')
    const id = extractBundleId(content)
    if (!id) {
      console.warn(`[import-dsh] WARN user-plugins/${relative(srcDir, src)}: no load({ id }) found, skipped`)
      continue
    }
    const rev = shortHash(content)
    const dest = join(outDir, 'user-plugins', `${id}.js`)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, content, 'utf8')
    entries.push({ id, url: `./user-plugins/${id}.js?rev=${rev}`, rev, inject: [], immediately: false })
    list.push({ id, file: `user-plugins/${id}.js`, rev, source: relative(srcDir, src) })
    console.log(`[import-dsh] user plugin ${id} (${rev}) <- user-plugins/${relative(srcDir, src)}`)
  }

  if (list.length > 0) {
    await writeFile(join(outDir, 'user-plugins.json'), JSON.stringify({ plugins: list }, null, 2), 'utf8')
  }
  return entries
}

/** Recursively find package.json files under a directory, skipping node_modules. */
async function findPackageJsonDirs(root) {
  const out = []
  async function walk(dir, depth) {
    if (depth > 3) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        const pkgPath = join(full, 'package.json')
        try {
          await readFile(pkgPath, 'utf8')
          out.push(full)
        } catch {
          await walk(full, depth + 1)
        }
      }
    }
  }
  await walk(root, 0)
  return out
}

async function main() {
  // 1. Copy the Vite dist (shell) verbatim.
  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(OUT_PLUGINS, { recursive: true })
  await cp(HARNESS_DIST, OUT_DIR, { recursive: true, verbatimSymlinks: true })
  console.log(`[import-dsh] copied shell dist -> ${relative(REPO_ROOT, OUT_DIR)}`)

  // 2. Rewrite index.html: relative assets + boot-manifest injection.
  const indexPath = join(OUT_DIR, 'index.html')
  const html = rewriteHtml(await readFile(indexPath, 'utf8'))
  await writeFile(indexPath, injectBootScript(html), 'utf8')
  console.log('[import-dsh] rewrote index.html (relative assets + boot script)')

  // 2.1 CSP patch: replace top-level `new Function` (Cordis jsExpr) with a stub,
  // so the shell loads under MV3 extension-pages CSP (no unsafe-eval).
  await patchDshWeb(OUT_DIR)

  // 3. Scan every workspace package for a `dsh.client` declaration.
  const entries = []
  let connectionDecl = null
  const dirs = await findPackageJsonDirs(HARNESS_PACKAGES)
  for (const dir of dirs) {
    const pkgPath = join(dir, 'package.json')
    let pkg
    try {
      pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
    } catch {
      continue
    }
    const decl = pkg['dsh']?.client
    if (decl === undefined) continue
    const id = pkg.name
    if (typeof id !== 'string') continue
    if (id === '@deepseek-ai/dsh-client-connection') {
      // 官方 bundle 连本地 harness（HTTP/WebSocket），浏览器扩展不可用。
      // 自定义 bridge bundle 由 build-connection-bridge.mjs 生成（见下方 step 4）。
      // 这里仅记录其声明（inject / immediately），待官方 bundle 扫描完成后
      // 重建 bridge bundle 并登记 entry，保证 boot-manifest 含 connection 服务。
      connectionDecl = decl
      console.log('[skip] @deepseek-ai/dsh-client-connection (replaced by custom bridge bundle, rebuilt below)')
      continue
    }
    // 浏览器扩展环境不适用的插件，剔除（避免加载失败/冲突/刷屏）：
    //  - dsh-client-hmr：请求 /plugins/events dev SSE，扩展里 404 刷屏
    //  - dsh-client-ui-directory-picker-native：与 browse 版互斥注册同一
    //    single slot (conversation.hero.workspace.directoryFlow) → 冲突崩溃；
    //    浏览器环境只保留 browse 版
    if (
      id === '@deepseek-ai/dsh-client-hmr' ||
      id === '@deepseek-ai/dsh-client-ui-directory-picker-native'
    ) {
      console.log(`[skip] ${id} (browser-extension incompatible)`)
      continue
    }
    const clientPath = join(dir, 'lib', 'client.js')
    const content = await readFile(clientPath, 'utf8').catch(() => null)
    if (content === null) {
      console.warn(`[import-dsh] WARN ${id}: lib/client.js missing, skipping`)
      continue
    }
    // <id> may be scoped (@deepseek-ai/x) → nested directory under plugins/.
    const relDir = id.split('/').join(sep)
    const dest = join(OUT_PLUGINS, relDir, 'client.js')
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, content, 'utf8')
    const rev = shortHash(content)
    entries.push({
      id,
      url: `./plugins/${id}/client.js?rev=${rev}`,
      rev,
      inject: Array.isArray(decl.inject) ? decl.inject : [],
      immediately: decl.immediately === true,
    })
    console.log(`[import-dsh] bundle ${id} (${rev}, imm=${decl.immediately === true})`)
  }

  // 3.5 Rebuild the custom connection bridge bundle (official dsh-client-connection
  //     connects to a local harness over HTTP/WebSocket — unavailable in-browser;
  //     build-connection-bridge.mjs replaces it with a chrome.runtime bridge) and
  //     register it first in the manifest so dependent plugins resolve it.
  if (connectionDecl) {
    console.log('[import-dsh] building custom connection bridge bundle...')
    execFileSync(process.execPath, [join(HERE, 'build-connection-bridge.mjs')], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    })
    const bridgePath = join(OUT_PLUGINS, '@deepseek-ai', 'dsh-client-connection', 'client.js')
    const bridgeContent = await readFile(bridgePath, 'utf8').catch(() => null)
    if (bridgeContent === null) {
      throw new Error('[import-dsh] connection bridge bundle missing after build — cannot boot without connection service')
    }
    const rev = shortHash(bridgeContent)
    entries.unshift({
      id: '@deepseek-ai/dsh-client-connection',
      url: `./plugins/@deepseek-ai/dsh-client-connection/client.js?rev=${rev}`,
      rev,
      inject: Array.isArray(connectionDecl.inject) ? connectionDecl.inject : [],
      immediately: connectionDecl.immediately === true,
    })
    console.log(`[import-dsh] connection bridge registered (${rev}, imm=${connectionDecl.immediately === true})`)
  }

  // 4. Merge user plugins from user-plugins/ (build-time, CSP-safe) and emit
  //    the boot manifest as a plain script (CSP-safe: no inline code).
  const userEntries = await collectUserPlugins(OUT_DIR)
  const allEntries = [...entries, ...userEntries]
  const graphRev = shortHash(JSON.stringify(allEntries.map(e => e.id + e.rev)))
  const manifest = `window.__DSH_BOOT__ = ${JSON.stringify({ rev: graphRev, entries: allEntries }, null, 2)};\n`
  await writeFile(join(OUT_DIR, 'boot-manifest.js'), manifest, 'utf8')
  console.log(`[import-dsh] boot-manifest.js written (${allEntries.length} entries: ${entries.length} official + ${userEntries.length} user, rev=${graphRev})`)

  console.log(`[import-dsh] done -> ${relative(REPO_ROOT, OUT_DIR)}`)
}

main().catch((error) => {
  console.error('[import-dsh] failed:', error)
  process.exitCode = 1
})
