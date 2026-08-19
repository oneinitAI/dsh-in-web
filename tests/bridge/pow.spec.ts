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
 * DeepSeekHashV1 / PoW 求解器的 TDD 测试。
 * 测试向量来自 CJackHwang/ds2api 的 pow/deepseek_pow_test.go，
 * 其注释明确：向量由直接调用 DeepSeek 官方 WASM 生成。
 */
import { describe, expect, it } from 'vitest'
import {
  buildPrefix,
  bytesToHex,
  deepSeekHashV1,
  solveAndBuildPowHeader,
  solvePow,
} from '../../utils/bridge/pow'

const enc = new TextEncoder()

describe('deepSeekHashV1（官方 WASM 生成向量）', () => {
  const vectors: ReadonlyArray<{ input: string; output: string }> = [
    { input: '', output: 'e594808bc5b7151ac160c6d39a02e0a8e261ed588578403099e3561dc40c26b3' },
    { input: 'testsalt_1700000000_42', output: 'd4a2ea58c89e40887c933484868380c6f803eaa8dc53a3b9df8e431b921a4f09' },
    { input: 'testsalt_1700000000_100000', output: 'abea2f35796b65486e9be1b36f7878c66cab021e96faa473fdf4decd31f9ba30' },
    { input: 'abc123salt_1700000000_12345', output: '74b3b7452745b70e85eb32ee7f0a9ec0381d42dd5137b695da915e104fc390e1' },
  ]
  it.each(vectors)('hash($input) = $output', ({ input, output }) => {
    expect(bytesToHex(deepSeekHashV1(enc.encode(input)))).toBe(output)
  })
})

describe('solvePow（官方向量）', () => {
  const cases: ReadonlyArray<{ salt: string; expire: number; answer: number; diff: number }> = [
    { salt: 'testsalt', expire: 1700000000, answer: 42, diff: 1000 },
    { salt: 'testsalt', expire: 1700000000, answer: 500, diff: 2000 },
    { salt: 'abc123salt', expire: 1700000000, answer: 12345, diff: 20000 },
  ]
  it.each(cases)('solve($salt, $expire) = $answer', ({ salt, expire, answer, diff }) => {
    const prefix = buildPrefix(salt, expire)
    const target = bytesToHex(deepSeekHashV1(enc.encode(`${prefix}${answer}`)))
    expect(solvePow(target, salt, expire, diff)).toBe(answer)
  })
})

describe('solveAndBuildPowHeader（官方向量）', () => {
  it('生成 x-ds-pow-response 且 answer 正确', () => {
    const salt = 'salt'
    const expireAt = 1712345678
    const answer = 777
    const challenge = bytesToHex(deepSeekHashV1(enc.encode(`salt_${expireAt}_${answer}`)))
    const header = solveAndBuildPowHeader({
      algorithm: 'DeepSeekHashV1',
      challenge,
      salt,
      expire_at: expireAt,
      difficulty: 2000,
      signature: 'sig',
      target_path: '/api/v0/chat/completion',
    })
    // base64 → JSON
    const raw = atob(header)
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(parsed.answer).toBe(answer)
    expect(parsed.algorithm).toBe('DeepSeekHashV1')
    expect(parsed.target_path).toBe('/api/v0/chat/completion')
  })
})

describe('solvePow 边界', () => {
  it('challenge 长度非法抛错', () => {
    expect(() => solvePow('abc', 's', 1, 10)).toThrow(/64 hex/)
  })
  it('difficulty 内无解抛错', () => {
    const salt = 'nonexistent'
    const expire = 1700000000
    // 造一个不可能命中的 challenge（对不存在的答案取 hash，diff 设极小）
    const target = bytesToHex(deepSeekHashV1(enc.encode(`${salt}_${expire}_999999`)))
    expect(() => solvePow(target, salt, expire, 0)).toThrow(/no solution/)
  })
})
