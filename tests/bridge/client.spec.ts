/**
 * client.ts —— DeepSeekWebClient 的 TDD 测试。
 * 用可注入 fetcher mock 网络层，覆盖：SSE 流式、主动 PoW、错误类型、会话创建、accessToken 换取。
 * 流程对齐 OmniRoute：currentUser 换 token → create_session → create_pow_challenge → completion。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  DSWebAuthError,
  DSWebChallengeError,
  DSWebProtocolError,
  DeepSeekWebClient,
  type BridgeEvent,
} from '../../utils/bridge/client'
import { deepSeekHashV1, bytesToHex } from '../../utils/bridge/pow'

/** 从 SSE 文本构造一个 mock Response */
function sseResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 官方向量：造一个真实 challenge 让客户端能解出 answer */
function makeRealChallenge(salt: string, answer: number, diff = 2000) {
  const expire = 1712345678
  const challenge = bytesToHex(deepSeekHashV1(new TextEncoder().encode(`${salt}_${expire}_${answer}`)))
  return {
    challenge,
    salt,
    expire_at: expire,
    difficulty: diff,
  }
}

/**
 * 对齐当前 streamChat 流程的通用 fetcher：
 *   users/current → accessToken；chat_session/create → sid；
 *   chat/create_pow_challenge → 真实 challenge（answer=777）；其余跳委托 handler。
 */
function chatAwareFetcher(
  handler: (url: string, init: RequestInit | undefined, callIndex: number) => Promise<Response>,
  accessToken = 'access-token-1',
) {
  let calls = 0
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const idx = calls++
    const u = String(url)
    if (u.includes('/users/current')) {
      return jsonResponse({ data: { biz_data: { token: accessToken } } })
    }
    if (u.includes('/chat_session/create')) {
      return jsonResponse({ data: { biz_data: { id: 'sid-1' } } })
    }
    if (u.includes('/chat/create_pow_challenge')) {
      return jsonResponse({
        data: {
          biz_data: {
            challenge: { algorithm: 'DeepSeekHashV1', ...makeRealChallenge('pow-salt', 777), signature: 'sig', target_path: '/api/v0/chat/completion' },
          },
        },
      })
    }
    return handler(url, init, idx)
  }
}

async function collect(gen: AsyncGenerator<BridgeEvent>): Promise<BridgeEvent[]> {
  const out: BridgeEvent[] = []
  for await (const e of gen) out.push(e)
  return out
}

