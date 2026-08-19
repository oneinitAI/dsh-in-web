/**
 * Virtual workspace aligned with dsh `ctx.fs` semantics
 * (fs/src/types.ts:60-160) — resolve / readText / writeText / editText
 * returning {before, after, version}, gated by SandboxMode three-state
 * policy (sandbox-policy/src/index.ts:67-120).
 *
 * Backed by IndexedDB (fake-indexeddb in tests).
 */

/**
 * TS 标准 lib.dom 的 FileSystemDirectoryHandle 未声明 entries()（File System
 * Access API 实验特性）。运行时存在，这里做最小形状补充，避免 any 污染。
 */
declare global {
  interface FileSystemDirectoryHandle {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>
  }
}

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

/** 真实文件夹工作区的路径标记前缀（showDirectoryPicker 选中的文件夹） */
export const REAL_DIR_PREFIX = 'file://'

/** 路径是否为真实文件夹工作区路径（file://<name>[/...]） */
export function isRealDirPath(path: string): boolean {
  return typeof path === 'string' && path.startsWith(REAL_DIR_PREFIX)
}

/** 由文件夹名构造真实工作区路径标记：my-project → file://my-project */
export function realDirPath(name: string): string {
  return `${REAL_DIR_PREFIX}${name}`
}

/** 取真实工作区路径的根名（file://my-project → my-project） */
export function realDirBaseName(path: string): string {
  return path.slice(REAL_DIR_PREFIX.length).replace(/\/.*$/, '').replace(/\/+$/, '')
}

/** 由 path 生成稳定 workspaceId：同 path 幂等（虚拟盘符与真实文件夹共用） */
export function workspaceIdFromPath(path: string): string {
  let hash = 0
  for (let i = 0; i < path.length; i += 1) hash = (hash * 31 + path.charCodeAt(i)) | 0
  return `ws-${(hash >>> 0).toString(36)}`
}

/** Windows 盘符前缀（C: / C:/ / C:/foo / C:\foo），用作虚拟 FS 的子根分区 */
const DRIVE_PREFIX_RE = /^([A-Za-z]:)(?:\/(.*))?$/

/** Path normalization + traversal guard. */
export function resolvePath(input: string): string {
  if (typeof input !== 'string' || input.trim() === '') throw new Error('path must be a non-empty string')
  const normalized = input.replace(/\\/g, '/')
  // 盘符路径保留盘符作为子根（C:/foo → C:/foo，C:/ → C:），
  // 让单库 IndexedDB 里以 C:/ 前缀分区，不混入根 '/' 下。
  const driveMatch = DRIVE_PREFIX_RE.exec(normalized)
  const drive = driveMatch ? driveMatch[1]! : ''
  const body = driveMatch ? driveMatch[2] ?? '' : normalized
  const parts = body.split('/').filter((p) => p !== '' && p !== '.')
  const out: string[] = []
  for (const part of parts) {
    if (part === '..') {
      if (out.length === 0) throw new Error('path escapes workspace root')
      out.pop()
    } else {
      out.push(part)
    }
  }
  if (drive) return out.length === 0 ? drive : `${drive}/${out.join('/')}`
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

  /** Create a directory (with ancestors). No-op when it already exists as a dir. */
  async mkdir(path: string): Promise<void> {
    this.assertWritable()
    const p = resolvePath(path)
    if (p === '/') return
    await this.ensureParentDirs(p)
    const existing = await this.getRecord<DirRecord | FileRecord>(p)
    if (existing?.kind === 'dir') return
    if (existing?.kind === 'file') throw new Error(`cannot mkdir: ${p} is a file`)
    await this.putRecord({ path: p, kind: 'dir' })
  }
}

/**
 * 真实文件夹工作区 —— 把 FileSystemDirectoryHandle 包成与虚拟 Workspace
 * 相同的表面（readText/writeText/editText/list/stat/delete/mkdir），
 * 让 SW 对真实工作区的文件操作直接读写磁盘真实文件。
 * 路径解析相对句柄根（/foo 即根下 foo），拒绝 '..' 穿越。
 */

/** 解析句柄内相对路径：/a/b → a/b，拒绝空路径与 '..' 逃逸 */
function realRelPath(input: string): string {
  if (typeof input !== 'string' || input.trim() === '') return ''
  const normalized = input.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  const out: string[] = []
  for (const part of normalized.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length === 0) throw new Error('path escapes workspace root')
      out.pop()
    } else {
      out.push(part)
    }
  }
  return out.join('/')
}

