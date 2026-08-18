/**
 * Official dsh settings runtime — Service-Worker-only integration point.
 *
 * The real official `SettingsProvider` (bundled from deepseek-harness by
 * scripts/build-official-settings.mjs into public/dsh-official/settings-runtime.js)
 * is loaded here via `importScripts` and driven through a typed surface. The
 * provider is subclassed with a chrome.storage.local backend, and the 11
 * official namespaces (schema + composition base from the authoritative 3080
 * describe) are registered against it.
 *
 * IMPORTANT: this module references `importScripts` / `chrome.storage`, so it
 * must only be imported from the background service worker.
 */
import { OFFICIAL_NAMESPACES } from './namespaces'
import type {
  SettingsDescriptor,
  SettingsNamespace,
  SettingsPathOp,
  SettingsSchema,
  SettingsSchemaJSON,
  SettingsScope,
} from './types'

/** Typed surface of the bundled official settings runtime. */
export interface OfficialSettingsRuntime {
  Context: new () => { events: unknown; registry: unknown; logger: unknown }
  SettingsProvider: abstract new (ctx: unknown, name: string) => SettingsProviderBase
  SettingsConflictError: new (ns: string, expected: number, actual: number) => SettingsConflictError
  deepEqualJson(a: unknown, b: unknown): boolean
  redactSecrets(schema: SettingsSchema, value: unknown): {
    value: unknown
    secrets: ReadonlyArray<{ readonly path: readonly string[]; readonly set: boolean }>
  }
  settingsNamespace(value: string): SettingsNamespace
  z: new <T = unknown>(json: SettingsSchemaJSON) => SettingsSchema<T>
}

export interface SettingsConflictError extends Error {
  readonly code: 'SETTINGS_CONFLICT'
  readonly expected: number
  readonly actual: number
}

/** The public settings-service instance surface the extension drives. */
export interface SettingsProviderInstance {
  /** Whether writes may persist through this provider (official describe reads it). */
  readonly writable: boolean
  register<T = unknown>(
    ns: SettingsNamespace,
    schema: SettingsSchema<T>,
    options?: { base?: Partial<T>; applies?: 'live' | 'restart' },
  ): SettingsScope<T>
  describe(options?: { redactSecrets?: boolean }): SettingsDescriptor[]
  get(ns: SettingsNamespace): unknown
  update(ns: SettingsNamespace, patch: object, expectedRevision?: number): Promise<void>
  replace(ns: SettingsNamespace, section: object, expectedRevision?: number): Promise<void>
  mutate(ns: SettingsNamespace, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
}

/**
 * Full base shape including the official protected provider contract
 * (load/persist/publish). A `declare`-only class: no runtime code, purely the
 * type the subclass checks `override`/`protected` access against. `implements`
 * is deliberately avoided — interface members are not merged into the class.
 */
declare abstract class SettingsProviderBase {
  readonly writable: boolean
  register<T = unknown>(
    ns: SettingsNamespace,
    schema: SettingsSchema<T>,
    options?: { base?: Partial<T>; applies?: 'live' | 'restart' },
  ): SettingsScope<T>
  describe(options?: { redactSecrets?: boolean }): SettingsDescriptor[]
  get(ns: SettingsNamespace): unknown
  update(ns: SettingsNamespace, patch: object, expectedRevision?: number): Promise<void>
  replace(ns: SettingsNamespace, section: object, expectedRevision?: number): Promise<void>
  mutate(ns: SettingsNamespace, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
  protected abstract load(): Promise<Record<string, unknown>>
  protected abstract persist(ns: string, section: Record<string, unknown>): Promise<void>
  protected publish(doc: Record<string, unknown>, source?: 'update' | 'provider'): void
}

declare global {
  /** Loaded by importScripts — see build-official-settings.mjs. */
  var DshOfficialSettings: OfficialSettingsRuntime | undefined
  /** Service-worker global (classic SW, no module) — declared here, DOM lib lacks it. */
  function importScripts(...urls: string[]): void
}

const RUNTIME_URL = 'dsh-official/settings-runtime.js'

let runtimeLoaded = false

/** Load the bundled official settings runtime once (idempotent). */
export function ensureOfficialSettingsRuntime(): void {
  if (runtimeLoaded) return
  runtimeLoaded = true
  if (globalThis.DshOfficialSettings !== undefined) return
  try {
    importScripts(chrome.runtime.getURL(RUNTIME_URL))
  } catch (error) {
    console.warn('[dsh-official-settings] runtime load failed:', error)
  }
}

/** The loaded runtime, or null when unavailable (load failed / non-SW env). */
export function getOfficialSettingsRuntime(): OfficialSettingsRuntime | null {
  ensureOfficialSettingsRuntime()
  return globalThis.DshOfficialSettings ?? null
}

/** chrome.storage.local backend for the official SettingsProvider document. */
export interface SettingsStorageBackend {
  load(): Promise<Record<string, Record<string, unknown>>>
  write(doc: Record<string, Record<string, unknown>>): Promise<void>
}

/**
 * One raw document `{ ns: section }` under a single storage key, mirroring the
 * previous `dsh-official-settings` layout so existing user overrides survive.
 */
export class ChromeSettingsStorageBackend implements SettingsStorageBackend {
  constructor(private readonly key: string) {}

