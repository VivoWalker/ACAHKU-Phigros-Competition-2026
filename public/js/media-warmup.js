(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BroadcastMediaWarmup = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';

  // Decoded Image objects are retained for the next scene, rather than warming
  // the entire song library. Browser/GPU residency remains browser controlled.
  function imagePath(value, origin = typeof location === 'object' ? location.origin : 'http://localhost') {
    if (typeof value !== 'string' || value.length > 600 || /[\r\n\\]/.test(value)) return '';
    try {
      const url = new URL(value, origin + '/');
      const decoded = decodeURIComponent(url.pathname);
      if (url.origin !== origin || !decoded.startsWith('/assets/') || decoded.includes('..') || /[\\\r\n]/.test(decoded) || !/\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(decoded)) return '';
      return url.pathname + url.search;
    } catch (_) { return ''; }
  }

  function createController(options = {}) {
    const maxDecoded = Math.max(2, Math.min(24, options.maxDecoded ?? 12));
    const concurrency = Math.max(1, Math.min(2, options.concurrency ?? 2));
    const timeoutMs = Math.max(100, options.timeoutMs ?? 4500);
    const fontTimeoutMs = Math.max(100, options.fontTimeoutMs ?? Math.min(timeoutMs, 2200));
    const createImage = options.createImage || (() => new Image());
    const setTimer = options.setTimer || setTimeout, clearTimer = options.clearTimer || clearTimeout;
    const requestIdle = options.requestIdle || (typeof requestIdleCallback === 'function'
      ? callback => requestIdleCallback(callback, { timeout: 250 }) : callback => setTimer(callback, 32));
    const cancelIdle = options.cancelIdle || (typeof cancelIdleCallback === 'function' ? cancelIdleCallback : clearTimer);
    const fonts = options.fonts ?? (typeof document === 'object' ? document.fonts : null);
    const origin = options.origin || (typeof location === 'object' ? location.origin : 'http://localhost');
    const entries = new Map();
    let wanted = new Set(), pinned = new Set(), serial = 0, stamp = 0, idle = null;
    let loading = 0, disposed = false, lastStatus = '', fontState = 'idle', fontPromise = null, finishFonts = null;

    function status() {
      const list = [...entries.values()];
      const target = [...wanted].map(src => entries.get(src));
      return {
        ready: list.filter(entry => entry.state === 'ready').length,
        loading,
        pending: list.filter(entry => entry.state === 'queued').length,
        failed: target.filter(entry => entry?.state === 'failed').length,
        total: wanted.size,
        targetReady: target.filter(entry => entry?.state === 'ready').length,
        targetPending: target.filter(entry => !entry || ['queued', 'loading'].includes(entry.state)).length,
        fonts: fontState
      };
    }
    function report() {
      const next = status(), signature = JSON.stringify(next);
      if (signature === lastStatus) return;
      lastStatus = signature;
      try { options.onStatus?.(next); } catch (_) { /* Diagnostics must not delay a scene. */ }
    }
    function touch(entry) { entry.used = ++stamp; }
    function result(entry, ok) { return { src: entry.src, image: ok ? entry.image : null, ok }; }
    function discard(entry) {
      entries.delete(entry.src);
      entry.image = null;
    }
    function makeRoom() {
      // Loading images count towards the same budget as decoded images. Pinning
      // influences eviction order, but cannot expand the fixed memory budget.
      const held = [...entries.values()].filter(entry => entry.image);
      if (held.length < maxDecoded) return true;
      const candidate = held.filter(entry => entry.state === 'ready')
        .sort((a, b) => Number(pinned.has(a.src)) - Number(pinned.has(b.src)) || Number(wanted.has(a.src)) - Number(wanted.has(b.src)) || a.used - b.used)[0];
      if (!candidate) return false;
      // An urgent extra cover may displace a background target. Do not report
      // an unqueued, evicted target as perpetually loading in staff diagnostics.
      wanted.delete(candidate.src); pinned.delete(candidate.src);
      discard(candidate);
      return true;
    }
    function pruneFailures() {
      const failures = [...entries.values()].filter(entry => entry.state === 'failed' && !wanted.has(entry.src));
      for (const entry of failures.slice(0, Math.max(0, failures.length - maxDecoded))) discard(entry);
    }
    function schedule() {
      if (disposed || idle !== null || ![...entries.values()].some(entry => entry.state === 'queued')) return;
      idle = requestIdle(() => { idle = null; pump(); });
    }
    function start(entry) {
      entry.state = 'loading'; loading++;
      let image, timer = null, complete = false;
      const finish = ok => {
        if (complete) return;
        complete = true;
        if (timer !== null) clearTimer(timer);
        if (image) { image.onload = null; image.onerror = null; }
        // Removing src alone leaves cancelled SVG documents retained by
        // Chromium. Assigning an empty source explicitly releases that load.
        if (!ok && image) image.src = '';
        // A late decode callback must also release the request's local image.
        image = null;
        loading--;
        entry.state = ok && !disposed ? 'ready' : 'failed';
        if (entry.state !== 'ready') entry.image = null;
        touch(entry);
        entry.resolve(result(entry, entry.state === 'ready'));
        entry.cancel = null;
        pruneFailures(); report(); schedule();
      };
      entry.cancel = () => finish(false);
      try {
        image = createImage(); entry.image = image;
        image.decoding = 'async';
        image.fetchPriority = entry.priority > 0 ? 'high' : 'low';
        image.onload = () => { if (typeof image.decode !== 'function') finish(true); };
        image.onerror = () => finish(false);
        timer = setTimer(() => finish(false), timeoutMs);
        image.src = entry.src;
        if (typeof image?.decode === 'function') Promise.resolve(image.decode()).then(() => finish(true), () => finish(false));
      } catch (_) { finish(false); }
    }
    function pump() {
      if (disposed) return;
      while (loading < concurrency) {
        const entry = [...entries.values()].filter(item => item.state === 'queued')
          .sort((a, b) => b.priority - a.priority || a.order - b.order)[0];
        if (!entry || !makeRoom()) break;
        start(entry);
      }
      report();
    }
    function enqueue(src, priority, explicit) {
      let entry = entries.get(src);
      if (entry) {
        entry.priority = Math.max(entry.priority, priority);
        entry.explicit ||= explicit; touch(entry);
        return entry;
      }
      // A burst of cover changes can outrun two stalled image decoders. Bound
      // their waiting records as well as the decoded bitmap cache, settling
      // displaced requests so an obsolete cover cannot hold its scene open.
      const queued = [...entries.values()].filter(item => item.state === 'queued');
      if (queued.length >= maxDecoded) {
        const oldest = queued.sort((a, b) => a.priority - b.priority || a.order - b.order)[0];
        oldest.state = 'cancelled'; oldest.resolve(result(oldest, false));
        wanted.delete(oldest.src); pinned.delete(oldest.src); discard(oldest);
      }
      entry = { src, priority, explicit, order: ++serial, used: ++stamp, image: null, state: 'queued' };
      entry.promise = new Promise(resolve => { entry.resolve = resolve; });
      entries.set(src, entry);
      return entry;
    }
    function normalize(paths) { return [...new Set((Array.isArray(paths) ? paths : []).map(path => imagePath(path, origin)).filter(Boolean))]; }

    function setImages(paths, settings = {}) {
      if (disposed) return status();
      const priority = normalize(settings.priority);
      const pins = normalize(settings.pinned);
      const requested = normalize(paths);
      const next = [...new Set([...priority, ...pins, ...requested])].slice(0, maxDecoded);
      wanted = new Set(next); pinned = new Set(pins.filter(src => wanted.has(src)));
      for (const entry of entries.values()) {
        if (entry.state === 'queued' && !wanted.has(entry.src) && !entry.explicit) {
          entry.state = 'cancelled'; entry.resolve(result(entry, false)); discard(entry);
        }
      }
      for (const src of next) enqueue(src, priority.includes(src) ? 10 : pinned.has(src) ? 5 : 0, false);
      pruneFailures(); report(); schedule();
      return status();
    }
    function decodeImage(path) {
      const src = imagePath(path, origin);
      if (disposed || !src) return Promise.resolve({ src, image: null, ok: false });
      const entry = enqueue(src, 100, true);
      // A scene already being committed should not wait for another idle period.
      pump();
      return entry.promise;
    }
    function prepare(paths) {
      if (disposed) return Promise.resolve([]);
      const requested = normalize(paths).slice(0, maxDecoded).map(src => enqueue(src, 50, false));
      pump();
      return Promise.all(requested.map(entry => entry.promise));
    }
    function getDecoded(path) {
      const entry = entries.get(imagePath(path, origin));
      if (!entry || entry.state !== 'ready') return null;
      touch(entry); return entry.image;
    }
    function prepareFonts() {
      if (fontPromise) return fontPromise;
      if (disposed || !fonts || typeof fonts.load !== 'function') return Promise.resolve(false);
      fontState = 'loading'; report();
      fontPromise = new Promise(resolve => {
        let finished = false;
        const timer = setTimer(() => finish(false), fontTimeoutMs);
        function finish(ok) {
          if (finished) return;
          finished = true; clearTimer(timer); finishFonts = null;
          fontState = ok && !disposed ? 'ready' : 'failed'; report(); resolve(ok && !disposed);
        }
        finishFonts = finish;
        Promise.allSettled([400, 500, 600, 700].map(weight => Promise.resolve().then(() => fonts.load(`${weight} 32px Saira`, 'ACAHKU PHIGROS 0123456789 香港大學動漫聯盟 預選賽 雙淘汰賽'))))
          .then(async results => {
            try {
              await fonts.ready;
              finish(results.every(item => item.status === 'fulfilled'));
            } catch (_) { finish(false); }
          });
      });
      return fontPromise;
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      if (idle !== null) { cancelIdle(idle); idle = null; }
      finishFonts?.(false);
      for (const entry of entries.values()) {
        if (entry.cancel) entry.cancel();
        else if (entry.state === 'queued') entry.resolve(result(entry, false));
      }
      entries.clear(); wanted.clear(); pinned.clear(); report();
    }
    return { setImages, decodeImage, prepare, getDecoded, prepareFonts, status, dispose };
  }
  return { createController, imagePath };
});
