/**
 * patch-dsh-web.mjs —— 对同步来的官方 dsh-web 产物做 CSP 兼容 patch。
 *
 * 背景：dsh 官方 shell 是 Electron 产物（无 CSP），index bundle 模块顶层就有
 * `const E3 = new Function("ctx","expr", ...)`（Cordis 的 jsExpr 表达式求值器）。
 * 在 MV3 扩展页面里，默认 CSP（script-src 'self'; object-src 'self'）禁止
 * unsafe-eval → 模块加载瞬间抛 EvalError → boot 链断裂 → side panel 白屏。
 *
 * 修复：把顶层 `new Function` 替换为安全 stub。已确认全部 39 个插件 bundle
 * 与 vendor 均不含 `__jsExpr` 字面量，E3 在运行时永远不会被真正调用，
 * 替换为零功能损失（若未来出现 __jsExpr 配置会抛出明确错误）。
 *
 * 用法：在 import-dsh.mjs 拷贝 dsh-web 之后、boot-manifest 生成前后调用。
 * 幂等：已 patch 过的文件再次运行不会重复匹配。
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const E3_ORIGINAL = 'const E3=new Function("ctx","expr",`\n  with (ctx) {\n    return eval(expr)\n  }\n`);'
const E3_PATCHED = 'const E3=(ctx,expr)=>{throw new Error("dsh-in-web: jsExpr disabled (CSP no unsafe-eval)")};'

/** Patch one JS file; returns true if changed. */
export function patchE3(fileContent) {
  if (!fileContent.includes(E3_ORIGINAL)) return false
  const patched = fileContent.replace(E3_ORIGINAL, E3_PATCHED)
  if (patched === fileContent) return false
  return patched
}

/** Patch every assets/index-*.js under the dsh-web root. */
export async function patchDshWeb(dshWebDir) {
  const assetsDir = join(dshWebDir, 'assets')
  const files = await readdir(assetsDir).catch(() => [])
  const targets = files.filter((f) => f.startsWith('index-') && f.endsWith('.js'))
  let changed = 0
  for (const name of targets) {
    const full = join(assetsDir, name)
    const content = await readFile(full, 'utf8')
    const patched = patchE3(content)
    if (patched) {
      await writeFile(full, patched, 'utf8')
      changed += 1
      console.log(`[patch-dsh-web] patched ${full} (E3 jsExpr stub)`)
    }
  }
  if (changed === 0) console.log('[patch-dsh-web] no index bundle needed patching (already patched or none found)')
  return changed
}

// Standalone run: node scripts/patch-dsh-web.mjs
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(process.platform === 'win32' ? '\\' : '/').pop())
if (isMain) {
  const root = process.cwd()
  patchDshWeb(join(root, 'public', 'dsh-web')).catch((e) => {
    console.error('[patch-dsh-web] failed:', e)
    process.exitCode = 1
  })
}