# dsh-in-web — Work Plan

## TL;DR (For humans)

**What you'll get:** 一个 Chrome 浏览器扩展（Manifest V3），在 chat.deepseek.com 页面内把它改造成 dsh（DeepSeek Harness）形态的 agent harness。用户无需安装任何本地程序：扩展通过网页版内部 API 直呼（复用你的登录态）驱动 DeepSeek 模型，提供虚拟文件系统（模型可读写文件）、skill 技能库（SKILL.md 格式，与 dsh 生态兼容）、提示词管理、以及一个内嵌 Cordis 内核的插件通道（现有 dsh 插件的 skill/工具/提示词声明尽量零修改加载）。UI 是浏览器原生 Side Panel + 页面内注入层。

**Why this approach:** 技术研究已完成（4 份报告）：网页 API 直呼已证实可行（端点/SSE/PoW/auth 全协议有 9 个开源实现可移植）；MV3 架构四件套（MAIN world 注入 + bridge + SW + Side Panel）与沙箱能力（sandbox key / offscreen / OPFS）已确认；dsh 语义蓝图（skill/prompt/tool/fs）已从官方源码带行号提取。方案 B（内嵌 Cordis 内核）已由用户拍板。

**What it will NOT do:** 不依赖本地安装；不做真 OS shell/PTY（浏览器物理边界，可选本地桥不在 v1）；不完整移植 host 侧 Node 插件（sandbox 等用浏览器等价物替代）；不做多账号/登录管理（复用现有登录态）。

**Effort:** Large
**Risk:** Medium — 依赖 chat.deepseek.com 网页 API 的稳定性（x-client-version 漂移、PoW 升级、x-hif-leim attestation 未来可能强制）；MV3 沙箱 CSP 细节有已知坑（sandbox key 是 eval 唯一合规通道）。

Your next move: 按 Wave 0 → 5 顺序执行，每波完成即验证。详细执行细节见下。

---

> TL;DR (machine): Large effort, Medium risk — Chrome MV3 扩展把 chat.deepseek.com 变成 dsh 形态 agent harness。5 波实现 + 最终验证波，TDD，零本地安装。

## Scope
### Must have
- MV3 扩展骨架（WXT 或 vite+crxjs）：manifest 最小权限、MAIN world content script + isolated bridge + SW + Side Panel 四件套
- **桥接层**：chat.deepseek.com API 直呼（protocol.ts / pow.ts / sse-parser.ts），auth 从登录态提取，SSE 流式解析，PoW DeepSeekHashV1 求解
- **虚拟文件系统**：IndexedDB 存储，模型可 read/write/edit（对齐 ctx.fs 语义 + SandboxMode 三态）
- **Skill 库**：SKILL.md 格式解析（L0 数据直载），<available_skills> 目录注入，skill 工具，/<name> 手势
- **提示词管理**：system prompt section 组装（对齐 dsh order 约定 + {{variable}} 插值），persona 预设行
- **基础 agent 循环**：把 桥接+skill+prompt+tool 串起来（多轮对话、工具调用文本解析）
- **插件通道（方案 B 起步）**：Cordis 内核嵌入 + 浏览器宿主面 ctx.* 适配器 + 插件加载器（L0 先通，L1 打包器设计）
- **UI**：Side Panel（会话/文件树/skill 库/提示词编辑器/终端 MVP）
- **工程化**：TDD（vitest）、typecheck/lint/test/build 门禁、README、构建打包
### Must NOT have (guardrails)
- 不依赖 Native Messaging Host / 任何本地后端进程（默认路径纯浏览器）
- 不使用 chrome.debugger（黄条警告）、<all_urls>（商店拒绝）、nativeMessaging
- 不做真 OS shell/PTY（v1 用浏览器等价物：sandbox 自研 shell simulator）
- 不做多账号/登录/云同步（复用现有登录态）
- 不在 extension_pages 写 unsafe-eval（MV3 最小 CSP 拒绝）
- 不完整移植 host 侧 Node 插件（sandbox/subprocess/terminal 走浏览器等价）
- 不做插件分发平台/市场（v1 是本地加载通道）
- defer 到 v2：File System Access 真实目录挂载、WebContainer 真 shell、Pyodide Python 执行、L3 完整 Cordis 生态兼容
- 不绕过 chat.deepseek.com 风控（单账号并发≤2 等限制在文档中明示）

## Verification strategy
> Zero human intervention - 所有验证 agent-executed，Evidence 写入 .omo/evidence/
- TDD：每个行为变更先失败测试（RED）再实现（GREEN）再 SURFACE（真实浏览器/curl 证据）
- 每 todo 的 Acceptance criteria 为可执行断言（具体命令/选择器/测试数据）
- 桥接层 SURFACE：真实浏览器（Playwright）登录 chat.deepseek.com 后验证 SSE 流式 + PoW；失败则 mock 协议 fixture 验证 + 记录
- MV3 集成：真实 Chrome 加载 unpacked 扩展验证四件套

