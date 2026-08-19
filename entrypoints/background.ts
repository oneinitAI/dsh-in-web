/**
 * Background service worker —— 扩展中枢。
 * Wave 1.5 架构：
 * 1. 维护页面状态（MAIN world → bridge → SW）
 * 2. 与 side panel 建立长 port，把页面状态与桥接流事件推给 UI
 * 3. 编排 agent loop：LLM 网络层在 content script（页面 origin fetch，Origin/Cookie 正确），
 *    SW 经 chat-stream 消息桥发起流式调用并收集事件
 * 4. 三种入口打开 side panel（工具图标 / 键盘命令 / bridge 请求）
 */
import type { Message } from '@/utils/bridge/protocol'
import {
  EXT_TOPIC_CHAT_STREAM_DONE,
  EXT_TOPIC_CHAT_STREAM_ERROR,
  EXT_TOPIC_CHAT_STREAM_EVENT,
  EXT_TOPIC_CHAT_STREAM_START,
  EXT_TOPIC_CHAT_STREAM_STOP,
  PANEL_PORT,
  type BridgeEventMessage,
  type ChatStreamEventPayload,
  type ChatStreamStartPayload,
} from '@/utils/messages'
import { runAgentLoop } from '@/utils/agent/loop'
import { runOpenAiAgentLoop } from '@/utils/agent/loop-openai'
import { buildAgentTools } from '@/utils/agent/tools'
import type { OpenAiMessage } from '@/utils/llm/openai-client'
import { getActiveLlmProvider } from '@/utils/llm/providers'
import {
  isRealDirPath,
  RealDirectoryWorkspace,
  realDirBaseName,
  REAL_DIR_PREFIX,
  workspaceIdFromPath,
  Workspace,
} from '@/utils/fs/workspace'
import {
  deleteDirectoryHandle,
  getDirectoryHandle,
} from '@/utils/fs/dir-handles'
import type { Skill } from '@/utils/skills/skill'
import type { LlmStreamEvent } from '@/utils/plugin/host'
import { getSettings, patchSettings, type DshSettings } from '@/utils/settings/settings'
import { DSH_AGENT_PRESET_CONTENTS } from '@/utils/agent-presets/contents'
import { DEFAULT_PERSONA, presetSystemPrompt } from '@/utils/agent-presets/persona'
import {
  ChromeSettingsStorageBackend,
  createOfficialSettingsProvider,
  ensureOfficialSettingsRuntime,
  getOfficialSettingsRuntime,
  namespaceView,
  type SettingsConflictError,
  type SettingsProviderInstance,
} from '@/utils/official-settings/runtime'
import { OFFICIAL_NAMESPACES } from '@/utils/official-settings/namespaces'
import { OFFICIAL_PLUGIN_ROSTER } from '@/utils/official-settings/plugin-roster'
import type { SettingsNamespace, SettingsPathOp } from '@/utils/official-settings/types'

interface PageState {
  authPresent: boolean
  token: string | null
  url: string
  connected: boolean
}

const INITIAL_STATE: PageState = { authPresent: false, token: null, url: '', connected: false }

/** 简单异步队列：把消息事件流转换成 async iterable */
class AsyncQueue<T> {
  private items: T[] = []
  private waiters: ((v: T) => void)[] = []

  push(item: T): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(item)
    else this.items.push(item)
  }

  async next(): Promise<T> {
    const item = this.items.shift()
    if (item !== undefined) return item
    return new Promise<T>((resolve) => this.waiters.push(resolve))
  }
}

type StreamSignal =
  | { kind: 'event'; event: LlmStreamEvent }
  | { kind: 'done' }
  | { kind: 'error'; error: string }

