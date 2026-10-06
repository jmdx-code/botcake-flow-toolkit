import { validatePendingFlowWire, type StoredPendingFlowWire } from "../../core/pending-flow-wire";

const STORE = "tasks";
const TTL_MS = 24 * 60 * 60 * 1000;
type Record = StoredPendingFlowWire & { tabId: number };

export async function savePrivatePendingFlow(value: unknown, tabId: number): Promise<string> {
  const task = validatePendingFlowWire(value);
  const record: Record = { ...task, id: crypto.randomUUID(), createdAt: Date.now(), tabId };
  await withStore("readwrite", store => store.put(record));
  return record.id;
}

export async function readPrivatePendingFlow(id: string, tabId: number): Promise<StoredPendingFlowWire | undefined> {
  const record = await withStore<Record | undefined>("readonly", store => store.get(id));
  if (!record || record.tabId !== tabId || Date.now() - record.createdAt > TTL_MS) return undefined;
  const { tabId: _owner, ...task } = record;
  return task;
}

export async function clearPrivatePendingFlow(id: string, tabId: number): Promise<void> {
  await withStore("readwrite", store => {
    const request = store.get(id);
    request.onsuccess = () => { if ((request.result as Record | undefined)?.tabId === tabId) store.delete(id); };
    return request;
  });
}

// Runs only in the extension service worker: no website database is migrated.
async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("botcake-private-pending-flow", 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开扩展任务存储"));
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result as T);
      transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error("流程任务存储失败"));
    });
  } finally { db.close(); }
}
