(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BroadcastDisplayMedia = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';

  const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
  function imagePath(value, allowLeadingSlash = false) {
    if (typeof value !== 'string' || value.length > 500 || /[\\%?#\x00-\x1f\x7f-\x9f]/.test(value)) return '';
    const path = allowLeadingSlash && value.startsWith('/') ? value.slice(1) : value;
    if (!/^assets\/.+\.(?:png|jpe?g|webp|avif)$/i.test(path)) return '';
    if (path.split('/').some(part => !part || part === '.' || part === '..')) return '';
    return path;
  }
  function readManifest(value) {
    if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.images) || !isRecord(value.backgrounds)) return null;
    const result = { images: new Map(), backgrounds: new Map() };
    for (const group of ['images', 'backgrounds']) {
      for (const [original, entry] of Object.entries(value[group]).slice(0, 1000)) {
        const source = imagePath(original);
        const destination = isRecord(entry) && imagePath(entry.path);
        if (!source || !destination || !destination.startsWith('assets/display/')) continue;
        if (['width', 'height'].some(key => entry[key] !== undefined && (!Number.isInteger(entry[key]) || entry[key] <= 0 || entry[key] > 16384))) continue;
        result[group].set(source, destination);
      }
    }
    return result;
  }

  // The endpoint verifies originals and derivatives on the server. Using its
  // response alone prevents a replaced original from keeping an old WebP map.
  function createClient(options = {}) {
    const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? (...args) => fetch(...args) : null);
    const setTimer = options.setTimer || setTimeout, clearTimer = options.clearTimer || clearTimeout;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(10000, options.timeoutMs)) : 1800;
    const Controller = Object.prototype.hasOwnProperty.call(options, 'AbortControllerImpl')
      ? options.AbortControllerImpl : typeof AbortController === 'function' ? AbortController : null;
    let status = 'loading', maps = { images: new Map(), backgrounds: new Map() };
    let controller = null, timer = null, settled = false, settleReady;
    const ready = new Promise(resolve => { settleReady = resolve; });

    function finish(next, manifest) {
      if (settled) return;
      settled = true;
      if (timer !== null) { clearTimer(timer); timer = null; }
      if (manifest) maps = manifest;
      status = next;
      settleReady(status);
    }
    function abort() {
      try { controller?.abort(); } catch (_) { /* Fallback does not depend on abort support. */ }
    }

    try {
      if (typeof fetchImpl !== 'function') throw new Error('Fetch unavailable.');
      controller = Controller ? new Controller() : null;
      timer = setTimer(() => { finish('fallback'); abort(); }, timeoutMs);
      Promise.resolve(fetchImpl('/api/display-assets', {
        cache: 'no-store', credentials: 'same-origin', ...(controller ? { signal: controller.signal } : {})
      })).then(response => {
        if (settled) return null;
        if (!response?.ok || typeof response.json !== 'function') throw new Error('Display manifest unavailable.');
        return response.json();
      }).then(value => {
        if (settled) return;
        const manifest = readManifest(value);
        finish(manifest ? 'ready' : 'fallback', manifest);
      }, () => finish('fallback'));
    } catch (_) { finish('fallback'); abort(); }

    return {
      ready,
      get status() { return status; },
      resolve(original) { return maps.images.get(imagePath(original, true)) || original; },
      background(original) { return maps.backgrounds.get(imagePath(original, true)) || null; },
      dispose() {
        if (status === 'disposed') return;
        finish('disposed');
        status = 'disposed'; maps = { images: new Map(), backgrounds: new Map() };
        abort();
      }
    };
  }

  return { createClient };
});
