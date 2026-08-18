/**
 * client.ts —— DeepSeekWebClient 的 TDD 测试。
 * 用可注入 fetcher mock 网络层，覆盖：SSE 流式、PoW 重试、错误类型、会话创建。
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

/**
 * 可感知调用序号的 fetcher：第一跳（create_session）返回会话 id，
 * 后续跳委托给 handler（completion）。
 */
function sessionAwareFetcher(
  handler: (url: string, init: RequestInit | undefined, callIndex: number) => Promise<Response>,
) {
  let calls = 0
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const idx = calls++
    if (idx === 0 && String(url).includes('/chat_session/create')) {
      return jsonResponse({ data: { biz_data: { id: 'sid-1' } } })
    }
    return handler(url, init, idx)
  }
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

async function collect(gen: AsyncGenerator<BridgeEvent>): Promise<BridgeEvent[]> {
  const out: BridgeEvent[] = []
  for await (const e of gen) out.push(e)
  return out
}

const enc = new TextEncoder()

describe('DeepSeekWebClient.streamChat', () => {
  it('SSE 成功流：thinking → text → finish', async () => {
    const handler = async (_url: string, _init?: RequestInit): Promise<Response> =>
      sseResponse([
        'data: {"v":"思考中","p":"response/thinking_content"}',
        'data: {"v":"你好","p":"response/content"}',
        'data: {"v":"FINISHED","p":"response/status"}',
        'data: [DONE]',
        '',
      ].join('\n'))
    const fetcher = vi.fn(sessionAwareFetcher(handler))
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
    // 第二跳（completion）请求体应含拼装好的 prompt 与默认模型参数
    const [, init] = fetcher.mock.calls[1]!
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body.prompt).toBe('User: hi')
    expect(body.thinking_enabled).toBe(true)
    expect(body.model_type).toBe('default')
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok')
  })

  it('PoW 重试：completion 返回 biz_code:40010 后带 x-ds-pow-response 重发', async () => {
    // 真实 challenge：answer=777（由 create_pow_challenge 端点返回）
    const c = makeRealChallenge('pow-salt', 777)
    const completionPow: string[] = []
    const fetcher = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      if (String(url).includes('/chat_session/create')) {
        return jsonResponse({ data: { biz_data: { id: 'sid-1' } } })
      }
      if (String(url).includes('/chat/create_pow_challenge')) {
        return jsonResponse({
          data: { biz_data: { challenge: { algorithm: 'DeepSeekHashV1', ...c, signature: 'sig', target_path: '/api/v0/chat/completion' } } },
        })
      }
      // completion
      completionPow.push(headers['x-ds-pow-response'] ?? '')
      if (!headers['x-ds-pow-response']) {
        return jsonResponse({ biz_code: 40010, message: 'pow_required' })
      }
      return sseResponse('data: {"v":"FINISHED","p":"response/status"}\n')
    })
    const client = new DeepSeekWebClient({ userToken: 'tok' })
    const events = await collect(client.streamChat(
      [{ role: 'user', content: 'hi' }],
      { fetcher: fetcher as typeof fetch },
    ))
    expect(events).toEqual([{ kind: 'finish' }])
    expect(completionPow.length).toBe(2)
    expect(completionPow[0]).toBe('')
    expect(completionPow[1]).toBeTruthy()
    // PoW 头能解出 answer=777
    const parsed = JSON.parse(atob(completionPow[1]!)) as { answer: number }
    expect(parsed.answer).toBe(777)
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

  it('缺 biz_data.id → DSWebProtocolError', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ data: { biz_data: {} } }))
    const client = new DeepSeekWebClient({ userToken: 'tok' })
    await expect(client.createChatSession({ fetcher: fetcher as typeof fetch })).rejects.toBeInstanceOf(DSWebProtocolError)
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

// 引用 enc 避免未使用告警（保留给未来二进制测试）
void enc
