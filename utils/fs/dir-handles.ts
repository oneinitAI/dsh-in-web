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
 * FileSystemDirectoryHandle 持久化 —— IndexedDB 存真实文件夹句柄。
 *
 * showDirectoryPicker() 只能在扩展页面（side panel / iframe，window + 用户手势）调用，
 * Service Worker 拿不到 picker 结果，只能从 IndexedDB 恢复 handle。扩展同源
 * （chrome-extension://）下 SW 与页面共享同一个 IndexedDB，因此 SW 可以
 * 经 getDirectoryHandle(workspaceId) 恢复真实文件夹并读写真实文件。
 *
 * FileSystemDirectoryHandle 支持 structured clone，可直接作为 IndexedDB 值存储。
 */

const DB_NAME = 'dsh-handles'
const STORE = 'handles'
const DB_VERSION = 1

interface DirHandleRecord {
  workspaceId: string
  handle: FileSystemDirectoryHandle
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'workspaceId' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** 保存（覆盖）某 workspaceId 对应的真实文件夹句柄 */
export async function saveDirectoryHandle(
  workspaceId: string,
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite')
      const record: DirHandleRecord = { workspaceId, handle }
      const req = t.objectStore(STORE).put(record)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

/** 读回 workspaceId 对应的真实文件夹句柄（无则 undefined） */
export async function getDirectoryHandle(
  workspaceId: string,
): Promise<FileSystemDirectoryHandle | undefined> {
  const db = await openDb()
  try {
    const record = await new Promise<DirHandleRecord | undefined>((resolve, reject) => {
      const t = db.transaction(STORE, 'readonly')
      const req = t.objectStore(STORE).get(workspaceId) as IDBRequest<DirHandleRecord | undefined>
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    return record?.handle
  } finally {
    db.close()
  }
}

/** 删除 workspaceId 对应的句柄（工作区删除时清理） */
export async function deleteDirectoryHandle(workspaceId: string): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite')
      const req = t.objectStore(STORE).delete(workspaceId)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}
