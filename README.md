# dsh-in-web

> **dsh (DeepSeek Harness) 在浏览器里运行** · 无需本地安装，无需额外额度

把 [chat.deepseek.com](https://chat.deepseek.com) 网页版改造成 **dsh（DeepSeek Harness）** 形态的 **Chrome MV3 浏览器扩展**。

> **核心卖点**：完全无需本地安装 dsh。登录态、模型、对话全部复用网页版免费额度，扩展只负责两件事——把官方 dsh 前端完整嵌入，数据层走网页 bridge。

> **英文版 English**: [README.en.md](./README.en.md)

## ⚠️ 网页反代架构的弊端（先读这里）

本项目的数据面不是官方 API，而是**网页版内部接口的桥接（网页反代）**。这种架构带来以下结构性代价，请在使用前知悉：

1. **依赖未公开的网页私有接口，无稳定性承诺**
   数据面对接 chat.deepseek.com 的网页内部 API（`users/current`、`chat_session/create`、`chat/create_pow_challenge`、`chat/completion` SSE 流 + DeepSeekHashV1 PoW）。这些接口无文档、无版本化、无 SLA，官方任何改动（路径、签名、PoW 参数、响应结构）都可能让扩展**立即失效**，需逆向跟进修复。

2. **功能天花板被网页版锁死**
   - **模型面**：网页版仅暴露对话模型，API 侧更全的型号、更长上下文不可用；
   - **协议面**：网页 SSE 是私有流协议，**无原生 function calling**——agent 工具调用无法原生工作，需自行配置第三方 OpenAI 兼容供应商才能获得真正的 tools；
   - **参数面**：温度、thinking、推理强度等网页版不暴露的 API 参数无从谈起。

3. **登录态与网页账号强耦合**
   所有会话建立在浏览器中 chat.deepseek.com 的登录 cookie 之上。cookie 过期、异地登录踢下线、手动登出 → 扩展数据面**立即瘫痪**；扩展无法独立管理凭证或刷新 token，完全被动跟随网页登录态。

4. **必须存在 chat.deepseek.com 页面**
   LLM 网络层（DeepSeekWebClient）运行在该页面的 content script 中——因为 SW 的 fetch 无法伪造 `Origin / Referer`（浏览器 forbidden headers），服务端会拒绝。因此**该页面必须开着**才能发起会话，纯 sidepanel 使用场景受页面生命周期限制。

5. **风控与额度风险**
   agent 多轮循环、工具密集调用会在短时间内产生高频请求，可能触发网页版风控（验证码、限流、临时封禁）；额度/速率与网页账号共享，重度使用会消耗网页版配额。

6. **持续维护成本高**
   官方前端产物更新需重新同步（`import-dsh`）并重新过 CSP patch（顶层 `new Function` → stub）；若官方引入新的 eval 用法会白屏。接口逆向是常态工作，不是一次性。

7. **结构性可靠性弱**
   - MV3 Service Worker 空闲回收（约 30s）会打断长连接；扩展 reload / 更新后旧页面报 `Extension context invalidated`（已做自动恢复，但结构性风险仍在）；
   - **无真正后端**：无法固定出口 IP、无法服务端并发、无法跨设备同步、无法脱离浏览器运行。

8. **合规边界**
   自动化调用网页接口可能超出 DeepSeek 服务条款允许范围，**仅供个人学习研究使用**，请勿用于生产或商业场景。

---

## 🚀 特性 Features

- ✅ **嵌入式官方 dsh 前端**：完整移植 dsh Shell + 37 个 client 插件（会话 / 工作区 / 技能 / 提示词 / 模型 / Agent 预设 / 设置……），零修改官方产物，仅在同步时做最小 CSP 兼容 patch。
- 🎚️ **dsh 模式开关**：Side Panel 永远是设置 / 开关页。打开开关，chat.deepseek.com 对话界面立即切换为全屏 dsh harness 形态；关闭即恢复普通对话，实时生效无需刷新。
- 🔌 **bridge 传输层**：自定义 `dsh-client-connection` bundle 替换官方 HTTP/WebSocket 连接层，RPC 经 `chrome.runtime` 转发到扩展后台，数据走 chat.deepseek.com 网页会话。
- 🌐 **网页版数据通道**：LLM 网络层放在 content script（isolated world）：fetch 以页面 origin 发出，`Origin / Cookie` 天然正确，服务端不拒绝。
- 🧠 **Agent 能力**：
  - Agent 预设（标准 / PTC / 极简 / 创造模式）+ persona 注入每条消息；
  - **第三方 OpenAI 兼容供应商 + 原生 function calling**：在 dsh 模型设置页配置供应商后，agent 工具调用真实执行（文件编辑 / shell / 检索 / skills / 子代理……），不再退化成对话；未配置时回退网页 bridge。
- 🧱 **原生功能保留**：流式聊天（thinking / text 分开展示）、虚拟工作区、skill 库、提示词管理、终端 MVP、Cordis 插件内核、工作流。

## 🏗️ 架构 Architecture

> 一句话看懂：网页的登录态 + 扩展的 dsh 前端 + content script 的网络层，三条线在 Service Worker 汇合。

```mermaid
flowchart TD
    subgraph PAGE["🌐 chat.deepseek.com 网页"]
        PW["🧩 page-world (MAIN world)<br/>登录态探测"]
        BR["🔌 bridge (isolated world)<br/>DeepSeekWebClient<br/>fetch 以页面 origin 发出"]
        PW <-->|"postMessage"| BR
    end

    BR -->|"chrome.runtime"| SW["⚙️ Service Worker (background)<br/>消息路由 · agent loop · 工具执行<br/>Cordis 宿主 · dsh RPC 网关<br/>(dsh-rpc / dsh-stream)"]

    SW -->|"chrome.runtime dsh-rpc"| SP["📌 Side Panel<br/>dshMode 开关页 ↔ dsh iframe<br/>官方 dsh Shell + 37 插件<br/>数据层 BridgeApiClient"]

    SW -->|"chrome.runtime dsh-rpc"| INJ["🖼️ 网页注入 dsh iframe<br/>dsh-ui.content.ts 注入<br/>官方 dsh Shell + 37 插件<br/>数据层 BridgeApiClient"]
```

**关键设计决策**

- 🧱 **LLM 网络层放在 content script 而非 SW**：扩展 SW 的 fetch 无法伪造 `Origin / Referer`（浏览器 forbidden headers），服务端会拒绝；content script 的 fetch 自动以页面 origin 发出，天然正确。（这也是「网页反代」弊端的根源，见上。）
- 🛡️ **CSP：顶层 `new Function` → stub**：MV3 扩展页 CSP 禁止 `unsafe-eval`，官方 index bundle 模块顶层就有 `new Function`（Cordis jsExpr 求值器），加载即崩。`scripts/patch-dsh-web.mjs` 把它替换为安全 stub；已确认全部插件 bundle 均不含 `__jsExpr`，零功能损失。
- 🔀 **连接层：BridgeApiClient 替换**：官方 `dsh-client-connection` 走 HTTP/WebSocket 连本地 harness，浏览器里不存在该服务。`scripts/dsh-bridge/` 的 BridgeApiClient 接管：`doFetch` → `chrome.runtime.sendMessage({ kind: 'dsh-rpc' })`，流 → `chrome.runtime.connect({ name: 'dsh-stream' })`，后台网关转发到网页 bridge。
- ♻️ **扩展上下文失效自动恢复**：MV3 扩展 reload / 更新后旧页面 `chrome.runtime` 引用全部失效（`Extension context invalidated`），`scripts/dsh-bridge/context-recovery.ts` 检测该错误后防抖重载宿主页面自动恢复。

## 🛠️ 开发 Development

```bash
pnpm install          # 安装依赖（F: 盘 exFAT 需 node-linker=hoisted）
pnpm dev              # WXT 开发模式（热重载）
pnpm build            # 构建产物 → .output/chrome-mv3
pnpm test             # vitest 全量测试（18 文件 / 152 测试）
pnpm compile          # tsc --noEmit 类型检查
pnpm check            # compile + test + build 一站式
```

### 同步 dsh 官方前端（可选）

`public/dsh-web/` 由本地 deepseek-harness checkout 同步生成，不入库。

```bash
node scripts/import-dsh.mjs                # 同步官方 dist + client 插件 + 生成 boot-manifest
node scripts/patch-dsh-web.mjs             # 自动应用 CSP 兼容 patch（import-dsh 内部也会调用）
node scripts/build-connection-bridge.mjs   # 重新构建自定义 connection bridge bundle
node scripts/build-official-settings.mjs   # 构建官方 settings runtime（pnpm build 内自动执行）
```

### 手动加载

1. `pnpm build`
2. Chrome → `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选择 `.output/chrome-mv3`
3. 打开 chat.deepseek.com 并登录
4. 点击扩展图标 / `Ctrl+Shift+Y` 打开侧边栏
5. 在设置页打开 **dsh 模式** → 对话界面切换为 dsh harness 形态

### 配置第三方 OpenAI 兼容供应商（可选，启用原生 function calling）

1. dsh 模式 → 设置 → **模型** → 「添加自定义提供方」
2. 填 route / Base URL / 模型 / API Key（Key 经 `credentials` 存到 `dsh-credentials`）
3. 会话中的 agent 即走原生 function calling（工具调用真实执行）；未配置时自动回退网页 bridge

### 调试

白屏 / 插件加载失败排查：打开 `chrome-extension://<扩展ID>/debug.html`，页面会直接渲染诊断结果（CSP 探测 / 资源可达性 / boot 复现 / RPC 探测），无需开 devtools。常见错误对照：

| 现象 | 处理 |
|---|---|
| `new Function: BLOCKED` | CSP patch 未生效 → 重跑 `node scripts/patch-dsh-web.mjs` |
| 资源 `404` | 重跑 `node scripts/import-dsh.mjs` 同步 `public/dsh-web/` |
| `transport failure ... Extension context invalidated` | 扩展已 reload，页面自动恢复或手动刷新一次 |
| RPC 探测 `THREW` | 扩展刚 reload → 刷新页面；仍挂 → 打开扩展详情里的 Service Worker 看后台 console |

## ✅ 测试覆盖 Test Coverage（18 文件 / 152 测试）

| 模块 | 文件 | 覆盖点 |
|---|---|---|
| bridge | `tests/bridge/*`（5 个） | PoW 解算 / SSE 解析 / 协议构造 / client 流式 + 重试 / 扩展上下文失效恢复 |
| fs | `tests/fs/workspace.spec.ts` | 虚拟工作区读写编辑、沙箱模式、路径防穿越 |
| skills | `tests/skills/skill.spec.ts` | SKILL.md 解析 / 目录渲染 / /name 匹配 |
| prompts | `tests/prompts/prompt.spec.ts` | 分节 / 插值 / persona |
| agent | `tests/agent/*`（3 个） | 工具调用解析 / agent loop 多轮回填 / 工具注册表 |
| plugin | `tests/plugin/*`（3 个） | Cordis 内核 / 浏览器宿主服务 / L0 加载器 |
| settings | `tests/settings/settings.spec.ts` | 设置持久化 / 归一化 |
| ui | `tests/ui/filetree.spec.ts` | 文件树构建与过滤 |
| terminal | `tests/terminal/shell.spec.ts` | 白名单命令 / 注入拒绝 / 引号解析 |
| agent-presets | `tests/agent-presets/persona.spec.ts` | 预设 persona 注入 / 能力声明 |

## 🗺️ 里程碑 Milestones

- **Wave 0** 骨架 + 四件套 + 基线验证 ✅
- **Wave 1** 协议层 + bridge runtime + 聊天 UI ✅
- **Wave 2** 虚拟 FS / skill 库 / 提示词 / agent 原语 ✅
- **Wave 3** Cordis 内核 / 浏览器宿主 / 插件加载器 / L1 设计 ✅
- **Wave 4** agent loop / Side Panel 标签页 / 终端 MVP ✅
- **Wave 5** 工程化（README / 收尾自检）✅
- **嵌入 dsh** 官方前端嵌入 + bridge 传输层 + CSP patch + 开关切换 ✅
- **Agent 层** persona 注入 + 工具调用回显 + Agent 预设配置 ✅
- **第三方供应商** OpenAI 兼容 + 原生 function calling + 扩展上下文自动恢复 ✅

## 📂 目录 Structure

```
entrypoints/
  background.ts            # SW：路由 / agent loop / Cordis 宿主 / dsh RPC 网关 / 供应商分流
  bridge.content.ts        # isolated world：LLM 网络层 + 消息桥
  page-world.content.ts    # MAIN world：登录态探测
  dsh-ui.content.ts        # 页面内嵌 dsh iframe 注入器（dshMode 驱动）
  sidepanel/               # main.tsx(开关页↔dsh iframe) / App.tsx / TerminalView.tsx / style.css
scripts/
  import-dsh.mjs           # 同步 dsh 官方前端产物 → public/dsh-web/
  patch-dsh-web.mjs        # CSP 兼容 patch（顶层 new Function → stub）
  build-connection-bridge.mjs  # 构建自定义 connection bridge bundle
  build-official-settings.mjs  # 构建官方 settings runtime
  dsh-bridge/              # BridgeApiClient / bridge-rpc / context-recovery / connection-entry
public/
  debug.html / debug.js    # 白屏诊断页（CSP / 资源 / boot / RPC 探测）
utils/
  bridge/                  # 协议层（client / protocol / pow / sse-parser）
  fs/workspace.ts          # 虚拟工作区（IndexedDB + 沙箱模式）
  skills/skill.ts          # skill 库 L0
  prompts/prompt.ts        # 提示词管理
  agent/                   # agent loop / 工具注册表 / 原语 / openai 原生 function calling loop
  plugin/                  # Cordis 宿主 / 加载器 / 设计
  settings/settings.ts     # DshSettings 持久化（chrome.storage.local）
  official-settings/       # 官方 settings namespace（provider / runtime / schema）
  llm/                     # OpenAI 兼容 client / 供应商存储
  ui/filetree.ts           # 文件树视图模型
  terminal/shell.ts        # 白名单 shell simulator
  messages.ts              # 全链路消息协议
tests/                     # 18 个 spec 文件
```

## 🙏 鸣谢 Acknowledgements

- 🤖 **DeepSeek**：感谢 DeepSeek 团队及其开源项目 **dsh（DeepSeek Harness）**。本项目嵌入的官方前端（`public/dsh-web/`）来自 [deepseek-ai/DeepSeek-Harness](https://github.com/deepseek-ai/DeepSeek-Harness)，遵循 MIT 协议，完整版权声明见 [LICENSE](./LICENSE)。
- 🧡 **oneinitAI**：本项目的工程实现与持续维护。

## ⚖️ 免责声明 Disclaimer

本项目仅用于**个人学习与技术研究**。它桥接的是 chat.deepseek.com 的网页内部接口，可能超出其服务条款允许范围；使用产生的账号风险（风控 / 封禁）由使用者自行承担。数据面未经 DeepSeek 官方授权或担保，请勿用于生产环境。

## 📄 许可 License

[MIT](./LICENSE)，保留 DeepSeek（dsh 原作者）与本项目作者版权声明。
