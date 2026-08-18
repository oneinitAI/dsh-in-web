// dsh-in-web side panel host.
//
// 自 Wave 5 起 side panel 是「dsh 模式开关页」：
//   - dshMode === 'off'：渲染 App.tsx（设置开关页，默认落在「设置」标签，含 dsh 模式开关）
//   - dshMode === 'on' ：渲染全屏 iframe 加载官方 dsh shell（public/dsh-web/index.html），
//                        并在主视图层叠加「退出 dsh 模式」按钮（side panel 自身打开的
//                        iframe 不带 ?embed=1，App.tsx 的 IS_EMBEDDED 退出按钮不生效，
//                        所以在这里补一个）。
//
// 状态联动：App.tsx 设置页开关 → patchSettings({dshMode}) → chrome.storage.onChanged
// → subscribeSettings 通知本组件实时切换视图（与 dsh-ui.content.ts 的页面注入同链路）。
//
// iframe 加载的 dsh shell 读取 window.__DSH_BOOT__（boot-manifest.js 设置）并挂载整个
// Cordis 客户端插件生态，same-origin 于扩展，chrome.runtime messaging 可用。

import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './style.css'
import { getSettings, patchSettings, subscribeSettings, type DshSettings } from '@/utils/settings/settings'

/** 是否以 iframe 嵌入模式运行（dsh-ui.content.ts 注入的 URL 带 ?embed=1） */
const IS_EMBEDDED = typeof location !== 'undefined' && location.search.includes('embed=1')

function PanelRoot() {
  const [settings, setSettings] = useState<DshSettings | null>(null)

  useEffect(() => {
    void getSettings().then(setSettings)
    return subscribeSettings(setSettings)
  }, [])

  const dshOn = settings?.dshMode === 'on'

  // side panel 自身打开的 iframe 没有 ?embed=1，退出按钮由本层叠加；
  // 网页注入路径（?embed=1）由 App.tsx 内部的 IS_EMBEDDED 退出按钮负责。
  const showExit = dshOn && !IS_EMBEDDED

  return (
    <div className="dsh-panel-host">
      {dshOn ? (
        <>
          <iframe
            className="dsh-panel-host__frame"
            src={chrome.runtime.getURL('dsh-web/index.html')}
            aria-label="dsh panel"
          />
          {showExit && (
            <button
              className="btn btn--danger dsh-panel-host__exit"
              onClick={() => void patchSettings({ dshMode: 'off' })}
            >
              退出 dsh 模式
            </button>
          )}
        </>
      ) : (
        <App />
      )}
    </div>
  )
}

const root = document.getElementById('root')!
createRoot(root).render(<PanelRoot />)
