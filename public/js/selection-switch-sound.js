(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BroadcastSelectionSwitchSound = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const PATH = '/assets/sfx/song-switch.ogg';
  function createPlayer(options = {}) {
    const enabled = options.enabled !== false, now = options.now || Date.now;
    const voices = new Set(), abort = new AbortController();
    let context, master, loading, buffer, active = false, volume = 0, latest = '', issued = 0, epoch = 0, disposed = false;
    const report = status => options.onStatus?.(status);
    function stop() {
      epoch++;
      for (const voice of voices) {
        try { voice.source.stop(); } catch (_) { /* Already ended. */ }
        voice.source.disconnect(); voice.gain.disconnect();
      }
      voices.clear();
    }
    function audio() {
      if (!context) {
        context = options.createContext ? options.createContext() : new (window.AudioContext || window.webkitAudioContext)();
        master = context.createGain(); master.gain.value = volume; master.connect(context.destination);
        loading = (options.load ? options.load() : fetch(PATH, { signal: abort.signal }).then(response => {
          if (!response.ok) throw new Error('Selection sound unavailable'); return response.arrayBuffer();
        })).then(bytes => context.decodeAudioData(bytes)).then(value => { if (!disposed) buffer = value; return value; });
        loading.catch(() => report('error'));
      }
      return context;
    }
    function play(key, token, started) {
      if (disposed || !active || !volume || epoch !== token || latest !== key || now() - started > 140 || !buffer) return;
      if (context.state !== 'running') { report('blocked'); return; }
      while (voices.size >= 2) {
        const oldest = voices.values().next().value;
        oldest.gain.gain.setTargetAtTime(0, context.currentTime, .006);
        try { oldest.source.stop(context.currentTime + .02); } catch (_) { /* Already ended. */ }
        voices.delete(oldest);
      }
      const source = context.createBufferSource(), gain = context.createGain(), voice = { source, gain };
      source.buffer = buffer; source.connect(gain); gain.connect(master); voices.add(voice);
      source.onended = () => { voices.delete(voice); source.disconnect(); gain.disconnect(); };
      source.start(); report('playing');
    }
    function update({ active: nextActive = false, volume: nextVolume = 1, cue, phase } = {}) {
      if (disposed) return;
      volume = Number.isFinite(nextVolume) ? Math.max(0, Math.min(1, nextVolume)) : 0;
      active = enabled && nextActive && phase?.stage === 'rolling';
      if (master) master.gain.value = active ? volume : 0;
      const key = phase?.stage === 'rolling' && cue ? JSON.stringify([cue.id, phase.index, phase.step]) : '';
      const changed = key !== latest; latest = key;
      if (!active || !volume) { stop(); report('silent'); return; }
      if (!changed) return;
      issued = phase.stepStartedAt ?? now(); const token = epoch, started = issued;
      try {
        const ctx = audio();
        if (ctx.state === 'suspended') { report('blocked'); return; }
        if (buffer) play(key, token, started);
        else loading.then(() => play(key, token, started)).catch(() => {});
      } catch (_) { report('error'); }
    }
    return {
      update,
      retry() { if (!disposed && context?.state === 'suspended') context.resume().catch(() => report('blocked')); },
      dispose() { if (disposed) return; disposed = true; active = false; stop(); abort.abort(); context?.close().catch(() => {}); buffer = loading = null; }
    };
  }
  return { PATH, createPlayer };
});
