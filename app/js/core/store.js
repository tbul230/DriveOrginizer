// Small promise wrapper over IndexedDB with an in-memory fallback.
// Stores: runs, ops (history), plans, snippets (content cache).

const DB_NAME = 'drive-organizer';
const DB_VERSION = 1;
const STORES = {
  runs: { keyPath: 'runId', indexes: [['createdAt', 'createdAt']] },
  ops: { keyPath: 'opId', indexes: [['runId', 'runId'], ['timestamp', 'timestamp']] },
  plans: { keyPath: 'id', indexes: [['createdAt', 'createdAt']] },
  snippets: { keyPath: 'id' },
};

class MemoryStore {
  constructor() { this.data = Object.fromEntries(Object.keys(STORES).map((s) => [s, new Map()])); this.persistent = false; }
  async get(store, key) { return structuredClone(this.data[store].get(key)); }
  async put(store, value) { this.data[store].set(value[STORES[store].keyPath], structuredClone(value)); return value; }
  async putMany(store, values) { for (const v of values) await this.put(store, v); }
  async delete(store, key) { this.data[store].delete(key); }
  async all(store) { return [...this.data[store].values()].map((v) => structuredClone(v)); }
  async byIndex(store, index, value) {
    return (await this.all(store)).filter((v) => v[index] === value);
  }
  async clear(store) { this.data[store].clear(); }
}

class IdbStore {
  constructor(db) { this.db = db; this.persistent = true; }
  _tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, mode);
      const os = tx.objectStore(store);
      let result;
      Promise.resolve(fn(os)).then((r) => { result = r; });
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
  }
  _req(req) { return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }); }
  get(store, key) { return this._tx(store, 'readonly', (os) => this._req(os.get(key))); }
  put(store, value) { return this._tx(store, 'readwrite', (os) => { os.put(value); return value; }); }
  putMany(store, values) { return this._tx(store, 'readwrite', (os) => { for (const v of values) os.put(v); }); }
  delete(store, key) { return this._tx(store, 'readwrite', (os) => { os.delete(key); }); }
  all(store) { return this._tx(store, 'readonly', (os) => this._req(os.getAll())); }
  byIndex(store, index, value) { return this._tx(store, 'readonly', (os) => this._req(os.index(index).getAll(value))); }
  clear(store) { return this._tx(store, 'readwrite', (os) => { os.clear(); }); }
}

function openIdb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, def] of Object.entries(STORES)) {
        if (db.objectStoreNames.contains(name)) continue;
        const os = db.createObjectStore(name, { keyPath: def.keyPath });
        for (const [iname, path] of def.indexes || []) os.createIndex(iname, path);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

export async function openStore({ forceMemory = false } = {}) {
  if (!forceMemory) {
    try { return new IdbStore(await openIdb()); } catch (e) { console.warn('Falling back to memory store:', e); }
  }
  return new MemoryStore();
}

export async function deleteDatabase() {
  if (typeof indexedDB === 'undefined') return;
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

export function uid(prefix = '') {
  const rnd = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return prefix + rnd;
}
