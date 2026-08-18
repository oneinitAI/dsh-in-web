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
      console.log('[skip] @deepseek-ai/dsh-client-connection (replaced by custom bridge bundle)')
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

  // 4. Emit the boot manifest as a plain script (CSP-safe: no inline code).
  const graphRev = shortHash(JSON.stringify(entries.map(e => e.id + e.rev)))
  const manifest = `window.__DSH_BOOT__ = ${JSON.stringify({ rev: graphRev, entries }, null, 2)};\n`
  await writeFile(join(OUT_DIR, 'boot-manifest.js'), manifest, 'utf8')
  console.log(`[import-dsh] boot-manifest.js written (${entries.length} entries, rev=${graphRev})`)

  console.log(`[import-dsh] done -> ${relative(REPO_ROOT, OUT_DIR)}`)
}

main().catch((error) => {
  console.error('[import-dsh] failed:', error)
  process.exitCode = 1
})
