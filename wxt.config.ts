import { defineConfig } from 'wxt'

export default defineConfig({
  manifest: {
    name: 'dsh-in-web',
    description: '把 chat.deepseek.com 网页版改造成 dsh（DeepSeek Harness）形态',
    version: '0.1.0',
    minimum_chrome_version: '116',
    permissions: [
      'sidePanel',
      'storage',
      'scripting',
      'activeTab',
      'contextMenus',
      'unlimitedStorage',
    ],
    host_permissions: ['https://chat.deepseek.com/*', '<all_urls>'],
    web_accessible_resources: [
      {
        // 允许页面 iframe 加载 dsh 面板（dsh-ui.content.ts 注入）。
        // dsh-web/** 覆盖嵌套 iframe（sidepanel.html → dsh-web/index.html → chunks/plugins/assets）
        // 在网页上下文加载扩展资源所需的所有 URL。
        resources: ['sidepanel.html', 'chunks/*', 'assets/*', 'dsh-web/**'],
        matches: ['https://chat.deepseek.com/*'],
      },
    ],
    action: {
      default_title: 'dsh-in-web',
    },
    commands: {
      'open-side-panel': {
        suggested_key: { default: 'Ctrl+Shift+Y' },
        description: '打开 dsh 侧边栏',
      },
    },
  },
})
