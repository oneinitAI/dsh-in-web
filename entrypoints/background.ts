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
import { buildAgentTools } from '@/utils/agent/tools'
import { Workspace } from '@/utils/fs/workspace'
import type { Skill } from '@/utils/skills/skill'
import type { LlmStreamEvent } from '@/utils/plugin/host'
import { getSettings, patchSettings, type DshSettings } from '@/utils/settings/settings'

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

    // ── Side Panel 数据查询（文件树 / skill 库）────────────────
    if (topic === 'panel-query') {
      const { cmd, path } = (message as { payload?: { cmd?: string; path?: string } }).payload ?? {}
      void (async () => {
        try {
          if (cmd === 'list-files') {
            const ws = await getQueryWs()
            const root = await ws.list('/')
            sendResponse({ ok: true, entries: root })
          } else if (cmd === 'read-file' && path) {
            const ws = await getQueryWs()
            const content = await ws.readText(path)
            sendResponse({ ok: true, content: content ?? null })
          } else if (cmd === 'list-skills') {
            sendResponse({ ok: true, skills })
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

  /** 流式聊天编排 —— agent loop 驱动（多轮工具调用回填） */
  async function runStream(messages: Message[], reasoning: boolean, search: boolean) {
    currentReasoning = reasoning
    currentSearch = search
    currentPersistSession = (await getSettings()).persistSession
    if (!currentPersistSession) currentSessionId = undefined
    const ws = new Workspace({ sandboxMode: 'workspace-write', dbName: 'dsh-in-web-workspace' })
    try {
      await ws.init()
    } catch (err) {
      pushBridgeEvent({ kind: 'error', error: `工作区初始化失败: ${err instanceof Error ? err.message : String(err)}` })
      return
    }

    try {
      const tools = buildAgentTools(ws, skills)
      const result = await runAgentLoop({
        llm: llmBridge,
        tools,
        messages,
        maxTurns: 8,
        onEvent: (ev) => {
          if (ev.kind === 'thinking') pushBridgeEvent({ kind: 'thinking', text: ev.text })
          else if (ev.kind === 'text') pushBridgeEvent({ kind: 'text', text: ev.text })
        },
      })
      pushBridgeEvent({ kind: 'finish' })
      // 更新会话内消息历史供下一轮连续对话（保留 tool 结果）
      sessionMessages = result.messages
    } catch (err) {
      pushBridgeEvent({ kind: 'error', error: err instanceof Error ? err.message : String(err) })
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
  const DSH_WORKSPACE_TITLE_KEY = 'dsh-workspace-title'
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

  let virtualSessionSeq = 0
  function mintVirtualSessionId(): string {
    virtualSessionSeq += 1
    return `sess-${Date.now()}-${virtualSessionSeq}`
  }

  async function getWorkspaceTitle(): Promise<string> {
    try {
      const stored = await chrome.storage.local.get(DSH_WORKSPACE_TITLE_KEY)
      const title = stored[DSH_WORKSPACE_TITLE_KEY]
      return typeof title === 'string' && title.trim() ? title.trim() : 'dsh-in-web'
    } catch {
      return 'dsh-in-web'
    }
  }

  async function setWorkspaceTitle(title: string): Promise<void> {
    try {
      await chrome.storage.local.set({ [DSH_WORKSPACE_TITLE_KEY]: title.trim() || 'dsh-in-web' })
    } catch {
      // 写失败静默（非扩展环境）
    }
  }

  async function buildWorkspaceView(): Promise<DshWorkspaceView> {
    const title = await getWorkspaceTitle()
    return {
      workspaceId: DSH_WORKSPACE_ID,
      path: '/',
      title,
      sessionIds: [],
      createdAt: DSH_WORKSPACE_CREATED_AT,
      updatedAt: new Date().toISOString(),
    }
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
  function dshSessionCreate(payload: unknown): DshRpcResult {
    const p = (payload ?? {}) as { sessionId?: unknown }
    const sessionId = typeof p.sessionId === 'string' && p.sessionId ? p.sessionId : mintVirtualSessionId()
    return { ok: true, value: { sessionId } }
  }

  function dshSessionPrompt(payload: unknown): DshRpcResult {
    const p = (payload ?? {}) as { content?: unknown }
    const text = extractPromptText(p.content)
    if (!text) {
      return {
        ok: false,
        error: { code: 'bad-request', message: 'session.prompt: empty text content', details: { issues: [] } },
      }
    }
    // 复用现有 chat-stream 桥：SW runStream → sendToPage → content script（页面 origin）流式聊天
    void runStream([{ role: 'user', content: text }], currentReasoning, currentSearch)
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
    // 虚拟子会话（无持久化，fork 即派发一个新的会话 id）
    return { ok: true, value: { sessionId: mintVirtualSessionId() } }
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

  // ── workspace.*（桥接到本地 IndexedDB Workspace）────────────────
  async function dshWorkspaceList(): Promise<DshRpcResult> {
    await getQueryWs() // 初始化本地 IndexedDB 工作区
    const view = await buildWorkspaceView()
    return { ok: true, value: { items: [view], archivedSessionIds: [] } }
  }

  async function dshWorkspaceCreate(): Promise<DshRpcResult> {
    await getQueryWs()
    const view = await buildWorkspaceView()
    return { ok: true, value: { workspace: view, created: false } }
  }

  async function dshWorkspaceRename(payload: unknown): Promise<DshRpcResult> {
    const p = (payload ?? {}) as { title?: unknown }
    const title = typeof p.title === 'string' && p.title.trim() ? p.title.trim() : 'dsh-in-web'
    await setWorkspaceTitle(title)
    await getQueryWs()
    const view = await buildWorkspaceView()
    return { ok: true, value: { workspace: view } }
  }

  async function dshWorkspaceDelete(): Promise<DshRpcResult> {
    await getQueryWs()
    return { ok: true, value: { deleted: true } }
  }

  async function dshWorkspaceInsertSessionBefore(): Promise<DshRpcResult> {
    await getQueryWs()
    const view = await buildWorkspaceView()
    return { ok: true, value: { workspace: view } }
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

  // ── settings.*（chrome.storage.local 的 DshSettings 命名空间视图）──
  const DSH_SETTINGS_NS = 'dsh-in-web'
  let settingsRevision = 0

  interface DshSettingsNamespaceView {
    ns: string
    schema: unknown
    value: unknown
    applies: 'live' | 'restart'
    secrets: { path: string[]; set: boolean }[]
    revision: number
  }

  async function buildSettingsNamespaceView(): Promise<DshSettingsNamespaceView> {
    const settings = await getSettings()
    return {
      ns: DSH_SETTINGS_NS,
      schema: {},
      value: { ...settings },
      applies: 'live',
      secrets: [],
      revision: settingsRevision,
    }
  }

  function dshSettingsNotExposed(ns: unknown): DshRpcResult {
    return {
      ok: false,
      error: {
        code: 'settings-not-exposed',
        message: `settings namespace not exposed: ${String(ns)}`,
        details: { ns: String(ns) },
      },
    }
  }

  function dshSettingsConflict(expected: number, actual: number): DshRpcResult {
    return {
      ok: false,
      error: {
        code: 'settings-conflict',
        message: 'settings revision conflict',
        details: { ns: DSH_SETTINGS_NS, expected, actual },
      },
    }
  }

  /** 校验命名空间 + 可选 expectedRevision；不满足返回错误包络，满足返回 null */
  function checkSettingsWrite(payload: { ns?: unknown; expectedRevision?: unknown }): DshRpcResult | null {
    if (payload.ns !== DSH_SETTINGS_NS) return dshSettingsNotExposed(payload.ns)
    if (typeof payload.expectedRevision === 'number' && payload.expectedRevision !== settingsRevision) {
      return dshSettingsConflict(payload.expectedRevision, settingsRevision)
    }
    return null
  }

  async function dshSettingsDescribe(): Promise<DshRpcResult> {
    const view = await buildSettingsNamespaceView()
    return { ok: true, value: { writable: true, hasDocument: false, namespaces: [view] } }
  }

  async function dshSettingsUpdate(payload: unknown): Promise<DshRpcResult> {
    const p = (payload ?? {}) as { ns?: unknown; patch?: unknown; expectedRevision?: unknown }
    const denied = checkSettingsWrite(p)
    if (denied) return denied
    const patch = (p.patch ?? {}) as Record<string, unknown>
    if (Object.keys(patch).length > 0) {
      await patchSettings(patch as Partial<DshSettings>)
      settingsRevision += 1
    }
    return { ok: true, value: await buildSettingsNamespaceView() }
  }

  async function dshSettingsReplace(payload: unknown): Promise<DshRpcResult> {
    const p = (payload ?? {}) as { ns?: unknown; section?: unknown; expectedRevision?: unknown }
    const denied = checkSettingsWrite(p)
    if (denied) return denied
    const section = (p.section ?? {}) as Record<string, unknown>
    if (Object.keys(section).length > 0) {
      await patchSettings(section as Partial<DshSettings>)
      settingsRevision += 1
    }
    return { ok: true, value: await buildSettingsNamespaceView() }
  }

  async function dshSettingsMutate(payload: unknown): Promise<DshRpcResult> {
    const p = (payload ?? {}) as { ns?: unknown; ops?: unknown; expectedRevision?: unknown }
    const denied = checkSettingsWrite(p)
    if (denied) return denied
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
            settingsPath: ['provider'],
            active: true,
          },
        ],
      },
    }
  }

  function dshLlmModels(): DshRpcResult {
    return { ok: true, value: { groups: DSH_MODEL_GROUPS, failures: [] } }
  }

  // ── 分派表（未列出的方法回落到 dshNotImplemented 错误包络）────────
  const dshRpcHandlers: Record<string, DshRpcHandler> = {
    'host.describe': () => ({ ok: true, value: dshDescribeValue() }),
    'session.list': () => ({ ok: true, value: { items: [] } }),
    'session.search': () => ({ ok: true, value: { items: [], hasMore: false } }),
    'session.create': dshSessionCreate,
    'session.history': () => ({ ok: true, value: { events: [], hasMore: false } }),
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
    'workspace.insertBefore': () => ({ ok: true, value: { workspaceIds: [DSH_WORKSPACE_ID] } }),
    'workspace.insertSessionBefore': dshWorkspaceInsertSessionBefore,
    'workspace.archiveSession': () => ({ ok: true, value: { archivedSessionIds: [] } }),
    'skill.list': dshSkillList,
    'settings.describe': dshSettingsDescribe,
    'settings.update': dshSettingsUpdate,
    'settings.replace': dshSettingsReplace,
    'settings.mutate': dshSettingsMutate,
    'llm.providers': dshLlmProviders,
    'llm.models': dshLlmModels,
    // agentPreset.list 由 dsh UI 启动时即调用（Agent 预设面板），返回空列表
    // 而非错误包络，避免面板显示「无法加载 Agent 预设」
    'agentPreset.list': () => ({
      ok: true,
      value: { presets: [], authorable: false, hasDocument: false },
    }),
    // credentials.describe / subagent.list：对应面板启动即调用，返回空数据
    'credentials.describe': () => ({ ok: true, value: { credentials: {} } }),
    'subagent.list': () => ({ ok: true, value: { entries: [], parentAvailable: true } }),
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
    const handler = dshRpcHandlers[req.method]
    let result: DshRpcResult
    try {
      result = handler ? await handler(req.payload) : dshNotImplemented(req.method)
    } catch (err) {
      // 任何实现抛错都收拢为合法错误包络，避免把异常泄漏给 iframe
      result = {
        ok: false,
        error: {
          code: 'internal',
          message: `dsh RPC failed: ${req.method}: ${err instanceof Error ? err.message : String(err)}`,
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

  // ── dsh 流（mux / host）骨架：保持端口打开、响应订阅、断线清理 ──
  const dshStreamPorts = new Set<chrome.runtime.Port>()

  interface DshStreamSubscribe {
    readonly kind: 'dsh-stream-subscribe'
    readonly stream: 'mux' | 'host'
  }

  function isDshStreamSubscribe(msg: unknown): msg is DshStreamSubscribe {
    if (typeof msg !== 'object' || msg === null) return false
    const m = msg as { kind?: unknown; stream?: unknown }
    return m.kind === 'dsh-stream-subscribe' && (m.stream === 'mux' || m.stream === 'host')
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'dsh-stream') return
    dshStreamPorts.add(port)
    port.onMessage.addListener((msg: unknown) => {
      if (!isDshStreamSubscribe(msg)) return
      // 骨架阶段不推送任何 frame（NOT-IMPLEMENTED frame 可能破坏客户端 gap 检测），仅保持端口打开
      port.postMessage({ kind: 'dsh-stream-ok', body: { stream: msg.stream } })
    })
    port.onDisconnect.addListener(() => {
      dshStreamPorts.delete(port)
    })
  })
})