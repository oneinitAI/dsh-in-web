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

import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import type { Message } from '@/utils/bridge/protocol'
import type { BridgeEventMessage } from '@/utils/messages'
import { buildFileTree, filterTree, type TreeNode } from '@/utils/ui/filetree'
import type { FsEntry } from '@/utils/fs/workspace'
import { realDirPath, workspaceIdFromPath } from '@/utils/fs/workspace'
import { saveDirectoryHandle } from '@/utils/fs/dir-handles'
import { parseSkillMd, type Skill } from '@/utils/skills/skill'
import { interpolate, parseSections, renderSections, type PromptSection } from '@/utils/prompts/prompt'
import { getSettings, patchSettings, type DshSettings } from '@/utils/settings/settings'
import {
  extractPluginId,
  isPluginBundle,
  listBuiltInUserPlugins,
  type UserPluginInfo,
} from '@/utils/plugin/user-plugins'
import { TerminalView } from './TerminalView'

/**
 * showDirectoryPicker 不在 TS 标准 lib.dom 中（File System Access API 实验特性），
 * 局部声明最小签名，避免 any。handle 类型 FileSystemDirectoryHandle 由 lib.dom 提供。
 */
declare global {
  interface Window {
    showDirectoryPicker(options?: {
      id?: string
      mode?: 'read' | 'readwrite'
      startIn?: string
    }): Promise<FileSystemDirectoryHandle>
  }
}

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

type Tab = 'chat' | 'files' | 'skills' | 'prompts' | 'terminal' | 'plugins' | 'settings'

const TAB_LABELS: Record<Tab, string> = {
  chat: '会话',
  files: '文件',
  skills: '技能',
  prompts: '提示词',
  terminal: '终端',
  plugins: '插件',
  settings: '设置',
}

