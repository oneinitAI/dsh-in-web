/**
 * DeepSeek-web Proof-of-Work solver —— 浏览器安全版。
 *
 * 算法: "DeepSeekHashV1" = SHA3-256，但 Keccak-f[1600] 置换只跑 rounds 1..23
 * （跳过 round 0）。参考实现：yinshuo-thu/deepseek-cli 的 src/auth/pow.ts，
 * 官方向量来源：CJackHwang/ds2api 的 pow/deepseek_pow_test.go（由官方 WASM 生成）。
 *
 * 纯 TS、零依赖；热路径用 Uint32Array 对规避 BigInt 慢速；difficulty 默认 144000。
 * 已在浏览器兼容性上做适配：base64 用 TextEncoder + btoa（替代 Node Buffer）。
 */

/* eslint-disable no-bitwise */

// ---- Keccak-f[1600] reduced to rounds 1..23 ------------------------------

// 标准 SHA-3 round 常量（[hi, lo] uint32 对）。DeepSeek 变体跳过 RC[0]。
const RC_HI: number[] = [
  0x00000000, 0x00000000, 0x80000000, 0x80000000,
  0x00000000, 0x00000000, 0x80000000, 0x80000000,
  0x00000000, 0x00000000, 0x00000000, 0x00000000,
  0x00000000, 0x80000000, 0x80000000, 0x80000000,
  0x80000000, 0x80000000, 0x00000000, 0x80000000,
  0x80000000, 0x80000000, 0x00000000, 0x80000000,
]
const RC_LO: number[] = [
  0x00000001, 0x00008082, 0x0000808a, 0x80008000,
  0x0000808b, 0x80000001, 0x80008081, 0x00008009,
  0x0000008a, 0x00000088, 0x80008009, 0x8000000a,
  0x8000808b, 0x0000008b, 0x00008089, 0x00008003,
  0x00008002, 0x00000080, 0x0000800a, 0x8000000a,
  0x80008081, 0x00008080, 0x80000001, 0x80008008,
]

// Rho/Pi 步的旋转表：源 lane → (旋转量, 目标 lane)。
const ROT_PI_MAP: ReadonlyArray<[number, number]> = [
  [0, 0], [1, 10], [62, 20], [28, 5], [27, 15],
  [36, 16], [44, 1], [6, 11], [55, 21], [20, 6],
  [3, 7], [10, 17], [43, 2], [25, 12], [39, 22],
  [41, 23], [45, 8], [15, 18], [21, 3], [8, 13],
  [18, 14], [2, 24], [61, 9], [56, 19], [14, 4],
]

/** 64 位循环左移 n（0..63），作用于 [hi, lo] 对 */
function rotl64(out: Uint32Array, hi: number, lo: number, n: number): void {
  n &= 63
  if (n === 0) {
    out[0] = hi >>> 0
    out[1] = lo >>> 0
    return
  }
  if (n < 32) {
    out[0] = ((hi << n) | (lo >>> (32 - n))) >>> 0
    out[1] = ((lo << n) | (hi >>> (32 - n))) >>> 0
  } else if (n === 32) {
    out[0] = lo >>> 0
    out[1] = hi >>> 0
  } else {
    const k = n - 32
    out[0] = ((lo << k) | (hi >>> (32 - k))) >>> 0
    out[1] = ((hi << k) | (lo >>> (32 - k))) >>> 0
  }
}

// 状态 = 25 lanes × 64 bits = Uint32Array(50)。模块级 scratch 缓冲避免热循环分配。
const _rotScratch = new Uint32Array(2)
const _b = new Uint32Array(50)
const _c = new Uint32Array(10)
const _d = new Uint32Array(10)