export default defineBackground(() => {
  // 官方 settings 运行时（cordis + schemastery + SettingsProvider 打包产物）：
  // importScripts 是经典 SW 的同步全局加载，必须在任何异步工作前执行。
  ensureOfficialSettingsRuntime()

  let pageState: PageState = { ...INITIAL_STATE }
  /** 页面所在 tab（向 content script 发消息用） */
  let pageTabId: number | undefined
  // 会话内复用的 chat_session_id（多轮连续）
  let currentSessionId: string | undefined
  // agent 循环的会话消息历史（含 tool 结果回填）
  let sessionMessages: Message[] = []
  // skill 库（运行时经插件加载器填充）
  let skills: Skill[] = []

  const panelPorts = new Set<chrome.runtime.Port>()
  let requestSeq = 0

  /** 供 panel-query 使用的共享工作区（懒加载） */
  let queryWs: Workspace | null = null
  async function getQueryWs(): Promise<Workspace> {
    if (!queryWs) {
      queryWs = new Workspace({ sandboxMode: 'workspace-write', dbName: 'dsh-in-web-workspace' })
      await queryWs.init()
    }
    return queryWs
  }

  /** 通知所有已连接 side panel */
  function broadcast(topic: string, payload: unknown) {
    for (const port of panelPorts) {
      try {
        port.postMessage({ topic, payload })
      } catch {
        // port 可能已断开
      }
    }
    // 也通过 sendMessage 兜底（panel 可能只挂 onMessage）
    chrome.runtime.sendMessage({ topic, payload }).catch(() => {
      // 无监听者，静默
    })
  }

  function pushBridgeEvent(ev: BridgeEventMessage) {
    broadcast('bridge-event', ev)
  }

  /** 向 content script 发消息（页面 origin 的 LLM 网络宿主） */
  async function sendToPage(message: Record<string, unknown>): Promise<void> {
    if (pageTabId == null) throw new Error('页面未连接（请打开 chat.deepseek.com）')
    await chrome.tabs.sendMessage(pageTabId, message)
  }

  // ── 页面消息（bridge 上报 MAIN world 的 page-ready 等）──
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (typeof message !== 'object' || message === null) return
    const { topic } = message as { topic?: unknown }

    if (topic === 'page-event') {
      const payload = (message as { payload?: unknown }).payload as
        | { topic: string; payload?: unknown }
        | undefined
      if (payload?.topic === 'page-ready') {
        const p = payload.payload as { authPresent: boolean; token: string | null; url: string }
        pageState = {
          authPresent: Boolean(p?.authPresent),
          token: typeof p?.token === 'string' && p.token ? p.token : null,
          url: typeof p?.url === 'string' ? p.url : '',
          connected: true,
        }
        if (sender.tab?.id != null) pageTabId = sender.tab.id
        broadcast('page-state', pageState)
      }
      sendResponse({ ok: true })
      return true
    }

    if (topic === 'open-panel') {
      void openSidePanel(sender.tab?.id)
      sendResponse({ ok: true })
      return
    }

    // ── side panel 命令 ──────────────────────────────
    if (topic === 'send-message') {
      const { messages, reasoning, search } =
        (message as { payload?: { messages: Message[]; reasoning?: boolean; search?: boolean } }).payload ?? {}
      void runStream(messages ?? [], reasoning ?? false, search ?? false)
      sendResponse({ ok: true })
      return
    }
    if (topic === 'stop-stream') {
      if (currentRequestId) {
        void sendToPage({ topic: EXT_TOPIC_CHAT_STREAM_STOP, payload: { requestId: currentRequestId } }).catch(
          () => {},
        )
        currentRequestId = undefined
      }
      pushBridgeEvent({ kind: 'error', error: 'stopped' })
      sendResponse({ ok: true })
      return
    }
    if (topic === 'clear-session') {
      currentSessionId = undefined
      sendResponse({ ok: true })
      return
    }

    // ── Side Panel 数据查询（文件树 / skill 库 / 真实工作区）────────────────
    if (topic === 'panel-query') {
      const { cmd, path, title } =
        (message as { payload?: { cmd?: string; path?: string; title?: string } }).payload ?? {}
      void (async () => {
        try {
          if (cmd === 'list-files') {
            const ws = await getQueryWs()
            const root = await ws.list('/')
            sendResponse({ ok: true, entries: root })
          } else if (cmd === 'read-file' && path) {
            // 真实文件夹工作区路径（file://...）走真实 handle 读取；其余走虚拟 Workspace
            if (isRealDirPath(path)) {
              const resolved = await resolveRealDirectory(path)
              if (!resolved) {
                sendResponse({ ok: false, error: `real directory not found: ${path}` })
                return
              }
              const rws = new RealDirectoryWorkspace(resolved.handle)
              const content = await rws.readText(resolved.rel)
              sendResponse({ ok: true, content: content ?? null })
              return
            }
            const ws = await getQueryWs()
            const content = await ws.readText(path)
            sendResponse({ ok: true, content: content ?? null })
          } else if (cmd === 'list-skills') {
            sendResponse({ ok: true, skills })
          } else if (cmd === 'create-real-workspace' && path) {
            // 真实文件夹工作区：句柄已由 side panel 经 dir-handles 存入 IndexedDB，
            // 这里校验 handle 存在后复用 workspace.create 建记录（幂等）。
            const handle = await getDirectoryHandle(workspaceIdFromPath(path))
            if (!handle) {
              sendResponse({ ok: false, error: `directory handle not found: ${path}（请先在侧栏选择文件夹）` })
              return
            }
            const result = await dshWorkspaceCreate({ path, title })
            sendResponse(result.ok ? { ok: true } : { ok: false, error: (result.error)?.message ?? 'create failed' })
          } else {
            sendResponse({ ok: false, error: `unknown query: ${cmd}` })
          }
        } catch (err) {
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      })()
      return true // 异步 sendResponse
    }
  })

  let currentRequestId: string | undefined

  /** LLM 桥：把 agent loop 的 LLM 调用转成 content script 的流式聊天 */
  async function* llmBridge(hist: Message[]): AsyncGenerator<LlmStreamEvent> {
    const requestId = `req-${Date.now()}-${requestSeq++}`
    currentRequestId = requestId
    const queue = new AsyncQueue<StreamSignal>()
    const listener = (msg: unknown) => {
      if (typeof msg !== 'object' || msg === null) return
      const m = msg as { topic?: unknown; payload?: unknown }
      const p = m.payload as { requestId?: string; sessionId?: string } | undefined
      if (p?.requestId !== requestId) return
      if (m.topic === EXT_TOPIC_CHAT_STREAM_EVENT) {
        const ev = (m.payload as ChatStreamEventPayload).event
        queue.push({ kind: 'event', event: ev })
      } else if (m.topic === EXT_TOPIC_CHAT_STREAM_DONE) {
        // persistSession 开启时把本次实际使用的会话存下，供下一轮复用
        if (currentPersistSession && typeof p?.sessionId === 'string' && p.sessionId) {
          currentSessionId = p.sessionId
        }
        queue.push({ kind: 'done' })
      } else if (m.topic === EXT_TOPIC_CHAT_STREAM_ERROR) {
        queue.push({ kind: 'error', error: (m.payload as { error: string }).error })
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    try {
      const payload: ChatStreamStartPayload = {
        requestId,
        messages: hist,
        reasoning: currentReasoning,
        search: currentSearch,
        chatSessionId: currentSessionId,
      }
      await sendToPage({ topic: EXT_TOPIC_CHAT_STREAM_START, payload })
      while (true) {
        const sig = await queue.next()
        if (sig.kind === 'done') return
        if (sig.kind === 'error') throw new Error(sig.error)
        yield sig.event
      }
    } finally {
      chrome.runtime.onMessage.removeListener(listener)
      if (currentRequestId === requestId) currentRequestId = undefined
    }
  }

  let currentReasoning = false
  let currentSearch = false
  /** persistSession 设置快照（每次 runStream 时读取）——开启则多轮复用 chat_session */
  let currentPersistSession = false

  /**
   * dsh 会话的流式回调面：runStream 把 agent loop 的流式事件 / 结束 / 失败
   * 透传给调用方（dshSessionPrompt 据此实时回显 assistant/message）。
   * round 从 1 开始，即 agent loop 的第几轮 LLM 调用。
   */
  interface StreamSink {
    onEvent(ev: LlmStreamEvent, round: number): void
    onFinish(): void
    onError(error: string): void
  }

  /** 流式聊天编排 —— agent loop 驱动（多轮工具调用回填） */
  async function runStream(messages: Message[], reasoning: boolean, search: boolean, sink?: StreamSink, preset?: string) {
    currentReasoning = reasoning
    currentSearch = search
    currentPersistSession = (await getSettings()).persistSession
    if (!currentPersistSession) currentSessionId = undefined
    const ws = new Workspace({ sandboxMode: 'workspace-write', dbName: 'dsh-in-web-workspace' })
    try {
      await ws.init()
    } catch (err) {
      const message = `工作区初始化失败: ${err instanceof Error ? err.message : String(err)}`
      pushBridgeEvent({ kind: 'error', error: message })
      sink?.onError(message)
      return
    }

    try {
      const tools = buildAgentTools(ws, skills, preset)
      // 统一 persona 注入：任何入口（dsh 会话 / side panel 原生聊天）进入
      // runStream 时，若无 system 前缀则注入默认 persona；dsh 会话路径
      // （session.prompt）已按 agentPreset 注入 system，此处跳过避免重复。
      const injected: Message[] =
        messages.length > 0 && messages[0]?.role === 'system'
          ? messages
          : [{ role: 'system', content: DEFAULT_PERSONA }, ...messages]
      const result = await runAgentLoop({
        llm: llmBridge,
        tools,
        messages: injected,
        maxTurns: 8,
        onEvent: (ev, round) => {
          if (ev.kind === 'thinking') pushBridgeEvent({ kind: 'thinking', text: ev.text })
          else if (ev.kind === 'text') pushBridgeEvent({ kind: 'text', text: ev.text })
          sink?.onEvent(ev, round)
        },
      })
      pushBridgeEvent({ kind: 'finish' })
      // 更新会话内消息历史供下一轮连续对话（保留 tool 结果）
      sessionMessages = result.messages
      sink?.onFinish()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      pushBridgeEvent({ kind: 'error', error: message })
      sink?.onError(message)
    }
  }

  async function openSidePanel(tabId?: number) {
    try {
      if (tabId != null) {
        await chrome.sidePanel.open({ tabId })
      } else {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
        if (tab?.id != null) await chrome.sidePanel.open({ tabId: tab.id })
      }
    } catch {
      // 非用户手势上下文会拒绝，静默
    }
  }

  // 工具图标点击 → 打开 side panel
  chrome.action.onClicked.addListener((tab) => {
    void openSidePanel(tab.id)
  })

  // 键盘命令 → 打开 side panel
  chrome.commands.onCommand.addListener((command) => {
    if (command === 'open-side-panel') {
      void openSidePanel()
    }
  })

  // ── 长 port：side panel ↔ SW 保活 + 推送通道 ──────────
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PANEL_PORT) return
    panelPorts.add(port)
    port.onDisconnect.addListener(() => {
      panelPorts.delete(port)
    })
    port.postMessage({ topic: 'page-state', payload: pageState })
  })

  // ===== dsh UI bridge skeleton =====
  // dsh UI（public/dsh-web iframe）经 chrome.runtime 与本 SW 通信，协议预先约定：
  //  - unary：iframe sendMessage({ kind: 'dsh-rpc', method, body: ClientRequest 全形 })，
  //    本端回 { kind: 'dsh-rpc:result', body: ServerResponse 全形 }，rpcId 原样回显（client 校验 echo）
  //  - stream：iframe connect({ name: 'dsh-stream' })，订阅 { kind: 'dsh-stream-subscribe', stream }，
  //    本端回 { kind: 'dsh-stream-ok', body: { stream } }
  // 线格式对齐 deepseek-harness apiproxy 的 rpc.schema.js（serverResponseSchema / rpcErrorSchema）

  interface DshClientRequest {
    readonly type: 'client-request'
    readonly rpcId: string
    readonly method: string
    readonly payload?: unknown
  }

  /** rpcErrorSchema 要求 code/message/details 三字段（details 必填）；details 按 code 分支对齐，允许任意键值 */
  interface DshRpcError {
    readonly code: string
    readonly message: string
    readonly details: Readonly<Record<string, unknown>>
  }

  type DshRpcResult =
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: DshRpcError }

  interface DshServerResponse {
    readonly type: 'server-response'
    readonly rpcId: string
    readonly result: DshRpcResult
  }

  interface DshRpcReply {
    readonly kind: 'dsh-rpc:result'
    readonly body: DshServerResponse
  }

  interface DshRpcEnvelope {
    readonly kind: 'dsh-rpc'
    readonly method?: unknown
    readonly body?: unknown
  }

  function isDshRpcEnvelope(message: unknown): message is DshRpcEnvelope {
    return (
      typeof message === 'object' &&
      message !== null &&
      (message as { kind?: unknown }).kind === 'dsh-rpc'
    )
  }

  function isDshClientRequest(body: unknown): body is DshClientRequest {
    if (typeof body !== 'object' || body === null) return false
    const b = body as { type?: unknown; rpcId?: unknown; method?: unknown }
    return b.type === 'client-request' && typeof b.rpcId === 'string' && typeof b.method === 'string'
  }

  /** 组装 ServerResponse 全形（rpcId 必须回显，client 端校验一致） */
  function dshResponse(rpcId: string, result: DshRpcResult): DshServerResponse {
    return { type: 'server-response', rpcId, result }
  }

  /** host.describe 最小可用桩（对齐 hostDescribeValueSchema：version+cwd 必填，attachedSessions 为 int >= 0） */
  function dshDescribeValue(): { version: string; cwd: string; attachedSessions: number; canOpenPath: boolean } {
    return { version: '0.1.0-dsh-in-web-bridge', cwd: '<dsh-in-web>', attachedSessions: 0, canOpenPath: false }
  }

  /** 未桥接方法：返回合法错误包络，让 UI 显示干净错误而非崩溃 */
  function dshNotImplemented(method: string): DshRpcResult {
    return { ok: false, error: { code: 'internal', message: `dsh RPC not yet bridged: ${method}`, details: {} } }
  }

  // ── dsh RPC 真实数据桥接 ──────────────────────────────────────────
  // 分派表把 harness 的 RPC 方法映射到本地能力：
  //  - host.describe / session.*（经 chat-stream 桥）/ workspace.* / skill.list /
  //    settings.*（chrome.storage）/ llm.* 返回真实或合理数据
  //  - 其余方法（subagent/goal/agentPreset/credentials/host 目录等）返回合法错误包络
  // value 形状对齐 deepseek-harness apiproxy 各 domain 的 Value schema，
  // 客户端 AbstractApiClient 会做第二层 zod 校验（UNARY_VALUE_SCHEMAS）。

  /** 固定单工作区（本地 IndexedDB 虚拟 FS 映射为 harness 的一个 workspace 实体） */
  const DSH_WORKSPACE_ID = 'dsh-in-web'
  /** 网页对话工作区：承载网页版 chat.deepseek.com 的会话数据（默认工作区） */
  const DSH_WEB_CHAT_WORKSPACE_TITLE = '网页对话'
  const DSH_WORKSPACE_CREATED_AT = new Date().toISOString()

  /** 固定模型目录（llm.models / session.models 共用；参考 utils/bridge/protocol.ts 的模型面） */
  const DSH_MODEL_GROUPS: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly models: ReadonlyArray<{ readonly id: string; readonly name: string }>
  }> = [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat' },
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
      ],
    },
  ]

  /** harness workspaceViewSchema 形状（workspaceId/path/title/sessionIds/createdAt/updatedAt） */
  interface DshWorkspaceView {
    workspaceId: string
    path: string
    title: string
    sessionIds: string[]
    createdAt: string
    updatedAt: string
  }

  // ── workspace 记录持久化（chrome.storage.local）────────────────────
  // workspace.create 真正创建一条记录并写入 dsh-workspaces；workspace.list
  // 读回全部记录。同一 path 幂等（created: false），对齐官方 adoption 语义。
  const DSH_WORKSPACES_KEY = 'dsh-workspaces'

  /** 真实创建的工作区记录（workspaceViewSchema 的持久化形态） */
  interface DshWorkspaceRecord {
    workspaceId: string
    path: string
    title: string
    sessionIds: string[]
    createdAt: string
    updatedAt: string
  }

  function isDshWorkspaceRecord(value: unknown): value is DshWorkspaceRecord {
    if (typeof value !== 'object' || value === null) return false
    const r = value as Record<string, unknown>
    return typeof r.workspaceId === 'string'
      && typeof r.path === 'string'
      && typeof r.title === 'string'
      && Array.isArray(r.sessionIds)
      && typeof r.createdAt === 'string'
      && typeof r.updatedAt === 'string'
  }

  async function readWorkspaces(): Promise<DshWorkspaceRecord[]> {
    try {
      const stored = await chrome.storage.local.get(DSH_WORKSPACES_KEY)
      const list = stored[DSH_WORKSPACES_KEY]
      if (!Array.isArray(list)) return []
      return list.filter(isDshWorkspaceRecord)
    } catch {
      return []
    }
  }

  async function writeWorkspaces(records: DshWorkspaceRecord[]): Promise<void> {
    try {
      await chrome.storage.local.set({ [DSH_WORKSPACES_KEY]: records })
    } catch {
      // 写失败静默（非扩展环境）
    }
  }

  /**
   * 虚拟盘符集合（Windows 常见盘符）。浏览器沙盒内是逻辑分区——
   * 全部落在同一个 IndexedDB Workspace，按 `C:/` 前缀分区。
   */
  const DSH_DRIVES: readonly string[] = ['C:', 'D:', 'E:', 'F:', 'G:']

  /** 盘符路径归一化：C:\foo → C:/foo，去掉尾部斜杠（C:/ → C:） */
  function normalizeDrivePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+$/, '')
  }

  /**
   * 构造目录浏览的面包屑链：盘符路径（C:/foo）首段为盘符本身
   * （path 为 C:，点击可跳回盘符根），其余段逐级累积。
   */
  function buildCrumbs(path: string): { name: string; path: string; hidden: false }[] {
    const driveMatch = /^([A-Za-z]:)(?:\/(.*))?$/.exec(path)
    if (driveMatch) {
      const drive = driveMatch[1]!
      const rest = driveMatch[2] ?? ''
      const crumbs: { name: string; path: string; hidden: false }[] = [
        { name: drive, path: drive, hidden: false },
      ]
      if (!rest) return crumbs
      let acc = drive
      for (const seg of rest.split('/').filter(Boolean)) {
        acc += '/' + seg
        crumbs.push({ name: seg, path: acc, hidden: false })
      }
      return crumbs
    }
    let acc = ''
    return path
      .split('/')
      .filter(Boolean)
      .map((seg) => {
        acc += '/' + seg
        return { name: seg, path: acc, hidden: false }
      })
  }

  /**
   * 把真实工作区浏览路径解析为 { workspace 记录, 目录句柄, 相对路径 }。
   * 路径形如 file://<name>[/sub...]：先匹配工作区记录（path 前缀），
   * 再从 IndexedDB 恢复该 workspaceId 的 FileSystemDirectoryHandle。
   * 非真实路径返回 null（走虚拟 Workspace 逻辑）。
   */
  async function resolveRealDirectory(
    path: string,
  ): Promise<{ workspace: DshWorkspaceRecord; handle: FileSystemDirectoryHandle; rel: string } | null> {
    if (!isRealDirPath(path)) return null
    const records = await readWorkspaces()
    const workspace = records.find(
      (r) => r.path.startsWith(REAL_DIR_PREFIX) && (path === r.path || path.startsWith(`${r.path}/`)),
    )
    if (!workspace) return null
    const handle = await getDirectoryHandle(workspace.workspaceId)
    if (!handle) return null
    const rel = path.slice(workspace.path.length).replace(/^\/+/, '')
    return { workspace, handle, rel }
  }

  /**
   * 构造真实工作区浏览的面包屑链：file://<name> 为根段（跳回文件夹根），
   * 其余段（sub/...）逐级累积。
   */
  function buildRealCrumbs(
    root: string,
    rel: string,
  ): { name: string; path: string; hidden: false }[] {
    const crumbs: { name: string; path: string; hidden: false }[] = [
      { name: realDirBaseName(root), path: root, hidden: false },
    ]
    if (!rel) return crumbs
    let acc = root
    for (const seg of rel.split('/').filter(Boolean)) {
      acc += '/' + seg
      crumbs.push({ name: seg, path: acc, hidden: false })
    }
    return crumbs
  }

  /** path 兜底：缺失时回落虚拟根路径；虚拟路径标识（<...>）原样保留 */
  function normalizeWorkspacePath(path: unknown): string {
    if (typeof path !== 'string' || !path.trim()) return `<${DSH_WORKSPACE_ID}>`
    const trimmed = path.trim()
    if (trimmed.startsWith('<')) return trimmed
    // 真实文件夹工作区路径标记（file://<name>[/...]）：原样保留，不做盘符/斜杠改写
    if (trimmed.startsWith(REAL_DIR_PREFIX)) return trimmed
    // 盘符路径（C:/foo / C:\foo / C:）：保留盘符前缀，不再强制加 '/'
    if (/^[A-Za-z]:/.test(trimmed)) return normalizeDrivePath(trimmed)
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  }

  /** 默认标题：path 的 basename（去掉虚拟路径尖括号）；无法取名时回落默认工作区 id */
  function workspaceBasename(path: string): string {
    const cleaned = path.replace(/^<(.+)>$/, '$1').replace(/\/+$/, '')
    const idx = cleaned.lastIndexOf('/')
    const base = idx < 0 ? cleaned : cleaned.slice(idx + 1)
    return base || DSH_WORKSPACE_ID
  }

  function toWorkspaceView(record: DshWorkspaceRecord): DshWorkspaceView {
    return {
      workspaceId: record.workspaceId,
      path: record.path,
      title: record.title,
      sessionIds: record.sessionIds,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  let virtualSessionSeq = 0
  function mintVirtualSessionId(): string {
    virtualSessionSeq += 1
    return `sess-${Date.now()}-${virtualSessionSeq}`
  }

  /**
   * 虚拟会话注册表：session.create / session.fork 写入，session.list 读回。
   * 每个会话额外持有事件日志（user/message + assistant/message 等），
   * 供 session.history 读回（多轮上下文可见）以及 mux 流实时回显。
   * 让 UI 的 currentSession() 能取到 blank session 及 agentPreset ——
   * dsh-client-ui-agent-preset 的 select 逻辑依赖
   * `session.blank && session.agentPreset !== staged` 才 apply。
   */

  // ── 会话事件类型（对齐 @deepseek-ai/dsh-session SessionEvent 的 wire 形状）──
  // 仅声明本次回显核心用到的类型；事件必须带 surfaceOp:'append'，
  // 否则客户端 isAppendSurfaceEvent 判定为假、不会渲染到会话视图。
  interface DshContentBlockText {
    type: 'text'
    text: string
  }
  interface DshContentBlockReasoning {
    type: 'reasoning'
    text: string
  }
  type DshContentBlock = DshContentBlockText | DshContentBlockReasoning

  /** 会话边界事件（turn/start、turn/end、step/start、step/end）——客户端按 turn/step 分组渲染 */
  interface DshTurnStartEvent {
    type: 'turn/start'
    seq: number
    time: number
    data: { turn: number }
  }
  interface DshTurnEndEvent {
    type: 'turn/end'
    seq: number
    time: number
    data: { turn: number; reason: { kind: 'completed' } | { kind: 'error'; error: { message: string; code: string } } }
  }
  interface DshStepStartEvent {
    type: 'step/start'
    seq: number
    time: number
    data: { turn: number; step: number }
  }
  interface DshStepEndEvent {
    type: 'step/end'
    seq: number
    time: number
    data: { turn: number; step: number }
  }

  interface DshUserMessageEvent {
    type: 'user/message'
    seq: number
    time: number
    data: {
      id: string
      role: 'user'
      content: DshContentBlockText[]
      source: { kind: 'user' }
    }
    surfaceOp: 'append'
  }

  /** assistant/message：thinking + text 合并进 content blocks（方式 B 消息级回显） */
  interface DshAssistantMessageEvent {
    type: 'assistant/message'
    seq: number
    time: number
    data: {
      turn: number
      step: number
      message: {
        id: string
        role: 'assistant'
        content: DshContentBlock[]
        source: { kind: 'model'; provider: string; model: string }
      }
    }
    surfaceOp: 'append'
  }

  /** tool-result 块（对齐 @deepseek-ai/dsh-session toolResultBlock schema） */
  interface DshToolResultBlock {
    type: 'tool-result'
    toolCallId: string
    content: DshContentBlockText[]
    isError: boolean
  }

  /** tool/call：agent 决定调用工具（工具名 + JSON 参数） */
  interface DshToolCallEvent {
    type: 'tool/call'
    seq: number
    time: number
    data: {
      turn: number
      step: number
      callId: string
      name: string
      arguments: string
    }
  }

  /** tool/result：工具执行结果以 user 消息（source kind:'tool'）回填，callId 与 tool/call 配对 */
  interface DshToolResultEvent {
    type: 'tool/result'
    seq: number
    time: number
    data: {
      turn: number
      step: number
      message: {
        role: 'user'
        content: DshToolResultBlock[]
        source: { kind: 'tool'; callId: string }
      }
    }
  }

  type DshSessionEvent =
    | DshTurnStartEvent
    | DshTurnEndEvent
    | DshStepStartEvent
    | DshStepEndEvent
    | DshUserMessageEvent
    | DshAssistantMessageEvent
    | DshToolCallEvent
    | DshToolResultEvent

  interface VirtualSessionRecord {
    agentPreset?: string
    /** 所属工作区 path（session.create 携带 workspaceId 时写入；session.list 的 cwd 字段） */
    cwd?: string
    blank: boolean
    createdAt: number
    /** 最后活动时间（session.list 的 updatedAt） */
    updatedAt: number
    /** 是否正在运行（session.list 的 running；host/session-status 据此推送） */
    running: boolean
    /** 事件日志（seq 连续递增，顺序即 seq 顺序） */
    events: DshSessionEvent[]
    /** 最后一个事件的 seq（空日志为 0） */
    seq: number
    /** 最近一次 prompt 使用的 turn 编号 */
    turn: number
  }

  const virtualSessions = new Map<string, VirtualSessionRecord>()

  function newVirtualSession(agentPreset?: string, cwd?: string): VirtualSessionRecord {
    const now = Date.now()
    return {
      ...(agentPreset !== undefined ? { agentPreset } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      blank: true,
      createdAt: now,
      updatedAt: now,
      running: false,
      events: [],
      seq: 0,
      turn: 0,
    }
  }

  /** 事件块转纯文本（只取 text 块；reasoning 不进模型上下文） */
  function extractEventText(content: readonly DshContentBlock[]): string {
    return content
      .filter((block): block is DshContentBlockText => block.type === 'text')
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join('\n\n')
  }

  /**
   * 从会话事件日志构建 runStream 的消息历史（多轮上下文）。
   * assistant/message 同 (turn,step) 的多次增量更新只取最后一次（完整内容）。
   */
  function sessionHistoryMessages(rec: VirtualSessionRecord): Message[] {
    const assistantLast = new Map<string, number>()
    for (let i = 0; i < rec.events.length; i += 1) {
      const event = rec.events[i]
      if (event === undefined || event.type !== 'assistant/message') continue
      assistantLast.set(`${event.data.turn}:${event.data.step}`, i)
    }
    const messages: Message[] = []
    const addedAssistant = new Set<string>()
    for (let i = 0; i < rec.events.length; i += 1) {
      const event = rec.events[i]
      if (event === undefined) continue
      if (event.type === 'user/message') {
        const text = extractEventText(event.data.content)
        if (text) messages.push({ role: 'user', content: text })
      } else if (event.type === 'assistant/message') {
        const key = `${event.data.turn}:${event.data.step}`
        if (assistantLast.get(key) !== i || addedAssistant.has(key)) continue
        addedAssistant.add(key)
        const text = extractEventText(event.data.message.content)
        if (text) messages.push({ role: 'assistant', content: text })
      }
    }
    return messages
  }

  // ── dsh 流帧（mux / host）与推送 ─────────────────────────────
  // 客户端（BridgeApiClient.readStream）期望 `{ kind:'dsh-stream-frame',
  // body: ServerRequest }`；ServerRequest.method 即帧自身的 type，
  // payload 即帧本身（对齐 host fetch/handler.ts 的组装）。
  interface DshMuxEventFrame {
    type: 'session/event'
    sessionId: string
    event: DshSessionEvent
  }
  interface DshMuxSubscribedFrame {
    type: 'session/subscribed'
    sessionId: string
    lastSeq: number
  }
  type DshMuxFrame = DshMuxEventFrame | DshMuxSubscribedFrame

  interface DshHostStatusFrame {
    type: 'host/session-status'
    sessionId: string
    running: boolean
  }
  interface DshHostAddedFrame {
    type: 'host/session-added'
    sessionId: string
    blank: boolean
    agentPreset?: string
  }
  type DshHostFrame = DshHostStatusFrame | DshHostAddedFrame

  function pushDshStreamFrame(port: chrome.runtime.Port, frame: DshMuxFrame | DshHostFrame): void {
    try {
      port.postMessage({
        kind: 'dsh-stream-frame',
        body: {
          type: 'server-request',
          rpcId: `push-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          method: frame.type,
          payload: frame,
        },
      })
    } catch {
      // 端口可能已断开，静默
    }
  }

  /** 向所有已订阅 mux 的端口广播一帧 */
  function broadcastMuxFrame(frame: DshMuxFrame): void {
    for (const port of dshStreamPorts) {
      if (dshStreamPortStreams.get(port) !== 'mux') continue
      pushDshStreamFrame(port, frame)
    }
  }

  /** 向所有已订阅 host 的端口广播一帧 */
  function broadcastHostFrame(frame: DshHostFrame): void {
    for (const port of dshStreamPorts) {
      if (dshStreamPortStreams.get(port) !== 'host') continue
      pushDshStreamFrame(port, frame)
    }
  }

  /** 记录一个会话事件并广播到 mux 端口（seq 由调用方递增，保持连续） */
  function appendSessionEvent(sessionId: string, rec: VirtualSessionRecord, event: DshSessionEvent): void {
    rec.events.push(event)
    rec.updatedAt = event.time
    broadcastMuxFrame({ type: 'session/event', sessionId, event })
  }

  /** 提取 session.prompt content 里的纯文本（text 类型 part） */
  function extractPromptText(content: unknown): string {
    if (!Array.isArray(content)) return ''
    const parts: string[] = []
    for (const part of content) {
      if (typeof part !== 'object' || part === null) continue
      const p = part as { type?: unknown; text?: unknown }
      if (p.type !== 'text') continue
      const text = typeof p.text === 'string' ? p.text.trim() : ''
      if (text) parts.push(text)
    }
    return parts.join('\n\n')
  }

  type DshRpcHandler = (payload: unknown) => DshRpcResult | Promise<DshRpcResult>

  // ── session.* ────────────────────────────────────────────────
  /**
   * 把会话关联到指定工作区：cwd = workspace.path，sessionId 并入
   * workspace.sessionIds 并持久化（dsh-workspaces）。「网页对话」工作区
   * （DSH_WORKSPACE_ID）不在 storage 时（默认/首次场景）补一条记录再关联；
   * 其余 workspaceId 找不到记录则返回 undefined（不关联，会话保持游离）。
   * 返回关联后的 cwd（即工作区 path），供调用方写入 VirtualSessionRecord。
   */
  async function linkSessionToWorkspace(
    sessionId: string,
    workspaceId: string,
  ): Promise<string | undefined> {
    const records = await readWorkspaces()
    const existing = records.find((r) => r.workspaceId === workspaceId)
    const ws: DshWorkspaceRecord | undefined =
      existing ?? (workspaceId === DSH_WORKSPACE_ID ? await thisWebChatWorkspace() : undefined)
    if (!ws) return undefined
    const sessionIds = ws.sessionIds.includes(sessionId)
      ? ws.sessionIds
      : [...ws.sessionIds, sessionId]
    if (sessionIds.length !== ws.sessionIds.length) {
      const next: DshWorkspaceRecord = { ...ws, sessionIds, updatedAt: new Date().toISOString() }
      const base = existing !== undefined ? records : [...records, ws]
      await writeWorkspaces(base.map((r) => (r.workspaceId === ws.workspaceId ? next : r)))
    }
    return ws.path
  }

  async function dshSessionCreate(payload: unknown): Promise<DshRpcResult> {
    const p = (payload ?? {}) as { sessionId?: unknown; agentPreset?: unknown; workspaceId?: unknown }
    const sessionId = typeof p.sessionId === 'string' && p.sessionId ? p.sessionId : mintVirtualSessionId()
    // sessionCreateRequestSchema 的 agentPreset 可选：透传回 value（undefined 时省略，schema optional）
    const agentPreset = typeof p.agentPreset === 'string' && p.agentPreset ? p.agentPreset : undefined
    // sessionCreateRequestSchema 的 workspaceId：显式有效 → 关联该工作区
    // （cwd=workspace.path + sessionId 并入 sessionIds，让 connectWorkspace 复用命中）；
    // 无效/找不到 → 不关联（cwd undefined）但创建仍成功；
    // 未携带 → 默认关联「网页对话」工作区（新会话默认挂在它下面，网页对话才有内容）。
    const workspaceId = typeof p.workspaceId === 'string' && p.workspaceId ? p.workspaceId : DSH_WORKSPACE_ID
    const cwd = await linkSessionToWorkspace(sessionId, workspaceId)
    virtualSessions.set(sessionId, newVirtualSession(agentPreset, cwd))
    // host 流：会话创建即推 host/session-added（blank 恒为 true，客户端在首个 running 翻转）
    broadcastHostFrame({ type: 'host/session-added', sessionId, blank: true, ...(agentPreset !== undefined ? { agentPreset } : {}) })
    return {
      ok: true,
      value: {
        sessionId,
        ...(agentPreset !== undefined ? { agentPreset } : {}),
      },
    }
  }

  /** session.list：读回虚拟会话注册表，映射 sessionSummarySchema 形状（含 cwd） */
  function dshSessionList(): DshRpcResult {
    const items = [...virtualSessions.entries()].map(([sessionId, rec]) => ({
      sessionId,
      updatedAt: rec.updatedAt,
      running: rec.running,
      blank: rec.blank,
      ...(rec.cwd !== undefined ? { cwd: rec.cwd } : {}),
      ...(rec.agentPreset !== undefined ? { agentPreset: rec.agentPreset } : {}),
    }))
    return { ok: true, value: { items } }
  }

  async function dshSessionPrompt(payload: unknown): Promise<DshRpcResult> {
    const p = (payload ?? {}) as { sessionId?: unknown; content?: unknown }
    const text = extractPromptText(p.content)
    if (!text) {
      return {
        ok: false,
        error: { code: 'bad-request', message: 'session.prompt: empty text content', details: { issues: [] } },
      }
    }
    const sessionId = typeof p.sessionId === 'string' && p.sessionId ? p.sessionId : mintVirtualSessionId()
    let rec = virtualSessions.get(sessionId)
    if (!rec) {
      rec = newVirtualSession()
      virtualSessions.set(sessionId, rec)
    }
    // 兜底关联：会话尚未关联任何工作区（历史遗留 / 未带 workspaceId 创建）时，
    // 挂到「网页对话」工作区，保证网页对话能看到对话内容。
    if (rec.cwd === undefined) {
      const cwd = await linkSessionToWorkspace(sessionId, DSH_WORKSPACE_ID)
      if (cwd !== undefined) rec.cwd = cwd
    }
    if (rec.running) {
      // 已有流在跑：拒绝并发 prompt（UI 运行中禁用输入，仅防御）
      return {
        ok: false,
        error: { code: 'busy', message: 'session.prompt: session is already running', details: {} },
      }
    }

    // 1) 打开 turn + 记录并回显 user/message；blank 会话在首个 prompt 接受后翻转
    rec.turn += 1
    const turn = rec.turn
    appendSessionEvent(sessionId, rec, {
      type: 'turn/start',
      seq: ++rec.seq,
      time: Date.now(),
      data: { turn },
    })
    const userEvent: DshUserMessageEvent = {
      type: 'user/message',
      seq: ++rec.seq,
      time: Date.now(),
      data: {
        id: crypto.randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      },
      surfaceOp: 'append',
    }
    appendSessionEvent(sessionId, rec, userEvent)
    if (rec.blank) rec.blank = false

    // 2) 运行状态置真 + host 帧（session.list 与 sidebar 据此显示 running）
    rec.running = true
    broadcastHostFrame({ type: 'host/session-status', sessionId, running: true })

    // 3) 多轮上下文：把该会话历史消息（含刚加入的 user）传给 runStream。
    //    dsh 会话自带完整历史，web 侧不再复用旧 chat_session（避免服务端历史重复）。
    const history = sessionHistoryMessages(rec)
    // 3.1) Agent 预设 persona 注入（Layer 0+1）：会话选了 agent 预设时，把该预设的
    //      persona（+ 能力说明 + 工具提示）作为 system message 放到历史最前；
    //      无预设走「网页对话」通用 persona。仅在历史没有 system 前缀时注入，
    //      避免多轮重复（sessionHistoryMessages 只产出 user/assistant，此处为防御）。
    const messages: Message[] =
      history.length > 0 && history[0]?.role === 'system'
        ? history
        : [
            { role: 'system', content: presetSystemPrompt(rec.agentPreset, { cwd: rec.cwd }) },
            ...history,
          ]
    currentSessionId = undefined

    // 4) 订阅流式事件，边收边实时回显 assistant/message（方式 B：同 messageId
    //    的增量更新会被客户端按 (turn,step) 原地替换，最终落一条完整消息）。
    let currentRound = 0
    let messageId = crypto.randomUUID()
    let thinking = ''
    let textSoFar = ''
    let lastPush = 0

    const buildContent = (): DshContentBlock[] => {
      const content: DshContentBlock[] = []
      if (thinking) content.push({ type: 'reasoning', text: thinking })
      if (textSoFar) content.push({ type: 'text', text: textSoFar })
      return content
    }

    const pushAssistantUpdate = (): void => {
      const content = buildContent()
      if (content.length === 0) return
      const now = Date.now()
      if (now - lastPush < 200) return
      lastPush = now
      const event: DshAssistantMessageEvent = {
        type: 'assistant/message',
        seq: ++rec.seq,
        time: now,
        data: {
          turn,
          step: Math.max(0, currentRound - 1),
          message: {
            id: messageId,
            role: 'assistant',
            content,
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          },
        },
        surfaceOp: 'append',
      }
      appendSessionEvent(sessionId, rec, event)
    }

    /** 结束当前 round：落一条完整 assistant/message + step/end（须已有 step/start） */
    const finalizeRound = (): void => {
      if (currentRound <= 0) return
      const content = buildContent()
      if (content.length > 0) {
        const event: DshAssistantMessageEvent = {
          type: 'assistant/message',
          seq: ++rec.seq,
          time: Date.now(),
          data: {
            turn,
            step: Math.max(0, currentRound - 1),
            message: {
              id: messageId,
              role: 'assistant',
              content,
              source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
            },
          },
          surfaceOp: 'append',
        }
        appendSessionEvent(sessionId, rec, event)
      }
      appendSessionEvent(sessionId, rec, {
        type: 'step/end',
        seq: ++rec.seq,
        time: Date.now(),
        data: { turn, step: Math.max(0, currentRound - 1) },
      })
    }

    /** 收尾：running 复位 + host 帧；重复调用幂等 */
    let settled = false
    const finishRunning = (): void => {
      if (settled) return
      settled = true
      if (rec.running) {
        rec.running = false
        broadcastHostFrame({ type: 'host/session-status', sessionId, running: false })
      }
    }

    const sessionSink: StreamSink = {
      onEvent: (ev, round) => {
        if (round !== currentRound) {
          // 进入新一轮（工具调用场景才有第 2+ 轮）：上一轮结束，新一轮打开
          if (currentRound > 0) finalizeRound()
          currentRound = round
          messageId = crypto.randomUUID()
          thinking = ''
          textSoFar = ''
          lastPush = 0
          appendSessionEvent(sessionId, rec, {
            type: 'step/start',
            seq: ++rec.seq,
            time: Date.now(),
            data: { turn, step: round - 1 },
          })
        }
        if (ev.kind === 'thinking' && ev.text) {
          thinking += ev.text
          pushAssistantUpdate()
        } else if (ev.kind === 'text' && ev.text) {
          textSoFar += ev.text
          pushAssistantUpdate()
        } else if (ev.kind === 'tool_call') {
          // 模型决定调用工具 → tool/call（callId 与随后的 tool/result 配对）
          appendSessionEvent(sessionId, rec, {
            type: 'tool/call',
            seq: ++rec.seq,
            time: Date.now(),
            data: {
              turn,
              step: Math.max(0, currentRound - 1),
              callId: ev.callId,
              name: ev.name,
              arguments: ev.arguments,
            },
          })
        } else if (ev.kind === 'tool_result') {
          // 工具执行结果 → tool/result（user 消息 + source kind:'tool'，对齐官方 schema）
          appendSessionEvent(sessionId, rec, {
            type: 'tool/result',
            seq: ++rec.seq,
            time: Date.now(),
            data: {
              turn,
              step: Math.max(0, currentRound - 1),
              message: {
                role: 'user',
                content: [
                  {
                    type: 'tool-result',
                    toolCallId: ev.callId,
                    content: [{ type: 'text', text: ev.output }],
                    isError: !ev.ok,
                  },
                ],
                source: { kind: 'tool', callId: ev.callId },
              },
            },
          })
        }
      },
      onFinish: () => {
        finalizeRound()
        appendSessionEvent(sessionId, rec, {
          type: 'turn/end',
          seq: ++rec.seq,
          time: Date.now(),
          data: { turn, reason: { kind: 'completed' } },
        })
        finishRunning()
      },
      onError: (error) => {
        finalizeRound()
        appendSessionEvent(sessionId, rec, {
          type: 'turn/end',
          seq: ++rec.seq,
          time: Date.now(),
          data: { turn, reason: { kind: 'error', error: { message: error, code: 'UNKNOWN' } } },
        })
        finishRunning()
      },
    }
    // 5) 第三方供应商分流：配置了 OpenAI 兼容供应商（dsh-llm-providers）→
    //    原生 function calling agent loop（工具调用真实工作）；
    //    未配置 → 回退网页 bridge（chat.deepseek.com 普通聊天）。
    const activeProvider = await getActiveLlmProvider()
    if (activeProvider) {
      void (async () => {
        try {
          const ws = new Workspace({ sandboxMode: 'workspace-write', dbName: 'dsh-in-web-workspace' })
          await ws.init()
          const tools = buildAgentTools(ws, skills, rec.agentPreset)
          const openAiMessages: OpenAiMessage[] = messages.map((m) => ({
            role: m.role,
            content: m.content,
          }))
          await runOpenAiAgentLoop({
            apiKey: activeProvider.apiKey,
            baseURL: activeProvider.baseURL,
            model: activeProvider.model,
            tools,
            messages: openAiMessages,
            maxTurns: 8,
            onEvent: sessionSink.onEvent,
          })
          sessionSink.onFinish()
        } catch (err) {
          sessionSink.onError(err instanceof Error ? err.message : String(err))
        }
      })()
    } else {
      void runStream(messages, currentReasoning, currentSearch, sessionSink, rec.agentPreset)
    }
    return { ok: true, value: { accepted: true } }
  }

  function dshSessionCancel(): DshRpcResult {
    if (currentRequestId) {
      void sendToPage({ topic: EXT_TOPIC_CHAT_STREAM_STOP, payload: { requestId: currentRequestId } }).catch(
        () => {},
      )
      currentRequestId = undefined
    }
    pushBridgeEvent({ kind: 'error', error: 'stopped' })
    return { ok: true, value: { accepted: true } }
  }

  function dshSessionSelectModel(payload: unknown): DshRpcResult {
    const p = (payload ?? {}) as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
    const provider = typeof p.provider === 'string' && p.provider ? p.provider : 'deepseek'
    const model = typeof p.model === 'string' && p.model ? p.model : 'deepseek-chat'
    const selected: { provider: string; model: string; reasoningEffort?: string } = { provider, model }
    if (typeof p.reasoningEffort === 'string' && p.reasoningEffort) selected.reasoningEffort = p.reasoningEffort
    return { ok: true, value: { selected } }
  }

  function dshSessionRename(payload: unknown): DshRpcResult {
    const p = (payload ?? {}) as { title?: unknown }
    const title = typeof p.title === 'string' && p.title.trim() ? p.title.trim() : 'Untitled'
    return { ok: true, value: { title, seq: 0 } }
  }

  function dshSessionFork(): DshRpcResult {
    // 虚拟子会话（无持久化，fork 即派发一个新的会话 id；同时写入注册表供 session.list 读回）
    const sessionId = mintVirtualSessionId()
    virtualSessions.set(sessionId, newVirtualSession())
    broadcastHostFrame({ type: 'host/session-added', sessionId, blank: true })
    return { ok: true, value: { sessionId } }
  }

  function dshSessionModels(): DshRpcResult {
    return {
      ok: true,
      value: {
        current: { provider: 'deepseek', model: 'deepseek-chat' },
        routable: true,
        groups: DSH_MODEL_GROUPS,
        failures: [],
      },
    }
  }

  // ── workspace.*（chrome.storage.local 真实持久化的工作区记录）────
  async function dshWorkspaceList(): Promise<DshRpcResult> {
    const records = await readWorkspaces()
    // 确保「网页对话」工作区始终在列（承载网页版会话；无记录时作为默认）
    if (records.length === 0) {
      return {
        ok: true,
        value: {
          items: [toWorkspaceView(await thisWebChatWorkspace())],
          archivedSessionIds: [],
        },
      }
    }
    return { ok: true, value: { items: records.map(toWorkspaceView), archivedSessionIds: [] } }
  }

  async function dshWorkspaceCreate(payload: unknown): Promise<DshRpcResult> {
    const p = (payload ?? {}) as { path?: unknown; title?: unknown }
    const path = normalizeWorkspacePath(p.path)
    const records = await readWorkspaces()
    // 官方 adoption 语义：同一 path 已归属某 workspace 时幂等返回（created: false）
    const existing = records.find((r) => r.path === path)
    if (existing) return { ok: true, value: { workspace: toWorkspaceView(existing), created: false } }
    const now = new Date().toISOString()
    const record: DshWorkspaceRecord = {
      workspaceId: workspaceIdFromPath(path),
      path,
      title: typeof p.title === 'string' && p.title.trim() ? p.title.trim() : workspaceBasename(path),
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    }
    await writeWorkspaces([...records, record])
    return { ok: true, value: { workspace: toWorkspaceView(record), created: true } }
  }

  async function dshWorkspaceRename(payload: unknown): Promise<DshRpcResult> {
    const p = (payload ?? {}) as { workspaceId?: unknown; title?: unknown }
    const workspaceId = typeof p.workspaceId === 'string' && p.workspaceId ? p.workspaceId : DSH_WORKSPACE_ID
    const title = typeof p.title === 'string' && p.title.trim() ? p.title.trim() : DSH_WORKSPACE_ID
    const records = await readWorkspaces()
    const record = records.find((r) => r.workspaceId === workspaceId)
    if (!record) {
      return { ok: false, error: { code: 'workspace-not-found', message: `workspace not found: ${workspaceId}`, details: { workspaceId } } }
    }
    const next: DshWorkspaceRecord = { ...record, title, updatedAt: new Date().toISOString() }
    await writeWorkspaces(records.map((r) => (r.workspaceId === workspaceId ? next : r)))
    return { ok: true, value: { workspace: toWorkspaceView(next) } }
  }

  async function dshWorkspaceDelete(payload: unknown): Promise<DshRpcResult> {
    const p = (payload ?? {}) as { workspaceId?: unknown }
    const workspaceId = typeof p.workspaceId === 'string' && p.workspaceId ? p.workspaceId : ''
    const records = await readWorkspaces()
    const next = records.filter((r) => r.workspaceId !== workspaceId)
    if (next.length === records.length) {
      return { ok: false, error: { code: 'workspace-not-found', message: `workspace not found: ${workspaceId}`, details: { workspaceId } } }
    }
    await writeWorkspaces(next)
    // 真实文件夹工作区：删除记录时同步清理 IndexedDB 里的目录句柄
    await deleteDirectoryHandle(workspaceId)
    return { ok: true, value: { deleted: true } }
  }

  async function dshWorkspaceInsertSessionBefore(payload: unknown): Promise<DshRpcResult> {
    const p = (payload ?? {}) as { workspaceId?: unknown; sessionId?: unknown; beforeSessionId?: unknown }
    const workspaceId = typeof p.workspaceId === 'string' && p.workspaceId ? p.workspaceId : ''
    const sessionId = typeof p.sessionId === 'string' && p.sessionId ? p.sessionId : ''
    const records = await readWorkspaces()
    // 缺省参数（UI 有时只带 sessionId）兜底：把会话并入首工作区，避免进入流程中断
    const target = records.find((r) => r.workspaceId === workspaceId) ?? records[0]
    if (!target) return { ok: true, value: { workspace: toWorkspaceView(await thisWebChatWorkspace()) } }
    let sessionIds = target.sessionIds.filter((id) => id !== sessionId)
    const beforeSessionId = typeof p.beforeSessionId === 'string' && p.beforeSessionId ? p.beforeSessionId : undefined
    if (sessionId) {
      if (beforeSessionId && sessionIds.includes(beforeSessionId)) {
        const idx = sessionIds.indexOf(beforeSessionId)
        sessionIds.splice(idx, 0, sessionId)
      } else {
        sessionIds.push(sessionId)
      }
    }
    const next: DshWorkspaceRecord = { ...target, sessionIds, updatedAt: new Date().toISOString() }
    await writeWorkspaces(records.map((r) => (r.workspaceId === target.workspaceId ? next : r)))
    return { ok: true, value: { workspace: toWorkspaceView(next) } }
  }

  /** 网页对话工作区（承载网页版会话；无任何工作区记录时的默认/兜底） */
  async function thisWebChatWorkspace(): Promise<DshWorkspaceRecord> {
    return {
      workspaceId: DSH_WORKSPACE_ID,
      path: `<${DSH_WORKSPACE_ID}>`,
      title: DSH_WEB_CHAT_WORKSPACE_TITLE,
      sessionIds: [],
      createdAt: DSH_WORKSPACE_CREATED_AT,
      updatedAt: new Date().toISOString(),
    }
  }

  // ── skill.list（本地 skill 库）──────────────────────────────────
  function dshSkillList(): DshRpcResult {
    return {
      ok: true,
      value: {
        skills: skills.map((s) => ({ name: s.name, description: s.description, modelInvocable: true })),
      },
    }
  }

  // ── settings.*（官方 SettingsProvider 真实运行 + dsh-in-web 自有命名空间）──
  // 官方 settings 体系（cordis SettingsProvider + schemastery schema）由
  // scripts/build-official-settings.mjs 打包进 public/dsh-official/settings-runtime.js，
  // SW 启动时经 importScripts 加载（ensureOfficialSettingsRuntime）。11 个官方
  // namespace（ui-theme/locale/ui-conversation/agent-loop/agent-presets/
  // ui-onboarding/web-search-deepseek/llm-deepseek/llm-pi-ai/permission/shell）
  // 的 schema + composition base 来自权威 3080 describe（utils/official-settings/
  // namespaces.ts），全部注册进官方 SettingsProvider，读写走官方合并/校验/乐观锁
  // 语义；user 文档持久化到 chrome.storage.local（key = 'dsh-official-settings'）。
  //  - dsh-in-web 自身命名空间保留（llm.providers 的 settingsNs 依赖），
  //    DshSettings（dshMode 等）仍是扩展自有配置，不走官方 namespace。
  const DSH_SETTINGS_NS = 'dsh-in-web'
  let settingsRevision = 0

  interface DshSettingsNamespaceView {
    ns: string
    schema: unknown
    value: unknown
    base?: unknown
    user?: unknown
    applies: 'live' | 'restart'
    secrets: readonly { readonly path: readonly string[]; readonly set: boolean }[]
    revision: number
  }

  const OFFICIAL_SETTINGS_STORAGE_KEY = 'dsh-official-settings'
  /** 官方 provider 暴露的 namespace（即 11 个官方注册表） */
  const OFFICIAL_EXPOSED_NAMESPACES: ReadonlySet<string> = new Set(
    OFFICIAL_NAMESPACES.map((spec) => spec.ns),
  )

  /** 官方 settings provider 惰性单例（每次 SW 启动重建；load 读回 storage） */
  let officialSettingsProvider: Promise<SettingsProviderInstance | null> | null = null

  function getOfficialSettings(): Promise<SettingsProviderInstance | null> {
    if (officialSettingsProvider === null) {
      officialSettingsProvider = (async () => {
        const runtime = getOfficialSettingsRuntime()
        if (runtime === null) {
          console.warn('[dsh-official-settings] runtime unavailable; official namespaces disabled')
          return null
        }
        const backend = new ChromeSettingsStorageBackend(OFFICIAL_SETTINGS_STORAGE_KEY)
        return createOfficialSettingsProvider(runtime, backend)
      })()
    }
    return officialSettingsProvider
  }

  /** dsh-in-web 命名空间的视图（llm.providers settingsNs 依赖） */
  async function buildSettingsNamespaceView(): Promise<DshSettingsNamespaceView> {
    const settings = await getSettings()
    return {
      ns: DSH_SETTINGS_NS,
      schema: {},
      // base/user 为 settingsNamespaceViewSchema 的可选层（目录层/用户覆盖层）。
      // models 面板会读 namespace.user / namespace.base（getPath/hasPath），
      // 提供空对象避免 undefined 穿透（本扩展无分层持久化，全部归一化到 value）。
      base: {},
      user: {},
      value: { ...settings },
      applies: 'live',
      secrets: [],
      revision: settingsRevision,
    }
  }

  // ── 官方错误包络（对齐 harness api-proxy.ts）──
  function dshSettingsNotExposed(ns: string): DshRpcResult {
    return {
      ok: false,
      error: {
        code: 'settings-not-exposed',
        message: `settings namespace "${ns}" is not exposed to configuration clients`,
        details: { ns },
      },
    }
  }

  function dshSettingsRejected(ns: string, error: unknown): DshRpcResult {
    return {
      ok: false,
      error: {
        code: 'settings-rejected',
        message: error instanceof Error ? error.message : String(error),
        details: { ns },
      },
    }
  }

  function dshSettingsConflict(ns: string, expected: number, actual: number): DshRpcResult {
    return {
      ok: false,
      error: {
        code: 'settings-conflict',
        message: `settings namespace "${ns}" changed since it was read (expected revision ${String(expected)}, now ${String(actual)})`,
        details: { ns, expected, actual },
      },
    }
  }

  function dshSettingsInternal(message: string): DshRpcResult {
    return { ok: false, error: { code: 'internal', message, details: {} } }
  }

  function isSettingsConflict(error: unknown): error is SettingsConflictError {
    return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'SETTINGS_CONFLICT'
  }

  /** 官方 namespace 写入（update/replace/mutate）：走官方 write 队列 + 乐观锁 + persist */
  async function writeOfficialSettings(
    ns: string,
    mode: 'update' | 'replace' | 'mutate',
    body: unknown,
    expectedRevision: unknown,
  ): Promise<DshRpcResult> {
    const provider = await getOfficialSettings()
    const runtime = getOfficialSettingsRuntime()
    if (provider === null || runtime === null) {
      return dshSettingsInternal('official settings runtime unavailable')
    }
    let branded: SettingsNamespace
    try {
      branded = runtime.settingsNamespace(ns)
    } catch (error) {
      // 非法命名空间名：client bug，官方同样按 settings-rejected 报告
      return dshSettingsRejected(ns, error)
    }
    if (!OFFICIAL_EXPOSED_NAMESPACES.has(ns)) return dshSettingsNotExposed(ns)
    const revision = typeof expectedRevision === 'number' ? expectedRevision : undefined
    try {
      if (mode === 'update') await provider.update(branded, (body ?? {}) as object, revision)
      else if (mode === 'replace') await provider.replace(branded, (body ?? {}) as object, revision)
      else await provider.mutate(branded, body as readonly SettingsPathOp[], revision)
    } catch (error) {
      if (isSettingsConflict(error)) return dshSettingsConflict(ns, error.expected, error.actual)
      return dshSettingsRejected(ns, error)
    }
    const descriptor = provider
      .describe({ redactSecrets: true })
      .find((candidate) => candidate.ns === ns)
    if (descriptor === undefined) {
      return dshSettingsInternal(`settings namespace "${ns}" was disposed after the ${mode}`)
    }
    return { ok: true, value: namespaceView(descriptor) }
  }

  async function dshSettingsDescribe(): Promise<DshRpcResult> {
    const provider = await getOfficialSettings()
    const official: DshSettingsNamespaceView[] =
      provider === null ? [] : provider.describe({ redactSecrets: true }).map(namespaceView)
    const namespaces: DshSettingsNamespaceView[] = [
      ...official,
      await buildSettingsNamespaceView(), // dsh-in-web：llm.providers settingsNs 依赖该 namespace
    ]
    return { ok: true, value: { writable: provider?.writable === true, hasDocument: false, namespaces } }
  }

  async function dshSettingsUpdate(payload: unknown): Promise<DshRpcResult> {
    const p = (payload ?? {}) as { ns?: unknown; patch?: unknown; expectedRevision?: unknown }
    const ns = String(p.ns ?? '')
    // dsh-in-web 自身命名空间：DshSettings（dshMode 等）不走官方 settings
    if (ns === DSH_SETTINGS_NS) {
      const patch = (p.patch ?? {}) as Record<string, unknown>
      if (Object.keys(patch).length > 0) {
        await patchSettings(patch as Partial<DshSettings>)
        settingsRevision += 1
      }
      return { ok: true, value: await buildSettingsNamespaceView() }
    }
    return writeOfficialSettings(ns, 'update', p.patch, p.expectedRevision)
  }

  async function dshSettingsReplace(payload: unknown): Promise<DshRpcResult> {
    const p = (payload ?? {}) as { ns?: unknown; section?: unknown; expectedRevision?: unknown }
    const ns = String(p.ns ?? '')
    if (ns === DSH_SETTINGS_NS) {
      const section = (p.section ?? {}) as Record<string, unknown>
      if (Object.keys(section).length > 0) {
        await patchSettings(section as Partial<DshSettings>)
        settingsRevision += 1
      }
      return { ok: true, value: await buildSettingsNamespaceView() }
    }
    return writeOfficialSettings(ns, 'replace', p.section, p.expectedRevision)
  }

  async function dshSettingsMutate(payload: unknown): Promise<DshRpcResult> {
    const p = (payload ?? {}) as { ns?: unknown; ops?: unknown; expectedRevision?: unknown }
    const ns = String(p.ns ?? '')
    if (ns === DSH_SETTINGS_NS) {
      const patch: Record<string, unknown> = {}
      if (Array.isArray(p.ops)) {
        for (const op of p.ops) {
          if (typeof op !== 'object' || op === null) continue
          const o = op as { op?: unknown; path?: unknown; value?: unknown }
          if (!Array.isArray(o.path) || o.path.length === 0) continue
          const key = String(o.path[0])
          if (o.op === 'set') patch[key] = o.value
          else if (o.op === 'unset') patch[key] = undefined
        }
      }
      if (Object.keys(patch).length > 0) {
        await patchSettings(patch as Partial<DshSettings>)
        settingsRevision += 1
      }
      return { ok: true, value: await buildSettingsNamespaceView() }
    }
    return writeOfficialSettings(ns, 'mutate', p.ops, p.expectedRevision)
  }

  /** settings.openDocument：扩展无文件文档（官方 host 为文件型 settings 文档时打开编辑器） */
  function dshSettingsOpenDocument(): DshRpcResult {
    return { ok: true, value: { opened: false, path: '' } }
  }

  // ── llm.*（固定模型目录）────────────────────────────────────────
  function dshLlmProviders(): DshRpcResult {
    return {
      ok: true,
      value: {
        providers: [
          {
            provider: 'deepseek',
            displayName: 'DeepSeek (网页版)',
            settingsNs: DSH_SETTINGS_NS,
            // settingsPath 必须为空数组：dsh-client-ui-settings-models 用
            // nodeAtPath(rehydrateSchema(namespace.schema), settingsPath) 解析节点，
            // 我们的 namespace.schema 是空对象（type 为空），任何非空 path 都会解析
            // 失败并渲染 "unresolvable settings path"。空数组让 nodeAtPath 返回 root
            // 节点本身（configured 判定走 settingsPath.length === 0 分支，恒成立）。
            settingsPath: [],
            active: true,
          },
        ],
      },
    }
  }

  function dshLlmModels(): DshRpcResult {
    return { ok: true, value: { groups: DSH_MODEL_GROUPS, failures: [] } }
  }

  // ── agentPreset.*（官方 4 个内置预设，元数据与 deepseek-harness
  //    apps/cli/config/agent-presets/{standard,code,minimal,cordis}/preset.yml 一致）──
  interface DshAgentPresetEntry {
    id: string
    trust: 'system' | 'user'
    isDefault: boolean
    name?: string
    description?: string
  }

  const DSH_AGENT_PRESETS: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly description: string
  }> = [
    {
      id: 'standard',
      name: '标准模式',
      description: '功能完整的编码 Agent，支持文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流。',
    },
    {
      id: 'code',
      name: 'PTC 模式',
      description: '具备标准模式的全部能力，并通过 Code Mode SDK 呈现工具，让模型用一个 TypeScript 程序组合多步操作。',
    },
    {
      id: 'minimal',
      name: '极简模式',
      description: '仅提供持久 bash 与 str_replace_editor 的双工具编码 Agent。',
    },
    {
      id: 'cordis',
      name: '创造模式',
      description: '用于创建自定义 Agent preset：具备标准模式的全部能力，并提供运行时检查、插件实验和 preset 创作指导。',
    },
  ]

  function dshAgentPresetList(): DshRpcResult {
    const presets: DshAgentPresetEntry[] = DSH_AGENT_PRESETS.map((p) => ({
      id: p.id,
      trust: 'system', // 官方内置
      isDefault: p.id === 'standard',
      name: p.name,
      description: p.description,
    }))
    // authorable 保守置 false：不暴露未桥接的「新建预设」创作流程，但预设列表展示真实 4 项
    return { ok: true, value: { presets, authorable: false, hasDocument: false } }
  }

  /** agentPreset 错误包络：details 携带 agentPreset id（对齐 rpcErrorSchema 分支） */
  function dshAgentPresetError(
    id: string,
    code: 'agent-preset-not-found' | 'agent-preset-read-only',
    message: string,
  ): DshRpcResult {
    return { ok: false, error: { code, message, details: { agentPreset: id } } }
  }

  function findAgentPreset(id: string): { id: string; name: string; description: string } | null {
    const preset = DSH_AGENT_PRESETS.find((p) => p.id === id)
    return preset ?? null
  }

  /**
   * agentPreset.read：返回预设完整 composition（官方 agent.cordis.yml 内容，从 harness
   * 逐字节读入硬编码于 @/utils/agent-presets/contents）。trust=system（官方内置）。
   */
  function dshAgentPresetRead(payload: unknown): DshRpcResult {
    const p = (payload ?? {}) as { agentPreset?: unknown }
    const id = typeof p.agentPreset === 'string' && p.agentPreset ? p.agentPreset : ''
    const preset = findAgentPreset(id)
    if (!preset) return dshAgentPresetError(id, 'agent-preset-not-found', `agent preset not found: ${id}`)
    const content = DSH_AGENT_PRESET_CONTENTS[id]
    return {
      ok: true,
      value: {
        agentPreset: preset.id,
        trust: 'system',
        content: content ?? '',
        name: preset.name,
        description: preset.description,
      },
    }
  }

  /** agentPreset.select：校验预设存在后返回选中 id（本扩展无真实会话挂载，确认存在即成功） */
  function dshAgentPresetSelect(payload: unknown): DshRpcResult {
    const p = (payload ?? {}) as { agentPreset?: unknown }
    const id = typeof p.agentPreset === 'string' && p.agentPreset ? p.agentPreset : ''
    if (!findAgentPreset(id)) return dshAgentPresetError(id, 'agent-preset-not-found', `agent preset not found: ${id}`)
    return { ok: true, value: { agentPreset: id } }
  }

  /** agentPreset.copy：复制预设（本扩展无本地文件系统，返回目标 id 即可，客户端据此更新列表） */
  function dshAgentPresetCopy(payload: unknown): DshRpcResult {
    const p = (payload ?? {}) as { agentPreset?: unknown }
    const id = typeof p.agentPreset === 'string' && p.agentPreset ? p.agentPreset : ''
    return { ok: true, value: { agentPreset: id } }
  }

  /** agentPreset.openDocument：本扩展无文件型预设文档（官方 host 打开 composition 文件） */
  function dshAgentPresetOpenDocument(payload: unknown): DshRpcResult {
    return { ok: true, value: { opened: false, path: '' } }
  }

  /** agentPreset.remove：官方内置预设（system trust）不可删除，返回只读错误 */
  function dshAgentPresetRemove(payload: unknown): DshRpcResult {
    const p = (payload ?? {}) as { agentPreset?: unknown }
    const id = typeof p.agentPreset === 'string' && p.agentPreset ? p.agentPreset : ''
    return dshAgentPresetError(id, 'agent-preset-read-only', 'system preset cannot be removed')
  }

  // ── pluginInventory.*（官方插件 roster 静态清单）────────────────────
  interface DshPluginInventoryEntry {
    entryId: string
    moduleName: string
    enabled: boolean
    fiberPhase: string | null
  }

  /**
   * 返回官方装配的完整插件清单：host 插件（base 78 + web host 17）+ client
   * 浏览器模块（boot-manifest 37）= 132 项。官方 Loader 树中已装配的插件标
   * `enabled: true, fiberPhase: 'active'`；web 装配中 disabled 的行（hmr、
   * skill-badge）标 `enabled: false, fiberPhase: null`，与官方
   * PluginInventoryGateway 的投影一致。
   */
  function dshPluginInventoryList(): DshRpcResult {
    const entries: DshPluginInventoryEntry[] = OFFICIAL_PLUGIN_ROSTER.map((p) => ({
      entryId: p.id,
      moduleName: p.moduleName,
      enabled: !p.disabled,
      fiberPhase: p.disabled ? null : 'active',
    }))
    return { ok: true, value: { entries } }
  }

  // ── goal.*（chrome.storage.local 真实持久化）──────────────────────
  // 官方 goal domain：request 携带 { sessionId, ref?: {id, revision},
  //   objective?, maxGoalRounds? }；value 为 { ref: {id, revision} }
  //   （create/edit/pause/resume/complete）或 { cleared: true }（clear）。
  // 以 dsh-goals key 存 Record<sessionId, Array<DshGoalRecord>>，让目标
  // 面板的 create → edit/pause/resume/complete/clear 全链路可真实操作。
  const DSH_GOALS_KEY = 'dsh-goals'

  type DshGoalStatus = 'active' | 'paused' | 'completed'

  interface DshGoalRecord {
    id: string
    revision: number
    objective: string
    maxGoalRounds?: number
    status: DshGoalStatus
    updatedAt: string
  }

  type DshGoalsStore = Record<string, DshGoalRecord[]>

  async function readGoals(): Promise<DshGoalsStore> {
    try {
      const stored = await chrome.storage.local.get(DSH_GOALS_KEY)
      const raw = stored[DSH_GOALS_KEY]
      return typeof raw === 'object' && raw !== null ? (raw as DshGoalsStore) : {}
    } catch {
      return {}
    }
  }

  async function writeGoals(store: DshGoalsStore): Promise<void> {
    try {
      await chrome.storage.local.set({ [DSH_GOALS_KEY]: store })
    } catch {
      // 写失败静默（非扩展环境）
    }
  }

  let goalSeq = 0
  function mintGoalId(): string {
    goalSeq += 1
    return `goal-${Date.now()}-${goalSeq}`
  }

  /** rpcErrorSchema 无 goal-not-found 专用码，缺失统一 internal + details:{} */
  function dshGoalNotFound(): DshRpcResult {
    return { ok: false, error: { code: 'internal', message: 'goal not found', details: {} } }
  }

  async function findGoalRecord(
    sessionId: string,
    id: string,
  ): Promise<{ store: DshGoalsStore; goals: DshGoalRecord[]; record: DshGoalRecord; index: number } | null> {
    const store = await readGoals()
    const goals = store[sessionId] ?? []
    const index = goals.findIndex((g) => g.id === id)
    if (index < 0) return null
    return { store, goals, record: goals[index]!, index }
  }

  function goalSessionId(payload: unknown): string {
    const p = (payload ?? {}) as { sessionId?: unknown }
    return typeof p.sessionId === 'string' && p.sessionId ? p.sessionId : ''
  }

  function goalRefId(payload: unknown): string {
    const p = (payload ?? {}) as { ref?: unknown }
    const ref = (p.ref ?? {}) as { id?: unknown }
    return typeof ref.id === 'string' && ref.id ? ref.id : ''
  }

  function goalMaxRounds(payload: unknown): number | undefined {
    const p = (payload ?? {}) as { maxGoalRounds?: unknown }
    return typeof p.maxGoalRounds === 'number' && Number.isInteger(p.maxGoalRounds) && p.maxGoalRounds > 0
      ? p.maxGoalRounds
      : undefined
  }

  async function dshGoalCreate(payload: unknown): Promise<DshRpcResult> {
    const sessionId = goalSessionId(payload)
    if (!sessionId) {
      return { ok: false, error: { code: 'bad-request', message: 'goal.create: sessionId required', details: {} } }
    }
    const p = (payload ?? {}) as { objective?: unknown }
    const objective = typeof p.objective === 'string' ? p.objective : ''
    const maxGoalRounds = goalMaxRounds(payload)
    const store = await readGoals()
    const goals = store[sessionId] ?? []
    const record: DshGoalRecord = {
      id: mintGoalId(),
      revision: 1,
      objective,
      ...(maxGoalRounds !== undefined ? { maxGoalRounds } : {}),
      status: 'active',
      updatedAt: new Date().toISOString(),
    }
    goals.push(record)
    store[sessionId] = goals
    await writeGoals(store)
    return { ok: true, value: { ref: { id: record.id, revision: record.revision } } }
  }

  async function dshGoalEdit(payload: unknown): Promise<DshRpcResult> {
    const found = await findGoalRecord(goalSessionId(payload), goalRefId(payload))
    if (!found) return dshGoalNotFound()
    const p = (payload ?? {}) as { objective?: unknown }
    if (typeof p.objective === 'string') found.record.objective = p.objective
    const maxGoalRounds = goalMaxRounds(payload)
    if (maxGoalRounds !== undefined) found.record.maxGoalRounds = maxGoalRounds
    found.record.revision += 1
    found.record.updatedAt = new Date().toISOString()
    await writeGoals(found.store)
    return { ok: true, value: { ref: { id: found.record.id, revision: found.record.revision } } }
  }

  async function dshGoalSetStatus(payload: unknown, status: DshGoalStatus): Promise<DshRpcResult> {
    const found = await findGoalRecord(goalSessionId(payload), goalRefId(payload))
    if (!found) return dshGoalNotFound()
    found.record.status = status
    found.record.revision += 1
    found.record.updatedAt = new Date().toISOString()
    await writeGoals(found.store)
    return { ok: true, value: { ref: { id: found.record.id, revision: found.record.revision } } }
  }

  async function dshGoalClear(payload: unknown): Promise<DshRpcResult> {
    const found = await findGoalRecord(goalSessionId(payload), goalRefId(payload))
    if (!found) return dshGoalNotFound()
    found.goals.splice(found.index, 1)
    if (found.goals.length === 0) delete found.store[goalSessionId(payload)]
    else found.store[goalSessionId(payload)] = found.goals
    await writeGoals(found.store)
    return { ok: true, value: { cleared: true } }
  }

  // ── credentials.*（chrome.storage.local 真实存储，describe 读回）──
  const DSH_CREDENTIALS_KEY = 'dsh-credentials'

  async function readCredentials(): Promise<Record<string, unknown>> {
    try {
      const stored = await chrome.storage.local.get(DSH_CREDENTIALS_KEY)
      const raw = stored[DSH_CREDENTIALS_KEY]
      return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  async function writeCredentials(creds: Record<string, unknown>): Promise<void> {
    try {
      await chrome.storage.local.set({ [DSH_CREDENTIALS_KEY]: creds })
    } catch {
      // 写失败静默（非扩展环境）
    }
  }

  function credentialsRef(payload: unknown): string {
    const p = (payload ?? {}) as { ref?: unknown }
    return typeof p.ref === 'string' && p.ref ? p.ref : ''
  }

  async function dshCredentialsSet(payload: unknown): Promise<DshRpcResult> {
    const ref = credentialsRef(payload)
    if (!ref) {
      return { ok: false, error: { code: 'bad-request', message: 'credentials.set: ref required', details: {} } }
    }
    const p = (payload ?? {}) as { value?: unknown }
    const creds = await readCredentials()
    creds[ref] = p.value ?? {}
    await writeCredentials(creds)
    return { ok: true, value: {} }
  }

  async function dshCredentialsUnset(payload: unknown): Promise<DshRpcResult> {
    const ref = credentialsRef(payload)
    if (!ref) {
      return { ok: false, error: { code: 'bad-request', message: 'credentials.unset: ref required', details: {} } }
    }
    const creds = await readCredentials()
    delete creds[ref]
    await writeCredentials(creds)
    return { ok: true, value: {} }
  }

  /** credentials.describe：读回 dsh-credentials 存储，每个已存 ref 标记 configured+writable */
  async function dshCredentialsDescribe(): Promise<DshRpcResult> {
    const creds = await readCredentials()
    const credentials: Record<string, { configured: boolean; writable: boolean }> = {}
    for (const ref of Object.keys(creds)) {
      credentials[ref] = { configured: true, writable: true }
    }
    return { ok: true, value: { credentials } }
  }

  // ── llm.discoverModels（真实 deepseek 模型目录）──────────────────
  function dshLlmDiscoverModels(): DshRpcResult {
    return {
      ok: true,
      value: {
        models: [
          { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 1000000, maxTokens: 1000000 },
          { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1000000, maxTokens: 1000000 },
        ],
      },
    }
  }

  // ── 分派表（未列出的方法回落到 dshNotImplemented 错误包络）────────
  const dshRpcHandlers: Record<string, DshRpcHandler> = {
    'host.describe': () => ({ ok: true, value: dshDescribeValue() }),
    // host.listDirectory：目录浏览面板读取本地 Workspace（IndexedDB）真实文件树
    // （对齐 hostListDirectoryValueSchema：path/home/crumbs/entries/truncated）。
    // entries 为 directoryEntrySchema = {name, path, hidden} 数组：目录项与文件项
    // 都返回，name 取路径最后一段，path 用完整路径；crumbs 按路径分段逐段累积。
    // 根层（/）返回虚拟盘符列表（C:/D:/E:...），选择盘符（C:）后进入该盘符的
    // 目录树（Workspace 单库内以 C:/ 前缀分区）。
    'host.listDirectory': async (payload) => {
      const p = (payload ?? {}) as { path?: unknown }
      const rawPath = typeof p.path === 'string' && p.path ? p.path : '/'
      try {
        // 根层：返回盘符列表作为目录 entries，home '/'、crumbs 空
        if (rawPath === '/' || rawPath === '') {
          return {
            ok: true,
            value: {
              path: '/',
              home: '/',
              crumbs: [],
              entries: DSH_DRIVES.map((drive) => ({ name: drive, path: drive, hidden: false })),
              truncated: false,
            },
          }
        }
        // 真实文件夹工作区（file://<name>[/...]）：走真实 handle entries() 列出目录
        const real = await resolveRealDirectory(rawPath)
        if (real) {
          const rws = new RealDirectoryWorkspace(real.handle)
          const entries = await rws.list(real.rel)
          return {
            ok: true,
            value: {
              path: rawPath,
              home: real.workspace.path,
              crumbs: buildRealCrumbs(real.workspace.path, real.rel),
              entries: entries.map((e) => {
                const name = e.path.split('/').filter(Boolean).pop() ?? e.path
                // 相对句柄根的子路径接到工作区根前缀上（file://<name>/<sub>...）
                const fullPath = `${real.workspace.path}${e.path}`
                return { name, path: fullPath, hidden: false }
              }),
              truncated: false,
            },
          }
        }
        const ws = await getQueryWs()
        const path = normalizeDrivePath(rawPath)
        const entries = await ws.list(path)
        return {
          ok: true,
          value: {
            path,
            home: '/',
            crumbs: buildCrumbs(path),
            entries: entries.map((e) => {
              const name = e.path.split('/').filter(Boolean).pop() ?? e.path
              return { name, path: e.path, hidden: false }
            }),
            truncated: false,
          },
        }
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'internal',
            message: `host.listDirectory: ${err instanceof Error ? err.message : String(err)}`,
            details: {},
          },
        }
      }
    },
    // host.pickDirectory：工作区目录选择对话框。浏览器无真实目录选择器，
    // 返回默认盘符路径 C:（与 host.describe 的 cwd 同属虚拟 FS），
    // 让「选择目录 → 创建工作区」流程不被 null（用户取消）中断。
    // 真实文件夹工作区由 side panel 的「打开文件夹建立工作区」按钮
    // （window.showDirectoryPicker）建立，走 panel-query create-real-workspace。
    'host.pickDirectory': () => ({ ok: true, value: { path: DSH_DRIVES[0] ?? 'C:' } }),
    // host.createDirectory：新建文件夹（对齐 hostCreateDirectoryValueSchema：
    // request { path, name }，value { path }）。真实工作区路径走真实 handle mkdir；
    // 虚拟盘符路径在 Workspace 里真实 mkdir（含父级），让新建后的目录树刷新能看到；
    // 失败时仍返回合成绝对路径兜底，避免打断 UI 浏览。
    'host.createDirectory': async (payload) => {
      const p = (payload ?? {}) as { path?: unknown; name?: unknown }
      const rawPath = typeof p.path === 'string' && p.path ? p.path : ''
      const name = typeof p.name === 'string' && p.name ? p.name.trim() : ''
      if (!rawPath || !name) return { ok: true, value: { path: '/' } }
      const target = `${rawPath}/${name}`
      try {
        const real = await resolveRealDirectory(rawPath)
        if (real) {
          const rws = new RealDirectoryWorkspace(real.handle)
          const rel = real.rel ? `${real.rel}/${name}` : name
          await rws.mkdir(rel)
          return { ok: true, value: { path: target } }
        }
        const ws = await getQueryWs()
        await ws.mkdir(normalizeDrivePath(target))
      } catch {
        // 创建失败静默：仍返回合成路径，避免目录浏览流程中断
      }
      return { ok: true, value: { path: target } }
    },
    'session.list': dshSessionList,
    'session.search': () => ({ ok: true, value: { items: [], hasMore: false } }),
    'session.create': dshSessionCreate,
    'session.history': (payload) => {
      const p = (payload ?? {}) as { sessionId?: unknown; beforeSeq?: unknown; maxMessages?: unknown }
      const sessionId = typeof p.sessionId === 'string' && p.sessionId ? p.sessionId : ''
      const rec = sessionId ? virtualSessions.get(sessionId) : undefined
      if (!rec) return { ok: true, value: { events: [], hasMore: false } }
      // beforeSeq 回退分页 / maxMessages 从尾部往前取（默认全量）；返回按 seq 升序
      const beforeSeq = typeof p.beforeSeq === 'number' && Number.isFinite(p.beforeSeq) ? p.beforeSeq : undefined
      const maxMessages =
        typeof p.maxMessages === 'number' && Number.isFinite(p.maxMessages) && p.maxMessages > 0
          ? Math.floor(p.maxMessages)
          : rec.events.length
      const page = beforeSeq === undefined ? rec.events : rec.events.filter((event) => event.seq < beforeSeq)
      const start = Math.max(0, page.length - maxMessages)
      const events = page.slice(start).map((event) => ({ event }))
      return { ok: true, value: { events, hasMore: start > 0 } }
    },
    'session.models': dshSessionModels,
    'session.selectModel': dshSessionSelectModel,
    'session.rename': dshSessionRename,
    'session.fork': dshSessionFork,
    'session.prompt': dshSessionPrompt,
    'session.cancel': dshSessionCancel,
    'workspace.list': dshWorkspaceList,
    'workspace.create': dshWorkspaceCreate,
    'workspace.rename': dshWorkspaceRename,
    'workspace.delete': dshWorkspaceDelete,
    'workspace.insertBefore': async () => {
      const records = await readWorkspaces()
      return { ok: true, value: { workspaceIds: records.map((r) => r.workspaceId) } }
    },
    'workspace.insertSessionBefore': dshWorkspaceInsertSessionBefore,
    'workspace.archiveSession': () => ({ ok: true, value: { archivedSessionIds: [] } }),
    'skill.list': dshSkillList,
    'settings.describe': dshSettingsDescribe,
    'settings.update': dshSettingsUpdate,
    'settings.replace': dshSettingsReplace,
    'settings.mutate': dshSettingsMutate,
    'settings.openDocument': dshSettingsOpenDocument,
    'llm.providers': dshLlmProviders,
    'llm.models': dshLlmModels,
    // agentPreset.list：Agent 预设面板启动即调用，返回官方 4 个内置预设
    // （standard/code/minimal/cordis，元数据与 harness preset.yml 一致）
    'agentPreset.list': dshAgentPresetList,
    // agentPreset.read/select/copy/openDocument/remove：预设详情/选择/复制/文档/删除。
    // read 返回官方 agent.cordis.yml 完整内容（@/utils/agent-presets/contents 硬编码），
    // select 校验存在性，copy/openDocument 为虚拟操作，remove 对 system 预设返回只读错误。
    'agentPreset.read': dshAgentPresetRead,
    'agentPreset.select': dshAgentPresetSelect,
    'agentPreset.copy': dshAgentPresetCopy,
    'agentPreset.openDocument': dshAgentPresetOpenDocument,
    'agentPreset.remove': dshAgentPresetRemove,
    // credentials.describe：读回 dsh-credentials 真实存储（set/unset 后能反映）
    'credentials.describe': dshCredentialsDescribe,
    'subagent.list': () => ({ ok: true, value: { entries: [], parentAvailable: true } }),
    // pluginInventory.list：dsh-client-ui-settings-plugin-inventory 的「插件」设置页
    // 经 ctx.remote.pluginInventory.list() 调用（wire method = pluginInventory.list，
    // 见 dsh-api-remotes TYPERT_REMOTE 中 pluginInventory descriptor）。
    // 返回形状对齐 PluginInventorySnapshot = { entries: [{ entryId, moduleName,
    //   enabled, fiberPhase }] }，entries 来自 boot-manifest 的真实 37 个内置插件。
    'pluginInventory.list': dshPluginInventoryList,
    // dynamicCordisRunner.*：本扩展不实现动态插件运行（Cordis 面板启动即调用
    // inventory / syncInspectManifest 显示插件清单），全部返回空/成功状态，
    // 让面板显示空清单而非「无法加载」错误。错误包络方法仅在真有动态插件
    // 运行时才可能被调用，届时 UI 显示错误但面板不崩。
    'dynamicCordisRunner.inventory': () => ({ ok: true, value: [] }),
    'dynamicCordisRunner.syncInspectManifest': () => ({ ok: true, value: null }),
    'dynamicCordisRunner.getClientCode': () => dshDynamicNotBridged('dynamicCordisRunner.getClientCode'),
    'dynamicCordisRunner.invoke': () => dshDynamicNotBridged('dynamicCordisRunner.invoke'),
    'dynamicCordisRunner.runHostHalf': () => ({
      ok: true,
      value: { ok: false, message: 'dynamic plugin host half not available in dsh-in-web' },
    }),
    'dynamicCordisRunner.resolveRequestRun': () => ({ ok: true, value: { accepted: false } }),
    'dynamicCordisRunner.resolveInspectQuery': () => ({ ok: true, value: { accepted: false } }),
    'dynamicCordisRunner.settleUserRun': () => ({
      ok: true,
      value: { ok: false, reason: 'plugin-missing', message: 'no dynamic plugin running in dsh-in-web' },
    }),
    'dynamicCordisRunner.stopFromPanel': () => ({ ok: true, value: { ok: true } }),
    'dynamicCordisRunner.undefineFromPanel': () => ({
      ok: true,
      value: { ok: false, reason: 'plugin-missing', message: 'no dynamic plugin defined in dsh-in-web' },
    }),
    'dynamicCordisRunner.reportClientGuardFailure': () => ({ ok: true, value: null }),
    'dynamicCordisRunner.reportRenderFailure': () => ({ ok: true, value: null }),
    // goal.*：chrome.storage.local 真实持久化（create → edit/pause/resume/complete/clear 全链路可操作）
    'goal.create': dshGoalCreate,
    'goal.edit': dshGoalEdit,
    'goal.pause': (payload) => dshGoalSetStatus(payload, 'paused'),
    'goal.resume': (payload) => dshGoalSetStatus(payload, 'active'),
    'goal.complete': (payload) => dshGoalSetStatus(payload, 'completed'),
    'goal.clear': dshGoalClear,
    // credentials.set/unset：chrome.storage.local 真实存储
    'credentials.set': dshCredentialsSet,
    'credentials.unset': dshCredentialsUnset,
    // session.attachment：需真实附件文件服务，保持错误包络（UI 显示干净错误）
    'session.attachment': () => dshNotImplemented('session.attachment'),
    // session.updateQueue：ack（会话队列操作，桥接层无真实队列）
    'session.updateQueue': () => ({ ok: true, value: { accepted: true } }),
    // subagent.*：本扩展无子代理运行——history 返回空事件流（hasMore false），
    // prompt 错误包络（需真实子代理运行），interrupt ack
    'subagent.history': () => ({ ok: true, value: { events: [], hasMore: false } }),
    'subagent.prompt': () => dshNotImplemented('subagent.prompt'),
    'subagent.interrupt': () => ({ ok: true, value: { accepted: true } }),
    // host.openPath：浏览器无法打开本地路径（host.describe 的 canOpenPath=false）
    'host.openPath': () => ({
      ok: false,
      error: { code: 'internal', message: 'host.openPath unavailable in browser', details: {} },
    }),
    // llm.discoverModels：返回真实 deepseek 模型目录（与 official llm-deepseek.models 一致）
    'llm.discoverModels': dshLlmDiscoverModels,
  }

  /** 未桥接的 dynamicCordisRunner 方法：返回合法错误包络（与 dshNotImplemented 同构） */
  function dshDynamicNotBridged(method: string): DshRpcResult {
    return {
      ok: false,
      error: { code: 'internal', message: `dsh RPC not yet bridged: ${method}`, details: {} },
    }
  }

  async function handleDshRpc(message: DshRpcEnvelope): Promise<DshRpcReply> {
    if (!isDshClientRequest(message.body)) {
      return {
        kind: 'dsh-rpc:result',
        body: dshResponse('', {
          ok: false,
          error: { code: 'internal', message: 'dsh RPC malformed request', details: {} },
        }),
      }
    }
    const req = message.body
    // remote 命名空间调用（ctx.remote.xxx）经 connection.rpc.call("/api", endpoint)
    // 发送的 method 是 "namespace/method"（斜杠，如 pluginInventory/list）；
    // 直接 api 调用（api.xxx）是 "namespace.method"（点号）。归一化为点号查表。
    const normalizedMethod = req.method.replaceAll('/', '.')
    const handler = dshRpcHandlers[normalizedMethod]
    let result: DshRpcResult
    try {
      result = handler ? await handler(req.payload) : dshNotImplemented(normalizedMethod)
    } catch (err) {
      // 任何实现抛错都收拢为合法错误包络，避免把异常泄漏给 iframe
      result = {
        ok: false,
        error: {
          code: 'internal',
          message: `dsh RPC failed: ${normalizedMethod}: ${err instanceof Error ? err.message : String(err)}`,
          details: {},
        },
      }
    }
    return { kind: 'dsh-rpc:result', body: dshResponse(req.rpcId, result) }
  }

  // unary RPC：listener 返回 Promise 即作为响应（MV3 支持）
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!isDshRpcEnvelope(message)) return undefined
    return handleDshRpc(message)
  })

  // ── dsh 流（mux / host）：保持端口打开、响应订阅、广播帧、断线清理 ──
  const dshStreamPorts = new Set<chrome.runtime.Port>()
  /** 每个端口订阅的流类型（mux 收 session/event，host 收 session-status 等） */
  const dshStreamPortStreams = new Map<chrome.runtime.Port, 'mux' | 'host'>()

  interface DshStreamSubscribe {
    readonly kind: 'dsh-stream-subscribe'
    readonly stream: 'mux' | 'host'
  }

  function isDshStreamSubscribe(msg: unknown): msg is DshStreamSubscribe {
    if (typeof msg !== 'object' || msg === null) return false
    const m = msg as { kind?: unknown; stream?: unknown }
    return m.kind === 'dsh-stream-subscribe' && (m.stream === 'mux' || m.stream === 'host')
  }

  /** mux 订阅基线：为每个已注册会话补发 session/subscribed（lastSeq = 最后事件 seq，空日志 -1） */
  function replayMuxBaseline(port: chrome.runtime.Port): void {
    for (const [sessionId, rec] of virtualSessions) {
      pushDshStreamFrame(port, {
        type: 'session/subscribed',
        sessionId,
        lastSeq: rec.events.length - 1,
      })
    }
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'dsh-stream') return
    dshStreamPorts.add(port)
    port.onMessage.addListener((msg: unknown) => {
      if (!isDshStreamSubscribe(msg)) return
      dshStreamPortStreams.set(port, msg.stream)
      port.postMessage({ kind: 'dsh-stream-ok', body: { stream: msg.stream } })
      if (msg.stream === 'mux') replayMuxBaseline(port)
    })
    port.onDisconnect.addListener(() => {
      dshStreamPorts.delete(port)
      dshStreamPortStreams.delete(port)
    })
  })
})