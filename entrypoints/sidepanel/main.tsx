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

// dsh-in-web side panel host.
//
// 两种呈现模式（按 URL 分流）：
//   - ?embed=1（dsh-ui.content.ts 在 chat.deepseek.com 注入的全屏 iframe）：
//     渲染官方 dsh harness（dsh-web/index.html）+ 浮层「退出 dsh 模式」按钮。
//   - 否则（side panel 自身打开）：渲染 App.tsx 设置/开关页——
//     dshMode 开关在这里控制，开启后网页对话界面切换为 dsh harness 形态，
//     side panel 自身保持开关页不变。

import { createRoot } from 'react-dom/client'
import { App } from './App'
import './style.css'
import { patchSettings } from '@/utils/settings/settings'

/** 网页注入模式（dsh-ui.content.ts 注入的 URL 带 ?embed=1） */
const IS_EMBEDDED = typeof location !== 'undefined' && location.search.includes('embed=1')

/** 网页注入模式：全屏官方 dsh harness + 浮层退出按钮 */
function EmbedRoot() {
  return (
    <div className="dsh-panel-host">
      <iframe
        className="dsh-panel-host__frame"
        src={chrome.runtime.getURL('dsh-web/index.html')}
        aria-label="dsh panel"
      />
      <button
        className="btn btn--danger dsh-panel-host__exit"
        onClick={() => void patchSettings({ dshMode: 'off' })}
      >
        退出 dsh 模式
      </button>
    </div>
  )
}

const root = document.getElementById('root')!
createRoot(root).render(IS_EMBEDDED ? <EmbedRoot /> : <App />)