describe('DeepSeekWebClient.streamChat', () => {
  it('SSE 成功流：thinking → text → finish（userToken 自动换 accessToken）', async () => {
    const handler = async (_url: string, _init?: RequestInit): Promise<Response> =>
      sseResponse([
        'data: {"v":"思考中","p":"response/thinking_content"}',
        'data: {"v":"你好","p":"response/content"}',
        'data: {"v":"FINISHED","p":"response/status"}',
        'data: [DONE]',
        '',
      ].join('\n'))
    const fetcher = vi.fn(chatAwareFetcher(handler))
    const client = new DeepSeekWebClient({ userToken: 'tok' })
    const events = await collect(client.streamChat(
      [{ role: 'user', content: 'hi' }],
      { reasoning: true, fetcher: fetcher as typeof fetch },
    ))
    expect(events).toEqual([
      { kind: 'thinking', text: '思考中' },
      { kind: 'text', text: '你好' },
      { kind: 'finish' },
    ])
    // 请求序列：users/current(0) → create_session(1) → create_pow_challenge(2) → completion(3)
    expect(fetcher.mock.calls[0]![0]).toContain('/users/current')
    expect(fetcher.mock.calls[1]![0]).toContain('/chat_session/create')
    expect(fetcher.mock.calls[2]![0]).toContain('/chat/create_pow_challenge')
    const [, init] = fetcher.mock.calls[3]!
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body.prompt).toBe('User: hi')
    expect(body.thinking_enabled).toBe(true)
    expect(body.model_type).toBe('default')
    expect(body.preempt).toBe(false)
    // completion 用换取的 accessToken 作 Bearer
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer access-token-1')
  })

  it('search 选项透传到 completion body（search_enabled）', async () => {
    const handler = async (_url: string, _init?: RequestInit): Promise<Response> =>
      sseResponse('data: {"v":"FINISHED","p":"response/status"}\n')
    const fetcher = vi.fn(chatAwareFetcher(handler))
    const client = new DeepSeekWebClient({ userToken: 'tok' })
    await collect(client.streamChat(
      [{ role: 'user', content: '查一下' }],
      { search: true, fetcher: fetcher as typeof fetch },
    ))
    const [, init] = fetcher.mock.calls[3]!
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body.search_enabled).toBe(true)
    // 未传 search 时默认 false（防意外开启）
    const fetcher2 = vi.fn(chatAwareFetcher(handler))
    await collect(new DeepSeekWebClient({ userToken: 'tok' }).streamChat(
      [{ role: 'user', content: 'hi' }],
      { fetcher: fetcher2 as typeof fetch },
    ))
    const [, init2] = fetcher2.mock.calls[3]!
    const body2 = JSON.parse(String(init2?.body)) as Record<string, unknown>
    expect(body2.search_enabled).toBe(false)
  })

  it('onSessionId 回调返回实际使用的 chat_session_id（复用或新建）', async () => {
    const handler = async (_url: string, _init?: RequestInit): Promise<Response> =>
      sseResponse('data: {"v":"FINISHED","p":"response/status"}\n')
    // 传 chatSessionId → 复用已有会话，不再调用 create_session
    const fetcher = vi.fn(chatAwareFetcher(handler))
    const sessionIds: (string | undefined)[] = []
    await collect(new DeepSeekWebClient({ userToken: 'tok' }).streamChat(
      [{ role: 'user', content: 'hi' }],
      { chatSessionId: 'sid-reuse', fetcher: fetcher as typeof fetch, onSessionId: (id) => sessionIds.push(id) },
    ))
    expect(sessionIds).toEqual(['sid-reuse'])
    // 复用时不请求 create_session：calls = current(0) + pow(1) + completion(2)
    expect(fetcher.mock.calls.map(([u]) => String(u))).not.toContain(expect.stringContaining('/chat_session/create'))
  })

  it('completion 请求总带有效的 x-ds-pow-response（主动 PoW）', async () => {
    const completionPow: string[] = []
    const fetcher = vi.fn(chatAwareFetcher(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/chat/completion')) {
        const headers = (init?.headers ?? {}) as Record<string, string>
        completionPow.push(headers['x-ds-pow-response'] ?? '')
        return sseResponse('data: {"v":"FINISHED","p":"response/status"}\n')
      }
      throw new Error(`unexpected call: ${url}`)
    }))
    const client = new DeepSeekWebClient({ userToken: 'tok' })
    const events = await collect(client.streamChat(
      [{ role: 'user', content: 'hi' }],
      { fetcher: fetcher as typeof fetch },
    ))
    expect(events).toEqual([{ kind: 'finish' }])
    // completion 仅一次，且带 PoW 头
    expect(completionPow.length).toBe(1)
    expect(completionPow[0]).toBeTruthy()
    // PoW 头能解出 answer=777
    const parsed = JSON.parse(atob(completionPow[0]!)) as { answer: number; target_path: string }
    expect(parsed.answer).toBe(777)
    expect(parsed.target_path).toBe('/api/v0/chat/completion')
  })

  it('completion 返回 40010（带 header 仍被拒）→ DSWebProtocolError', async () => {
    const fetcher = vi.fn(chatAwareFetcher(async () =>
      jsonResponse({ biz_code: 40010, message: 'pow_required' })))
    const client = new DeepSeekWebClient({ userToken: 'tok' })
    const err = await collect(client.streamChat(
      [{ role: 'user', content: 'hi' }],
      { fetcher: fetcher as typeof fetch },
    )).catch((e) => e)
    expect(err).toBeInstanceOf(DSWebProtocolError)
    expect(String((err as Error).message)).toContain('pow_required after retry')
  })

  it('completion 返回 200 + 未知 JSON → DSWebProtocolError（错误信息含响应摘要）', async () => {
    const fetcher = vi.fn(chatAwareFetcher(async () =>
      jsonResponse({ biz_code: 40003, message: 'access token expired' })))
    const client = new DeepSeekWebClient({ userToken: 'tok' })
    const err = await collect(client.streamChat(
      [{ role: 'user', content: 'hi' }],
      { fetcher: fetcher as typeof fetch },
    )).catch((e) => e)
    expect(err).toBeInstanceOf(DSWebProtocolError)
    expect(String((err as Error).message)).toContain('completion: unexpected JSON body')
    expect(String((err as Error).message)).toContain('biz_code')
  })

  it('403 + HTML → DSWebChallengeError', async () => {
    const fetcher = vi.fn(async () => new Response('<html>challenge</html>', { status: 403, headers: { 'content-type': 'text/html' } }))
    const client = new DeepSeekWebClient({ userToken: 'tok' })
    await expect(async () => {
      await collect(client.streamChat([{ role: 'user', content: 'hi' }], { fetcher: fetcher as typeof fetch }))
    }).rejects.toBeInstanceOf(DSWebChallengeError)
  })

  it('401 → DSWebAuthError', async () => {
    const fetcher = vi.fn(async () => jsonResponse({}, 401))
    const client = new DeepSeekWebClient({ userToken: 'tok' })
    await expect(async () => {
      await collect(client.streamChat([{ role: 'user', content: 'hi' }], { fetcher: fetcher as typeof fetch }))
    }).rejects.toBeInstanceOf(DSWebAuthError)
  })

  it('显式传 accessToken 时跳过 users/current', async () => {
    const handler = async (_url: string, _init?: RequestInit): Promise<Response> =>
      sseResponse('data: {"v":"FINISHED","p":"response/status"}\n')
    const fetcher = vi.fn(chatAwareFetcher(handler))
    const client = new DeepSeekWebClient({ userToken: 'tok' })
    await collect(client.streamChat(
      [{ role: 'user', content: 'hi' }],
      { fetcher: fetcher as typeof fetch, accessToken: 'pre-acquired' },
    ))
    // 第一跳直接是 create_session，无 users/current
    expect(fetcher.mock.calls[0]![0]).toContain('/chat_session/create')
    const completionCall = fetcher.mock.calls.find(([u]) => String(u).includes('/chat/completion'))
    expect((completionCall![1]?.headers as Record<string, string>).authorization).toBe('Bearer pre-acquired')
  })
})

