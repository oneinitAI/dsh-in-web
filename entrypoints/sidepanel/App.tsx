import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Message } from '@/utils/bridge/protocol'
import type { BridgeEventMessage } from '@/utils/messages'
import { buildFileTree, filterTree, type TreeNode } from '@/utils/ui/filetree'
import type { FsEntry } from '@/utils/fs/workspace'
import { parseSkillMd, type Skill } from '@/utils/skills/skill'
import { interpolate, parseSections, renderSections, type PromptSection } from '@/utils/prompts/prompt'

interface PageState {
  authPresent: boolean
  url: string
  connected: boolean
}

interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
  thinking: string
}

const INITIAL: PageState = { authPresent: false, url: '', connected: false }

type Tab = 'chat' | 'files' | 'skills' | 'prompts'

const TAB_LABELS: Record<Tab, string> = {
  chat: '会话',
  files: '文件',
  skills: '技能',
  prompts: '提示词',
}

/** 给 SW 发 panel-query 的封装（返回 ok + payload） */
function query<T>(cmd: 'list-files' | 'read-file' | 'list-skills', path?: string): Promise<T> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { topic: 'panel-query', payload: { cmd, path } },
      (resp: unknown) => resolve((resp as { ok: boolean } & T) as T),
    )
  })
}

/**
 * dsh-in-web Side Panel（Wave 4.2）：
 * 标签页：会话（流式聊天）/ 文件树（虚拟工作区浏览）/ skill 库 / 提示词编辑器。
 */