/** 沿 rel 逐级 getDirectoryHandle，返回目标目录句柄 */
async function walkDirs(
  root: FileSystemDirectoryHandle,
  rel: string,
  create = false,
): Promise<FileSystemDirectoryHandle> {
  let dir = root
  for (const seg of rel.split('/')) {
    if (!seg) continue
    dir = await dir.getDirectoryHandle(seg, create ? { create: true } : undefined)
  }
  return dir
}

export class RealDirectoryWorkspace {
  private readonly root: FileSystemDirectoryHandle

  constructor(root: FileSystemDirectoryHandle) {
    this.root = root
  }

  async init(): Promise<void> {
    // 无初始化动作：根句柄即目录根
  }

  /** List direct children of a dir（path '' 或 '/' 为句柄根）。 */
  async list(path: string): Promise<FsEntry[]> {
    const rel = realRelPath(path)
    const dir = rel ? await walkDirs(this.root, rel) : this.root
    const entries: FsEntry[] = []
    for await (const [name, handle] of dir.entries()) {
      const entryPath = `${rel ? '/' + rel + '/' : '/'}${name}`
      if (handle.kind === 'file') {
        const file = await (handle as FileSystemFileHandle).getFile()
        entries.push({ path: entryPath, kind: 'file', size: file.size, version: 1 })
      } else {
        entries.push({ path: entryPath, kind: 'dir' })
      }
    }
    return entries
  }

  /** Resolve + read real file text. Returns undefined when missing. */
  async readText(path: string): Promise<string | undefined> {
    const rel = realRelPath(path)
    const segs = rel.split('/').filter(Boolean)
    const fileName = segs.pop()
    if (!fileName) return undefined
    const dir = segs.length ? await walkDirs(this.root, segs.join('/')) : this.root
    try {
      const fileHandle = await dir.getFileHandle(fileName)
      const file = await fileHandle.getFile()
      return await file.text()
    } catch {
      return undefined
    }
  }

  /** Write (create or overwrite) a real file. Auto-creates parent dirs. */
  async writeText(path: string, content: string): Promise<WriteResult> {
    const rel = realRelPath(path)
    const segs = rel.split('/').filter(Boolean)
    const fileName = segs.pop()
    if (!fileName) throw new Error('invalid path')
    const dir = segs.length ? await walkDirs(this.root, segs.join('/'), true) : this.root
    const fileHandle = await dir.getFileHandle(fileName, { create: true })
    const writable = await fileHandle.createWritable()
    try {
      await writable.write(content)
    } finally {
      await writable.close()
    }
    return { version: 1 }
  }

  /** Edit via oldString/newString on a real file. */
  async editText(path: string, spec: EditSpec): Promise<EditResult> {
    const before = await this.readText(path)
    if (before === undefined) throw new Error(`file not found: ${path}`)
    if (!spec.oldString) throw new Error('oldString must be non-empty')
    const after = spec.replaceAll
      ? before.split(spec.oldString).join(spec.newString)
      : before.replace(spec.oldString, spec.newString)
    if (after === before) throw new Error('oldString not found in file content')
    await this.writeText(path, after)
    return { before, after, version: 1 }
  }

  /** Stat a single real path. Returns undefined when missing. */
  async stat(path: string): Promise<FsEntry | undefined> {
    const rel = realRelPath(path)
    const segs = rel.split('/').filter(Boolean)
    const name = segs.pop()
    if (!name) return undefined
    const dir = segs.length ? await walkDirs(this.root, segs.join('/')) : this.root
    try {
      const fileHandle = await dir.getFileHandle(name)
      const file = await fileHandle.getFile()
      return { path, kind: 'file', size: file.size, version: 1 }
    } catch {
      // 不是文件，继续查目录
    }
    try {
      await dir.getDirectoryHandle(name)
      return { path, kind: 'dir' }
    } catch {
      return undefined
    }
  }

  /** Delete a real file or directory. */
  async delete(path: string): Promise<void> {
    const rel = realRelPath(path)
    const segs = rel.split('/').filter(Boolean)
    const name = segs.pop()
    if (!name) throw new Error('invalid path')
    const dir = segs.length ? await walkDirs(this.root, segs.join('/')) : this.root
    await dir.removeEntry(name, { recursive: true })
  }

  /** Create a directory on the real fs (with ancestors). */
  async mkdir(path: string): Promise<void> {
    const rel = realRelPath(path)
    if (!rel) return
    await walkDirs(this.root, rel, true)
  }
}
