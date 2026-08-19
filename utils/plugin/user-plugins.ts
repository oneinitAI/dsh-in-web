/**
 * 用户插件管理 —— side panel「插件」页的数据层。
 *
 * 「插件」页让用户粘贴/选择 dsh client 插件 bundle（格式与官方 client.js 相同：
 * `window.__ModuleLoader__.load({ id, factory })`，如 @oneinitai/dsh-settings-plus
 * 的 lib/client.js）。插件存两份：
 *  - chrome.storage.local（key: dsh-user-plugins）—— 权威持久层；
 *  - localStorage（同 key）—— dsh iframe 与 side panel 同源（chrome-extension://），
 *    dsh-web/user-plugins.js 在 boot 前同步读它把插件追加进 __DSH_BOOT__.entries。
 *
 * 双写保持一致；读时 chrome.storage 优先，localStorage 仅作回退。
 * 纯函数（extractPluginId / isPluginBundle / buildUserPluginEntry）与存储分离，可单测。
 */

export interface UserPlugin {
  /** 插件 id，如 '@oneinitai/dsh-settings-plus'（与 bundle 内 id 一致） */
  id: string
  /** bundle 源码（完整的 `window.__ModuleLoader__.load({...})` 脚本） */
  code: string
  /** 添加时间（ms 时间戳） */
  addedAt: number
}

export const USER_PLUGINS_KEY = 'dsh-user-plugins'

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

/**
 * 把一个用户插件构建成追加到 __DSH_BOOT__.entries 的 entry 行。
 * url 由调用方注入（真实环境用 URL.createObjectURL(new Blob([code]))；测试注入假实现）。
 * @param plugin - 用户插件。
 * @param createUrl - code → blob/data URL 的转换函数。
 * @returns entry 行；id 非法或 createUrl 失败时返回 null。
 */
export function buildUserPluginEntry(
  plugin: UserPlugin,
  createUrl: (code: string) => string,
): { id: string; url: string; rev: string; immediately: boolean } | null {
  if (!plugin || typeof plugin.id !== 'string' || typeof plugin.code !== 'string') return null
  if (plugin.id.trim() === '' || plugin.code.trim() === '') return null
  let url: string
  try {
    url = createUrl(plugin.code)
  } catch {
    return null
  }
  if (!url) return null
  // rev 用字符串即可（parseBootManifest 只要求 string）；immediately=false 走普通 arrival。
  return { id: plugin.id, url, rev: 'user', immediately: false }
}

/** 从 chrome.storage / localStorage 读取已安装插件（返回新数组，未安装返回 []） */
export async function readUserPlugins(): Promise<UserPlugin[]> {
  try {
    const stored = await chrome.storage.local.get(USER_PLUGINS_KEY)
    const list = stored[USER_PLUGINS_KEY]
    if (Array.isArray(list)) {
      const valid = list.filter(isUserPlugin)
      // 回填 localStorage（dsh iframe 同步读取依赖它；首装时可能缺失）
      try {
        localStorage.setItem(USER_PLUGINS_KEY, JSON.stringify(valid))
      } catch {
        // 非扩展环境忽略
      }
      return valid
    }
  } catch {
    // chrome.storage 不可用（测试环境）→ 回落 localStorage
  }
  try {
    const raw = localStorage.getItem(USER_PLUGINS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter(isUserPlugin) : []
  } catch {
    return []
  }
}

/** 双写持久化（chrome.storage 权威 + localStorage 镜像）；返回是否成功 */
export async function writeUserPlugins(plugins: UserPlugin[]): Promise<boolean> {
  const clean = plugins.filter(isUserPlugin)
  let ok = false
  try {
    await chrome.storage.local.set({ [USER_PLUGINS_KEY]: clean })
    ok = true
  } catch {
    // 非扩展环境
  }
  try {
    localStorage.setItem(USER_PLUGINS_KEY, JSON.stringify(clean))
  } catch {
    // 忽略（无 localStorage 环境）
  }
  return ok
}

/** 添加插件（按 id 去重，覆盖旧版本）；返回最终列表 */
export async function addUserPlugin(id: string, code: string, now = Date.now()): Promise<UserPlugin[]> {
  const existing = await readUserPlugins()
  const next = [...existing.filter((p) => p.id !== id), { id, code, addedAt: now }]
  await writeUserPlugins(next)
  return next
}

/** 移除插件；返回最终列表 */
export async function removeUserPlugin(id: string): Promise<UserPlugin[]> {
  const existing = await readUserPlugins()
  const next = existing.filter((p) => p.id !== id)
  await writeUserPlugins(next)
  return next
}

/** 类型守卫：UserPlugin 字段形状校验 */
function isUserPlugin(value: unknown): value is UserPlugin {
  if (typeof value !== 'object' || value === null) return false
  const o = value as Record<string, unknown>
  return typeof o.id === 'string' && typeof o.code === 'string'
}
