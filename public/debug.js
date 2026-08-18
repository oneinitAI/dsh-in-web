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
  },
}
window.__dshDebug.run()