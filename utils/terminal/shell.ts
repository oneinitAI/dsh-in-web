/**
 * Terminal MVP — browser-native shell simulator.
 * Sandbox semantics: whitelist-only commands operating on the virtual
 * workspace (IndexedDB). No eval, no subprocess, no shell metacharacters —
 * unknown commands and metacharacter injection are rejected outright.
 */

export interface ShellCommand {
  name: string
  args: string[]
}

/** Minimal fs surface the shell needs (Workspace satisfies this). */
export interface ShellFs {
  list(path: string): Promise<{ path: string; kind: 'file' | 'dir'; size?: number }[]>
  readText(path: string): Promise<string | undefined>
  stat(path: string): Promise<{ path: string; kind: 'file' | 'dir'; size?: number } | undefined>
  writeText(path: string, content: string): Promise<{ version: number }>
}

/** Metacharacters that indicate shell injection attempts → reject. */
const FORBIDDEN_CHARS = /[|&;`$()<>]/

export function isForbidden(line: string): boolean {
  return FORBIDDEN_CHARS.test(line)
}

/**
 * Parse a command line into { name, args } honoring double quotes.
 * Returns null for empty/blank lines. Throws on forbidden metacharacters.
 */
export function parseCommandLine(line: string): ShellCommand | null {
  if (isForbidden(line)) throw new Error('forbidden shell metacharacters')
  const trimmed = line.trim()
  if (!trimmed) return null
  const args: string[] = []
  let i = 0
  let cur = ''
  let inQuote = false
  while (i < trimmed.length) {
    const ch = trimmed[i]!
    if (ch === '"') {
      inQuote = !inQuote
    } else if (ch === ' ' && !inQuote) {
      if (cur) {
        args.push(cur)
        cur = ''
      }
    } else {
      cur += ch
    }
    i++
  }
  if (inQuote) throw new Error('unterminated quote')
  if (cur) args.push(cur)
  const name = args[0] ?? ''
  return { name, args: args.slice(1) }
}

/** Command registry with per-command usage text. */
export interface CommandSpec {
  name: string
  usage: string
  run: (sh: ShellSimulator, args: string[]) => Promise<string> | string
}

export class ShellSimulator {
  private cwd = '/'
  private readonly fs: ShellFs
  private readonly commands = new Map<string, CommandSpec>()
  private readonly history: string[] = []

  constructor(fs: ShellFs) {
    this.fs = fs
    this.register(defaultCommands)
  }

  getCwd(): string {
    return this.cwd
  }

  getHistory(): readonly string[] {
    return this.history
  }

  register(specs: CommandSpec[]): void {
    for (const s of specs) this.commands.set(s.name, s)
  }

  listCommands(): CommandSpec[] {
    return [...this.commands.values()]
  }

  /** Resolve a possibly-relative path against cwd. No '..' escapes allowed. */
  private resolve(raw: string): string {
    const p = raw.startsWith('/') ? raw : `${this.cwd === '/' ? '' : this.cwd}/${raw}`
    const parts = p.split('/').filter((x) => x !== '' && x !== '.')
    const out: string[] = []
    for (const part of parts) {
      if (part === '..') {
        if (out.length === 0) throw new Error('path escapes workspace root')
        out.pop()
      } else {
        out.push(part)
      }
    }
    return '/' + out.join('/')
  }

  /** Execute one line; returns output text (already trimmed of trailing \n). */
  async exec(line: string): Promise<string> {
    const cmd = parseCommandLine(line)
    if (!cmd) return ''
    this.history.push(line.trim())
    const spec = this.commands.get(cmd.name)
    if (!spec) return `command not found: ${cmd.name}`
    return String(await spec.run(this, cmd.args))
  }
}

/** Core whitelist commands. */
export const defaultCommands: CommandSpec[] = [
  {
    name: 'help',
    usage: 'help — list available commands',
    run: (sh) => {
      const lines = sh.listCommands().map((c) => `  ${c.usage}`)
      return ['Available commands:', ...lines].join('\n')
    },
  },
  {
    name: 'pwd',
    usage: 'pwd — print working directory',
    run: (sh) => sh.getCwd(),
  },
  {
    name: 'ls',
    usage: 'ls [path] — list directory contents',
    run: async (sh, args) => {
      const target = sh['resolve'](args[0] ?? sh.getCwd())
      const entries = await sh['fs'].list(target)
      if (entries.length === 0) return ''
      return entries
        .map((e) => (e.kind === 'dir' ? `${e.path.split('/').pop()}/` : e.path.split('/').pop() ?? ''))
        .join('  ')
    },
  },
  {
    name: 'cat',
    usage: 'cat <file> — print file contents',
    run: async (sh, args) => {
      if (!args[0]) return 'usage: cat <file>'
      const p = sh['resolve'](args[0])
      const content = await sh['fs'].readText(p)
      return content ?? `cat: ${p}: no such file`
    },
  },
  {
    name: 'write',
    usage: 'write <file> <content...> — write (overwrite) a file',
    run: async (sh, args) => {
      if (args.length < 2) return 'usage: write <file> <content...>'
      const p = sh['resolve'](args[0]!)
      await sh['fs'].writeText(p, args.slice(1).join(' '))
      return `wrote ${p}`
    },
  },
  {
    name: 'echo',
    usage: 'echo <text...> — print text',
    run: (_sh, args) => args.join(' '),
  },
  {
    name: 'clear',
    usage: 'clear — clear the terminal (handled by UI)',
    run: () => '',
  },
]