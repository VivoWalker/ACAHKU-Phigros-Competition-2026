(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BroadcastIntermission = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const defaults = () => ({ videoPath: '', loop: true, resumeTime: '', cue: null });
  const safePath = value => typeof value === 'string' && value.length <= 180 && !/[\\%?#\x00-\x1f\x7f-\x9f]/.test(value)
    && /^(?:assets\/intermission\/[a-zA-Z0-9_./-]+|media\/intermission\/[a-f0-9-]{36})\.(?:mp4|webm)$/i.test(value)
    && !value.split('/').some(part => !part || part === '.' || part === '..');
  const validTime = value => typeof value === 'string' && (value === '' || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value));
  function validate(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !(value.videoPath === '' || safePath(value.videoPath)) || typeof value.loop !== 'boolean' || !validTime(value.resumeTime))
      throw new Error('Invalid intermission video, loop or resume time.');
    if (value.cue !== null && (!value.videoPath || !value.cue || typeof value.cue !== 'object'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.cue.id)
      || !Number.isSafeInteger(value.cue.startedAt) || value.cue.startedAt < 0)) throw new Error('Invalid intermission playback cue.');
    return value;
  }
  function createPlayer({ canvas, now = () => Date.now(), enabled = true, onStatus = () => {} }) {
    const document = canvas.ownerDocument, window = document.defaultView;
    const layer = document.createElement('div');
    layer.className = 'intermission-media-layer'; layer.dataset.intermissionMedia = ''; layer.hidden = true;
    const message = document.createElement('p'); message.className = 'intermission-video-message';
    message.textContent = '預告暫時無法播放'; message.hidden = true; layer.append(message); canvas.append(layer);
    let config, active = false, video, events, timer = 0, disposed = false, pending = false, generation = 0, signature = '', status = 'silent';
    function setStatus(value) { if (status === value) return; status = value; layer.dataset.status = value; onStatus(value); }
    function release() {
      generation++; pending = false; window.clearTimeout(timer); timer = 0; events?.abort(); events = null;
      if (video) { video.pause(); video.removeAttribute('src'); video.load(); video.remove(); video = null; }
      layer.hidden = true; message.hidden = true;
    }
    function sync() {
      if (disposed || !active || !video || document.hidden) return;
      const elapsed = Math.max(0, (now() - config.cue.startedAt) / 1000);
      if (Number.isFinite(video.duration) && video.duration > 0) {
        if (!config.loop && elapsed >= video.duration) { release(); setStatus('ended'); return; }
        const desired = config.loop ? elapsed % video.duration : elapsed;
        // Circular distance avoids a redundant seek at the native loop boundary.
        const difference = Math.abs(video.currentTime - desired);
        if (Math.min(difference, config.loop ? video.duration - difference : difference) > .6) {
          try { video.currentTime = desired; } catch (_) { /* Metadata may still be loading. */ }
        }
      }
      if (video.paused && !pending && !['blocked', 'error'].includes(status)) {
        pending = true; const token = generation, current = video;
        Promise.resolve().then(() => {
          if (disposed || token !== generation || video !== current) return;
          return current.play();
        }).then(() => {
          if (disposed || token !== generation || video !== current) return;
          pending = false; setStatus('playing');
        }).catch(error => {
          if (disposed || token !== generation || video !== current) return;
          pending = false;
          if (error?.name !== 'AbortError') {
            message.hidden = error?.name === 'NotAllowedError';
            setStatus(error?.name === 'NotAllowedError' ? 'blocked' : 'error');
          }
        });
      }
    }
    function schedule() {
      window.clearTimeout(timer); timer = 0;
      if (!disposed && active && video && !document.hidden)
        timer = window.setTimeout(() => { timer = 0; sync(); schedule(); }, 250);
    }
    function update(next = {}) {
      if (disposed) return;
      config = next.config; active = next.active === true;
      const key = config?.cue && safePath(config.videoPath) ? `${config.cue.id}:${config.videoPath}:${config.loop}` : '';
      if (!active || document.hidden || !key) { release(); signature = ''; setStatus('silent'); return; }
      if (key !== signature) {
        release(); signature = key;
        video = document.createElement('video'); video.dataset.intermissionVideo = '';
        video.preload = 'auto'; video.playsInline = true; video.loop = config.loop; video.muted = !enabled;
        events = new window.AbortController(); const options = { signal: events.signal };
        for (const kind of ['loadedmetadata', 'canplay']) video.addEventListener(kind, sync, options);
        video.addEventListener('ended', () => { if (!config.loop) { release(); setStatus('ended'); } }, options);
        video.addEventListener('error', () => { message.hidden = false; setStatus('error'); }, options);
        layer.prepend(video); video.src = '/' + config.videoPath; layer.hidden = false; setStatus('loading');
      }
      sync(); schedule();
    }
    return {
      update,
      retry() { if (!disposed && active) { signature = ''; update({ config, active }); } },
      get hasMedia() { return !!video; },
      dispose() { if (disposed) return; disposed = true; release(); config = null; layer.remove(); }
    };
  }
  return { defaults, safePath, validTime, validate, createPlayer };
});
