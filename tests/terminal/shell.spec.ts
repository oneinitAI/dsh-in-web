/**
 * terminal/shell.ts — 白名单 shell simulator 的 TDD 测试。
 * 覆盖：命令解析（引号/注入拒绝）、白名单命令（help/pwd/ls/cat/write/echo）、
 * 相对路径解析 + 防穿越、未知命令拒绝。
 */
import { describe, expect, it } from 'vitest'
import {
  ShellSimulator,
  isForbidden,
  parseCommandLine,
  type ShellFs,
} from '../../utils/terminal/shell'

/** 内存版 ShellFs（对齐 Workspace 语义） */
function makeFs(): ShellFs & { entries: Map<string, string> } {
  const entries = new Map<string, string>([
    ['/readme.md', '# hello\nline2'],
    ['/notes/a.txt', 'aaa'],
    ['/notes/b.txt', 'bbb'],
  ])
  const fs: ShellFs & { entries: Map<string, string> } = {
    entries,
    async list(path) {
      const prefix = path === '/' ? '/' : path + '/'
      const out: { path: string; kind: 'file' | 'dir'; size?: number }[] = []
      for (const p of entries.keys()) {
        if (p === '/' || !p.startsWith(prefix)) continue
        const rest = p.slice(prefix.length)
        if (rest.includes('/')) continue
        out.push({ path: p, kind: 'file', size: entries.get(p)?.length })
      }
      // 隐式父目录
      const dirs = new Set<string>()
      for (const p of entries.keys()) {
        if (!p.startsWith(prefix)) continue
        const rest = p.slice(prefix.length)
        if (!rest.includes('/')) continue
        dirs.add(prefix + rest.split('/')[0])
      }
      for (const d of dirs) out.push({ path: d, kind: 'dir' })
      return out
    },
    async readText(path) {
      return entries.get(path)
    },
    async stat(path) {
      if (!entries.has(path)) return undefined
      return { path, kind: 'file', size: entries.get(path)?.length }
    },
    async writeText(path, content) {
      entries.set(path, content)
      return { version: 1 }
    },
  }
  return fs
}

describe('parseCommandLine', () => {
  it('拆分普通命令与参数', () => {
    expect(parseCommandLine('cat /a/b.txt')).toEqual({ name: 'cat', args: ['/a/b.txt'] })
    expect(parseCommandLine('  ls   ')).toEqual({ name: 'ls', args: [] })
  })

  it('支持双引号参数（保留内部空格）', () => {
    expect(parseCommandLine('write /f.txt "hello world"')).toEqual({
      name: 'write',
      args: ['/f.txt', 'hello world'],
    })
  })

  it('空行返回 null', () => {
    expect(parseCommandLine('')).toBeNull()
    expect(parseCommandLine('   ')).toBeNull()
  })

  it('拒绝 shell 元字符（注入防护）', () => {
    expect(isForbidden('ls | rm -rf /')).toBe(true)
    expect(isForbidden('echo $(whoami)')).toBe(true)
    expect(isForbidden('cat /a; ls')).toBe(true)
    expect(isForbidden('ls && ls')).toBe(true)
    expect(() => parseCommandLine('ls | grep x')).toThrow('forbidden')
  })

  it('未闭合引号报错', () => {
    expect(() => parseCommandLine('write /f "abc')).toThrow('unterminated')
  })
})

describe('ShellSimulator', () => {
  it('help 列出全部命令', async () => {
    const sh = new ShellSimulator(makeFs())
    const out = await sh.exec('help')
    expect(out).toContain('pwd')
    expect(out).toContain('cat')
    expect(out).toContain('write')
    expect(out).toContain('clear')
  })

  it('pwd 初始为 /，cd 未实现时仅根目录', async () => {
    const sh = new ShellSimulator(makeFs())
    expect(await sh.exec('pwd')).toBe('/')
  })

  it('ls 列出根目录条目', async () => {
    const sh = new ShellSimulator(makeFs())
    const out = await sh.exec('ls')
    expect(out).toContain('readme.md')
    expect(out).toContain('notes/')
  })

  it('cat 读取文件内容；缺失文件报错', async () => {
    const sh = new ShellSimulator(makeFs())
    expect(await sh.exec('cat /readme.md')).toBe('# hello\nline2')
    expect(await sh.exec('cat /nope.txt')).toContain('no such file')
  })

  it('write 创建/覆盖文件，随后可 cat', async () => {
    const sh = new ShellSimulator(makeFs())
    expect(await sh.exec('write /new.txt hello world')).toContain('wrote')
    expect(await sh.exec('cat /new.txt')).toBe('hello world')
  })

  it('echo 原样输出', async () => {
    const sh = new ShellSimulator(makeFs())
    expect(await sh.exec('echo hi there')).toBe('hi there')
  })

  it('未知命令拒绝', async () => {
    const sh = new ShellSimulator(makeFs())
    expect(await sh.exec('rm -rf /')).toBe('command not found: rm')
  })

  it('相对路径基于 cwd 解析', async () => {
    const sh = new ShellSimulator(makeFs())
    // cwd 初始为 /，相对路径 notes/a.txt 应解析到 /notes/a.txt
    expect(await sh.exec('cat notes/a.txt')).toBe('aaa')
  })

  it('记录历史', async () => {
    const sh = new ShellSimulator(makeFs())
    await sh.exec('pwd')
    await sh.exec('ls')
    expect(sh.getHistory()).toEqual(['pwd', 'ls'])
  })

  it('clear 返回空串（UI 处理清屏）', async () => {
    const sh = new ShellSimulator(makeFs())
    expect(await sh.exec('clear')).toBe('')
  })
})