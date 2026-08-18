# Ultrawork Notepad — dsh-in-web（浏览器扩展版 dsh）

Started: 2026-08-18

## 目标（用户拍板）
把 chat.deepseek.com 网页版改造成 dsh（DeepSeek Harness）形态，载体为**浏览器扩展**：
1. 用户完全无需本地安装 dsh
2. 插件系统：**方案 B 采纳**——扩展 worker 内跑真 Cordis 内核 + 浏览器版 ctx.* 宿主面
3. 基本功能必须有：**文件读写、skill（技能）、提示词（系统提示管理）**
4. 运行在 chat.deepseek.com 页面内（登录态复用）
5. 实施优先级：**核心功能优先**
6. 用户附加诉求：**dsh 插件尽量零修改直接用**（L0 数据直载 + L1 源码零修改构建级适配优先）

## 插件兼容分级（2026-08-18 用户确认方案 B 后定稿）
- L0 免打包直载：SKILL.md / tool schema / prompt preset / settings schema —— 纯数据零修改
- L1 源码零修改：只用已实现服务的轻量插件 → 适配打包器（esbuild browser target + node:* shim）
- L2 小幅适配：未实现宿主服务 → 替换等价实现/降级
- L3 不支持：sandbox/subprocess/terminal/pty/e2b（物理边界）

## 兼容层设计
插件仓库 → 适配打包器（可选）→ 扩展 worker 内 Cordis 内核 → 浏览器宿主面：
ctx.llm→网页桥 / ctx.fs→虚拟FS / ctx.skills→SKILL.md注册表 / ctx.settings→chrome.storage / ctx.systemPrompt→组装 / 其余按需，未实现报 service-not-available

## dsh 语义蓝图（bg_fecffeb3 完成，2026-08-18，带行号官方实现）
### Skill
- SKILL.md = YAML frontmatter + Markdown 正文；frontmatter 键：name/description/when-to-use/disable-model-invocation/user-invocable/metadata
- name 正则 ^[a-z0-9]+(?:-[a-z0-9]+)*$（packages/skill/skill/src/index.ts:34）
- 内存 schema：SkillDefinition{name,description,whenToUse,invocation{modelInvocable,userInvocable},source,provider,resourceBase?,content,path?,metadata?}（:55-101）
- 目录注入 <available_skills>（tool-skill/src/index.ts:254-321）；正文 skill 工具 → <skill_content>+<skill_resources>+<skill_instructions>（skill/src/index.ts:171-184）
- 用户手势 /<name> 正则 SKILL_GESTURE（tool-skill/src/index.ts:409）
- discovery：目录型 <root>/<name>/SKILL.md 不递归 + 扁平型 <root>/<name>.md（skill-filesystem/src/index.ts:723-728）
### SystemPrompt
- ctx.systemPrompt.section({name,order,text|fn,complete?})/context/toolProvider/variable/suppressRuntimeContext（core/system-prompt/src/index.ts:13-39）
- order 约定：-100 身份 / 0 persona / 100-199 工具指引 / 110 sandbox:policy（:60-62 + sandbox-policy:115）
- {{variable}} 插值（:212-295）；toolOrder + <unlisted-tools>（:140-178）
- persona preset 行：{text,complete?,includeRuntimeContext?}（preset/persona/src/index.ts:34-52）
### Tool
- defineTool({name,description,parameters,output,execute,finalizeContent?,timeoutMs?,isConcurrencySafe?,presentCall?,presentResult?})（core/tools/src/index.ts:211-288）
- output 必填 {schema(JSON Schema),render(args,value),presentationMeta?}
- 五事件流水线：pre-execute(waterfall allow/deny/ask) / execute(waterfall wrap) / post-execute(waterfall replace) / result(emit frozen) / change(emit global)（:142-208）
- name 规则 [A-Za-z0-9_-]{1,64}；MCP 桥命名 mcp__server__raw，超长 SHA256 截断（mcp-client/src/tools.ts:45-51,96-102）
- 保留名 run_code
### FS + Sandbox
- ctx.fs 接口：resolve/readText/writeText/editText({oldString,newString,replaceAll?},intent,signal,sandboxPolicy)→{before,after,version}（fs/src/types.ts:60-160）
- 工具：read/write/edit/grep/glob（tool-fs + tool-fs-search）
- SandboxMode 三态：read-only(默认,fail-safe)/workspace-write/danger-full-access（sandbox-policy/src/index.ts:67-120）
- sandbox:policy 作为 systemPrompt.context(order 110)；fs/edit-intent(waterfall) + fs/observed(emit)
- 项目根 = 最近含 .git 祖先；session cwd 决定沙箱边界

