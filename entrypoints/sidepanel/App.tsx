import { useEffect, useState } from 'react'

interface PageState {
  authPresent: boolean
  url: string
  connected: boolean
}

const INITIAL: PageState = { authPresent: false, url: '', connected: false }

/**
 * dsh-in-web Side Panel 壳（Wave 0）。
 * 展示四件套链路状态：SW 连接 / 页面桥接 / 登录态。
 * Wave 1+ 在此挂会话面板、文件树、skill 库、提示词编辑器、终端。
 */
export function App() {
  const [state, setState] = useState<PageState>(INITIAL)
  const [portState, setPortState] = useState<'connecting' | 'open' | 'closed'>('connecting')

  useEffect(() => {
    const port = chrome.runtime.connect({ name: 'dsh-panel-port' })
    const onMessage = (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        (message as { topic?: unknown }).topic === 'page-state'
      ) {
        setState((message as { payload: PageState }).payload)
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

  return (
    <div className="panel">
      <header className="panel__header">
        <h1 className="panel__title">dsh-in-web</h1>
        <span className={`badge ${state.connected ? 'badge--ok' : 'badge--warn'}`}>
          {state.connected ? '页面已桥接' : '等待页面'}
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
          <span className="status__label">chat.deepseek.com 登录态</span>
          <span className={`badge ${state.authPresent ? 'badge--ok' : 'badge--err'}`}>
            {state.authPresent ? '已登录' : '未检测到登录'}
          </span>
        </div>
        <div className="status__row">
          <span className="status__label">当前页面</span>
          <span className="status__url" title={state.url}>
            {state.url || '—'}
          </span>
        </div>
      </section>

      <section className="placeholder">
        <p>Wave 0 骨架已就绪。</p>
        <p>Wave 1+ 将在此提供：会话 / 文件系统 / skill 库 / 提示词 / 终端。</p>
      </section>
    </div>
  )
}
