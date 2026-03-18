const DB_NAME = 'vmrunner';
const DB_VERSION = 1;

interface StoreSchema {
  snapshots: { key: string; vmId: string; data: Blob; createdAt: number };
  sessions: { key: string; files: Record<string, string>; vmConfig: any; timestamp: number };
  cache: { key: string; data: string; expiresAt: number };
  preferences: { key: string; value: any };
}

let db: IDBDatabase | null = null;

async function getDB(): Promise<IDBDatabase> {
  if (db) return db;

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('snapshots')) {
        database.createObjectStore('snapshots', { keyPath: 'key' });
      }
      if (!database.objectStoreNames.contains('sessions')) {
        database.createObjectStore('sessions', { keyPath: 'key' });
      }
      if (!database.objectStoreNames.contains('cache')) {
        database.createObjectStore('cache', { keyPath: 'key' });
      }
      if (!database.objectStoreNames.contains('preferences')) {
        database.createObjectStore('preferences', { keyPath: 'key' });
      }
    };

    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };

    request.onerror = () => reject(request.error);
  });
}

async function put<K extends keyof StoreSchema>(
  store: K,
  data: StoreSchema[K]
): Promise<void> {
  const database = await getDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(store, 'readwrite');
    tx.objectStore(store).put(data);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function get<K extends keyof StoreSchema>(
  store: K,
  key: string
): Promise<StoreSchema[K] | undefined> {
  const database = await getDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(store, 'readonly');
    const request = tx.objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function del(store: keyof StoreSchema, key: string): Promise<void> {
  const database = await getDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAll<K extends keyof StoreSchema>(
  store: K
): Promise<StoreSchema[K][]> {
  const database = await getDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(store, 'readonly');
    const request = tx.objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const storage = {
  async saveSnapshot(vmId: string, state: ArrayBuffer) {
    const blob = new Blob([state]);
    await put('snapshots', {
      key: vmId,
      vmId,
      data: blob,
      createdAt: Date.now(),
    });
  },

  async loadSnapshot(vmId: string): Promise<ArrayBuffer | null> {
    const entry = await get('snapshots', vmId);
    if (!entry) return null;
    return entry.data.arrayBuffer();
  },

  async deleteSnapshot(vmId: string) {
    await del('snapshots', vmId);
  },

  async saveSession(
    vmId: string,
    files: Record<string, string>,
    vmConfig: any
  ) {
    await put('sessions', {
      key: vmId,
      files,
      vmConfig,
      timestamp: Date.now(),
    });
  },

  async loadSession(vmId: string) {
    return get('sessions', vmId);
  },

  async deleteSession(vmId: string) {
    await del('sessions', vmId);
  },

  async listSessions() {
    return getAll('sessions');
  },

  async cacheSet(key: string, data: string, ttlMs: number = 5 * 60 * 1000) {
    await put('cache', {
      key,
      data,
      expiresAt: Date.now() + ttlMs,
    });
  },

  async cacheGet(key: string): Promise<string | null> {
    const entry = await get('cache', key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      await del('cache', key);
      return null;
    }
    return entry.data;
  },

  async setPref(key: string, value: any) {
    await put('preferences', { key, value });
  },

  async getPref(key: string): Promise<any> {
    const entry = await get('preferences', key);
    return entry?.value;
  },

  async getStorageUsage(): Promise<{ used: number; quota: number }> {
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      const estimate = await navigator.storage.estimate();
      return {
        used: estimate.usage || 0,
        quota: estimate.quota || 0,
      };
    }
    return { used: 0, quota: 0 };
  },

  async cleanupCache() {
    const entries = await getAll('cache');
    const now = Date.now();
    for (const entry of entries) {
      if (now > entry.expiresAt) {
        await del('cache', entry.key);
      }
    }
  },

  async clearAll() {
    try {
      const database = await getDB();
      for (const name of Array.from(database.objectStoreNames)) {
        const tx = database.transaction(name, 'readwrite');
        tx.objectStore(name).clear();
      }
    } catch {  }
  },

  async clearEphemeral() {
    try {
      const database = await getDB();
      for (const name of ['sessions', 'cache']) {
        if (database.objectStoreNames.contains(name)) {
          const tx = database.transaction(name, 'readwrite');
          tx.objectStore(name).clear();
        }
      }
    } catch {  }
  },
};


