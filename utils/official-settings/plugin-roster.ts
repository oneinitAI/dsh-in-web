/**
 * dsh-in-web — DeepSeek Harness (dsh) in the browser.
 *
 * This file embeds/adapts code from deepseek-ai/DeepSeek-Harness (dsh),
 * distributed under the MIT License.
 *
 * Copyright (c) 2026 DeepSeek (dsh / DeepSeek-Harness)
 * Copyright (c) 2026 oneinitAI
 *
 * SPDX-License-Identifier: MIT
 */

/**
 * Official dsh plugin roster for the in-browser harness.
 *
 * Static projection of the plugins a real dsh deployment assembles — the union
 * of the `@deepseek-ai/dsh-base` bundle (78 host rows), the
 * `@deepseek-ai/dsh-web-app` bundle's web-only host rows (17), and the browser
 * roster `window.__DSH_BOOT__` ships (37 client plugin modules). Extracted from
 * `packages/bundle/base/cordis.patch.yml` + `packages/bundle/web-app/cordis.patch.yml`
 * of the deepseek-harness checkout and the synced `public/dsh-web/boot-manifest.js`.
 *
 * The host `id` is the Loader row id; the client `id` is the module specifier
 * (they never collide). `disabled` mirrors rows the web composition disables
 * (`hmr`, `skill-badge`), so the inventory UI shows the same enablement the
 * official Loader tree would.
 */

export interface OfficialPluginRosterEntry {
  /** Loader row id (host) or module specifier (client). Unique across the roster. */
  readonly id: string
  /** Exact module specifier the Loader entry imports. */
  readonly moduleName: string
  /** Whether the plugin mounts on the host plane (vs the browser roster). */
  readonly host: boolean
  /** Disabled by the assembled web composition (mirrors Loader disablement). */
  readonly disabled?: boolean
}