## 浏览器沙箱能力修正（2026-08-18 用户质疑后）
- 原"L3 物理边界"判断过于武断，已修正：
  - 代码执行沙箱：Web Worker / iframe sandbox / MV3 sandbox manifest key（官方不可信代码通道）/ WASM(Pyodide/QuickJS) —— 可行且隔离更强
  - 文件系统：OPFS（navigator.storage.getDirectory，持久无 5MB 限）+ File System Access API（真实本地目录授权）
  - 终端：xterm.js 纯前端
  - grep/glob：ripgrep-wasm 或浏览器实现
- 核心 harness 纯浏览器、零后端进程
- 真正需后端的：真 OS shell/PTY、任意 OS 进程、系统级凭据 → 设计为可选本地桥（非默认）
- 真实坑（验证中 bg_e8e99b5a）：MV3 CSP 禁 eval/远程脚本（sandbox key 是豁免通道）；SW 30s 空闲被杀 → 长流式需 off-screen document

## 网页 API 逆向结论（bg_d0442d35 完成，2026-08-18）—— API 直呼可行且推荐
- 端点：/api/v0/users/login|current、chat_session/create|delete|fetch_page|update_title、chat/completion(SSE主)、chat/continue(续传)、chat/stop_stream、chat/edit_message、chat/regenerate、chat/history_messages、chat/create_pow_challenge、file/upload_file、file/fetch_files、client/settings
- Auth：localStorage.userToken(JSON包装{value}) → GET /users/current → resp.biz_data.token=accessToken(~24h) → Authorization: Bearer；扩展用 chrome.cookies.get 或 MAIN world localStorage 读 userToken
- 请求体：{chat_session_id, model_type, parent_message_id, prompt(单字符串! System/User/Assistant 拼装), ref_file_ids, thinking_enabled, search_enabled}
- 关键 headers：Accept: application/json,text/event-stream；x-client-platform: web；x-client-version: 2.0.0(漂移!旧 1.x 是 x-app-version)；x-client-bundle-id: com.deepseek.chat(2.0+新)；x-client-locale；x-client-timezone-offset(秒)；x-ds-pow-response
- SSE：text/event-stream，data:{json}\n\n + data:[DONE]\n\n；字段 {v,p,o}；path: response/content(正文delta)、response/thinking_content(思维链)、response/status(FINISHED|INCOMPLETE|AUTO_CONTINUE)、response/fragments(type THINK|RESPONSE|ANSWER)、search_status|search_results|quasi_status|elapsed_secs(跳过)；INCOMPLETE→POST /chat/continue{chat_session_id,message_id,fallback_to_resume:true}
- PoW：DeepSeekHashV1 = SHA3-256 skip round 0(rounds 1..23,丢 iota[0])；字段{algorithm,challenge,salt,signature,difficulty~144000,expire_at,target_path}；前缀 salt_expire_at_ 搜 nonce→base64(JSON{...answer...}) 作 x-ds-pow-response；触发 412 或 200 JSON 含 pow_required/biz_code:40010；~50-500ms，WASM 可压 ~50ms
- 工具调用：网页版不支持原生 function calling！需 DSML 提示词注入 + 文本解析(<|DSML|tool_calls>)——桥接层必须自做双向翻译器
- 反爬：单账号并发≤2(超会封禁)；x-client-version 漂移是主要维护成本；x-hif-leim attestation(未强制)；403+HTML=Cloudflare challenge
- 可移植基线：OmniRoute open-sse/executors/deepseek-web.ts + lib/deepseek-pow.ts（最新 2.0.0）；yinshuo-thu/deepseek-cli pow.ts（纯净 TS）；ds2api vercel_stream_impl.js（SSE 状态机）；algopian/chromeclaw（MV3 骨架）；zhu1090093659/deepseek-pp（fetch hook 生命周期测试）
- 建议目录：src/bridge/deepseek/{protocol.ts,pow.ts,sse-parser.ts} + src/content/main.ts + src/background/service-worker.ts