/** Keccak-f[1600] 只跑 rounds 1..23（DeepSeekHashV1 变体） */
function keccakF23(s: Uint32Array): void {
  for (let r = 1; r < 24; r++) {
    // theta
    for (let x = 0; x < 5; x++) {
      const i0 = x * 2
      const i1 = (x + 5) * 2
      const i2 = (x + 10) * 2
      const i3 = (x + 15) * 2
      const i4 = (x + 20) * 2
      _c[i0] = (s[i0]! ^ s[i1]! ^ s[i2]! ^ s[i3]! ^ s[i4]!) >>> 0
      _c[i0 + 1] = (s[i0 + 1]! ^ s[i1 + 1]! ^ s[i2 + 1]! ^ s[i3 + 1]! ^ s[i4 + 1]!) >>> 0
    }
    for (let x = 0; x < 5; x++) {
      const xm = ((x + 4) % 5) * 2
      const xp = ((x + 1) % 5) * 2
      rotl64(_rotScratch, _c[xp]!, _c[xp + 1]!, 1)
      _d[x * 2] = (_c[xm]! ^ _rotScratch[0]!) >>> 0
      _d[x * 2 + 1] = (_c[xm + 1]! ^ _rotScratch[1]!) >>> 0
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        const i = (y + x) * 2
        s[i] = (s[i]! ^ _d[x * 2]!) >>> 0
        s[i + 1] = (s[i + 1]! ^ _d[x * 2 + 1]!) >>> 0
      }
    }
    // rho + pi
    for (let i = 0; i < 25; i++) {
      const [rot, dest] = ROT_PI_MAP[i]!
      const si = i * 2
      rotl64(_rotScratch, s[si]!, s[si + 1]!, rot)
      const di = dest * 2
      _b[di] = _rotScratch[0]!
      _b[di + 1] = _rotScratch[1]!
    }
    // chi
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        const ix = (y + x) * 2
        const ix1 = (y + ((x + 1) % 5)) * 2
        const ix2 = (y + ((x + 2) % 5)) * 2
        s[ix] = (_b[ix]! ^ ((~_b[ix1]! >>> 0) & _b[ix2]!)) >>> 0
        s[ix + 1] = (_b[ix + 1]! ^ ((~_b[ix1 + 1]! >>> 0) & _b[ix2 + 1]!)) >>> 0
      }
    }
    // iota: a0 ^= rc[r]
    s[0] = (s[0]! ^ RC_LO[r]!) >>> 0
    s[1] = (s[1]! ^ RC_HI[r]!) >>> 0
  }
}

const RATE = 136 // bytes; SHA3-256 rate

/** DeepSeekHashV1 —— `data` 的 32 字节摘要（SHA3-256 但跳 round 0） */
export function deepSeekHashV1(data: Uint8Array): Uint8Array {
  const s = new Uint32Array(50)
  let off = 0
  // absorb 整块
  while (off + RATE <= data.length) {
    for (let i = 0; i < RATE / 8; i++) {
      const lo = readU32LE(data, off + i * 8)
      const hi = readU32LE(data, off + i * 8 + 4)
      s[i * 2] = (s[i * 2]! ^ lo) >>> 0
      s[i * 2 + 1] = (s[i * 2 + 1]! ^ hi) >>> 0
    }
    keccakF23(s)
    off += RATE
  }
  // final block + SHA3 padding (0x06 ... 0x80)
  const final = new Uint8Array(RATE)
  final.set(data.subarray(off))
  final[data.length - off] = 0x06
  final[RATE - 1] = (final[RATE - 1]! | 0x80) >>> 0
  for (let i = 0; i < RATE / 8; i++) {
    const lo = readU32LE(final, i * 8)
    const hi = readU32LE(final, i * 8 + 4)
    s[i * 2] = (s[i * 2]! ^ lo) >>> 0
    s[i * 2 + 1] = (s[i * 2 + 1]! ^ hi) >>> 0
  }
  keccakF23(s)
  // squeeze 32 字节（state words 0..3，little-endian）
  const out = new Uint8Array(32)
  for (let i = 0; i < 4; i++) {
    writeU32LE(out, i * 8, s[i * 2]!)
    writeU32LE(out, i * 8 + 4, s[i * 2 + 1]!)
  }
  return out
}

function readU32LE(buf: Uint8Array, off: number): number {
  return ((buf[off]! | (buf[off + 1]! << 8) | (buf[off + 2]! << 16) | (buf[off + 3]! << 24)) >>> 0)
}
function writeU32LE(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff
  buf[off + 1] = (v >>> 8) & 0xff
  buf[off + 2] = (v >>> 16) & 0xff
  buf[off + 3] = (v >>> 24) & 0xff
}

