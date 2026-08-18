#!/usr/bin/env node
/**
 * verify-official-settings.mjs
 *
 * End-to-end verification of the official settings integration: bundles the
 * official SettingsProvider runtime (cordis + schemastery + dsh-settings src),
 * loads the real OFFICIAL_NAMESPACES schema data from
 * utils/official-settings/namespaces.ts, registers all 11 namespaces through a
 * SettingsProvider subclass, and asserts the official semantics:
 *
 *   - root Context is self-contained (no Node deps)
 *   - each official schema reproduces the authoritative 3080 resolved value
 *   - describe({ redactSecrets: true }) yields base/user/revision/applies/secrets
 *   - update merges + optimistic-lock conflict (SettingsConflictError)
 *   - replace({}) resets to base/schema defaults
 *   - mutate set/unset path ops apply and fall back to base
 *   - unknown-namespace and duplicate-registration fail loud
 *
 * Run: node scripts/verify-official-settings.mjs   (from the repo root)
 */
import { build } from 'esbuild'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const REPO = 'F:/dsh/dsh-in-web'
const HARNESS = 'F:/dsh/deepseek-harness'
const OUTDIR = mkdtempSync(join(tmpdir(), 'dsh-settings-verify-'))

const MODULE_MAP = {
  '@deepseek-ai/cordis': `${HARNESS}/node_modules/@deepseek-ai/cordis/lib/index.js`,
  '@deepseek-ai/schemastery': `${HARNESS}/node_modules/@deepseek-ai/schemastery/lib/index.mjs`,
  '@deepseek-ai/dsh-settings': `${HARNESS}/packages/settings/settings/src/index.ts`,
  '@deepseek-ai/cosmokit': `${HARNESS}/node_modules/@deepseek-ai/cosmokit/lib/index.js`,
}

const resolvePlugin = {
  name: 'dsh-settings-resolve',
  setup(build) {
    build.onResolve({ filter: /^(@deepseek-ai\/cordis|@deepseek-ai\/schemastery|@deepseek-ai\/dsh-settings|@deepseek-ai\/cosmokit|@deepseek-ai\/dsh-brand)$/ }, (args) => {
      if (!MODULE_MAP[args.path]) return { errors: [{ text: `unmapped specifier ${args.path}` }] }
      return { path: MODULE_MAP[args.path] }
    })
  },
}

// Verify entry: re-exports the official runtime + the real schema data.
const verifyEntry = join(OUTDIR, 'verify-entry.ts')
writeFileSync(verifyEntry, [
  `export { Context, SettingsProvider, settingsNamespace, redactSecrets, SettingsConflictError, z } from '${REPO}/scripts/dsh-official-settings/entry.ts'`,
  `export { OFFICIAL_NAMESPACES } from '${REPO}/utils/official-settings/namespaces.ts'`,
].join('\n'))

await build({
  entryPoints: [verifyEntry],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: join(OUTDIR, 'verify.mjs'),
  plugins: [resolvePlugin],
  logLevel: 'silent',
})

const { Context, SettingsProvider, settingsNamespace, redactSecrets, SettingsConflictError, z, OFFICIAL_NAMESPACES } =
  await import('file://' + join(OUTDIR, 'verify.mjs').replaceAll('\\', '/'))

// ── 1. root Context self-contained ───────────────────────────────────
const ctx = new Context()
assert.ok(ctx.events && ctx.registry && ctx.logger, 'root Context services present')

// ── 2. official schema hydration reproduces authoritative values ─────
const officialFull = JSON.parse(
  readFileSync('C:/Users/zzz/AppData/Local/Temp/opencode/official-describe.json', 'utf8').replace(/^\uFEFF/, ''),
).result.value.namespaces
const byNs = new Map(officialFull.map((n) => [n.ns, n]))
assert.equal(OFFICIAL_NAMESPACES.length, officialFull.length, 'all official namespaces present')
for (const entry of OFFICIAL_NAMESPACES) {
  const ref = byNs.get(entry.ns)
  assert.ok(ref, `official reference for ${entry.ns}`)
  assert.deepEqual(entry.schemaJSON, ref.schema, `schemaJSON for ${entry.ns} matches official`)
  const schema = new z(entry.schemaJSON)
  const input = ref.user ?? entry.base ?? {}
  assert.deepEqual(schema(input), ref.value, `schema(${entry.ns}) reproduces official value`)
}

