(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BroadcastDraftStorage = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const TTL_MS = 7 * 24 * 60 * 60 * 1000, MAX_RECORDS = 512, MAX_BYTES = 256 * 1024;
  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const validIdentity = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
  const bytes = value => typeof TextEncoder === 'function' ? new TextEncoder().encode(value).length : value.length * 3;

  // Drafts are data only. Reject functions, cycles and non-JSON values instead
  // of silently dropping them and restoring an incomplete scoring sheet.
  function plain(value, seen = new Set(), depth = 0) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object' || depth > 12 || seen.has(value)) return false;
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    seen.add(value);
    const valid = Object.values(value).every(item => plain(item, seen, depth + 1));
    seen.delete(value);
    return valid;
  }
  const validRecords = records => Array.isArray(records) && records.length <= MAX_RECORDS
    && records.every(record => isRecord(record) && plain(record));

  function createStore(options = {}) {
    const role = options.role;
    let origin = options.origin, storage;
    try {
      origin ??= typeof location === 'object' ? location.origin : '';
      storage = Object.hasOwn(options, 'storage') ? options.storage : typeof sessionStorage === 'object' ? sessionStorage : null;
    } catch (_) { storage = null; }
    const enabled = ['control', 'scorekeeper'].includes(role) && typeof origin === 'string' && origin.length > 0 && origin.length <= 2048;
    const key = enabled ? `broadcast-drafts:v1:${role}:${encodeURIComponent(origin)}` : '';
    const now = options.now || Date.now;
    const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : TTL_MS;
    function remove() {
      try { if (enabled && storage) { storage.removeItem(key); return true; } } catch (_) { /* Storage can be denied or full. */ }
      return false;
    }
    function read(identity) {
      if (!enabled || !storage || !validIdentity(identity)) return null;
      try {
        const raw = storage.getItem(key);
        if (raw === null) return null;
        if (raw.length > MAX_BYTES || bytes(raw) > MAX_BYTES) throw new Error('Draft too large');
        const saved = JSON.parse(raw), time = now();
        if (!isRecord(saved) || saved.version !== 1 || saved.role !== role || saved.origin !== origin || saved.identity !== identity
          || !Number.isFinite(saved.updatedAt) || !Number.isFinite(time) || saved.updatedAt < 0 || saved.updatedAt > time + 60000
          || time - saved.updatedAt >= ttlMs || !validRecords(saved.records)) throw new Error('Draft unavailable');
        return saved;
      } catch (_) { remove(); return null; }
    }
    return {
      load(identity) { return read(identity)?.records || []; },
      save(identity, records) {
        if (!enabled || !storage || !validIdentity(identity)) return false;
        try {
          if (!validRecords(records)) throw new Error('Invalid draft');
          if (!records.length) return remove();
          const updatedAt = now();
          if (!Number.isFinite(updatedAt) || updatedAt < 0) throw new Error('Invalid clock');
          const raw = JSON.stringify({ version: 1, role, origin, identity, updatedAt, records });
          if (bytes(raw) > MAX_BYTES) throw new Error('Draft too large');
          storage.setItem(key, raw); return true;
        } catch (_) {
          // A failed replacement must not revive an older, already-saved draft
          // on reload. The caller still owns its current in-memory edits.
          remove(); return false;
        }
      },
      clear(identity) {
        if (!enabled || !storage || !validIdentity(identity)) return false;
        try {
          const raw = storage.getItem(key);
          if (raw === null) return true;
          const saved = JSON.parse(raw);
          if (!isRecord(saved) || saved.identity !== identity || saved.role !== role || saved.origin !== origin) return false;
          return remove();
        } catch (_) { return remove(); }
      }
    };
  }
  return { createStore, TTL_MS, MAX_RECORDS, MAX_BYTES };
});
