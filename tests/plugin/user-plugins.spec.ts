/**
 * user-plugins.ts —— 「插件」页数据层（构建期合并方案）的 TDD 测试。
 * 覆盖：id 提取 / bundle 校验 / user-plugins.json 清单解析 / 类型守卫过滤。
 * listBuiltInUserPlugins() 依赖 chrome.runtime + fetch，测试仅覆盖纯函数部分。
 */
import { describe, expect, it } from 'vitest'
import {
  extractPluginId,
  isPluginBundle,
  parseUserPluginsManifest,
  type UserPluginInfo,
} from '../../utils/plugin/user-plugins'

const BUNDLE = `window.__ModuleLoader__.load({ id: '@oneinitai/dsh-settings-plus', factory: (require) => { var module = { exports: {} }; return module.exports; } })`

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

describe('parseUserPluginsManifest', () => {
  it('解析合法清单并按 id 排序', () => {
    const text = JSON.stringify({
      plugins: [
        { id: 'z/pkg', file: 'user-plugins/z/pkg.js', rev: 'aabbccdd', source: 'z.js' },
        { id: 'a/pkg', file: 'user-plugins/a/pkg.js', rev: '11223344', source: 'a.js' },
      ],
    })
    expect(parseUserPluginsManifest(text).map((p) => p.id)).toEqual(['a/pkg', 'z/pkg'])
  })

  it('非法 JSON / 非数组 / 缺字段条目均安全处理', () => {
    expect(parseUserPluginsManifest('not json')).toEqual([])
    expect(parseUserPluginsManifest('{"plugins": 42}')).toEqual([])
    expect(parseUserPluginsManifest('{"plugins": [{"id": "x", "file": "f.js", "rev": "r"}]}')).toEqual([])
    expect(parseUserPluginsManifest('{"plugins": [{"id": "ok", "file": "f.js", "rev": "r", "source": "s.js"}]}'))
      .toEqual([{ id: 'ok', file: 'f.js', rev: 'r', source: 's.js' }] satisfies UserPluginInfo[])
  })

  it('空清单返回 []', () => {
    expect(parseUserPluginsManifest('{"plugins": []}')).toEqual([])
  })
})