/** Host rows from the `dsh-base` bundle (78). */
const BASE_HOST_PLUGINS: readonly OfficialPluginRosterEntry[] = [
  { id: 'timer', moduleName: '@deepseek-ai/cordis-plugin-timer', host: true },
  // Disabled in the web composition (web-app patch overrides hmr with disabled: true).
  { id: 'hmr', moduleName: '@deepseek-ai/cordis-plugin-hmr', host: true, disabled: true },
  { id: 'llm', moduleName: '@deepseek-ai/dsh-llm', host: true },
  { id: 'session', moduleName: '@deepseek-ai/dsh-session', host: true },
  { id: 'typert', moduleName: '@deepseek-ai/dsh-typert-registry', host: true },
  { id: 'typert-loader', moduleName: '@deepseek-ai/dsh-typert-loader', host: true },
  { id: 'typert-gateway', moduleName: '@deepseek-ai/dsh-api-gateway', host: true },
  { id: 'session-title', moduleName: '@deepseek-ai/dsh-session-title', host: true },
  { id: 'session-title-llm', moduleName: '@deepseek-ai/dsh-session-title-first-prompt-llm', host: true },
  { id: 'user-questions', moduleName: '@deepseek-ai/dsh-user-questions', host: true },
  { id: 'agent', moduleName: '@deepseek-ai/dsh-agent', host: true },
  { id: 'agent-default-model', moduleName: '@deepseek-ai/dsh-agent-default-model', host: true },
  { id: 'jobs', moduleName: '@deepseek-ai/dsh-jobs-local', host: true },
  { id: 'llm-retry', moduleName: '@deepseek-ai/dsh-llm-retry', host: true },
  { id: 'settings', moduleName: '@deepseek-ai/dsh-settings-file', host: true },
  { id: 'credentials', moduleName: '@deepseek-ai/dsh-credentials-local', host: true },
  { id: 'llm-pi-ai', moduleName: '@deepseek-ai/dsh-llm-pi-ai', host: true },
  { id: 'session-persistence-jsonl', moduleName: '@deepseek-ai/dsh-session-persistence-jsonl', host: true },
  { id: 'attachment-local', moduleName: '@deepseek-ai/dsh-attachment-local', host: true },
  { id: 'session-query-sqlite', moduleName: '@deepseek-ai/dsh-session-query-sqlite', host: true },
  { id: 'session-projection', moduleName: '@deepseek-ai/dsh-session-projection', host: true },
  { id: 'session-telemetry-otel', moduleName: '@deepseek-ai/dsh-session-telemetry-otel', host: true },
  { id: 'subprocess', moduleName: '@deepseek-ai/dsh-subprocess-local', host: true },
  { id: 'sandbox', moduleName: '@deepseek-ai/dsh-sandbox-local', host: true },
  { id: 'sandbox-policy', moduleName: '@deepseek-ai/dsh-sandbox-policy', host: true },
  { id: 'bash-sandbox', moduleName: '@deepseek-ai/dsh-bash-sandbox', host: true },
  { id: 'pwsh-sandbox', moduleName: '@deepseek-ai/dsh-pwsh-sandbox', host: true },
  { id: 'approval', moduleName: '@deepseek-ai/dsh-user-approval', host: true },
  { id: 'permission', moduleName: '@deepseek-ai/dsh-permission-presets', host: true },
  { id: 'shell-env', moduleName: '@deepseek-ai/dsh-shell-env', host: true },
  { id: 'tool-bash', moduleName: '@deepseek-ai/dsh-tool-bash', host: true },
  { id: 'tool-pwsh', moduleName: '@deepseek-ai/dsh-tool-pwsh', host: true },
  { id: 'tool-jobs', moduleName: '@deepseek-ai/dsh-tool-jobs', host: true },
  { id: 'fs-observation-policy', moduleName: '@deepseek-ai/dsh-fs-observation-policy', host: true },
  { id: 'tool-fs', moduleName: '@deepseek-ai/dsh-tool-fs', host: true },
  { id: 'tool-fs-search', moduleName: '@deepseek-ai/dsh-tool-fs-search', host: true },
  { id: 'agent-instructions', moduleName: '@deepseek-ai/dsh-agent-instructions', host: true },
  { id: 'skill', moduleName: '@deepseek-ai/dsh-skill', host: true },
  { id: 'skill-filesystem', moduleName: '@deepseek-ai/dsh-skill-filesystem', host: true },
  // Disabled by default in the base bundle.
  { id: 'skill-badge', moduleName: '@deepseek-ai/dsh-skill-badge', host: true, disabled: true },
  { id: 'tool-skill', moduleName: '@deepseek-ai/dsh-tool-skill', host: true },
  { id: 'commands', moduleName: '@deepseek-ai/dsh-commands', host: true },
  { id: 'command-feedback', moduleName: '@deepseek-ai/dsh-command-feedback', host: true },
  { id: 'goal', moduleName: '@deepseek-ai/dsh-goal', host: true },
  { id: 'goal-round-driver', moduleName: '@deepseek-ai/dsh-goal-round-driver', host: true },
  { id: 'command-goal', moduleName: '@deepseek-ai/dsh-command-goal', host: true },
  { id: 'plan-mode', moduleName: '@deepseek-ai/dsh-plan-mode', host: true },
  { id: 'token-meter', moduleName: '@deepseek-ai/dsh-token-meter', host: true },
  { id: 'compaction-basic', moduleName: '@deepseek-ai/dsh-compaction-basic', host: true },
  { id: 'command-compact', moduleName: '@deepseek-ai/dsh-command-compact', host: true },
  { id: 'subagent', moduleName: '@deepseek-ai/dsh-subagent', host: true },
  { id: 'subagent-spawn-in-process', moduleName: '@deepseek-ai/dsh-subagent-spawn-in-process', host: true },
  { id: 'subagent-fork-in-process', moduleName: '@deepseek-ai/dsh-subagent-fork-in-process', host: true },
  { id: 'tool-subagent-control', moduleName: '@deepseek-ai/dsh-tool-subagent-control', host: true },
  { id: 'tool-subagent-list-agents', moduleName: '@deepseek-ai/dsh-tool-subagent-control/list-agents', host: true },
  { id: 'tool-subagent', moduleName: '@deepseek-ai/dsh-tool-subagent', host: true },
  { id: 'tool-subagent-fork', moduleName: '@deepseek-ai/dsh-tool-subagent', host: true },
  { id: 'tool-subagent-report', moduleName: '@deepseek-ai/dsh-tool-subagent-report', host: true },
  { id: 'workflow-worker-thread', moduleName: '@deepseek-ai/dsh-workflow-worker-thread', host: true },
  { id: 'tool-workflow', moduleName: '@deepseek-ai/dsh-tool-workflow', host: true },
  { id: 'timeout-policy', moduleName: '@deepseek-ai/dsh-tool-call-timeout-policy', host: true },
  { id: 'spill-local', moduleName: '@deepseek-ai/dsh-spill-local', host: true },
  { id: 'spill-policy', moduleName: '@deepseek-ai/dsh-spill-policy', host: true },
  { id: 'session-checkpoint-policy', moduleName: '@deepseek-ai/dsh-session-checkpoint-policy', host: true },
  { id: 'tool-result-pruner', moduleName: '@deepseek-ai/dsh-compaction-tool-result-pruner', host: true },
  { id: 'tool-todo', moduleName: '@deepseek-ai/dsh-tool-todo', host: true },
  { id: 'tool-goal', moduleName: '@deepseek-ai/dsh-tool-goal', host: true },
  { id: 'tool-ralph', moduleName: '@deepseek-ai/dsh-tool-ralph', host: true },
  { id: 'tool-str-replace-editor', moduleName: '@deepseek-ai/dsh-tool-str-replace-editor', host: true },
  { id: 'repeat-tool-reminder', moduleName: '@deepseek-ai/dsh-repeat-tool-reminder', host: true },
  { id: 'web', moduleName: '@deepseek-ai/dsh-web', host: true },
  { id: 'web-search-deepseek', moduleName: '@deepseek-ai/dsh-web-search-deepseek', host: true },
  { id: 'tool-web', moduleName: '@deepseek-ai/dsh-tool-web', host: true },
  { id: 'tools', moduleName: '@deepseek-ai/dsh-tools', host: true },
  { id: 'system-prompt', moduleName: '@deepseek-ai/dsh-system-prompt', host: true },
  { id: 'agent-loop', moduleName: '@deepseek-ai/dsh-agent-loop', host: true },
  { id: 'fs-sandbox', moduleName: '@deepseek-ai/dsh-fs-sandbox', host: true },
  { id: 'llm-deepseek', moduleName: '@deepseek-ai/dsh-llm-deepseek', host: true },
]

