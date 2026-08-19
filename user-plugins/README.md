# user-plugins/ —— 用户插件合并目录

把 dsh client 插件 bundle（与官方 `lib/client.js` 同格式的
`window.__ModuleLoader__.load({ id, factory })` 脚本，例如
`@oneinitai/dsh-settings-plus` 的 `lib/client.js`）以
`<包名>.js` 命名放入本目录（scoped 包用原样名，如
`@oneinitai/dsh-settings-plus.js`）。

运行 `pnpm exec import-dsh` 后：

- 每个 bundle 被复制为 `public/dsh-web/user-plugins/<id>.js`（扩展包内静态文件）；
- 对应 entry 追加进 `__DSH_BOOT__.entries`（`./user-plugins/<id>.js?rev=…`，
  与官方 client bundle 同走 `'self'` 相对路径加载，MV3 CSP 合规）；
- 生成 `public/dsh-web/user-plugins.json` 清单（side panel「插件」页读取展示）。

随后 `pnpm build` 并在 chrome://extensions 重新加载扩展即生效。

> 为什么不做运行时添加：MV3 打包扩展的 extension_pages CSP 被 Chrome 锁定为
> 最小 `script-src 'self'`，blob:/data:/unsafe-eval 一律被拒（manifest 校验即失败），
> 运行时动态注入用户代码不可行。
