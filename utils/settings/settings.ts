/**
 * 插件设置 —— chrome.storage.local 持久化，全端（SW / content script / Side Panel）共享。
 * 读：getSettings()（始终与默认值合并，防字段缺失）；写：patchSettings(partial)。
 * 变更订阅：subscribeSettings(cb)，storage.onChanged 驱动，任何端写入都会通知。
 * 纯类型 + chrome.storage API，可在四端安全 import。
 */

export interface DshSettings {
  /** 页面注入开关：off = 普通对话；on = 页面内嵌 dsh 风格全功能 UI */
  dshMode: 'off' | 'on'
  /** 聊天：思考模式（reasoning） */
  reasoning: boolean
  /** 聊天：联网搜索 */
  search: boolean
  /** 聊天：复用会话（多轮连续）；false 则每轮新建 chat_session */
  persistSession: boolean
  /** UI：暗色主题 */
  darkTheme: boolean
  /** UI：字号（px） */
  fontSize: number
}

export const DEFAULT_SETTINGS: DshSettings = {
  dshMode: 'off',
  reasoning: true,
  search: false,
  persistSession: false,
  darkTheme: true,
  fontSize: 13,
}

const STORAGE_KEY = 'dsh-settings'

/** 从原始存储值合并且逐字段校验类型；非法字段回落默认值 */
export function normalizeSettings(raw: unknown): DshSettings {
  const o = (raw ?? {}) as Record<string, unknown>
  return {
    dshMode: o.dshMode === 'on' ? 'on' : 'off',
    reasoning: typeof o.reasoning === 'boolean' ? o.reasoning : DEFAULT_SETTINGS.reasoning,
    search: typeof o.search === 'boolean' ? o.search : DEFAULT_SETTINGS.search,
    persistSession:
      typeof o.persistSession === 'boolean' ? o.persistSession : DEFAULT_SETTINGS.persistSession,
    darkTheme: typeof o.darkTheme === 'boolean' ? o.darkTheme : DEFAULT_SETTINGS.darkTheme,
    fontSize:
      typeof o.fontSize === 'number' && o.fontSize >= 10 && o.fontSize <= 20
        ? o.fontSize
        : DEFAULT_SETTINGS.fontSize,
  }
}

/** 读取当前设置（始终与默认值合并） */
export async function getSettings(): Promise<DshSettings> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY)
    return normalizeSettings(stored[STORAGE_KEY])
  } catch {
    // 非扩展环境（如测试无 chrome.storage）回落默认值
    return { ...DEFAULT_SETTINGS }
  }
}

/** 部分更新并持久化；返回合并后的完整设置 */
export async function patchSettings(patch: Partial<DshSettings>): Promise<DshSettings> {
  const merged = { ...(await getSettings()), ...patch }
  const normalized = normalizeSettings(merged)
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: normalized })
  } catch {
    // 忽略写失败（非扩展环境）
  }
  return normalized
}

type SettingsListener = (settings: DshSettings) => void

const listeners = new Set<SettingsListener>()

/** 订阅设置变更（storage.onChanged 驱动）；返回取消函数 */
export function subscribeSettings(cb: SettingsListener): () => void {
  listeners.add(cb)
  if (listeners.size === 1) {
    // 首个订阅者挂上 storage 监听（幂等）
    try {
      chrome.storage.onChanged.addListener(onStorageChanged)
    } catch {
      // 非扩展环境：静默
    }
  }
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0) {
      try {
        chrome.storage.onChanged.removeListener(onStorageChanged)
      } catch {
        // 忽略
      }
    }
  }
}

function onStorageChanged(changes: Record<string, chrome.storage.StorageChange>, area: string): void {
  if (area !== 'local' || !(STORAGE_KEY in changes)) return
  const next = normalizeSettings(changes[STORAGE_KEY]?.newValue)
  for (const cb of listeners) {
    try {
      cb(next)
    } catch {
      // 监听器异常不影响其他订阅者
    }
  }
}