// ── 3. provider + registration + describe + writes ──────────────────
class MemStore {
  doc = {}
  async load() { return structuredClone(this.doc) }
  async persist(ns, section) { this.doc[ns] = structuredClone(section) }
}
class TestProvider extends SettingsProvider {
  constructor(ctx, store) { super(ctx, 'settings'); this.store = store; this.writable = true }
  async load() { return this.store.load() }
  async persist(ns, section) { return this.store.persist(ns, section) }
}
const store = new MemStore()
const provider = new TestProvider(ctx, store)
provider.publish(await provider.load())
for (const entry of OFFICIAL_NAMESPACES) {
  provider.register(
    settingsNamespace(entry.ns),
    new z(entry.schemaJSON),
    entry.base !== undefined ? { base: entry.base } : undefined,
  )
}

const all = provider.describe({ redactSecrets: true })
assert.equal(all.length, 11, '11 descriptors')
for (const d of all) {
  assert.equal(d.revision, 0, `revision 0 for ${d.ns}`)
  assert.equal(d.applies, 'live', `applies live for ${d.ns}`)
  const ref = byNs.get(String(d.ns))
  if (ref?.base !== undefined) assert.deepEqual(d.base, ref.base, `base for ${d.ns}`)
}
const ws = all.find((d) => d.ns === 'web-search-deepseek')
assert.ok(ws.secrets?.some((s) => s.path[0] === 'apiKey' && s.set === false), 'apiKey secret slot redacted')
assert.equal(ws.value.apiKey, undefined, 'apiKey absent from redacted value')

// update + conflict
const theme = all.find((d) => d.ns === 'ui-theme')
await provider.update(settingsNamespace('ui-theme'), { preference: 'dark' }, theme.revision)
let after = provider.describe({ redactSecrets: true }).find((d) => d.ns === 'ui-theme')
assert.equal(after.value.preference, 'dark')
assert.equal(after.revision, 1)
await assert.rejects(
  provider.update(settingsNamespace('ui-theme'), { preference: 'light' }, 0),
  (e) => e instanceof SettingsConflictError && e.code === 'SETTINGS_CONFLICT',
  'stale revision rejects',
)

// replace({}) resets
const wss = all.find((d) => d.ns === 'web-search-deepseek')
await provider.update(settingsNamespace('web-search-deepseek'), { baseURL: 'https://x' }, wss.revision)
let cur = provider.describe({ redactSecrets: true }).find((d) => d.ns === 'web-search-deepseek')
assert.equal(cur.value.baseURL, 'https://x')
await provider.replace(settingsNamespace('web-search-deepseek'), {}, cur.revision)
cur = provider.describe({ redactSecrets: true }).find((d) => d.ns === 'web-search-deepseek')
assert.equal(cur.value.baseURL, undefined, 'replace({}) falls back to base')
assert.deepEqual(cur.user, {}, 'replace({}) stores empty user section')

// mutate set/unset
const llm = all.find((d) => d.ns === 'llm-deepseek')
await provider.mutate(settingsNamespace('llm-deepseek'), [{ op: 'set', path: ['maxTokens'], value: 12345 }], llm.revision)
let llmAfter = provider.describe({ redactSecrets: true }).find((d) => d.ns === 'llm-deepseek')
assert.equal(llmAfter.value.maxTokens, 12345)
assert.equal(llmAfter.value.defaultContextWindow, 1000000, 'untouched base field preserved')
await provider.mutate(settingsNamespace('llm-deepseek'), [{ op: 'unset', path: ['maxTokens'] }], llmAfter.revision)
llmAfter = provider.describe({ redactSecrets: true }).find((d) => d.ns === 'llm-deepseek')
assert.equal(llmAfter.value.maxTokens, 256000, 'unset falls back to base')

// unknown namespace + duplicate registration fail loud
await assert.rejects(
  provider.update(settingsNamespace('zzz-not-registered'), { preference: 'dark' }),
  /^Error: settings namespace "zzz-not-registered" is not registered$/,
)
assert.throws(
  () => provider.register(settingsNamespace('ui-theme'), new z(OFFICIAL_NAMESPACES.find((n) => n.ns === 'ui-theme').schemaJSON)),
  /settings namespace "ui-theme" is already registered/,
)

console.log('✓ official settings runtime verified: 11 namespaces, describe/update/conflict/replace/mutate/redact all official')