describe('DeepSeekWebClient.createChatSession', () => {
  it('从 biz_data.id 提取会话 id', async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ data: { biz_data: { id: 'sid-abc' } } }))
    const client = new DeepSeekWebClient({ userToken: 'tok' })
    const id = await client.createChatSession({ fetcher: fetcher as typeof fetch })
    expect(id).toBe('sid-abc')
    const [, init] = fetcher.mock.calls[0]!
    expect(JSON.parse(String(init?.body))).toEqual({ agent: 'chat' })
  })

  it('从 biz_data.chat_session.id（嵌套结构）提取会话 id', async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ data: { biz_data: { chat_session: { id: 'sid-nested' } } } }))
    const client = new DeepSeekWebClient({ userToken: 'tok' })
    const id = await client.createChatSession({ fetcher: fetcher as typeof fetch })
    expect(id).toBe('sid-nested')
  })

  it('缺会话 id → DSWebProtocolError（错误信息含响应摘要便于诊断）', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ data: { biz_data: {} } }))
    const client = new DeepSeekWebClient({ userToken: 'tok' })
    const err = await client.createChatSession({ fetcher: fetcher as typeof fetch }).catch((e) => e)
    expect(err).toBeInstanceOf(DSWebProtocolError)
    expect(String((err as Error).message)).toContain('create_session')
  })
})

describe('accessToken 流程', () => {
  it('currentUser 从 biz_data.token 取 accessToken', async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ data: { biz_data: { token: 'access-token-1' } } }))
    const client = new DeepSeekWebClient({ userToken: 'user-token-1' })
    const token = await client.currentUser({ fetcher: fetcher as typeof fetch })
    expect(token).toBe('access-token-1')
    const [, init] = fetcher.mock.calls[0]!
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer user-token-1')
  })
})