export function App() {
  const [tab, setTab] = useState<Tab>('chat')
  const [state, setState] = useState<PageState>(INITIAL)
  const [portState, setPortState] = useState<'connecting' | 'open' | 'closed'>('connecting')
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // ── 文件树 / skill 库 / 提示词 状态 ────────────────
  const [tree, setTree] = useState<TreeNode[]>([])
  const [treeQuery, setTreeQuery] = useState('')
  const [fileContent, setFileContent] = useState<{ path: string; content: string } | null>(null)
  const [skills, setSkills] = useState<Skill[]>([])
  const [promptSrc, setPromptSrc] = useState(
    [
      'System: 你是 dsh-in-web 的助手。',
      '',
      'Skills: {{skills}}',
      '',
      'Workspace: {{workspace}}',
    ].join('\n'),
  )
  const [promptVars, setPromptVars] = useState('skills=读写文件与执行命令\nworkspace=/ 虚拟工作区')
  const [promptResult, setPromptResult] = useState('')

  useEffect(() => {
    const port = chrome.runtime.connect({ name: 'dsh-panel-port' })
    const onMessage = (message: unknown) => {
      if (typeof message !== 'object' || message === null) return
      const { topic, payload } = message as { topic: string; payload: unknown }
      if (topic === 'page-state') {
        setState(payload as PageState)
      } else if (topic === 'bridge-event') {
        handleBridgeEvent(payload as BridgeEventMessage)
      }
    }
    port.onMessage.addListener(onMessage)
    port.onDisconnect.addListener(() => setPortState('closed'))
    setPortState('open')
    return () => {
      port.onMessage.removeListener(onMessage)
      port.disconnect()
    }
  }, [])

  function handleBridgeEvent(ev: BridgeEventMessage) {
    if (ev.kind === 'thinking') {
      setTurns((prev) => {
        const copy = [...prev]
        const last = copy[copy.length - 1]
        if (last && last.role === 'assistant') {
          last.thinking += ev.text ?? ''
          return copy
        }
        copy.push({ role: 'assistant', content: '', thinking: ev.text ?? '' })
        return copy
      })
    } else if (ev.kind === 'text') {
      setStreaming(true)
      setTurns((prev) => {
        const copy = [...prev]
        const last = copy[copy.length - 1]
        if (last && last.role === 'assistant') {
          last.content += ev.text ?? ''
          return copy
        }
        copy.push({ role: 'assistant', content: ev.text ?? '', thinking: '' })
        return copy
      })
    } else if (ev.kind === 'finish') {
      setStreaming(false)
    } else if (ev.kind === 'error') {
      setStreaming(false)
      setError(ev.error ?? '未知错误')
    }
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [turns])

  // 进入文件树标签时拉取数据
  useEffect(() => {
    if (tab !== 'files') return
    void query<{ entries: FsEntry[] }>('list-files').then((r) => {
      setTree(buildFileTree(r.entries ?? []))
    })
  }, [tab])

  // 进入 skill 标签时拉取数据
  useEffect(() => {
    if (tab !== 'skills') return
    void query<{ skills: Skill[] }>('list-skills').then((r) => {
      setSkills(r.skills ?? [])
    })
  }, [tab])

  // 提示词实时渲染
  useEffect(() => {
    try {
      const vars: Record<string, string> = {}
      for (const line of promptVars.split('\n')) {
        const idx = line.indexOf('=')
        if (idx > 0) vars[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
      }
      const sections = parseSections(promptSrc)
      setPromptResult(renderSections(sections, vars))
    } catch {
      setPromptResult('（提示词解析失败，请检查格式）')
    }
  }, [promptSrc, promptVars])

  function send() {
    const text = input.trim()
    if (!text || streaming) return
    setError(null)
    const history: Message[] = turns.map((t) => ({
      role: t.role === 'assistant' ? 'assistant' : 'user',
      content: t.content,
    }))
    const all: Message[] = [...history, { role: 'user', content: text }]
    setTurns((prev) => [...prev, { role: 'user', content: text, thinking: '' }])
    setInput('')
    chrome.runtime.sendMessage({ topic: 'send-message', payload: { messages: all, reasoning: true } }).catch(() => {})
  }

  function stop() {
    chrome.runtime.sendMessage({ topic: 'stop-stream' }).catch(() => {})
  }

  async function openFile(node: TreeNode) {
    if (node.kind !== 'file') return
    const r = await query<{ content: string | null }>('read-file', node.path)
    setFileContent({ path: node.path, content: r.content ?? '' })
  }

  const visibleTree = filterTree(tree, treeQuery)

  function renderTree(nodes: TreeNode[], depth: number): ReactNode {
    return nodes.map((n) => (
      <div key={n.path}>
        <div
          className={`tree-row tree-row--${n.kind} ${fileContent?.path === n.path ? 'tree-row--active' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => void openFile(n)}
        >
          <span className="tree-row__icon">{n.kind === 'dir' ? '▸' : '·'}</span>
          <span className="tree-row__name">{n.name}</span>
          {n.kind === 'file' && n.size != null && <span className="tree-row__meta">{n.size}B</span>}
        </div>
        {n.children && renderTree(n.children, depth + 1)}
      </div>
    ))
  }

  return (
    <div className="panel">
      <header className="panel__header">
        <h1 className="panel__title">dsh-in-web</h1>
        <span className={`badge ${state.connected ? 'badge--ok' : 'badge--warn'}`}>
          {state.connected ? '已桥接' : '等待页面'}
        </span>
      </header>

      <nav className="tabs">
        {(['chat', 'files', 'skills', 'prompts'] as const).map((t) => (
          <button key={t} className={`tab ${tab === t ? 'tab--active' : ''}`} onClick={() => setTab(t)}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </nav>

      {tab === 'chat' && (
        <>
          <section className="status">
            <div className="status__row">
              <span className="status__label">SW 长连接</span>
              <span className={`badge ${portState === 'open' ? 'badge--ok' : 'badge--err'}`}>
                {portState === 'open' ? '已连接' : portState === 'connecting' ? '连接中' : '已断开'}
              </span>
            </div>
            <div className="status__row">
              <span className="status__label">登录态</span>
              <span className={`badge ${state.authPresent ? 'badge--ok' : 'badge--err'}`}>
                {state.authPresent ? '已登录' : '未检测到登录'}
              </span>
            </div>
          </section>

          {error && (
            <div className="error-bar">
              <span>{error}</span>
              <button className="icon-btn" onClick={() => setError(null)}>×</button>
            </div>
          )}

          <div className="chat" ref={scrollRef}>
            {turns.length === 0 && (
              <div className="chat__empty">在 chat.deepseek.com 登录后，在这里发消息测试网页版桥接。</div>
            )}
            {turns.map((t, i) => (
              <div key={i} className={`msg msg--${t.role}`}>
                <div className="msg__role">{t.role === 'user' ? '你' : 'DSH'}</div>
                {t.thinking && (
                  <details className="thinking" open={false}>
                    <summary>思考</summary>
                    <div className="thinking__body">{t.thinking}</div>
                  </details>
                )}
                <div className="msg__content">{t.content || (i === turns.length - 1 && streaming ? '…' : '')}</div>
              </div>
            ))}
          </div>

          <div className="composer">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
              placeholder="发消息给 DeepSeek 网页版…"
              rows={3}
            />
            <div className="composer__actions">
              {streaming ? (
                <button className="btn btn--danger" onClick={stop}>停止</button>
              ) : (
                <button className="btn btn--primary" onClick={send} disabled={!state.authPresent || !input.trim()}>
                  发送
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {tab === 'files' && (
        <div className="files">
          <input
            className="files__search"
            placeholder="过滤路径…"
            value={treeQuery}
            onChange={(e) => setTreeQuery(e.target.value)}
          />
          <div className="files__tree">
            {visibleTree.length === 0 ? (
              <div className="chat__empty">（空工作区）</div>
            ) : (
              renderTree(visibleTree, 0)
            )}
          </div>
          {fileContent && (
            <div className="files__preview">
              <div className="files__preview-head">
                <span className="files__preview-path">{fileContent.path}</span>
                <button className="icon-btn" onClick={() => setFileContent(null)}>×</button>
              </div>
              <pre className="files__preview-body">{fileContent.content || '（空文件）'}</pre>
            </div>
          )}
        </div>
      )}

      {tab === 'skills' && (
        <div className="skills">
          {skills.length === 0 ? (
            <div className="chat__empty">（无可用技能）</div>
          ) : (
            skills.map((s) => (
              <details key={s.name} className="skill">
                <summary className="skill__head">
                  <span className="skill__name">/{s.name}</span>
                  <span className="skill__desc">{s.description}</span>
                </summary>
                <pre className="skill__body">{s.body}</pre>
              </details>
            ))
          )}
        </div>
      )}

      {tab === 'prompts' && (
        <div className="prompts">
          <label className="prompts__label">{'模板（Header: body 分节，{{变量}} 插值）'}</label>
          <textarea
            className="prompts__src"
            value={promptSrc}
            onChange={(e) => setPromptSrc(e.target.value)}
            rows={10}
          />
          <label className="prompts__label">变量（每行 key=value）</label>
          <textarea
            className="prompts__vars"
            value={promptVars}
            onChange={(e) => setPromptVars(e.target.value)}
            rows={3}
          />
          <label className="prompts__label">渲染结果</label>
          <pre className="prompts__out">{promptResult}</pre>
        </div>
      )}
    </div>
  )
}