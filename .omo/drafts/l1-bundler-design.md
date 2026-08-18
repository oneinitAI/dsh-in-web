# W3.4 — L1 适配打包器设计（esbuild browser target + node:* shim）

> 目标：让 **源码零修改** 的 dsh 插件（L1 级别）也能在 dsh-in-web 中加载。
> L1 = 插件源码不改，构建时用 esbuild 打包成浏览器可执行 bundle。
> 与 L0（纯数据直载，无需打包）互补。

## 1. 输入 / 输出

- 输入：插件目录 `/plugins/<name>/`，含
  - `dsh.plugin.json`（manifest：entry / skills / tools / prompts）
  - `entry` 指向的 JS/TS 源码（Cordis 插件：`(ctx, config) => ...` 或 `{ apply(ctx, config) }`）
  - 依赖声明（package.json 或 manifest 内 `dependencies`）
- 输出：浏览器可执行 bundle（ESM）
  - `/plugins/<name>/.dist/index.js`（写入虚拟 FS，或内存缓存）
  - 导出符合 Cordis `Plugin` 形状的默认导出

## 2. 打包配置（esbuild）

```js
// 伪代码
await esbuild.build({
  entryPoints: [pluginDir + '/' + manifest.entry],
  bundle: true,
  format: 'esm',
  target: ['chrome120'],            // 对齐 MV3 浏览器基线
  platform: 'browser',              // 关键：无 Node 内建解析
  external: ['@deepseek-ai/cordis'], // 内核单例，不重复打包
  alias: {
    'node:fs/promises': shimFs,
    'node:path': shimPath,
    'node:os': shimOs,
    // ...
  },
  define: {
    'process.env.NODE_ENV': '"production"',
  },
})
```

## 3. node:* shim 策略

| node 内建 | 浏览器 shim | 说明 |
|---|---|---|
| `node:fs/promises` | 虚拟 FS 适配器（ctx.fs 的 Workspace） | 顶层方法代理到 Workspace |
| `node:path` | 轻量 posix path 工具 | resolve/basename/dirname/join |
| `node:os` | 常量填充 | EOL/arch/platform 只读值 |
| `node:crypto` | Web Crypto 适配 | randomUUID/subtle 可用 |
| `node:events` | EventEmitter 迷你实现 | 或 polyfill 包 |
| `node:util` | 常用函数 | promisify/format 等 |
| `node:buffer` | 纯 JS Buffer polyfill | 仅在明确需要时 |
| `node:child_process`/`node:net`/`node:http` | ❌ 不可 shim | 标记 runtime 错误 `service-not-available` |

**分级**：
- L1a：只用 fs/path/os/crypto/events 等 → 完整可用
- L1b：触及 child_process/net/http → 加载成功，调用时抛 `service-not-available`（对齐 dsh 的未实现服务语义）

## 4. 运行时约束

- Cordis 内核是单例：`external: ['@deepseek-ai/cordis']`，bundle 通过 import map 或 SW 内的模块作用域引用内核。
- bundle 在扩展 SW（service worker）内 `import()` 动态执行——MV3 允许 SW 内动态 import（同源资源）。
- 插件源码不可信：执行在扩展上下文；SandboxMode 默认 read-only 兜底，ctx.fs 写操作受策略约束。
- 版本兼容：dsh 插件若依赖 `@deepseek-ai/cordis` 的版本与内核不同，按 semver major 匹配，不匹配则拒绝加载并提示。

## 5. 实施顺序（归入 Wave 3 收尾 / Wave 5 工程化）

1. `scripts/build-plugin.mjs`：Node 侧 CLI（开发期用），把插件目录打包到 `.output/plugins/<name>/`
2. SW 内 `loadBundle(pluginName)`：读 bundle → `import()` → `ctx.plugin(bundle.default)`
3. shim 模块落地 `utils/plugin/shim/{fs,path,os}.ts` + 测试
4. L1 冒烟：把一个真实 dsh 插件（纯 ctx 数据型）打包加载，断言 skill 注册进 ctx.skills

## 6. 已确认的边界

- 记事本结论：host 侧插件（依赖 Node fs/sandbox/subprocess/llm/terminal）浏览器物理不可行 → 归 L1b，调用时 `service-not-available`。
- client 侧插件（slots/connection/remote）可跑，但需 dsh Web client runtime 支持——当前版本先不实现，属 L2+。
- 真 OS 能力（PTY/任意进程）只有可选本地桥能提供（非默认路径，见 plan Must NOT）。

## 状态
- [x] 方案文档（本文件）
- [ ] esbuild 打包器 CLI（Wave 5 实施）
- [ ] shim 模块 + 测试
- [ ] L1 冒烟测试