## MV3 架构结论（bg_d9bd8598 完成，2026-08-18）
- 四件套：MAIN world content script(document_start) + isolated bridge.js + SW + Side Panel
- 桥：MAIN window.postMessage → isolated window.message → chrome.runtime.sendMessage → SW → side panel（Google 官方样本 ai.gemini-on-device-audio-scribe）
- fetch monkey-patch 在 MAIN world 是拦截 SSE 唯一路径（MV3 webRequest 只读、declarativeNetRequest 看不到 body、debugger 黄条警告禁）；response.clone() 再读 body
- 存储：IndexedDB(虚拟工作区主存,dexie) + chrome.storage.session(运行时10MB) + chrome.storage.local(配置/skill索引,10MB,unlimitedStorage豁免) + OPFS(大文件,60%磁盘) + File System Access(可选真目录,用户手势必需,Chrome122+可选永远允许)
- 注意：content script 拿的是页面 origin 的 OPFS/IndexedDB，不是扩展的！扩展自己的必须在 side panel/offscreen 调用
- Side Panel：chrome.sidePanel，4 触发(工具图标/右键/命令/页面消息→SW open({tabId}))，必须在用户手势内；minimum_chrome_version 116
- SW 保活：长 port chrome.runtime.connect（Chrome 114+）；SSE 长间隙>30s 会杀 SW → 由 MAIN world 拦截转发而非 SW 直接 fetch
- manifest 最小集：sidePanel, storage, scripting, activeTab, contextMenus + optional unlimitedStorage + host_permissions https://chat.deepseek.com/*
- 禁：debugger, <all_urls>, nativeMessaging

