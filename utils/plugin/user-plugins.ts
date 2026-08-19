/**
 * 用户插件 —— side panel「插件」页的数据层。
 *
 * MV3 打包扩展的 extension_pages CSP 被 Chrome 锁定为最小 `script-src 'self'`，
 * blob:/data:/unsafe-eval 一律被拒（manifest 校验即失败），运行时动态注入用户
 * 代码不可行。因此用户插件改为**构建期合并**：
 *
 *   仓库根 user-plugins/<bundle>.js
 *     └─ import-dsh.mjs 扫描 → 复制为 dsh-web/user-plugins/<id>.js（扩展包内静态文件）
 *          └─ 追加进 __DSH_BOOT__.entries（url: ./user-plugins/<id>.js?rev=…，
 *             与官方 client bundle 同走 'self' 相对路径）
 *               └─ 生成 dsh-web/user-plugins.json 清单（本模块读取展示）
 *
 * 添加插件 = 把官方同格式的 bundle（window.__ModuleLoader__.load({ id, factory })，
 * 如 @oneinitai/dsh-settings-plus 的 lib/client.js）放入 user-plugins/ 目录，
 * 重新运行 `pnpm exec import-dsh` + `pnpm build` 并重新加载扩展后生效。
 * 本模块只负责：校验 bundle 格式 / 提取插件 id / 解析内置清单。
 */

export interface UserPluginInfo {
  /** 插件 id，如 '@oneinitai/dsh-settings-plus' */
  id: string
  /** 扩展包内相对路径，如 user-plugins/@oneinitai/dsh-settings-plus.js */
  file: string
  /** 内容 hash（前 8 位） */
  rev: string
  /** 来源文件名（仓库 user-plugins/ 下的原始文件名） */
  source: string
}

/** 从 bundle 源码提取插件 id（load({ id: '...' }) 或双引号） */
export function extractPluginId(code: string): string | null {
  if (typeof code !== 'string') return null
  // window.__ModuleLoader__.load({ id: 'xxx', factory: ... }) —— 允许空白/单双引号
  const match = /load\(\s*\{\s*id\s*:\s*['"]([^'"]+)['"]/.exec(code)
  return match?.[1] ?? null
}

/** 校验 bundle 是否形如合法插件（含 __ModuleLoader__.load 调用与 id） */
export function isPluginBundle(code: string): boolean {
  if (typeof code !== 'string') return false
  if (!code.includes('__ModuleLoader__.load')) return false
  return extractPluginId(code) !== null
}

/** 解析 user-plugins.json 清单文本（纯函数，便于测试） */
export function parseUserPluginsManifest(text: string): UserPluginInfo[] {
  try {
    const parsed = JSON.parse(text) as { plugins?: unknown }
    if (!parsed || !Array.isArray(parsed.plugins)) return []
    return parsed.plugins
      .filter(isUserPluginInfo)
      .sort((a, b) => a.id.localeCompare(b.id))
  } catch {
    return []
  }
}

/**
 * 读取扩展包内 user-plugins.json（由 import-dsh.mjs 生成），返回已内置的用户插件。
 * 旧产物（未重新构建）返回 []。
 */
export async function listBuiltInUserPlugins(): Promise<UserPluginInfo[]> {
  try {
    const url = chrome.runtime.getURL('dsh-web/user-plugins.json')
    const res = await fetch(url)
    if (!res.ok) return []
    const text = await res.text()
    return parseUserPluginsManifest(text)
  } catch {
    return []
  }
}

/** 类型守卫：UserPluginInfo 字段形状校验 */
function isUserPluginInfo(value: unknown): value is UserPluginInfo {
  if (typeof value !== 'object' || value === null) return false
  const o = value as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.file === 'string' &&
    typeof o.rev === 'string' &&
    typeof o.source === 'string'
  )
}
