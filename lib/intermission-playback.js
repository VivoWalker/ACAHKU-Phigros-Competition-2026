const Videos = require('../public/js/broadcast-videos');

// The server owns completion, including while every staff panel is closed.
function createIntermissionPlayback({ store, onChange = () => {}, now = () => Date.now(),
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer, closed = false, generation = 0;
  function current() {
    const state = store.state, config = Videos.intermission(state.broadcast?.intermission);
    if (state.scene !== 'arcaea-trailer' || !config.cue || !Number.isFinite(config.videoDuration) || config.videoDuration <= 0) return null;
    return { key: JSON.stringify([state.eventId, config.videoPath, config.cue.id, config.videoDuration]),
      end: config.cue.startedAt + config.videoDuration * 1000 };
  }
  function sync() {
    const epoch = ++generation;
    clearTimer(timer); timer = null;
    const target = !closed && current();
    if (!target) return;
    timer = setTimer(() => {
      if (epoch !== generation || closed) return;
      timer = null;
      if (current()?.key !== target.key || now() < target.end) { sync(); return; }
      try {
        store.commit({ type: 'stop-intermission-video', payload: {} }, store.state.revision);
        onChange('arcaea-trailer');
      } catch {
        // A failed durable save must not advance the event. Retry after the
        // storage becomes writable, without spinning on an expired deadline.
        timer = setTimer(sync, 1000);
      }
    }, Math.min(2147483647, Math.max(0, target.end - now())));
  }
  return { sync, close() { closed = true; generation++; clearTimer(timer); timer = null; } };
}
module.exports = { createIntermissionPlayback };
