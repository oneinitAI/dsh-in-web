/**
 * Extension-context recovery (shared by bridge-api-client.ts and bridge-rpc.ts).
 *
 * Chrome MV3 扩展被 reload / 更新后，旧页面（sidepanel 自身、或 dsh-ui 注入的
 * dsh-web iframe）持有的 chrome.runtime 上下文全部失效：任何 sendMessage /
 * connect 调用都会抛 "Extension context invalidated."。这是不可重试的硬错误
 * （port 重连也没用——旧上下文的任何引用都不可用），唯一恢复方式是重新加载
 * 扩展页面，让它重新 boot 并重新 connect。这里检测到该错误后防抖触发
 * location.reload()，避免无限刷新（如扩展被禁用时）。
 */
const CONTEXT_INVALIDATED_RE = /Extension context invalidated/i;
let lastContextReloadAt = 0;
const CONTEXT_RELOAD_THROTTLE_MS = 5_000;

/** True when the error is the classic "extension context invalidated" failure. */
export function isContextInvalidated(error: unknown): boolean {
  // chrome.runtime.lastError 是 { message } 形状而非 Error 实例，统一提取 message。
  const message = error instanceof Error
    ? error.message
    : typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error);
  return CONTEXT_INVALIDATED_RE.test(message);
}

/** Throttled host-page reload to recover an invalidated extension context. */
export function recoverInvalidatedContext(): void {
  const now = Date.now();
  if (now - lastContextReloadAt < CONTEXT_RELOAD_THROTTLE_MS) return;
  lastContextReloadAt = now;
  try {
    // 仅重载扩展页面自身（chrome-extension:// origin，sidepanel 或 dsh-web
    // iframe）；bridge content script 运行的网页宿主不受影响。
    if (typeof location !== 'undefined' && location.protocol === 'chrome-extension:') {
      location.reload();
    }
  } catch {
    /* 非浏览器宿主（测试）下静默 */
  }
}