## 沙箱能力矩阵结论（bg_e8e99b5a 完成，2026-08-18）
- MV3 extension_pages 最小 CSP：script-src 'self' 'wasm-unsafe-eval'; object-src 'self'（禁 unsafe-eval/远程）
- sandbox manifest key：允许 unsafe-inline/unsafe-eval，opaque origin，无 chrome.*，postMessage 通信，官方不可信代码通道（bitwarden/scriptcat 先例）
- 代码执行：JS→sandbox iframe；Python→offscreen(WORKERS reason, Chrome113+)+module Worker 跑 Pyodide(需 patch 去 Function 构造器 pyodide#3075)；不可 SW new Worker(crbug1219164)
- 终端：MVP=xterm.js+sandbox iframe 自研 shell simulator(白名单命令 worker 跑)；进阶=WebContainer API(纯浏览器真 shell,商业许可需评估)
- OPFS：扩展页面/offscreen worker 可用；content script 不可(页面 origin)；createSyncAccessHandle 仅 worker
- SW：30s idle / 5min 单请求 / fetch 30s；offscreen 与 SW 独立但 SW 死 offscreen 拆
- 需要 COOP/COEP(cross_origin_embedder_policy: require-corp + cross_origin_opener_policy: same-origin) 若用 SharedArrayBuffer

## 架构方向
浏览器扩展（Manifest V3）：
- 桥接层：content script（MAIN world 注入）驱动 chat.deepseek.com 模型（网络拦截/API 直呼 + DOM 兜底）
- 文件：虚拟工作区（extension storage / IndexedDB）+ 可选 File System Access API 真实目录
- 技能库：skill 定义（指令 + 工具能力注入）
- 提示词管理：系统提示词预设/会话级
- 预留插件 API：文档化契约 + 运行时钩子注册表

## 待办
- [ ] R1 研究 chat.deepseek.com 网页 API 逆向现状（endpoints/流式协议/现有 userscript）
- [ ] R2 研究 dsh 的 skill/提示词/工具概念（对齐 dsh 语义）
- [ ] R3 研究 MV3 扩展架构（MAIN world、storage 文件系统、File System Access、side panel）
- [ ] R4 Plan Agent 生成执行计划
- [ ] 实现（分波）

## 进度（2026-08-18）
### Wave 0 完成 ✅
- WXT 骨架 + 四件套（page-world MAIN / bridge isolated / SW / side panel）+ manifest 最小权限
- 用户真实浏览器手动验证通过：SW 长连接 ✓ / 页面已桥接 ✓ / 登录态探测 ✓（localStorage.userToken）
- 自动化 headless 测试不可用（Playwright 默认 --disable-extensions；CDP 直连后 SW 能跑但 content script 在 headless 不注入）→ SURFACE 验证以用户真实浏览器为准
- 修复：unlimitedStorage 不能作为 optional_permission（移到 permissions）
### Wave 1 协议层完成 ✅（39 测试全绿 + compile 干净）
- utils/bridge/pow.ts：DeepSeekHashV1（SHA3-256 跳 round 0）——官方 WASM 向量 4 组 hash + 3 组 solve + 1 组 header 全过
- utils/bridge/protocol.ts：端点/请求头(2.0.0 版)/请求体/flattenMessagesToPrompt
- utils/bridge/sse-parser.ts：SSE chunk 解析（两种形态 + skip 路径 + fragments）
- utils/bridge/client.ts：DeepSeekWebClient（createChatSession/streamChat/PoW 自动重试/错误分类 challenge/auth/protocol）
- 参考实现：yinshuo-thu/deepseek-cli（dswebClient.ts + pow.ts + smoke-pow 向量来自 CJackHwang/ds2api）
### 待办
- Wave 1 剩余：W1.4 bridge runtime 集成（MAIN world token 提取 + SW 编排 + 命令路由）
- Wave 2：虚拟FS / skill 库 / 提示词管理 / agent 循环
- Wave 3-5 + F1-F4

## Findings（已掌握，供设计对齐 dsh 语义）
- dsh = DeepSeek Harness（deepseek-ai/deepseek-harness，HEAD 47f9438，本地副本 F:\dsh\deepseek-harness）
- 网页版 chat.deepseek.com 已有 agent 工作区预览（snap-home.yml：Workspace Write 访问模式、命令按钮、模型选择、推理等级、工具行详情面板）
- dsh skill 语义（参考 dsh-skills-manager 调研）：ctx.skills.register/get/registerProvider；invocation{modelInvocable,userInvocable}；source rank（provider/custom/user/bundled/project）；技能文件 = SKILL.md + YAML frontmatter（name/description）；模型侧注入 <available_skills>
- dsh 提示词语义（参考 dsh-prompt-studio 调研）：system-prompt 组装管线（ctx.systemPrompt.section/variable/assemble）；PromptComponent 模型 = kind(native/supplement)×role(system/user/assistant)×position(after_system/anchored/tail)×order；llm/stream 拦截器 rewriteRequest 请求级注入
- dsh 工具：命名可调用 + schema（z 声明），agent loop 调用回填
- 备注：以上是 DSH 插件级语义（需本地 harness），扩展版只能做语义对齐，不能直接用 ctx.* 服务
- 【Cordis 浏览器化事实核查 2026-08-18】
  - Cordis 内核（@deepseek-ai/cordis）纯 JS DI/插件框架，可跑浏览器（证据：client/web/src/loader-status.ts import FiberState；storage 继承 Service）
  - dsh Web 客户端 = 浏览器内 Cordis 应用：packages/client/web（AppRoot/boot.tsx/app-shell.ts）+ client/runtime/src/client（独立 client 上下文：sessions/workspaces/conversation/slots/agents），window.__ModuleLoader__.load() 加载客户端插件 bundle
  - 插件分三类：host 侧（Node 强依赖 fs/sandbox/subprocess/llm/terminal/e2b → 浏览器物理不可行）；client 侧（slots/connection/remote → 浏览器可跑）；数据侧（SKILL.md/tool schema/prompt preset → 可迁移）