/** Web-only host rows from the `dsh-web-app` bundle (17). */
const WEB_HOST_PLUGINS: readonly OfficialPluginRosterEntry[] = [
  { id: 'code-runtime', moduleName: '@deepseek-ai/dsh-code-runtime-worker-thread', host: true },
  { id: 'storage', moduleName: '@deepseek-ai/dsh-storage', host: true },
  { id: 'storage-json', moduleName: '@deepseek-ai/dsh-storage-json', host: true },
  { id: 'storage-domain', moduleName: '@deepseek-ai/dsh-storage-domain', host: true },
  { id: 'message-feedback', moduleName: '@deepseek-ai/dsh-message-feedback', host: true },
  { id: 'session-log-download', moduleName: '@deepseek-ai/dsh-session-log-export', host: true },
  { id: 'workspace', moduleName: '@deepseek-ai/dsh-workspace', host: true },
  { id: 'session-projection-cache', moduleName: '@deepseek-ai/dsh-session-projection-cache', host: true },
  { id: 'session-stats', moduleName: '@deepseek-ai/dsh-session-stats', host: true },
  { id: 'directory-picker', moduleName: '@deepseek-ai/dsh-host-directory-picker-auto', host: true },
  { id: 'plugin-inventory', moduleName: '@deepseek-ai/dsh-host-plugin-inventory', host: true },
  { id: 'api-gateway', moduleName: '@deepseek-ai/dsh-host-apiproxy', host: true },
  { id: 'cordis-host-runner', moduleName: '@deepseek-ai/dsh-cordis-host-runner', host: true },
  { id: 'web-startup', moduleName: '@deepseek-ai/dsh-web-app/startup', host: true },
  { id: 'webserver', moduleName: '@deepseek-ai/dsh-host-webserver', host: true },
  { id: 'web-runtime', moduleName: '@deepseek-ai/dsh-web-app', host: true },
  { id: 'agent-presets', moduleName: '@deepseek-ai/dsh-agent-presets', host: true },
]

/** Browser-roster plugins from `window.__DSH_BOOT__` (37 client modules). */
const CLIENT_PLUGINS: readonly OfficialPluginRosterEntry[] = [
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-agent-preset',
  '@deepseek-ai/dsh-client-ui-commands',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-deliverables',
  '@deepseek-ai/dsh-client-ui-directory-picker-browse',
  '@deepseek-ai/dsh-client-ui-goal',
  '@deepseek-ai/dsh-client-ui-input-trigger',
  '@deepseek-ai/dsh-client-ui-jobs',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-message-feedback',
  '@deepseek-ai/dsh-client-ui-model-selection',
  '@deepseek-ai/dsh-client-ui-permission-presets',
  '@deepseek-ai/dsh-client-ui-plan',
  '@deepseek-ai/dsh-client-ui-settings-general',
  '@deepseek-ai/dsh-client-ui-settings-models',
  '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-skill',
  '@deepseek-ai/dsh-client-ui-subagent',
  '@deepseek-ai/dsh-client-ui-theme',
  '@deepseek-ai/dsh-client-ui-tool',
  '@deepseek-ai/dsh-client-ui-trajectory',
  '@deepseek-ai/dsh-client-ui-user-questions',
  '@deepseek-ai/dsh-client-ui-workflow-run',
  '@deepseek-ai/dsh-client-ui-workspace',
  '@deepseek-ai/dsh-cordis-client-runner',
  '@deepseek-ai/dsh-client-ui-cordis',
  '@deepseek-ai/dsh-session-log-export',
  '@deepseek-ai/dsh-typert-registry',
].map((moduleName) => ({ id: moduleName, moduleName, host: false }))

/**
 * Complete assembled plugin roster: base host (78) + web host (17) + client
 * browser modules (37) = 132 entries, mirroring the official base+web-app
 * assembly (the Loader rows plus the client module table), with disabled rows
 * (`hmr`, `skill-badge`) retained for enablement fidelity.
 */
export const OFFICIAL_PLUGIN_ROSTER: readonly OfficialPluginRosterEntry[] = [
  ...BASE_HOST_PLUGINS,
  ...WEB_HOST_PLUGINS,
  ...CLIENT_PLUGINS,
]
