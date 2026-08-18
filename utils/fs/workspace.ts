/**
 * Virtual workspace aligned with dsh `ctx.fs` semantics
 * (fs/src/types.ts:60-160) — resolve / readText / writeText / editText
 * returning {before, after, version}, gated by SandboxMode three-state
 * policy (sandbox-policy/src/index.ts:67-120).
 *
 * Backed by IndexedDB (fake-indexeddb in tests).
 */

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export interface WriteResult {
  version: number
}

export interface EditResult {
  before: string
  after: string
  version: number
}

export interface FsEntry {
  path: string
  kind: 'file' | 'dir'
  size?: number
  version?: number
}

export interface EditSpec {
  oldString: string
  newString: string
  replaceAll?: boolean
}

export interface WorkspaceOptions {
  sandboxMode?: SandboxMode
  dbName?: string
}

/** Path normalization + traversal guard. */
export function resolvePath(input: string): string {
  if (typeof input !== 'string' || input.trim() === '') throw new Error('path must be a non-empty string')
  const normalized = input.replace(/\\/g, '/')
  const parts = normalized.split('/').filter((p) => p !== '' && p !== '.')
  const out: string[] = []
  for (const part of parts) {
    if (part === '..') {
      if (out.length === 0) throw new Error('path escapes workspace root')
      out.pop()
    } else {
      out.push(part)
    }
  }
  return '/' + out.join('/')
}

interface FileRecord {
  path: string
  kind: 'file'
  content: string
  version: number
}

interface DirRecord {
  path: string
  kind: 'dir'
}

const STORE = 'entries'

function parentPath(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx <= 0 ? '/' : p.slice(0, idx)
}

export class Workspace {
  private db: IDBDatabase | null = null
  private mode: SandboxMode
  private dbName: string

  constructor(opts: WorkspaceOptions = {}) {
    this.mode = opts.sandboxMode ?? 'read-only'
    this.dbName = opts.dbName ?? 'dsh-in-web-workspace'
  }

  async init(): Promise<void> {
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'path' })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    // ensure root dir exists
    await this.putRecord({ path: '/', kind: 'dir' })
  }

  private tx(mode: IDBTransactionMode): IDBTransaction {
    if (!this.db) throw new Error('workspace not initialized')
    return this.db.transaction(STORE, mode)
  }

  private getRecord<T>(path: string): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      const t = this.tx('readonly')
      const req = t.objectStore(STORE).get(path) as IDBRequest<T | undefined>
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  private putRecord(rec: FileRecord | DirRecord): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = this.tx('readwrite')
      const req = t.objectStore(STORE).put(rec)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  }

  private deleteRecord(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = this.tx('readwrite')
      const req = t.objectStore(STORE).delete(path)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  }

  private allRecords(): Promise<Array<FileRecord | DirRecord>> {
    return new Promise((resolve, reject) => {
      const t = this.tx('readonly')
      const req = t.objectStore(STORE).getAll() as IDBRequest<Array<FileRecord | DirRecord>>
      req.onsuccess = () => resolve(req.result ?? [])
      req.onerror = () => reject(req.error)
    })
  }

  private assertWritable(): void {
    if (this.mode !== 'workspace-write' && this.mode !== 'danger-full-access') {
      throw new Error('write denied: sandbox mode is read-only')
    }
  }

  private async ensureParentDirs(path: string): Promise<void> {
    let p = parentPath(path)
    while (p !== '/') {
      const existing = await this.getRecord<DirRecord | FileRecord>(p)
      if (!existing) {
        await this.putRecord({ path: p, kind: 'dir' })
      } else if (existing.kind !== 'dir') {
        throw new Error(`parent ${p} is not a directory`)
      }
      p = parentPath(p)
    }
  }

  /** Resolve + read. Returns undefined when missing. */
  async readText(path: string): Promise<string | undefined> {
    const p = resolvePath(path)
    const rec = await this.getRecord<FileRecord>(p)
    return rec?.kind === 'file' ? rec.content : undefined
  }

  /** Write (create or overwrite). Bumps version. Auto-creates parents. */
  async writeText(path: string, content: string): Promise<WriteResult> {
    this.assertWritable()
    const p = resolvePath(path)
    await this.ensureParentDirs(p)
    const existing = await this.getRecord<FileRecord>(p)
    const version = (existing?.kind === 'file' ? existing.version : 0) + 1
    await this.putRecord({ path: p, kind: 'file', content, version })
    return { version }
  }

  /** Edit via oldString/newString. Returns before/after/version. */
  async editText(path: string, spec: EditSpec): Promise<EditResult> {
    this.assertWritable()
    const p = resolvePath(path)
    const rec = await this.getRecord<FileRecord>(p)
    if (rec?.kind !== 'file') throw new Error(`file not found: ${p}`)
    if (!spec.oldString) throw new Error('oldString must be non-empty')
    const after = spec.replaceAll
      ? rec.content.split(spec.oldString).join(spec.newString)
      : rec.content.replace(spec.oldString, spec.newString)
    if (after === rec.content) throw new Error('oldString not found in file content')
    const version = rec.version + 1
    await this.putRecord({ path: p, kind: 'file', content: after, version })
    return { before: rec.content, after, version }
  }

  /** List direct children of a dir. */
  async list(path: string): Promise<FsEntry[]> {
    const p = resolvePath(path)
    const all = await this.allRecords()
    const prefix = p === '/' ? '/' : p + '/'
    return all
      .filter((r) => r.path !== '/' && r.path.startsWith(prefix) && !r.path.slice(prefix.length).includes('/'))
      .map((r) => {
        const base: FsEntry = { path: r.path, kind: r.kind }
        if (r.kind === 'file') {
          base.size = r.content.length
          base.version = r.version
        }
        return base
      })
  }

  /** Stat a single path. Returns undefined when missing. */
  async stat(path: string): Promise<FsEntry | undefined> {
    const p = resolvePath(path)
    const rec = await this.getRecord<FileRecord | DirRecord>(p)
    if (!rec) return undefined
    const base: FsEntry = { path: rec.path, kind: rec.kind }
    if (rec.kind === 'file') {
      base.size = rec.content.length
      base.version = rec.version
    }
    return base
  }

  /** Delete a file (or empty dir). */
  async delete(path: string): Promise<void> {
    this.assertWritable()
    const p = resolvePath(path)
    await this.deleteRecord(p)
  }
}
