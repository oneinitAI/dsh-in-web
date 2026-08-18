// dsh-in-web side panel host.
//
// side panel 永远是开关/设置页（App.tsx）：
//   - dshMode 开关在 App.tsx 的「设置」标签里控制
//   - 打开 dsh 模式只影响 chat.deepseek.com 网页上的对话界面
//     （dsh-ui.content.ts 注入的全屏 dsh iframe），side panel 自身不变
//   - 网页注入路径（?embed=1）由 App.tsx 内部的 IS_EMBEDDED 退出按钮负责；
//     side panel 自身打开的页面没有 ?embed=1，因此不显示退出按钮——关闭
//     dsh 模式直接在设置页操作开关即可。

import { createRoot } from 'react-dom/client'
import { App } from './App'
import './style.css'

const root = document.getElementById('root')!
createRoot(root).render(<App />)
