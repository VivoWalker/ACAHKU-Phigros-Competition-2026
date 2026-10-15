(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BroadcastSelectionAudio = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const FADE_MS = 500, DEFAULT_DURATION = 12, TICK_MS = 25;
  const clamp = value => Math.max(0, Math.min(1, value));
  const ease = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
  const duration = song => Number.isFinite(song?.previewDuration) && song.previewDuration > 0 && song.previewDuration <= 600 ? song.previewDuration : DEFAULT_DURATION;
  const safePath = path => typeof path === 'string' && path.length <= 180 && /^assets\/song-preview\/[A-Za-z0-9_./-]+\.(mp3|ogg|wav|m4a)$/i.test(path) && !/[\r\n]/.test(path) && !path.includes('..');
  const validCue = cue => cue && typeof cue.id === 'string' && cue.id.length > 0 && ['ban', 'picks'].includes(cue.kind) && Number.isFinite(cue.startedAt) && Array.isArray(cue.songIds) && cue.songIds.length === (cue.kind === 'ban' ? 1 : 2) && cue.songIds.every(id => typeof id === 'string' && id.length > 0);

  // The half-second lead-in lets an old preview fade before the new one starts.
  // A shared clock also keeps a reloaded OBS source from replaying finished picks.
  function phase(cue, songs, now, fadeMs = FADE_MS) {
    if (!validCue(cue)) return null;
    const catalog = new Map((songs || []).map(song => [song.id, song]));
    const lengths = cue.songIds.map(id => duration(catalog.get(id)) * 1000);
    let elapsed = now - cue.startedAt - fadeMs;
    if (elapsed < 0) return { pending: true, songId: cue.songIds[0], index: 0, offset: 0, duration: lengths[0] / 1000, cycle: 0 };
    if (cue.kind === 'ban') {
      const cycle = Math.floor(elapsed / lengths[0]);
      return { songId: cue.songIds[0], index: 0, offset: (elapsed % lengths[0]) / 1000, duration: lengths[0] / 1000, cycle };
    }
    for (let index = 0; index < lengths.length; index++) {
      if (elapsed < lengths[index]) return { songId: cue.songIds[index], index, offset: elapsed / 1000, duration: lengths[index] / 1000, cycle: 0 };
      elapsed -= lengths[index];
    }
    return { complete: true, songId: cue.songIds.at(-1), index: cue.songIds.length - 1, offset: lengths.at(-1) / 1000, duration: lengths.at(-1) / 1000, cycle: 0 };
  }

  function createPlayer(options = {}) {
    const now = options.now || Date.now;
    const setTimer = options.setTimer || setTimeout, clearTimer = options.clearTimer || clearTimeout;
    const createAudio = options.createAudio || (() => new Audio());
    const fadeMs = options.fadeMs ?? FADE_MS, enabled = options.enabled !== false;
    const gain = Number.isFinite(options.gain) ? clamp(options.gain) : .8;
    let context = null, key = null, current = null, retiring = null, prepared = null, timer = null;
    let disposed = false, blocked = false, lastFocus, lastStatus = '', failedSources = new Set();
    const durationCache = new Map();

    function catalog(songs) {
      return songs.map(song => !durationCache.has(song.previewAudio)
        ? song : { ...song, previewDuration: durationCache.get(song.previewAudio) });
    }
    function learnDuration(item) {
      const length = item.audio.duration;
      if (!Number.isFinite(length) || length <= 0 || length > 600 || !context || current !== item && prepared !== item) return;
      durationCache.set(item.path, length); context.songs = catalog(context.rawSongs);
    }

    function report(state, songId = null) {
      const next = JSON.stringify([state, songId]);
      if (next !== lastStatus) { lastStatus = next; options.onStatus?.({ state, songId, kind: context?.cue.kind || null }); }
    }
    function focus(songId) {
      if (songId !== lastFocus) { lastFocus = songId; options.onFocus?.(songId); }
    }
    function detach(item) {
      if (!item?.audio) return;
      for (const [event, listener] of Object.entries(item.listeners || {})) item.audio.removeEventListener(event, listener);
      item.listeners = {};
    }
    function release(item) {
      if (!item?.audio || item.released) return;
      item.released = true;
      detach(item); item.audio.pause(); item.audio.volume = 0;
      // Remove the source as well as pausing: no background downloads survive a scene exit.
      item.audio.removeAttribute('src'); item.audio.load();
      item.audio.remove?.();
    }
    function retire() {
      release(prepared); prepared = null;
      release(retiring); retiring = null;
      if (current?.audio) {
        detach(current);
        retiring = current;
        retiring.volume = current.audio.volume; retiring.startsAt = now(); retiring.endsAt = now() + fadeMs;
        role(retiring, 'retiring');
      }
      current = null;
    }
    function role(item, value) {
      if (!item.audio?.dataset) return;
      delete item.audio.dataset.selectionAudio;
      delete item.audio.dataset.selectionAudioPrepared;
      delete item.audio.dataset.selectionAudioRetiring;
      item.audio.dataset[value === 'prepared' ? 'selectionAudioPrepared' : value === 'retiring' ? 'selectionAudioRetiring' : 'selectionAudio'] = '';
      item.audio.dataset.songId = item.songId;
    }
    function position(item, offset) {
      try { item.audio.currentTime = Math.max(0, offset); } catch (_) { /* Retry when metadata arrives. */ }
    }
    function start(item, currentPhase) {
      position(item, currentPhase.offset);
      let promise;
      try { promise = item.audio.play(); } catch (error) { failed(item, error); return; }
      Promise.resolve(promise).then(() => {
        if (disposed || current !== item) { if (retiring?.audio !== item.audio) release(item); return; }
        item.playing = true;
        report('playing', item.songId);
        tick();
      }).catch(error => failed(item, error));
    }
    function failed(item, error) {
      if (disposed) return;
      if (prepared === item) {
        failedSources.add(item.path); release(prepared); prepared = null;
        return;
      }
      if (current !== item) return;
      item.playing = false; item.failed = true; item.audio.pause(); item.audio.volume = 0;
      if (error?.name === 'NotAllowedError') { blocked = true; release(prepared); prepared = null; report('blocked', item.songId); }
      else { failedSources.add(item.path); report('error', item.songId); }
    }
    function makeMedia(item, mediaRole) {
      item.audio = createAudio(); item.audio.preload = 'auto'; item.audio.loop = false; item.audio.volume = 0;
      if (typeof document !== 'undefined' && item.audio.nodeType === 1) {
        item.audio.hidden = true; role(item, mediaRole);
        document.body?.append(item.audio);
      }
      item.listeners = {
        loadedmetadata: () => {
          if (current !== item && prepared !== item) return;
          learnDuration(item);
          if (current === item) {
            const next = phase(context?.cue, context?.songs, now(), fadeMs);
            if (!item.playing && next && !next.complete && !next.pending) position(item, next.offset);
          }
          tick();
        },
        error: () => failed(item, new Error('Preview audio could not be loaded')),
        ended: () => {
          if (current !== item) return;
          item.playing = false; item.ended = true; item.audio.volume = 0;
          learnDuration(item);
          // The clock advances the sequence even when a decoder stalls or ends
          // a few samples early; ended itself never starts an uncontrolled loop.
          tick();
        }
      };
      for (const [event, listener] of Object.entries(item.listeners)) item.audio.addEventListener(event, listener);
      item.audio.src = '/' + item.path;
    }
    function prepare(songId) {
      const song = context?.songs.find(song => song.id === songId);
      const path = safePath(song?.previewAudio) ? song.previewAudio : '';
      if (prepared && (prepared.songId !== songId || prepared.path !== path || prepared.cueKey !== key)) {
        release(prepared); prepared = null;
      }
      if (prepared || !enabled || blocked || !path || failedSources.has(path)) return;
      const item = prepared = { songId, path, cueKey: key, audio: null, playing: false };
      try { makeMedia(item, 'prepared'); }
      catch (_) { failedSources.add(path); release(item); if (prepared === item) prepared = null; }
    }
    function open(currentPhase, song) {
      const segmentKey = JSON.stringify([key, currentPhase.index, currentPhase.cycle]);
      const path = safePath(song?.previewAudio) ? song.previewAudio : '';
      // A ban loop can seek the same warmed decoder rather than fetching and
      // rebuilding a media element every twelve seconds.
      if (context.cue.kind === 'ban' && current?.audio && current.path === path && current.cueKey === key && !current.failed) {
        current.segmentKey = segmentKey; current.playing = false; current.ended = false;
        start(current, currentPhase); return;
      }
      release(current); current = null;
      focus(currentPhase.songId);
      if (prepared && prepared.songId === currentPhase.songId && prepared.path === path && prepared.cueKey === key) {
        current = prepared; prepared = null; current.segmentKey = segmentKey;
        role(current, 'current');
      } else {
        release(prepared); prepared = null;
        current = { segmentKey, songId: currentPhase.songId, path, cueKey: key, audio: null, playing: false };
      }
      if (!enabled) { report('muted', currentPhase.songId); return; }
      if (!path) { report('missing', currentPhase.songId); return; }
      if (blocked) { report('blocked', currentPhase.songId); return; }
      if (failedSources.has(path)) { report('error', currentPhase.songId); return; }
      const item = current;
      try {
        if (!item.audio) makeMedia(item, 'current');
        report('loading', item.songId); start(item, currentPhase);
      } catch (error) {
        if (item.audio) failed(item, error);
        else { failedSources.add(path); report('error', item.songId); }
      }
    }
    function schedule() {
      if (timer !== null || disposed || !retiring && !context) return;
      timer = setTimer(() => { timer = null; tick(); }, TICK_MS);
    }
    function tick() {
      if (disposed) return;
      const time = now();
      if (retiring) {
        const length = retiring.endsAt - retiring.startsAt;
        const progress = length > 0 ? (time - retiring.startsAt) / length : 1;
        retiring.audio.volume = retiring.volume * (1 - ease(progress));
        if (progress >= 1) { release(retiring); retiring = null; }
      }
      const currentPhase = context && phase(context.cue, context.songs, time, fadeMs);
      if (currentPhase?.pending) { prepare(currentPhase.songId); report('waiting'); }
      else if (currentPhase?.complete) {
        release(current); current = null;
        release(prepared); prepared = null;
        focus(currentPhase.songId); report('complete', currentPhase.songId);
        // No need to keep a frame timer alive after the second clip ends.
        if (!retiring) return;
      } else if (currentPhase) {
        const song = context.songs.find(song => song.id === currentPhase.songId);
        const segmentKey = JSON.stringify([key, currentPhase.index, currentPhase.cycle]);
        const path = safePath(song?.previewAudio) ? song.previewAudio : '';
        if (!current || current.segmentKey !== segmentKey || current.path !== path) open(currentPhase, song);
        if (current?.audio && current.playing) {
          const fadeSeconds = fadeMs / 1000;
          current.audio.volume = gain * (fadeSeconds > 0 ? Math.min(ease(currentPhase.offset / fadeSeconds), ease((currentPhase.duration - currentPhase.offset) / fadeSeconds)) : 1);
          // Only the next selected track is warmed, after actual playback has
          // started. Initial candidate draws and disabled staff previews never
          // create media, and a failed/blocked first play does not fan out loads.
          if (context.cue.kind === 'picks' && currentPhase.index === 0) prepare(context.cue.songIds[1]);
        }
      } else if (!retiring) report('silent');
      schedule();
    }
    function update({ cue, songs = [], active = false } = {}) {
      if (disposed) return;
      const next = active && validCue(cue) ? { cue, rawSongs: songs, songs: catalog(songs) } : null;
      const nextKey = next ? JSON.stringify([cue.id, cue.kind, cue.songIds, cue.startedAt]) : null;
      if (nextKey !== key) {
        retire(); blocked = false; failedSources = new Set(); key = nextKey;
        // Delivery latency shortens the outgoing fade, keeping the two sources
        // separate while preserving the shared cue start time.
        if (retiring && next) retiring.endsAt = Math.max(retiring.startsAt, Math.min(retiring.endsAt, cue.startedAt + fadeMs));
      }
      context = next;
      if (!next) focus(null);
      tick();
    }
    function retry() {
      if (disposed || !enabled || !context) return;
      blocked = false; failedSources.clear(); release(current); release(prepared); current = prepared = null; tick();
    }
    function dispose() {
      disposed = true; if (timer !== null) clearTimer(timer); timer = null;
      release(current); release(retiring); release(prepared); current = retiring = prepared = context = null;
    }
    return { update, retry, dispose, get phase() { return context && phase(context.cue, context.songs, now(), fadeMs); } };
  }
  return { createPlayer, phase, safePath, FADE_MS, DEFAULT_DURATION };
});