/** 是否以 iframe 嵌入模式运行（dsh-ui.content.ts 注入的 URL 带 ?embed=1） */
const IS_EMBEDDED = typeof location !== 'undefined' && location.search.includes('embed=1')

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
  const [tab, setTab] = useState<Tab>('settings')
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

  // ── 设置（持久化）────────────────────────
  const [settings, setSettings] = useState<DshSettings | null>(null)

  // ── 用户插件（构建期合并，CSP-safe）───────────
  const [builtInPlugins, setBuiltInPlugins] = useState<UserPluginInfo[]>([])
  const [pluginSrc, setPluginSrc] = useState('')
  const [pluginName, setPluginName] = useState('')
  const [pluginMsg, setPluginMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  // ── 真实文件夹工作区（showDirectoryPicker）────────────────
  const [wsBusy, setWsBusy] = useState(false)
  const [wsInfo, setWsInfo] = useState<string | null>(null)
  const [wsError, setWsError] = useState<string | null>(null)

  useEffect(() => {
    void getSettings().then(setSettings)
  }, [])

  // 应用主题（dark/light）与字号到 documentElement —— CSS 变量驱动，见 style.css :root
  useEffect(() => {
    if (!settings) return
    const root = document.documentElement
    root.dataset.theme = settings.darkTheme ? 'dark' : 'light'
    root.style.setProperty('--dsh-font-size', `${settings.fontSize}px`)
  }, [settings])

  async function toggleSetting<K extends keyof DshSettings>(key: K, value: DshSettings[K]) {
    const next = await patchSettings({ [key]: value })
    setSettings(next)
  }

  /**
   * 「打开文件夹建立工作区」：showDirectoryPicker 必须由用户手势直接触发
   * （按钮 onClick），SW 无法弹出选择器，因此这里：
   * 1. picker 选真实文件夹 → 2. handle 存 IndexedDB（key = workspaceId，同源共享）
   * → 3. 通知 SW 建工作区记录（SW 从 IndexedDB 恢复 handle 供真实读写）。
   */
  async function openFolderWorkspace() {
    setWsError(null)
    setWsInfo(null)
    let handle: FileSystemDirectoryHandle
    try {
      handle = await window.showDirectoryPicker({ mode: 'readwrite' })
    } catch {
      // 用户取消 / 环境不支持：静默回到当前状态
      return
    }
    const name = handle.name
    const path = realDirPath(name)
    const workspaceId = workspaceIdFromPath(path)
    setWsBusy(true)
    try {
      await saveDirectoryHandle(workspaceId, handle)
      const resp = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        chrome.runtime.sendMessage(
          { topic: 'panel-query', payload: { cmd: 'create-real-workspace', path, title: name } },
          (r: unknown) => resolve((r as { ok: boolean; error?: string }) ?? { ok: false }),
        )
      })
      if (resp.ok) {
        setWsInfo(`工作区「${name}」已建立（${path}），可在 dsh 界面的工作区列表切换到它`)
      } else {
        setWsError(resp.error ?? '建立工作区失败')
      }
    } catch (err) {
      setWsError(err instanceof Error ? err.message : String(err))
    } finally {
      setWsBusy(false)
    }
  }

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

  // 进入插件标签时拉取已内置的用户插件清单（import-dsh 生成）
  useEffect(() => {
    if (tab !== 'plugins') return
    void listBuiltInUserPlugins().then(setBuiltInPlugins)
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
    void chrome.runtime.sendMessage({
      topic: 'send-message',
      payload: {
        messages: all,
        reasoning: settings?.reasoning ?? true,
        search: settings?.search ?? false,
      },
    }).catch(() => {})
  }

  function stop() {
    chrome.runtime.sendMessage({ topic: 'stop-stream' }).catch(() => {})
  }

  async function openFile(node: TreeNode) {
    if (node.kind !== 'file') return
    const r = await query<{ content: string | null }>('read-file', node.path)
    setFileContent({ path: node.path, content: r.content ?? '' })
  }

  // ── 用户插件：文件选择读取 bundle 源码 ─────────────
  async function onPickPluginFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const text = await file.text()
    setPluginSrc(text)
    setPluginName(extractPluginId(text) ?? '')
    setPluginMsg(null)
  }

  /**
   * 校验粘贴/选择的 bundle 格式，并给出「保存到 user-plugins/ 后重建」的引导。
   * MV3 扩展页 CSP 禁 blob/data/eval，插件必须在构建期合并进扩展包内。
   */
  async function addPlugin() {
    const code = pluginSrc.trim()
    if (!code) {
      setPluginMsg({ kind: 'err', text: '请先选择插件文件或粘贴 bundle 源码' })
      return
    }
    if (!isPluginBundle(code)) {
      setPluginMsg({ kind: 'err', text: '不是合法的插件 bundle：需要 window.__ModuleLoader__.load({ id, factory }) 格式' })
      return
    }
    const id = extractPluginId(code)
    if (!id) {
      setPluginMsg({ kind: 'err', text: '无法从 bundle 提取插件 id' })
      return
    }
    setPluginName(id)
    setPluginSrc('')
    setPluginMsg({
      kind: 'ok',
      text: `校验通过：插件 ${id}。请将当前 bundle 保存为仓库 user-plugins/${id}.js，然后运行 pnpm exec import-dsh && pnpm build，重新加载扩展后生效（构建期合并，CSP-safe）。`,
    })
  }

  /** 查看已内置用户插件的最新清单 */
  async function refreshPlugins() {
    setBuiltInPlugins(await listBuiltInUserPlugins())
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
        {IS_EMBEDDED && (
          <button className="btn btn--danger btn--small" onClick={() => void toggleSetting('dshMode', 'off')}>
            退出 dsh 模式
          </button>
        )}
      </header>

      <nav className="tabs">
        {(['chat', 'files', 'skills', 'prompts', 'terminal', 'plugins', 'settings'] as const).map((t) => (
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
            <div className="msg-column">
              {turns.length === 0 && (
                <div className="chat__empty">在 chat.deepseek.com 登录后，在这里发消息测试网页版桥接。</div>
              )}
              {turns.map((t, i) => (
                <div key={i} className={`msg msg--${t.role}`}>
                  {t.thinking && (
                    <details
                      className="thinking"
                      open={false}
                      data-state={i === turns.length - 1 && streaming ? 'running' : undefined}
                    >
                      <summary>思考过程</summary>
                      <div className="thinking__body">{t.thinking}</div>
                    </details>
                  )}
                  <div className="msg__content">{t.content || (i === turns.length - 1 && streaming ? '…' : '')}</div>
                </div>
              ))}
            </div>
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
                <button className="send-btn" onClick={send} disabled={!state.authPresent || !input.trim()} aria-label="发送">
                  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M3 8l10-5-3.5 9L8 8 3 8z" fill="currentColor" />
                  </svg>
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

      {tab === 'terminal' && <TerminalView />}

      {tab === 'plugins' && (
        <div className="plugins">
          <p className="settings__hint">
            添加 dsh client 插件 bundle（与官方 client.js 同格式：<code>{`window.__ModuleLoader__.load({ id, factory })`}</code>，如
            dshsp 的 <code>lib/client.js</code>）。MV3 扩展页 CSP 禁止运行时注入（blob/data/eval 均不可用），
            插件需在<strong>构建期</strong>合并进扩展包内生效：
          </p>
          <ol className="plugins__steps">
            <li>将 bundle 源码保存为仓库 <code>user-plugins/&lt;id&gt;.js</code>（id 为插件包名，如 <code>@oneinitai/dsh-settings-plus.js</code>）</li>
            <li>运行 <code>pnpm exec import-dsh</code>（合并进 <code>dsh-web/user-plugins/</code> 并追加 boot entries）+ <code>pnpm build</code></li>
            <li>在 chrome://extensions 重新加载扩展，刷新页面后生效</li>
          </ol>

          <div className="plugins__add">
            <input
              type="file"
              accept=".js,text/javascript"
              className="plugins__file"
              onChange={(e) => void onPickPluginFile(e)}
              title="选择插件 bundle 文件（.js）"
            />
            <textarea
              className="plugins__src"
              placeholder="或粘贴 bundle 源码进行校验…"
              rows={5}
              value={pluginSrc}
              onChange={(e) => {
                setPluginSrc(e.target.value)
                setPluginName(extractPluginId(e.target.value) ?? '')
              }}
            />
            {pluginName && (
              <div className="plugins__detected">识别到插件 id：<code>{pluginName}</code></div>
            )}
            <button className="btn btn--primary" onClick={() => void addPlugin()}>
              校验插件
            </button>
            {pluginMsg && (
              <div className={`ws-note ${pluginMsg.kind === 'ok' ? 'ws-note--ok' : 'ws-note--err'}`}>
                {pluginMsg.text}
              </div>
            )}
          </div>

          <div className="plugins__list">
            <div className="plugins__list-head">
              <span>已内置的用户插件（来自 user-plugins/）</span>
              <button className="btn btn--small" onClick={() => void refreshPlugins()}>
                刷新
              </button>
            </div>
            {builtInPlugins.length === 0 ? (
              <div className="chat__empty">（暂无 —— 添加 bundle 到 user-plugins/ 并重新构建后出现）</div>
            ) : (
              builtInPlugins.map((p) => (
                <div key={p.id} className="plugin-row">
                  <span className="plugin-row__id">{p.id}</span>
                  <span className="plugin-row__meta">{p.source} · {p.rev}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {tab === 'settings' && (
        <div className="settings">
          {settings == null ? (
            <div className="chat__empty">加载设置中…</div>
          ) : (
            <>
              <div className="settings__group">
                <h3 className="settings__group-title">工作区</h3>
                <button
                  className="btn btn--primary"
                  onClick={() => void openFolderWorkspace()}
                  disabled={wsBusy}
                >
                  {wsBusy ? '建立中…' : '打开文件夹建立工作区'}
                </button>
                <p className="settings__hint">
                  选择本地真实文件夹（File System Access API），建立后该工作区映射到真实目录，可读写真实文件。
                </p>
                {wsInfo && <div className="ws-note ws-note--ok">{wsInfo}</div>}
                {wsError && <div className="ws-note ws-note--err">{wsError}</div>}
              </div>

              <div className="settings__group">
                <h3 className="settings__group-title">页面注入</h3>
                <label className="setting-row">
                  <span className="setting-row__label">
                    dsh 模式
                    <span className="setting-row__hint">on = 页面内嵌 dsh 全功能界面；off = 普通 DeepSeek 对话</span>
                  </span>
                  <span className="switch">
                    <input
                      type="checkbox"
                      checked={settings.dshMode === 'on'}
                      onChange={(e) => void toggleSetting('dshMode', e.target.checked ? 'on' : 'off')}
                    />
                    <span className="switch__track" />
                  </span>
                </label>
              </div>

              <div className="settings__group">
                <h3 className="settings__group-title">聊天</h3>
                <label className="setting-row">
                  <span className="setting-row__label">
                    思考模式
                    <span className="setting-row__hint">reasoning：展示模型思考过程</span>
                  </span>
                  <span className="switch">
                    <input
                      type="checkbox"
                      checked={settings.reasoning}
                      onChange={(e) => void toggleSetting('reasoning', e.target.checked)}
                    />
                    <span className="switch__track" />
                  </span>
                </label>
                <label className="setting-row">
                  <span className="setting-row__label">
                    联网搜索
                    <span className="setting-row__hint">search：搜索后回答</span>
                  </span>
                  <span className="switch">
                    <input
                      type="checkbox"
                      checked={settings.search}
                      onChange={(e) => void toggleSetting('search', e.target.checked)}
                    />
                    <span className="switch__track" />
                  </span>
                </label>
                <label className="setting-row">
                  <span className="setting-row__label">
                    会话复用
                    <span className="setting-row__hint">多轮连续对话共享 chat_session</span>
                  </span>
                  <span className="switch">
                    <input
                      type="checkbox"
                      checked={settings.persistSession}
                      onChange={(e) => void toggleSetting('persistSession', e.target.checked)}
                    />
                    <span className="switch__track" />
                  </span>
                </label>
              </div>

              <div className="settings__group">
                <h3 className="settings__group-title">界面</h3>
                <label className="setting-row">
                  <span className="setting-row__label">暗色主题</span>
                  <span className="switch">
                    <input
                      type="checkbox"
                      checked={settings.darkTheme}
                      onChange={(e) => void toggleSetting('darkTheme', e.target.checked)}
                    />
                    <span className="switch__track" />
                  </span>
                </label>
                <label className="setting-row">
                  <span className="setting-row__label">字号：{settings.fontSize}px</span>
                  <input
                    type="range"
                    min={10}
                    max={20}
                    value={settings.fontSize}
                    onChange={(e) => void toggleSetting('fontSize', Number(e.target.value))}
                    className="setting-row__range"
                  />
                </label>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}