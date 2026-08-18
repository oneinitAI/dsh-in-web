import { useEffect, useRef, useState } from 'react'
import type { Message } from '@/utils/bridge/protocol'
import type { BridgeEventMessage } from '@/utils/messages'

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

/**
 * dsh-in-web Side Panel（Wave 1）：
 * 状态区（SW 连接/页面桥接/登录态）+ 聊天区（流式输出）+ 输入发送/停止。
 */
export function App() {
  const [state, setState] = useState<PageState>(INITIAL)
  const [portState, setPortState] = useState<'connecting' | 'open' | 'closed'>('connecting')
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

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

  return (
    <div className="panel">
      <header className="panel__header">
        <h1 className="panel__title">dsh-in-web</h1>
        <span className={`badge ${state.connected ? 'badge--ok' : 'badge--warn'}`}>
          {state.connected ? '已桥接' : '等待页面'}
        </span>
      </header>

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
    </div>
  )
}