// ---- PoW challenge 模型 + 求解器 ----------------------------------------

export interface PowChallenge {
  algorithm: string
  /** 64 字符 hex */
  challenge: string
  salt: string
  /** unix 秒 */
  expire_at: number
  difficulty: number
  signature: string
  target_path: string
}

export class UnsupportedAlgorithmError extends Error {
  constructor(algo: string) {
    super(`pow: unsupported algorithm: ${algo}`)
    this.name = 'UnsupportedAlgorithmError'
  }
}

export class PowSolveError extends Error {
  constructor(message: string) {
    super(`pow: ${message}`)
    this.name = 'PowSolveError'
  }
}

/** `<salt>_<expire_at>_` —— 必须与 Go 的 BuildPrefix 完全一致 */
export function buildPrefix(salt: string, expireAt: number): string {
  return `${salt}_${expireAt}_`
}

/**
 * 在 [0, difficulty) 内搜索 nonce，使
 *   DeepSeekHashV1(prefix + str(nonce)) == challenge_hex
 * 返回 nonce 数字；找不到抛 PowSolveError。
 * signal 每 1024 次尝试检查一次（供取消）。
 */
export function solvePow(
  challengeHex: string,
  salt: string,
  expireAt: number,
  difficulty: number,
  signal?: AbortSignal,
): number {
  if (challengeHex.length !== 64) {
    throw new PowSolveError('challenge must be 64 hex chars')
  }
  const target = hexToBytes(challengeHex)
  const prefix = utf8(buildPrefix(salt, expireAt))
  const tail = new Uint8Array(20)
  for (let n = 0; n < difficulty; n++) {
    if ((n & 0x3ff) === 0 && signal?.aborted) {
      throw new PowSolveError('aborted')
    }
    const nlen = writeDecimal(tail, n)
    const buf = new Uint8Array(prefix.length + nlen)
    buf.set(prefix, 0)
    buf.set(tail.subarray(0, nlen), prefix.length)
    if (bytesEqual(deepSeekHashV1(buf), target)) return n
  }
  throw new PowSolveError('no solution within difficulty')
}

/** 求解并生成 x-ds-pow-response 头：base64(JSON{...})；difficulty 缺省 144000 */
export function solveAndBuildPowHeader(c: PowChallenge, signal?: AbortSignal): string {
  if (c.algorithm !== 'DeepSeekHashV1') {
    throw new UnsupportedAlgorithmError(c.algorithm)
  }
  const difficulty = c.difficulty > 0 ? c.difficulty : 144000
  const answer = solvePow(c.challenge, c.salt, c.expire_at, difficulty, signal)
  return buildPowHeader(c, answer)
}

export function buildPowHeader(c: PowChallenge, answer: number): string {
  const payload = {
    algorithm: c.algorithm,
    challenge: c.challenge,
    salt: c.salt,
    answer,
    signature: c.signature,
    target_path: c.target_path,
  }
  return base64EncodeUtf8(JSON.stringify(payload))
}

// ---- helpers --------------------------------------------------------------

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export function bytesToHex(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) {
    s += b[i]!.toString(16).padStart(2, '0')
  }
  return s
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** 把 n 的十进制写入 buf 末端（倒写），返回长度；随后拷到开头 */
function writeDecimal(buf: Uint8Array, n: number): number {
  if (n === 0) {
    buf[0] = 0x30
    return 1
  }
  let pos = buf.length
  let v = n
  while (v > 0) {
    pos--
    buf[pos] = 0x30 + (v % 10)
    v = Math.floor(v / 10)
  }
  const len = buf.length - pos
  buf.copyWithin(0, pos, pos + len)
  return len
}

/** UTF-8 字符串 → base64（浏览器安全版，替代 Node Buffer） */
function base64EncodeUtf8(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  // 小 payload（PoW header）直接用 String.fromCharCode 足够
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return btoa(bin)
}
