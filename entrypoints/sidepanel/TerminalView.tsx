/**
 * TerminalView — xterm.js + whitelist shell simulator（W4.3 终端 MVP）。
 * 直接在 side panel 内实例化 Workspace（与 SW 共享同一扩展 IndexedDB），
 * 无需 SW 桥接。安全边界：白名单命令 + 元字符注入拒绝（shell.ts）。
 */
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { ShellSimulator } from '@/utils/terminal/shell'
import { Workspace } from '@/utils/fs/workspace'

const PROMPT = '$ '

export function TerminalView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const shellRef = useRef<ShellSimulator | null>(null)
  const bufRef = useRef('')

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const term = new Terminal({
      convertEol: true,
      fontSize: 12,
      fontFamily: 'Consolas, "Courier New", monospace',
      // 终端固定深色主题（不随面板 data-theme）—— 终端惯例，且与 .terminal 容器 CSS 一致
      theme: { background: '#16181d', foreground: '#e6e8eb', cursor: '#2b6cb0' },
      scrollback: 1000,
    })
    term.open(container)
    termRef.current = term

    const ws = new Workspace({ sandboxMode: 'workspace-write', dbName: 'dsh-in-web-workspace' })
    void ws
      .init()
      .then(() => {
        shellRef.current = new ShellSimulator(ws)
        term.writeln('dsh-in-web shell — 白名单命令: help / pwd / ls / cat / write / echo / clear')
        term.write(PROMPT)
      })
      .catch((err: unknown) => {
        term.writeln(`workspace init failed: ${err instanceof Error ? err.message : String(err)}`)
        term.write(PROMPT)
      })

    term.onData((data) => {
      const sh = shellRef.current
      if (!sh) return
      for (const ch of data) {
        if (ch === '\r') {
          const line = bufRef.current
          term.write('\r\n')
          bufRef.current = ''
          void (async () => {
            try {
              const out = await sh.exec(line)
              if (line.trim() === 'clear') {
                term.clear()
              } else if (out) {
                term.writeln(out)
              }
            } catch (err) {
              term.writeln(`error: ${err instanceof Error ? err.message : String(err)}`)
            }
            term.write(PROMPT)
          })()
        } else if (ch === '\x7f') {
          // 退格
          if (bufRef.current.length > 0) {
            bufRef.current = bufRef.current.slice(0, -1)
            term.write('\b \b')
          }
        } else if (ch >= ' ') {
          bufRef.current += ch
          term.write(ch)
        }
      }
    })

    return () => {
      term.dispose()
    }
  }, [])

  return <div className="terminal" ref={containerRef} />
}