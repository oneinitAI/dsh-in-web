# dsh-in-web

把 [chat.deepseek.com](https://chat.deepseek.com) 网页版改造成 **dsh（DeepSeek Harness）** 形态的 **Chrome MV3 浏览器扩展**。

**核心卖点**：用户完全无需本地安装 dsh——登录态、模型、对话全部复用网页版免费额度，扩展只负责"把官方 dsh 前端完整嵌入 + 数据层走网页 bridge"。

> 本项目嵌入的 dsh 官方前端（`public/dsh-web/`）来自 [deepseek-harness](https://github.com/deepseek-ai/DeepSeek-Harness)，遵循其 MIT 协议（见 [LICENSE](./LICENSE)）。

## 特性

- **嵌入式官方 dsh 前端**：完整移植 dsh（DeepSeek Harness）Shell + 39 个 client 插件（会话 / 工作区 / 技能 / 提示词 / 模型 / 设置……），零修改官方产物，仅在同步时做最小 CSP 兼容 patch
- **开关切换**：Side Panel = dsh 模式设置页；打开"dsh 模式"开关，对话界面即切换为 dsh harness 形态（全屏 iframe 注入），关闭即恢复普通 DeepSeek 对话，实时生效无需刷新
- **bridge 传输层**：自定义 `dsh-client-connection` bundle 替换官方 HTTP/WebSocket 连接层，RPC 经 `chrome.runtime` 转发到扩展后台，数据走 chat.deepseek.com 网页会话
- **网页版数据通道**：LLM 网络层放在 content script（isolated world）——fetch 以页面 origin 发出，Origin/Cookie 天然正确，服务端不拒绝
- **原生功能保留**：流式聊天（thinking / text 分开展示）、虚拟工作区、skill 库、提示词管理、终端 MVP、Cordis 插件内核

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│ chat.deepseek.com（页面）                                     │
│  ┌─────────────────┐        ┌───────────────────────┐      │
│  │ page-world      │        │ bridge (isolated)     │      │
│  │ (MAIN world)    │◄──────►│  DeepSeekWebClient     │      │
│  │ 登录态探测       │  pm    │  fetch 以页面 origin    │      │
│  └─────────────────┘        └──────────┬────────────┘      │
└─────────────────────────────────────────┼───────────────────┘
                                          │ chrome.runtime
┌─────────────────────────────────────────┼───────────────────┐
│ Service Worker（background）             ▼                   │
│  消息路由 · agent loop · 工具执行 · Cordis 宿主               │
│  dsh RPC 网关（dsh-rpc / dsh-stream）                      │
└─────────────────────────────────────────┬───────────────────┘
                                          │ chrome.runtime (dsh-rpc)
┌─────────────────────────────────────────▼───────────────────┐
│ Side Panel（sidepanel.html）                                 │
│  ┌──────────────────────────────────────────────┐           │
│  │ dshMode=off → App.tsx 设置开关页（默认）        │           │
│  │ dshMode=on  → iframe 加载 dsh-web/index.html  │           │
│  │              （官方 dsh Shell + 39 插件）       │           │
│  │              数据层：BridgeApiClient ──┐      │           │
│  └────────────────────────────────────────┼──────┘           │
│        chrome.runtime dsh-rpc ◄───────────┘                  │
└─────────────────────────────────────────────────────────────┘
```

**关键设计决策**：

- **LLM 网络层放在 content script（isolated world）而非 SW**——扩展 SW 的 fetch 无法伪造 `Origin/Referer`（浏览器 forbidden headers），服务端会拒绝；content script 的 fetch 自动以页面 origin 发出，Origin/Cookie 天然正确。
- **dsh 前端零修改嵌入**——官方 Shell 是 Electron 产物，迁移到 MV3 扩展页有两个硬性差异，均在同步脚本（`scripts/import-dsh.mjs` → `scripts/patch-dsh-web.mjs`）里自动处理：
  - **CSP**：MV3 扩展页默认 CSP 禁止 `unsafe-eval`，而 Shell 的 index bundle 模块顶层就有 `new Function`（Cordis jsExpr 求值器）→ 加载即崩。patch 把它替换为安全 stub（已确认全部插件 bundle 均不含 `__jsExpr`，零功能损失）。
  - **连接层**：官方 `dsh-client-connection` 走 HTTP/WebSocket 连本地 harness，浏览器内不存在该服务。用 `scripts/dsh-bridge/` 的 BridgeApiClient 替换——`doFetch` 走 `chrome.runtime.sendMessage({kind:'dsh-rpc'})`，流走 `chrome.runtime.connect({name:'dsh-stream'})`，后台网关转发到网页 bridge。

## 开发

```bash
pnpm install          # 安装依赖（F: 盘 exFAT 需 node-linker=hoisted）
pnpm dev              # WXT 开发模式（热重载）
pnpm build            # 构建产物 → .output/chrome-mv3
pnpm test             # vitest 全量测试
pnpm compile          # tsc --noEmit 类型检查
pnpm check            # compile + test + build 一站式
```

### 同步 dsh 官方前端（可选，仅当需要更新官方产物时）

`public/dsh-web/` 由本地 deepseek-harness checkout 同步生成，不入库：

```bash
node scripts/import-dsh.mjs        # 同步官方 dist + 39 个 client 插件 + 生成 boot-manifest
node scripts/patch-dsh-web.mjs     # 自动应用 CSP 兼容 patch（import-dsh 内部也会调用）
node scripts/build-connection-bridge.mjs   # 重新构建自定义 connection bridge bundle
```

### 手动加载

1. `pnpm build`
2. Chrome → `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选择 `.output/chrome-mv3`
3. 打开 chat.deepseek.com 并登录
4. 点击扩展图标 / `Ctrl+Shift+Y` 打开侧边栏
5. 在设置页打开 **dsh 模式** → 对话界面切换为 dsh harness 形态

### 调试

白屏 / 插件加载失败排查：打开 `chrome-extension://<扩展ID>/debug.html`，页面会直接渲染诊断结果（CSP 探测 / 资源可达性 / boot 复现），无需开 devtools。

## 测试覆盖

| 模块 | 文件 | 覆盖点 |
|---|---|---|
| bridge | `tests/bridge/*` | PoW 解算 / SSE 解析 / 协议构造 / client 流式+重试 |
| fs | `tests/fs/workspace.spec.ts` | 虚拟工作区读写编辑、沙箱模式、路径防穿越 |
| skills | `tests/skills/skill.spec.ts` | SKILL.md 解析 / 目录渲染 / /name 匹配 |
| prompts | `tests/prompts/prompt.spec.ts` | 分节 / 插值 / persona |
| agent | `tests/agent/*` | 工具调用解析 / agent loop 多轮回填 / 工具注册表 |
| plugin | `tests/plugin/*` | Cordis 内核 / 浏览器宿主服务 / L0 加载器 |
| settings | `tests/settings/settings.spec.ts` | 设置持久化 / 归一化 |
| ui | `tests/ui/filetree.spec.ts` | 文件树构建与过滤 |
| terminal | `tests/terminal/shell.spec.ts` | 白名单命令 / 注入拒绝 / 引号解析 |

## 里程碑

- **Wave 0** 骨架 + 四件套 + 基线验证 ✅
- **Wave 1** 协议层 + bridge runtime + 聊天 UI ✅
- **Wave 2** 虚拟 FS / skill 库 / 提示词 / agent 原语 ✅
- **Wave 3** Cordis 内核 / 浏览器宿主 / 插件加载器 / L1 设计 ✅
- **Wave 4** agent loop / Side Panel 标签页 / 终端 MVP ✅
- **Wave 5** 工程化（README / 收尾自检）🔄
- **嵌入 dsh** 官方前端嵌入 + bridge 传输层 + CSP patch + 开关切换 🔄

## 目录

```
entrypoints/
  background.ts            # SW：路由 / agent loop / Cordis 宿主 / dsh RPC 网关
  bridge.content.ts        # isolated world：LLM 网络层 + 消息桥
  page-world.content.ts    # MAIN world：登录态探测
  dsh-ui.content.ts        # 页面内嵌 dsh iframe 注入器（dshMode 驱动）
  sidepanel/               # main.tsx(开关页↔dsh iframe) / App.tsx / TerminalView.tsx / style.css
scripts/
  import-dsh.mjs           # 同步 dsh 官方前端产物 → public/dsh-web/
  patch-dsh-web.mjs        # CSP 兼容 patch（顶层 new Function → stub）
  build-connection-bridge.mjs  # 构建自定义 connection bridge bundle
  dsh-bridge/              # BridgeApiClient / bridge-rpc / connection-entry（连接层替换）
public/
  debug.html / debug.js    # 白屏诊断页
utils/
  bridge/                  # 协议层（client/protocol/pow/sse-parser）
  fs/workspace.ts          # 虚拟工作区（IndexedDB + 沙箱模式）
  skills/skill.ts          # skill 库 L0
  prompts/prompt.ts        # 提示词管理
  agent/                   # agent loop / 工具注册表 / 原语
  plugin/                  # Cordis 宿主 / 加载器 / 设计
  settings/settings.ts     # DshSettings 持久化（chrome.storage.local）
  ui/filetree.ts           # 文件树视图模型
  terminal/shell.ts        # 白名单 shell simulator
  messages.ts              # 全链路消息协议
tests/                     # 17 个 spec 文件
```

## 许可

[MIT](./LICENSE) —— 保留 DeepSeek（dsh 原作者）与本项目作者版权声明。