  async load(): Promise<Record<string, Record<string, unknown>>> {
    try {
      const stored = await chrome.storage.local.get(this.key)
      const raw = stored[this.key]
      if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        return raw as Record<string, Record<string, unknown>>
      }
    } catch {
      // 非扩展环境：空文档
    }
    return {}
  }

  async write(doc: Record<string, Record<string, unknown>>): Promise<void> {
    try {
      await chrome.storage.local.set({ [this.key]: doc })
    } catch {
      // 非扩展环境：忽略写失败
    }
  }
}

/**
 * Build the extension's official settings provider: subclass the bundled
 * SettingsProvider with the chrome.storage backend, load the persisted
 * document, and register all 11 official namespaces. Call once, reuse.
 */
export async function createOfficialSettingsProvider(
  runtime: OfficialSettingsRuntime,
  backend: SettingsStorageBackend,
): Promise<SettingsProviderInstance> {
  class ChromeStorageSettingsProvider extends runtime.SettingsProvider {
    override readonly writable = true
    private doc: Record<string, Record<string, unknown>> = {}

    constructor(ctx: unknown, store: SettingsStorageBackend) {
      super(ctx, 'settings')
      this.store = store
    }
    private readonly store: SettingsStorageBackend

    protected override async load(): Promise<Record<string, unknown>> {
      this.doc = await this.store.load()
      return structuredClone(this.doc)
    }

    protected override async persist(ns: string, section: Record<string, unknown>): Promise<void> {
      this.doc = { ...this.doc, [ns]: structuredClone(section) }
      await this.store.write(this.doc)
    }

    /** Manual equivalent of the official Service.init: load + publish once. */
    async init(): Promise<void> {
      this.publish(await this.load())
    }
  }

  const ctx = new runtime.Context()
  const provider = new ChromeStorageSettingsProvider(ctx, backend)
  // Publish the persisted document BEFORE registering so each namespace
  // resolves with any user overrides already in storage.
  await provider.init()
  for (const spec of OFFICIAL_NAMESPACES) {
    provider.register(
      runtime.settingsNamespace(spec.ns),
      new runtime.z(spec.schemaJSON),
      spec.base !== undefined ? { base: spec.base } : undefined,
    )
  }
  return provider
}

/**
 * Official wire shape for one descriptor — mirrors api-proxy.ts namespaceView.
 */
export interface SettingsNamespaceView {
  ns: string
  schema: unknown
  value: unknown
  base?: unknown
  user?: unknown
  applies: 'live' | 'restart'
  secrets: ReadonlyArray<{ readonly path: readonly string[]; readonly set: boolean }>
  revision: number
}

/** Serialize one official descriptor to the wire view (api-proxy namespaceView). */
export function namespaceView(descriptor: SettingsDescriptor): SettingsNamespaceView {
  return {
    ns: String(descriptor.ns),
    schema: descriptor.schema,
    value: descriptor.value,
    ...(descriptor.base === undefined ? {} : { base: descriptor.base }),
    ...(descriptor.user === undefined ? {} : { user: descriptor.user }),
    applies: descriptor.applies,
    secrets: (descriptor.secrets ?? []).map((secret) => ({ path: [...secret.path], set: secret.set })),
    revision: descriptor.revision,
  }
}