## Execution strategy
### Parallel execution waves
**Wave 0 — 脚手架**：MV3 扩展骨架（manifest/四件套/Side Panel 壳）+ 构建工具（WXT）+ 基线验证
**Wave 1 — 桥接层**：protocol.ts / pow.ts / sse-parser.ts / bridge runtime（MAIN+isolated+SW 消息总线）
**Wave 2 — 核心功能**：虚拟文件系统（IndexedDB）、skill 库（L0）、提示词管理、基础 agent 循环
**Wave 3 — 插件通道**：Cordis 内核嵌入 + 浏览器宿主面 ctx.* + 插件加载器（L0 数据直载优先）
**Wave 4 — UI**：Side Panel（会话/文件树/skill 库/提示词编辑器/终端 MVP）
**Wave 5 — 工程化**：README/i18n/构建/打包冒烟
**Final verification wave**：F1 计划合规 / F2 代码质量 / F3 真实手动 QA / F4 范围保真

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
|---|---|---|---|
| W0 脚手架 | — | 全部 | — |
| W1 桥接层 | W0 | W2 agent 循环 | W2 FS/skill/prompt 可并行 |
| W2 核心功能 | W0(+W1 for agent loop) | W4 | W1 可并行 |
| W3 插件通道 | W0(+W2 语义) | W4 | W1/W2 可并行 |
| W4 UI | W1,W2,W3 | W5 | — |
| W5 工程化 | W4 | F1-F4 | — |
| F1-F4 | 全部 | — | 互相并行 |

## Todos
<!-- APPEND TASK BATCHES BELOW THIS LINE -->
### Wave 0 — 脚手架
- [ ] 1. 初始化 dsh-in-web 项目骨架（WXT + TS + vitest），manifest 最小权限（sidePanel/storage/scripting/activeTab/contextMenus + optional unlimitedStorage + host_permissions chat.deepseek.com）
- [ ] 2. 四件套骨架：MAIN world content script（document_start）+ isolated bridge.js + SW（长 port）+ Side Panel 壳（空 UI）
- [ ] 3. 基线验证：`pnpm dev` 起扩展，Chrome 加载 unpacked 无报错，四件套通信链路打通（postMessage→bridge→SW→panel）

### Wave 1 — 桥接层
- [ ] 4. protocol.ts：端点常量/headers/请求体/响应类型（TDD，fixture 断言）
- [ ] 5. pow.ts：DeepSeekHashV1 求解器（TDD，已知 challenge→nonce fixture）
- [ ] 6. sse-parser.ts：SSE 流解析状态机（TDD，mock SSE chunk → 事件序列）
- [ ] 7. bridge runtime：MAIN world fetch 拦截 + userToken 提取 + postMessage 桥（TDD + Playwright SURFACE）

### Wave 2 — 核心功能
- [ ] 8. 虚拟文件系统：IndexedDB 存储 + read/write/edit + SandboxMode（TDD）
- [ ] 9. skill 库：SKILL.md 解析 + <available_skills> 渲染 + skill 工具 + /<name> 手势（TDD）
- [ ] 10. 提示词管理：section 组装 + {{variable}} + persona 预设行（TDD）
- [ ] 11. 基础 agent 循环：桥接+skill+prompt+tool 串起来，DSML 工具调用文本解析（TDD）

### Wave 3 — 插件通道
- [ ] 12. Cordis 内核嵌入扩展 worker（TDD，内核在浏览器 worker 跑通 apply(ctx)）
- [ ] 13. 浏览器宿主面 ctx.* 适配器：ctx.skills/ctx.settings/ctx.fs/ctx.systemPrompt/ctx.llm（TDD）
- [ ] 14. 插件加载器：L0 数据直载（SKILL.md/tool schema/prompt preset 从插件仓库解析加载）（TDD）
- [ ] 15. L1 适配打包器设计（esbuild browser target + node:* shim 方案文档 + 冒烟）

### Wave 4 — UI
- [ ] 16. Side Panel：会话面板 + 模型流式输出（TDD + Playwright）
- [ ] 17. Side Panel：文件树 + skill 库 + 提示词编辑器
- [ ] 18. 终端 MVP：xterm.js + sandbox iframe 自研 shell simulator（白名单命令）

### Wave 5 — 工程化
- [ ] 19. README/README.zh/i18n 骨架
- [ ] 20. 构建打包 + Chrome 加载冒烟
- [ ] 21. 收尾自检（依赖矩阵一致/Must NOT 无违反）

## Final verification wave
- [ ] F1. Plan compliance audit
- [ ] F2. Code quality review
- [ ] F3. Real manual QA（真实浏览器加载扩展 + 登录态驱动模型）
- [ ] F4. Scope fidelity

## Commit strategy
- Conventional commits（feat:/fix:/docs:/build:/chore:）带 body
- 一次提交一个关注点；每个标 Y 的 todo 完成后立即提交
- 绝不提交 node_modules/、日志、凭据、cookie
- 本目录当前非 git repo——Wave 0 完成脚手架后 git init + 首提交
