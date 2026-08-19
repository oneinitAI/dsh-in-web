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
 * context-recovery.ts —— 扩展上下文失效（Extension context invalidated）恢复逻辑测试。
 * 覆盖：错误识别（Error / lastError 形状）、防抖、协议白名单（仅 chrome-extension: 页面重载）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isContextInvalidated, recoverInvalidatedContext } from '../../scripts/dsh-bridge/context-recovery'

const realLocation = globalThis.location

afterEach(() => {
  vi.restoreAllMocks()
  // 恢复 location（vitest 环境通常有 location；若被 mock 掉需还原）
  Object.defineProperty(globalThis, 'location', { value: realLocation, configurable: true, writable: true })
})

describe('isContextInvalidated', () => {
  it('识别 Error 实例的 context invalidated 消息', () => {
    expect(isContextInvalidated(new Error('Extension context invalidated.'))).toBe(true)
    expect(isContextInvalidated(new Error('Extension context invalidated'))).toBe(true)
  })

  it('识别 chrome.runtime.lastError 形状（{ message }，非 Error 实例）', () => {
    expect(isContextInvalidated({ message: 'Extension context invalidated.' })).toBe(true)
  })

  it('拒绝无关错误', () => {
    expect(isContextInvalidated(new Error('Something else'))).toBe(false)
    expect(isContextInvalidated(new Error('connection refused'))).toBe(false)
    expect(isContextInvalidated({ message: 'No receiving end' })).toBe(false)
    expect(isContextInvalidated('random string')).toBe(false)
    expect(isContextInvalidated(undefined)).toBe(false)
    expect(isContextInvalidated(null)).toBe(false)
  })
})

describe('recoverInvalidatedContext', () => {
  it('在 chrome-extension: 页面触发 location.reload（防抖：5s 内只重载一次）', () => {
    const reload = vi.fn()
    // 模拟扩展页面 origin
    Object.defineProperty(globalThis, 'location', {
      value: { protocol: 'chrome-extension:', reload },
      configurable: true,
      writable: true,
    })

    recoverInvalidatedContext()
    expect(reload).toHaveBeenCalledTimes(1)

    // 防抖窗口内再次调用不再触发
    recoverInvalidatedContext()
    recoverInvalidatedContext()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('在网页宿主（https origin）不重载', () => {
    const reload = vi.fn()
    Object.defineProperty(globalThis, 'location', {
      value: { protocol: 'https:', reload },
      configurable: true,
      writable: true,
    })

    recoverInvalidatedContext()
    expect(reload).not.toHaveBeenCalled()
  })

  it('location 缺失时静默失败（测试宿主无 location）', () => {
    Object.defineProperty(globalThis, 'location', { value: undefined, configurable: true, writable: true })
    expect(() => recoverInvalidatedContext()).not.toThrow()
  })
})
