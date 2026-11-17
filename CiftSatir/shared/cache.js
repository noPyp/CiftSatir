(function (global) {
  'use strict';

  const DS = (global.DualSub = global.DualSub || {});
  const { MEMORY_CACHE_LIMIT, INDEXED_DB_NAME, INDEXED_DB_VERSION } = DS.constants;

  const STORES = {
    words: 'words',
    sentences: 'sentences',
    starred: 'starred'
  };

  // IndexedDB is the source of truth: MV3 terminates the service worker at any
  // time, so anything held only in memory would silently vanish mid-session.
  // The LRU sits in front purely to keep repeat lookups off the disk path.
  class LruCache {
    constructor(limit) {
      this.limit = limit || MEMORY_CACHE_LIMIT;
      this.map = new Map();
    }

    get(key) {
      if (!this.map.has(key)) {
        return undefined;
      }

      const value = this.map.get(key);
      // Re-insert to mark as most-recently used.
      this.map.delete(key);
      this.map.set(key, value);
      return value;
    }

    set(key, value) {
      if (this.map.has(key)) {
        this.map.delete(key);
      }

      this.map.set(key, value);

      while (this.map.size > this.limit) {
        const oldest = this.map.keys().next().value;
        this.map.delete(oldest);
      }
    }

    delete(key) {
      this.map.delete(key);
    }

    clear() {
      this.map.clear();
    }
  }

  let dbPromise = null;

  function openDb() {
    if (dbPromise) {
      return dbPromise;
    }

    dbPromise = new Promise((resolve, reject) => {
      let request;
      try {
        request = indexedDB.open(INDEXED_DB_NAME, INDEXED_DB_VERSION);
      } catch (error) {
        reject(error);
        return;
      }

      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of Object.values(STORES)) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: 'key' });
          }
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB açılamadı.'));
    });

    return dbPromise;
  }

  function withStore(storeName, mode, fn) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      let transaction;
      try {
        transaction = db.transaction(storeName, mode);
      } catch (error) {
        reject(error);
        return;
      }

      const store = transaction.objectStore(storeName);
      let result;

      try {
        result = fn(store);
      } catch (error) {
        reject(error);
        return;
      }

      transaction.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB hatası.'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB işlemi iptal edildi.'));
    }));
  }

  function normalizeKey(word) {
    return String(word || '').trim().toLowerCase();
  }

  const lru = new LruCache(MEMORY_CACHE_LIMIT);

  async function get(storeName, word) {
    const key = normalizeKey(word);
    if (!key) {
      return null;
    }

    const cacheKey = storeName + ':' + key;
    const cached = lru.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const row = await withStore(storeName, 'readonly', (store) => store.get(key));
      const value = row ? row.value : null;
      lru.set(cacheKey, value);
      return value;
    } catch (error) {
      return null;
    }
  }

  async function put(storeName, word, value, extra) {
    const key = normalizeKey(word);
    if (!key) {
      return false;
    }

    lru.set(storeName + ':' + key, value);

    try {
      await withStore(storeName, 'readwrite', (store) => store.put(Object.assign({
        key: key,
        value: value,
        updatedAt: Date.now()
      }, extra || {})));
      return true;
    } catch (error) {
      // A failed persist still leaves the LRU warm for this session.
      return false;
    }
  }

  async function remove(storeName, word) {
    const key = normalizeKey(word);
    lru.delete(storeName + ':' + key);

    try {
      await withStore(storeName, 'readwrite', (store) => store.delete(key));
      return true;
    } catch (error) {
      return false;
    }
  }

  async function all(storeName) {
    try {
      const rows = await withStore(storeName, 'readonly', (store) => store.getAll());
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      return [];
    }
  }

  async function count(storeName) {
    try {
      const total = await withStore(storeName, 'readonly', (store) => store.count());
      return Number(total) || 0;
    } catch (error) {
      return 0;
    }
  }

  // Eviction keeps the store bounded. Starred words are never candidates
  // because the user explicitly asked for them to be kept.
  async function evictIfNeeded(storeName, limit) {
    const total = await count(storeName);
    if (total <= limit) {
      return 0;
    }

    const rows = await all(storeName);
    rows.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));

    const toDelete = Math.max(0, Math.ceil(total * 0.1));
    let deleted = 0;

    for (const row of rows.slice(0, toDelete)) {
      const ok = await remove(storeName, row.key);
      if (ok) {
        deleted += 1;
      }
    }

    return deleted;
  }

  DS.cache = {
    STORES: STORES,
    LruCache: LruCache,
    normalizeKey: normalizeKey,
    get: get,
    put: put,
    remove: remove,
    all: all,
    count: count,
    evictIfNeeded: evictIfNeeded,
    clearMemory: () => lru.clear()
  };
})(typeof self !== 'undefined' ? self : this);
