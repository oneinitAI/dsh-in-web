/**
 * user-plugins.ts —— 用户插件管理（「插件」页数据层）的 TDD 测试。
 * mock chrome.storage.local + localStorage 覆盖：id 提取 / bundle 校验 /
 * entry 构建 / 双写持久化 / 添加与移除。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  addUserPlugin,
  buildUserPluginEntry,
  extractPluginId,
  isPluginBundle,
  readUserPlugins,
  removeUserPlugin,
  USER_PLUGINS_KEY,
  writeUserPlugins,
  type UserPlugin,
} from '../../utils/plugin/user-plugins'

const BUNDLE = `window.__ModuleLoader__.load({ id: '@oneinitai/dsh-settings-plus', factory: (require) => { var module = { exports: {} }; return module.exports; } })`

/** 构造 chrome.storage mock（与真实 API 形状一致）+ 绑定到 globalThis.chrome */
function mockChromeStorage() {
  const store = new Map<string, unknown>()
  const storage = {
    local: {
      async get(keys: string | string[] | Record<string, unknown>) {
        if (typeof keys === 'string') return { [keys]: store.get(keys) }
        if (Array.isArray(keys)) {
          const out: Record<string, unknown> = {}
          for (const k of keys) out[k] = store.get(k)
          return out
        }
        const out: Record<string, unknown> = {}
        for (const [k, def] of Object.entries(keys)) out[k] = store.get(k) ?? def
        return out
      },
      async set(items: Record<string, unknown>) {
        for (const [k, v] of Object.entries(items)) store.set(k, v)
      },
      async remove(keys: string | string[]) {
        for (const k of typeof keys === 'string' ? [keys] : keys) store.delete(k)
      },
    },
    onChanged: { addListener: () => {}, removeListener: () => {} },
  }
  ;(globalThis as Record<string, unknown>).chrome = { storage }
  return { store, storage }
}

/** 构造内存版 localStorage（node 测试环境无此全局）并挂到 globalThis */
function mockLocalStorage() {
  let data = new Map<string, string>()
  const storage = {
    get length() {
      return data.size
    },
    clear() {
      data.clear()
    },
    getItem(key: string) {
      return data.has(key) ? data.get(key)! : null
    },
    key(i: number) {
      return [...data.keys()][i] ?? null
    },
    removeItem(key: string) {
      data.delete(key)
    },
    setItem(key: string, value: string) {
      data.set(key, String(value))
    },
  }
  ;(globalThis as Record<string, unknown>).localStorage = storage
  return storage
}

describe('extractPluginId', () => {
  it('提取 load({ id: ... }) 中的插件 id（单引号）', () => {
    expect(extractPluginId(BUNDLE)).toBe('@oneinitai/dsh-settings-plus')
  })

  it('支持双引号与任意空白', () => {
    expect(extractPluginId(`window.__ModuleLoader__.load( {  id:  "a/b" , factory: null })`)).toBe('a/b')
  })

  it('无 load({id}) 时返回 null', () => {
    expect(extractPluginId('const x = 1')).toBeNull()
    expect(extractPluginId('')).toBeNull()
    expect(extractPluginId(null as unknown as string)).toBeNull()
  })
})

describe('isPluginBundle', () => {
  it('含 __ModuleLoader__.load 且带 id 视为合法', () => {
    expect(isPluginBundle(BUNDLE)).toBe(true)
  })

  it('缺 __ModuleLoader__.load 或缺 id 视为非法', () => {
    expect(isPluginBundle('const x = 1')).toBe(false)
    expect(isPluginBundle('window.__ModuleLoader__.load({ factory: null })')).toBe(false)
    expect(isPluginBundle('')).toBe(false)
  })
})

