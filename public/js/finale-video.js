(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BroadcastFinaleVideo = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const safePath = value => typeof value === 'string' && value.length <= 180
    && /^assets\/finale\/[a-zA-Z0-9_./-]+\.(mp4|webm)$/i.test(value)
    && !value.split('/').some(part => part === '..' || part === '.' || !part);
  function createPlayer({ canvas, now = () => Date.now(), enabled = true, onComplete = () => {}, onStatus = () => {} }) {
    const document = canvas.ownerDocument, window = document.defaultView;
    const layer = document.createElement('div');
    layer.className = 'finale-video-layer'; layer.dataset.finaleVideoLayer = ''; layer.hidden = true;
    const message = document.createElement('p'); message.className = 'finale-video-message'; message.hidden = true;
    message.textContent = '影片暫時無法播放，請由主控返回準備畫面'; layer.append(message); canvas.append(layer);
    let match, active = false, video, mediaEvents, timer = 0, disposed = false, cueId, completedCue, playPending = false, generation = 0;
    const phase = () => window.BroadcastFinalSequence.phase(match, now());
    function status(value) { layer.dataset.status = value; onStatus(value); }
    function stopTimer() { if (timer) window.clearTimeout(timer); timer = 0; }
    function release() {
      generation++; playPending = false; mediaEvents?.abort(); mediaEvents = null;
      if (video) {
        video.pause(); video.removeAttribute('src'); video.load(); video.remove(); video = null;
      }
    }
    function stop() { stopTimer(); release(); layer.hidden = true; message.hidden = true; status('silent'); }
    function complete() {
      const id = match?.finale?.videoCue?.id;
      stop();
      if (id && completedCue !== id) { completedCue = id; onComplete(id); }
    }
    function sync() {
      if (disposed || !active || document.hidden) return;
      const state = phase(), cue = match?.finale?.videoCue;
      if (state.videoEnded) { complete(); return; }
      if (!video || !state.videoActive || !cue || now() < cue.startedAt) return;
      // If a replacement clip is shorter than its configured slot, retain its
      // last frame rather than repeatedly seeking and playing its final 40ms.
      if (video.ended) return;
      const desired = Math.max(0, (now() - cue.startedAt) / 1000);
      if (Number.isFinite(video.duration) && video.duration > 0 && Math.abs(video.currentTime - desired) > .4) {
        try { video.currentTime = Math.min(desired, Math.max(0, video.duration - .04)); } catch { /* Retry when metadata is ready. */ }
      }
      if (video.paused && !video.ended && !playPending && layer.dataset.status !== 'error' && layer.dataset.status !== 'blocked') {
        playPending = true; const token = generation, playingVideo = video;
        Promise.resolve().then(() => {
          if (disposed || token !== generation || video !== playingVideo) return;
          return playingVideo.play();
        }).then(() => {
          if (disposed || token !== generation || video !== playingVideo) return;
          playPending = false; message.hidden = true; status('playing');
        }).catch(error => {
          if (disposed || token !== generation || video !== playingVideo) return;
          playPending = false;
          if (error?.name !== 'AbortError') {
            message.hidden = error?.name === 'NotAllowedError';
            status(error?.name === 'NotAllowedError' ? 'blocked' : 'error');
          }
        });
      }
    }
    function schedule() {
      stopTimer();
      if (disposed || !active || document.hidden || !phase().videoActive) return;
      timer = window.setTimeout(() => { timer = 0; sync(); schedule(); }, 100);
    }
    function update(next = {}) {
      if (disposed) return;
      match = next.match; active = next.active === true;
      const state = phase(), id = match?.finale?.videoCue?.id;
      if (active && !document.hidden && state.videoEnded) { complete(); return; }
      if (!active || document.hidden || !state.videoActive || !safePath(match?.finale?.videoPath)) { stop(); return; }
      if (id !== cueId || !video) {
        release(); cueId = id;
        video = document.createElement('video'); mediaEvents = new window.AbortController();
        video.dataset.finaleVideo = ''; video.preload = 'auto'; video.playsInline = true;
        video.muted = !enabled; video.volume = enabled ? 1 : 0; video.loop = false;
        const options = { signal: mediaEvents.signal };
        for (const kind of ['loadedmetadata', 'canplay', 'seeked']) video.addEventListener(kind, sync, options);
        video.addEventListener('ended', () => { if (phase().videoEnded) complete(); }, options);
        video.addEventListener('error', () => { message.hidden = false; status('error'); }, options);
        layer.prepend(video); video.src = '/' + match.finale.videoPath; status('loading');
      }
      layer.hidden = false; sync(); schedule();
    }
    return {
      update,
      retry() { if (!disposed && video) { status('loading'); sync(); schedule(); } },
      get hasMedia() { return !!video; },
      dispose() { if (disposed) return; disposed = true; stop(); match = null; layer.remove(); }
    };
  }
  return { safePath, createPlayer };
});
