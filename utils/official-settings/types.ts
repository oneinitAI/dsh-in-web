/**
 * Shared pure types for the official dsh settings integration.
 *
 * The extension runs the real official `SettingsProvider` (bundled from the
 * deepseek-harness source by scripts/build-official-settings.mjs) in the
 * Service Worker. These types mirror the official public surface
 * (@deepseek-ai/dsh-settings) and the schemastery `toJSON()` envelope so the
 * dsh-in-web TS code stays typed without importing the harness packages.
 *
 * This module has NO runtime imports — safe to import from any entrypoint.
 */

/** Nominal id of one registered settings namespace (official branding). */
export type SettingsNamespace = string & { readonly __settingsNamespace?: never }

/** schemastery toJSON node metadata (subset the extension touches). */
export interface SettingsSchemaMeta {
  readonly required?: boolean
  readonly default?: unknown
  readonly step?: number
  readonly min?: number
  readonly max?: number
  readonly role?: string
  readonly description?: string
  readonly [key: string]: unknown
}

/** One schemastery toJSON ref node. */
export interface SettingsSchemaRef {
  readonly type: 'const' | 'union' | 'object' | 'string' | 'number' | 'boolean' | 'dict' | 'array' | 'tuple' | string
  readonly meta: SettingsSchemaMeta
  /** const 节点字面量 */
  readonly value?: unknown
  /** union 节点：子节点 uid 列表 */
  readonly list?: readonly number[]
  /** object 节点：字段 → 子节点 uid */
  readonly dict?: Readonly<Record<string, number>>
  /** array/dict 节点：元素 schema uid */
  readonly inner?: number
  /** dict 节点：string-key schema uid（schemastery toJSON 可选键） */
  readonly sKey?: number
}

/**
 * schemastery `toJSON()` envelope ({ uid, refs }), the shape the official
 * service serializes per namespace and the client rehydrates with
 * `new Schema(json)`.
 */
export interface SettingsSchemaJSON {
  readonly uid: number
  readonly refs: Readonly<Record<string, SettingsSchemaRef>>
}

/** Minimal live schemastery schema surface used by the extension. */
export interface SettingsSchema<T = unknown> {
  (value: unknown): T
  toJSON(): SettingsSchemaJSON
  /** inner node access used by redaction (structural walk). */
  readonly type?: string
  readonly meta?: { role?: unknown }
  readonly dict?: Record<string, SettingsSchema<unknown>>
  readonly inner?: SettingsSchema<unknown>
}

/** One registered namespace as surfaced to configuration surfaces. */
export interface SettingsDescriptor {
  readonly ns: string
  readonly schema: unknown
  readonly value: unknown
  readonly revision: number
  readonly base?: unknown
  readonly user?: unknown
  readonly applies: 'live' | 'restart'
  readonly secrets?: ReadonlyArray<{ readonly path: readonly string[]; readonly set: boolean }>
}

/** One path-addressed edit to a namespace's user section. */
export type SettingsPathOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

/** Options for SettingsProvider.describe. */
export interface SettingsDescribeOptions {
  redactSecrets?: boolean
}

/** Registration options beyond the namespace schema. */
export interface SettingsRegisterOptions<T> {
  base?: Partial<T>
  applies?: 'live' | 'restart'
  validate?: (value: T) => void
}

/** Owner-facing handle for one registered namespace. */
export interface SettingsScope<T> {
  get(): T
  watch(callback: (next: T, prev: T) => void | Promise<void>): () => void
  update(patch: object, expectedRevision?: number): Promise<void>
  replace(section: object, expectedRevision?: number): Promise<void>
}

/** A write refused because the namespace moved since the caller read it. */
export interface SettingsConflictErrorLike extends Error {
  readonly code: 'SETTINGS_CONFLICT'
  readonly expected: number
  readonly actual: number
}

/** One official namespace spec embedded from the authoritative 3080 describe. */
export interface OfficialNamespaceSpec {
  readonly ns: string
  readonly schemaJSON: SettingsSchemaJSON
  readonly base?: Readonly<Record<string, unknown>>
}
