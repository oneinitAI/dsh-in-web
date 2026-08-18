/**
 * protocol.ts —— 端点/请求头/请求体/消息拼装的 TDD 测试。
 * 契约来源：yinshuo-thu/deepseek-cli 的 dswebClient.ts（ds2api Go 参考的镜像）。
 */
import { describe, expect, it } from 'vitest'
import {
  buildClientTimezoneOffset,
  buildCompletionBody,
  buildContinueBody,
  buildCreateSessionBody,
  buildHeaders,
  buildPowChallengeBody,
  ENDPOINTS,
  flattenMessagesToPrompt,
  type Message,
} from '../../utils/bridge/protocol'

describe('endpoints', () => {
  it('暴露完整端点清单', () => {
    expect(ENDPOINTS.chatCompletion).toBe('/api/v0/chat/completion')
    expect(ENDPOINTS.chatContinue).toBe('/api/v0/chat/continue')
    expect(ENDPOINTS.chatStopStream).toBe('/api/v0/chat/stop_stream')
    expect(ENDPOINTS.chatSessionCreate).toBe('/api/v0/chat_session/create')
    expect(ENDPOINTS.createPowChallenge).toBe('/api/v0/chat/create_pow_challenge')
    expect(ENDPOINTS.usersCurrent).toBe('/api/v0/users/current')
    expect(ENDPOINTS.chatHistoryMessages).toBe('/api/v0/chat/history_messages')
  })
})

describe('flattenMessagesToPrompt', () => {
  it('按 System/User/Assistant 角色前缀拼装，\\n\\n 分隔', () => {
    const messages: Message[] = [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！' },
      { role: 'user', content: '谢谢' },
    ]
    expect(flattenMessagesToPrompt(messages)).toBe(
      'System: 你是助手\n\nUser: 你好\n\nAssistant: 你好！\n\nUser: 谢谢',
    )
  })
  it('tool 角色使用 Tool: 前缀', () => {
    const messages: Message[] = [
      { role: 'user', content: '查文件' },
      { role: 'assistant', content: '读取中' },
      { role: 'tool', content: '{ok:true}' },
    ]
    const flat = flattenMessagesToPrompt(messages)
    expect(flat).toContain('Tool: {ok:true}')
  })
  it('跳过空 content 的消息', () => {
    expect(flattenMessagesToPrompt([
      { role: 'user', content: '  ' },
      { role: 'user', content: '实际内容' },
    ])).toBe('User: 实际内容')
  })
  it('空数组返回空串', () => {
    expect(flattenMessagesToPrompt([])).toBe('')
  })
})

describe('buildClientTimezoneOffset', () => {
  it('UTC+8 时区返回 28800 秒', () => {
    // 2026-01-01 中国时区 getTimezoneOffset() === -480
    const fakeNow = new Date('2026-01-01T00:00:00+08:00')
    // 直接注入一个已知 offset 的 Date 不可行，这里验证函数形态：与 -getTimezoneOffset()*60 一致
    const d = new Date(2026, 0, 1, 12, 0, 0) // 本地时间
    const expected = -d.getTimezoneOffset() * 60
    expect(buildClientTimezoneOffset(d)).toBe(expected)
    // 中国时区应 > 0
    expect(expected).toBeGreaterThanOrEqual(0)
  })
})

describe('buildHeaders', () => {
  it('包含必要头', () => {
    const h = buildHeaders({ authorization: 'Bearer tok123' })
    expect(h.authorization).toBe('Bearer tok123')
    expect(h.origin).toBe('https://chat.deepseek.com')
    expect(h.referer).toBe('https://chat.deepseek.com/')
    expect(h.accept).toContain('text/event-stream')
    expect(h['content-type']).toBe('application/json')
    expect(h['x-client-platform']).toBe('web')
    expect(h['x-client-version']).toBeDefined()
    expect(h['x-client-bundle-id']).toBe('com.deepseek.chat')
  })
  it('PoW 头存在时加入 x-ds-pow-response', () => {
    const h = buildHeaders({ authorization: 'x', powResponse: 'abc' })
    expect(h['x-ds-pow-response']).toBe('abc')
  })
  it('contentType=null 时不输出 content-type', () => {
    const h = buildHeaders({ authorization: 'x', contentType: null })
    expect(h['content-type']).toBeUndefined()
  })
})

describe('request bodies', () => {
  it('buildCompletionBody 结构完整', () => {
    const raw = buildCompletionBody({
      chat_session_id: 'sid-1',
      model_type: 'default',
      parent_message_id: null,
      prompt: 'System: x\n\nUser: y',
      ref_file_ids: [],
      thinking_enabled: true,
      search_enabled: false,
      preempt: false,
    })
    const body = JSON.parse(raw) as Record<string, unknown>
    expect(body.chat_session_id).toBe('sid-1')
    expect(body.model_type).toBe('default')
    expect(body.parent_message_id).toBeNull()
    expect(body.prompt).toContain('User: y')
    expect(body.ref_file_ids).toEqual([])
    expect(body.thinking_enabled).toBe(true)
    expect(body.search_enabled).toBe(false)
    expect(body.preempt).toBe(false)
  })
  it('buildContinueBody 结构正确', () => {
    const body = JSON.parse(buildContinueBody('sid-1', 42)) as Record<string, unknown>
    expect(body.chat_session_id).toBe('sid-1')
    expect(body.message_id).toBe(42)
    expect(body.fallback_to_resume).toBe(true)
  })
  it('buildCreateSessionBody 含 agent', () => {
    expect(JSON.parse(buildCreateSessionBody())).toEqual({ agent: 'chat' })
  })
  it('buildPowChallengeBody 含 target_path', () => {
    expect(JSON.parse(buildPowChallengeBody('/api/v0/chat/completion'))).toEqual({
      target_path: '/api/v0/chat/completion',
    })
  })
})
