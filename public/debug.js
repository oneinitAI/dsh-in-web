// debug.js —— 外部脚本，绕开 MV3 扩展页 CSP 的 inline 限制
window.__dshDebug = {
  outEl: null,
  out(cls, msg) {
    const d = document.createElement('div')
    d.className = cls
    d.textContent = msg
    window.__dshDebug.outEl.appendChild(d)
  },
  run() {
    const out = window.__dshDebug.out
    const outEl = document.getElementById('out')
    window.__dshDebug.outEl = outEl
    out('info', 'URL: ' + location.href)

    // ── 1. CSP unsafe-eval 探测 ──────────────────────────────────
    try {
      new Function('return 1')()
      out('ok', 'new Function: OK → unsafe-eval 允许')
    } catch (e) {
      out('bad', 'new Function: BLOCKED → ' + e.message)
      out('bad', '   ↑ index bundle 顶层有 new Function，模块加载即崩 → 白屏根因')
    }

    // ── 2. 全局错误捕获 ─────────────────────────────────────────
    window.addEventListener('error', (e) => {
      out('bad', 'window error: ' + e.message + ' @ ' + (e.filename || '') + ':' + e.lineno + ':' + e.colno)
    })
    window.addEventListener('unhandledrejection', (e) => {
      const r = e.reason
      out('bad', 'unhandledrejection: ' + (r && r.message ? r.message : String(r)))
    })

    // ── 3. 资源可达性 ────────────────────────────────────────────
    async function probe(url) {
      try {
        const r = await fetch(url)
        out('info', 'fetch ' + url + ' → ' + r.status)
      } catch (e) {
        out('bad', 'fetch ' + url + ' FAILED: ' + e.message)
      }
    }
    probe('./dsh-web/boot-manifest.js')
    probe('./dsh-web/assets/index-D2d4DJUa.js')
    probe('./dsh-web/assets/vendor-CDQA2RH1.js')
    probe('./dsh-web/plugins/@deepseek-ai/dsh-client-connection/client.js')

    // ── 4. 按真实顺序复现 boot ──────────────────────────────────
    out('---', '')
    out('info', '[4] 开始复现 dsh-web boot …')

    const s1 = document.createElement('script')
    s1.src = './dsh-web/boot-manifest.js'
    s1.onload = () => {
      out('ok', 'boot-manifest.js loaded, __DSH_BOOT__ = ' + (typeof window.__DSH_BOOT__) +
        (window.__DSH_BOOT__ ? ' (rev=' + window.__DSH_BOOT__.rev + ', entries=' + window.__DSH_BOOT__.entries.length + ')' : ''))
      const s2 = document.createElement('script')
      s2.type = 'module'
      s2.crossOrigin = ''
      s2.src = './dsh-web/assets/index-D2d4DJUa.js'
      s2.onload = () => {
        out('ok', 'index bundle (module) loaded')
        out('info', '__ModuleLoader__ = ' + (typeof window.__ModuleLoader__))
        out('info', 'document.body.childElementCount = ' + document.body.childElementCount)
        if (typeof window.__ModuleLoader__ !== 'undefined') {
          try {
            const keys = Object.keys(window.__ModuleLoader__)
            out('info', 'loader keys: ' + keys.join(', '))
          } catch (e) { out('info', 'loader read: ' + e.message) }
        }
      }
      s2.onerror = (ev) => {
        out('bad', 'index bundle (module) LOAD/EXEC FAILED')
        if (ev && ev.message) out('bad', '  detail: ' + ev.message)
      }
      document.head.appendChild(s2)
    }
    s1.onerror = () => out('bad', 'boot-manifest.js LOAD FAILED (404?)')
    document.head.appendChild(s1)

    // ── 5. RPC 探测：逐个调用 dsh RPC，看返回形状（模型/预设/插件面板数据源）──
    out('---', '')
    out('info', '[5] RPC 探测（直接发 chrome.runtime dsh-rpc，模拟 dsh UI 调用）…')
    const rpcMethods = [
      'host.describe',
      'session.list', 'session.models', 'session.create',
      'workspace.list', 'skill.list',
      'settings.describe', 'llm.providers', 'llm.models',
      'agentPreset.list', 'agentPreset.read', 'credentials.describe', 'subagent.list',
      'dynamicCordisRunner/inventory', 'dynamicCordisRunner/syncInspectManifest',
    ]
    let settingsDescribeValue = null
    for (const method of rpcMethods) {
      const body = method === 'session.create'
        ? { type: 'client-request', rpcId: 'diag-1', method, payload: { title: 'diag' } }
        : { type: 'client-request', rpcId: 'diag-1', method, payload: {} }
      try {
        const reply = await chrome.runtime.sendMessage({ kind: 'dsh-rpc', method, body })
        const r = reply?.body?.result
        if (r?.ok === true) {
          out('ok', method + ' → ok: ' + JSON.stringify(r.value).slice(0, 180))
          if (method === 'settings.describe') settingsDescribeValue = r.value
        } else {
          out('bad', method + ' → ERROR: ' + JSON.stringify(r?.error).slice(0, 160))
        }
      } catch (e) {
        out('bad', method + ' → THREW: ' + e.message)
      }
    }
    // settings.describe 特判：展开每个 namespace 的 value，直接展示 9 个官方 namespace
    // 的真实配置（如 ui-theme: preference=system），证明 settings 配置真的返回。
    const sNamespaces = settingsDescribeValue && Array.isArray(settingsDescribeValue.namespaces)
      ? settingsDescribeValue.namespaces
      : []
    for (const ns of sNamespaces) {
      if (!ns || typeof ns.ns !== 'string') continue
      const v = ns.value
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const pairs = Object.keys(v)
          .filter((k) => v[k] !== undefined)
          .map((k) => k + '=' + JSON.stringify(v[k]))
        out('info', 'settings[' + ns.ns + ']: ' + (pairs.length ? pairs.join(', ') : '(empty)'))
      } else {
        out('info', 'settings[' + ns.ns + ']: ' + JSON.stringify(v))
      }
    }
    out('info', '[5] RPC 探测完成')
  },
}
window.__dshDebug.run()