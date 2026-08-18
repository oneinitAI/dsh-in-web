# dsh-in-web

把 [chat.deepseek.com](https://chat.deepseek.com) 网页版改造成 dsh（DeepSeek Harness）形态的 **Chrome MV3 浏览器扩展**。

**核心卖点**：用户完全无需本地安装 dsh——登录态、模型、对话全部复用网页版免费额度，扩展只负责"改造前端为 harness"。

## 特性

- **会话**：侧边栏流式聊天（thinking / text 分开展示），多轮工具调用自动回填
- **文件系统**：浏览器内虚拟工作区（IndexedDB），文件树浏览 + 内容预览
- **Skill 库**：SKILL.md 风格技能（frontmatter + 正文），`/name` 手势匹配
- **提示词管理**：`Header: body` 分节组装 + `{{变量}}` 插值 + persona 预设
- **终端 MVP**：xterm.js + 白名单 shell simulator（help/pwd/ls/cat/write/echo/clear），元字符注入拒绝
- **插件通道**：内嵌 Cordis 内核，`ctx.fs / ctx.skills / ctx.llm` 宿主服务，L0 插件加载器 + L1 打包器设计

## 架构

```
┌────────────────────────────────────────────────────────┐
│ chat.deepseek.com（页面）                                │
│  ┌─────────────────┐        ┌──────────────────────┐  │
│  │ page-world      │        │ bridge (isolated)    │  │
│  │ (MAIN world)    │◄──────►│  DeepSeekWebClient    │  │
│  │ 登录态探测       │  pm    │  fetch 以页面 origin  │  │
│  └─────────────────┘        └──────────┬───────────┘  │
└────────────────────────────────────────┼──────────────┘
                                         │ chrome.runtime
┌────────────────────────────────────────┼──────────────┐
│ Service Worker（background）            ▼              │
│  消息路由 · agent loop · 工具执行 · Cordis 宿主          │
│  Workspace（IndexedDB 同库）                           │
└────────────────────────────────────────┬──────────────┘
                                         │ Port + sendMessage
┌────────────────────────────────────────▼──────────────┐
│ Side Panel                                            │
│  会话 / 文件 / 技能 / 提示词 / 终端 标签页              │
│  Workspace（共享 IndexedDB）· ShellSimulator           │
└───────────────────────────────────────────────────────┘
```

**关键设计决策**：LLM 网络层放在 **content script（isolated world）** 而非 SW——扩展 SW 的 fetch 无法伪造 `Origin/Referer`（浏览器 forbidden headers），服务端会拒绝；content script 的 fetch 自动以页面 origin 发出，Origin/Cookie 天然正确。

## 开发

```bash
pnpm install          # 安装依赖（F: 盘 exFAT 需 node-linker=hoisted）
pnpm dev              # WXT 开发模式（热重载）
pnpm build            # 构建产物 → .output/chrome-mv3
pnpm test             # vitest 全量测试（121 用例 / 15 文件）
pnpm compile          # tsc --noEmit 类型检查
pnpm check            # compile + test + build 一站式
```

### 手动加载

1. `pnpm build`
2. Chrome → `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选择 `.output/chrome-mv3`
3. 打开 chat.deepseek.com 并登录
4. 点击扩展图标 / `Ctrl+Shift+Y` 打开侧边栏

## 测试覆盖

| 模块 | 文件 | 覆盖点 |
|---|---|---|
| bridge | `tests/bridge/*` | PoW 解算 / SSE 解析 / 协议构造 / client 流式+重试 |
| fs | `tests/fs/workspace.spec.ts` | 虚拟工作区读写编辑、沙箱模式、路径防穿越 |
| skills | `tests/skills/skill.spec.ts` | SKILL.md 解析 / 目录渲染 / /name 匹配 |
| prompts | `tests/prompts/prompt.spec.ts` | 分节 / 插值 / persona |
| agent | `tests/agent/*` | 工具调用解析 / agent loop 多轮回填 / 工具注册表 |
| plugin | `tests/plugin/*` | Cordis 内核 / 浏览器宿主服务 / L0 加载器 |
| ui | `tests/ui/filetree.spec.ts` | 文件树构建与过滤 |
| terminal | `tests/terminal/shell.spec.ts` | 白名单命令 / 注入拒绝 / 引号解析 |

## 里程碑

- **Wave 0** 骨架 + 四件套 + 基线验证 ✅
- **Wave 1** 协议层 + bridge runtime + 聊天 UI ✅
- **Wave 2** 虚拟 FS / skill 库 / 提示词 / agent 原语 ✅
- **Wave 3** Cordis 内核 / 浏览器宿主 / 插件加载器 / L1 设计 ✅
- **Wave 4** agent loop / Side Panel 标签页 / 终端 MVP ✅
- **Wave 5** 工程化（README / 收尾自检）🔄
- **验证** F1–F4 端到端 ⏳

## 目录

```
entrypoints/
  background.ts            # SW：路由 / agent loop / Cordis 宿主
  bridge.content.ts        # isolated world：LLM 网络层 + 消息桥
  page-world.content.ts    # MAIN world：登录态探测
  sidepanel/               # App.tsx / TerminalView.tsx / style.css
utils/
  bridge/                  # 协议层（client/protocol/pow/sse-parser）
  fs/workspace.ts          # 虚拟工作区（IndexedDB + 沙箱模式）
  skills/skill.ts          # skill 库 L0
  prompts/prompt.ts        # 提示词管理
  agent/                   # agent loop / 工具注册表 / 原语
  plugin/                  # Cordis 宿主 / 加载器 / 设计
  ui/filetree.ts           # 文件树视图模型
  terminal/shell.ts        # 白名单 shell simulator
  messages.ts              # 全链路消息协议
tests/                     # 15 个 spec 文件 121 用例
```