describe('buildUserPluginEntry', () => {
  const plugin: UserPlugin = { id: 'p/a', code: 'code-here', addedAt: 1 }
  const createUrl = (code: string) => `blob:mock-${code.length}`

  it('构建 entry 行（rev=user, immediately=false）', () => {
    expect(buildUserPluginEntry(plugin, createUrl)).toEqual({
      id: 'p/a',
      url: 'blob:mock-9',
      rev: 'user',
      immediately: false,
    })
  })

  it('id 空白/缺字段返回 null', () => {
    expect(buildUserPluginEntry({ ...plugin, id: '  ' }, createUrl)).toBeNull()
    expect(buildUserPluginEntry({ id: 'x', code: '', addedAt: 0 }, createUrl)).toBeNull()
    expect(buildUserPluginEntry(null as unknown as UserPlugin, createUrl)).toBeNull()
  })

  it('createUrl 抛错返回 null', () => {
    expect(buildUserPluginEntry(plugin, () => { throw new Error('no blob') })).toBeNull()
  })
})

describe('用户插件持久化（chrome.storage + localStorage 双写）', () => {
  beforeEach(() => {
    mockLocalStorage()
  })

  it('writeUserPlugins 双写：chrome.storage 与 localStorage 都有数据', async () => {
    mockChromeStorage()
    const plugins: UserPlugin[] = [
      { id: 'a', code: BUNDLE, addedAt: 1 },
      { id: 'b', code: BUNDLE, addedAt: 2 },
    ]
    await writeUserPlugins(plugins)

    const stored = await chrome.storage.local.get(USER_PLUGINS_KEY)
    expect((stored[USER_PLUGINS_KEY] as UserPlugin[]).map((p) => p.id)).toEqual(['a', 'b'])
    expect(JSON.parse(localStorage.getItem(USER_PLUGINS_KEY) ?? '[]').map((p: UserPlugin) => p.id))
      .toEqual(['a', 'b'])
  })

  it('readUserPlugins 回填 localStorage（chrome 有数据、localStorage 为空时）', async () => {
    mockChromeStorage()
    await chrome.storage.local.set({ [USER_PLUGINS_KEY]: [{ id: 'x', code: BUNDLE, addedAt: 9 }] })
    const list = await readUserPlugins()
    expect(list.map((p) => p.id)).toEqual(['x'])
    expect(localStorage.getItem(USER_PLUGINS_KEY)).toContain('"x"')
  })

  it('chrome.storage 不可用时回落 localStorage', async () => {
    ;(globalThis as Record<string, unknown>).chrome = undefined
    localStorage.setItem(USER_PLUGINS_KEY, JSON.stringify([{ id: 'y', code: BUNDLE, addedAt: 3 }]))
    const list = await readUserPlugins()
    expect(list.map((p) => p.id)).toEqual(['y'])
  })

  it('addUserPlugin 按 id 去重覆盖旧版本', async () => {
    mockChromeStorage()
    await addUserPlugin('p/dup', 'v1', 100)
    await addUserPlugin('p/dup', 'v2', 200)
    const list = await readUserPlugins()
    expect(list).toHaveLength(1)
    expect(list[0]?.code).toBe('v2')
    expect(list[0]?.addedAt).toBe(200)
  })

  it('removeUserPlugin 移除指定插件', async () => {
    mockChromeStorage()
    await addUserPlugin('a', BUNDLE, 1)
    await addUserPlugin('b', BUNDLE, 2)
    const after = await removeUserPlugin('a')
    expect(after.map((p) => p.id)).toEqual(['b'])
    const stored = await chrome.storage.local.get(USER_PLUGINS_KEY)
    expect((stored[USER_PLUGINS_KEY] as UserPlugin[]).map((p) => p.id)).toEqual(['b'])
  })

  it('过滤非法形状的存储数据（缺字段条目丢弃）', async () => {
    mockChromeStorage()
    await chrome.storage.local.set({
      [USER_PLUGINS_KEY]: [{ id: 'ok', code: BUNDLE, addedAt: 1 }, { id: 'bad' }],
    })
    const list = await readUserPlugins()
    expect(list.map((p) => p.id)).toEqual(['ok'])
  })
})
