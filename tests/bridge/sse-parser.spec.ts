/**
 * sse-parser.ts —— SSE chunk 解析的 TDD 测试。
 * 契约来源：yinshuo-thu/deepseek-cli 的 dswebClient.ts parseDeepSeekChunk
 * （ds2api Go 参考的镜像），覆盖两种 chunk 形态 + 跳过路径 + fragments。
 */
import { describe, expect, it } from 'vitest'
import { parseDeepSeekChunk } from '../../utils/bridge/sse-parser'

describe('parseDeepSeekChunk', () => {
  it('解析 response/content 为 text 事件', () => {
    const { events } = parseDeepSeekChunk({ v: '你好', p: 'response/content' }, { thinkingEnabled: true })
    expect(events).toEqual([{ kind: 'text', text: '你好' }])
  })

  it('解析 response/thinking_content 为 thinking 事件', () => {
    const { events } = parseDeepSeekChunk({ v: '思考中', p: 'response/thinking_content' }, { thinkingEnabled: true })
    expect(events).toEqual([{ kind: 'thinking', text: '思考中' }])
  })

  it('解析 response/status=FINISHED 为 finish 事件', () => {
    const { events } = parseDeepSeekChunk({ v: 'FINISHED', p: 'response/status' }, {})
    expect(events).toEqual([{ kind: 'finish' }])
  })

  it('解析嵌套批处理数组（v 为数组）逐项递归', () => {
    const { events } = parseDeepSeekChunk(
      { v: [{ p: 'response/thinking_content', v: '想' }, { p: 'response/content', v: '好' }], p: '' },
      { thinkingEnabled: true },
    )
    expect(events).toEqual([
      { kind: 'thinking', text: '想' },
      { kind: 'text', text: '好' },
    ])
  })

  it('跳过 quasi_status / search_status / elapsed_secs', () => {
    const { events } = parseDeepSeekChunk({ v: { x: 1 }, p: 'response/quasi_status' }, {})
    const { events: e2 } = parseDeepSeekChunk({ v: { x: 1 }, p: 'response/search_status' }, {})
    const { events: e3 } = parseDeepSeekChunk({ v: 1.2, p: 'response/elapsed_secs' }, {})
    expect(events).toEqual([])
    expect(e2).toEqual([])
    expect(e3).toEqual([])
  })

  it('解析 fragments 数组（THINK/RESPONSE）', () => {
    const { events, nextType } = parseDeepSeekChunk(
      {
        v: { response: { fragments: [{ type: 'THINK', content: '推理' }, { type: 'RESPONSE', content: '回答' }] } },
        p: '',
      },
      { thinkingEnabled: true },
    )
    expect(events).toEqual([
      { kind: 'thinking', text: '推理' },
      { kind: 'text', text: '回答' },
    ])
    expect(nextType).toBe('text')
  })

  it('fragments 中 type=ANSWER 归入当前类型', () => {
    const { events } = parseDeepSeekChunk(
      { v: { response: { fragments: [{ type: 'ANSWER', content: '答' }] } }, p: '' },
      { thinkingEnabled: true, currentType: 'text' },
    )
    expect(events).toEqual([{ kind: 'text', text: '答' }])
  })

  it('非 FINISHED 的 status 不产出事件', () => {
    const { events } = parseDeepSeekChunk({ v: 'INCOMPLETE', p: 'response/status' }, {})
    expect(events).toEqual([])
  })

  it('无 v 字段的 chunk 返回空', () => {
    expect(parseDeepSeekChunk({ p: 'x' }, {}).events).toEqual([])
  })
})
