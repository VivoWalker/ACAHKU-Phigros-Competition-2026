(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BroadcastSceneBgm = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const FADE_MS = 650, TICK_MS = 25;
  const clamp = value => Math.max(0, Math.min(1, value));
  const ease = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
  const safePath = path => typeof path === 'string' && path.length <= 180 &&
    /^\/?assets\/bgm\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(ogg|mp3|m4a|wav)$/i.test(path) && !path.includes('..');

  function createPlayer(options = {}) {
    const now = options.now || Date.now;
    const setTimer = options.setTimer || setTimeout, clearTimer = options.clearTimer || clearTimeout;
    const createAudio = options.createAudio || (() => new Audio());
    const enabled = options.enabled !== false;
    const gain = Number.isFinite(options.gain) ? clamp(options.gain) : .3;
    const fadeMs = Number.isFinite(options.fadeMs) ? Math.max(0, Math.min(5000, options.fadeMs)) : FADE_MS;
    let onStatus = options.onStatus;
    let desired = null, active = false, current = null, retiring = null, timer = null;
    let disposed = false, failure = null, lastStatus = '';

    function report(state) {
      const trackId = desired?.id || null, statusKey = JSON.stringify([state, trackId]);
      if (lastStatus === statusKey) return;
      lastStatus = statusKey;
      onStatus?.({ state, trackId });
    }
    function stop(item) {
      if (!item?.audio) return;
      // A play() promise can settle after its source has been unloaded. Silence
      // it again, even when the DOM/listener cleanup already ran.
      item.audio.pause(); item.audio.volume = 0;
      if (item.released) return;
      item.released = true;
      for (const [name, listener] of Object.entries(item.listeners)) item.audio.removeEventListener(name, listener);
      item.listeners = {};
      item.audio.removeAttribute('src'); item.audio.load(); item.audio.remove?.();
    }
    function clearMedia() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      stop(current); stop(retiring);
      current = retiring = null;
    }
    function role(item, isRetiring) {
      if (!item.audio.dataset) return;
      delete item.audio.dataset.sceneBgm;
      delete item.audio.dataset.sceneBgmRetiring;
      item.audio.dataset[isRetiring ? 'sceneBgmRetiring' : 'sceneBgm'] = '';
      item.audio.dataset.trackId = item.track.id;
    }
    function fade(item, to, duration = fadeMs) {
      item.fade = { from: item.audio.volume, to, startsAt: now(), endsAt: now() + duration };
    }
    function retire() {
      if (!current) return;
      stop(retiring); retiring = null;
      const previous = current; current = null;
      if (!previous.playing || previous.audio.volume === 0 || !fadeMs) { stop(previous); return; }
      retiring = previous; role(retiring, true); fade(retiring, 0);
    }
    function tick() {
      if (disposed) return;
      const time = now();
      let animating = false;
      for (const item of [current, retiring]) {
        if (!item?.playing || !item.fade) continue;
        const { from, to, startsAt, endsAt } = item.fade;
        const progress = endsAt > startsAt ? (time - startsAt) / (endsAt - startsAt) : 1;
        item.audio.volume = clamp(from + (to - from) * ease(progress));
        if (progress < 1) animating = true;
        else {
          item.fade = null;
          if (item === retiring) { stop(retiring); retiring = null; }
        }
      }
      // Stable looping audio needs no polling timer; media.loop owns the loop.
      if (animating && timer === null) timer = setTimer(() => { timer = null; tick(); }, TICK_MS);
      else if (!animating && timer !== null) { clearTimer(timer); timer = null; }
    }
    function failed(item, error) {
      if (disposed || current !== item || item.released) { stop(item); return; }
      failure = error?.name === 'NotAllowedError' ? 'blocked' : 'error';
      stop(item); current = null;
      report(failure); tick();
    }
    function open(track, immediate = false) {
      retire();
      const item = current = { track, audio: null, listeners: {}, playing: false, released: false, fade: null };
      try {
        item.audio = createAudio();
        item.audio.preload = 'auto'; item.audio.loop = true; item.audio.volume = 0;
        item.listeners.error = () => failed(item, new Error('Scene background music could not be loaded'));
        item.audio.addEventListener('error', item.listeners.error);
        if (typeof document !== 'undefined' && item.audio.nodeType === 1) {
          item.audio.hidden = true; role(item, false); document.body?.append(item.audio);
        }
        item.audio.src = '/' + track.path;
        report('loading');
        const playback = item.audio.play();
        Promise.resolve(playback).then(() => {
          if (disposed || current !== item || item.released) { stop(item); return; }
          item.playing = true;
          fade(item, item.track.gain, immediate ? 0 : fadeMs);
          report('playing'); tick();
        }).catch(error => failed(item, error));
      } catch (error) { failed(item, error); }
      tick();
    }
    function update({ track = null, active: nextActive = false, immediate = false } = {}) {
      if (disposed) return;
      const valid = track && typeof track.id === 'string' && track.id.length > 0 && track.id.length <= 128 && safePath(track.path);
      const next = valid ? { id: track.id, path: track.path.replace(/^\//, ''),
        gain: gain * (Number.isFinite(track.gain) ? clamp(track.gain) : 1) } : null;
      const changed = desired?.id !== next?.id || desired?.path !== next?.path;
      if (changed || !active && nextActive) failure = null;
      desired = next; active = nextActive === true;
      if (!active || !enabled) { clearMedia(); report(enabled ? 'silent' : 'muted'); return; }
      if (immediate) clearMedia();
      if (!desired) {
        retire(); tick(); report(track ? 'missing' : 'silent'); return;
      }
      if (current && current.track.id === desired.id && current.track.path === desired.path) {
        if (current.track.gain !== desired.gain) {
          current.track = desired;
          if (current.playing) { fade(current, desired.gain); tick(); }
        }
        return;
      }
      if (failure) { report(failure); return; }
      open(desired, immediate);
    }
    function retry() {
      if (disposed || !enabled || !active || !desired || !failure) return;
      failure = null; open(desired);
    }
    function dispose() {
      if (disposed) return;
      disposed = true; active = false; desired = null; failure = null;
      clearMedia(); onStatus = null;
    }
    return { update, retry, dispose, get hasMedia() { return !!(current?.audio && !current.released || retiring?.audio && !retiring.released); } };
  }
  return { createPlayer, safePath, FADE_MS };
});
