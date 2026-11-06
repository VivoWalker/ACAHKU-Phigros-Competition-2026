const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { StateStore } = require('../lib/store');
const { createIntermissionPlayback } = require('../lib/intermission-playback');
const { createBroadcastServer } = require('../server');
const Videos = require('../public/js/broadcast-videos');

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intermission-playback-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true })); return dir;
}
function fixture(t) {
  const store = new StateStore(directory(t));
  let clock = Date.now(), serial = 0;
  const timers = new Map(), changes = [];
  const player = createIntermissionPlayback({ store, now: () => clock,
    setTimer(fn, delay) { const id = ++serial; timers.set(id, { fn, delay }); return id; },
    clearTimer(id) { timers.delete(id); }, onChange(scene) { changes.push(scene); player.sync(); } });
  t.after(() => player.close());
  function commit(type, payload = {}) { store.commit({ type, payload }, store.state.revision); player.sync(); }
  function wake(offset) {
    clock += offset;
    const [id, timer] = timers.entries().next().value;
    timers.delete(id); timer.fn();
  }
  commit('play-intermission-video');
  return { store, player, commit, wake, timers, changes, now: () => clock };
}

test('shared trailer deadline returns to rest once without changing tournament data', t => {
  const f = fixture(t), before = structuredClone(f.store.state.tournament), qualifier = structuredClone(f.store.state.qualifier);
  const cue = f.store.state.broadcast.intermission.cue;
  f.wake(cue.startedAt + Videos.clips.arcaea.videoDuration * 1000 - f.now());
  assert.equal(f.store.state.scene, 'intermission');
  assert.equal(f.store.state.broadcast.intermission.cue, null);
  assert.deepEqual(f.store.state.tournament, before); assert.deepEqual(f.store.state.qualifier, qualifier);
  assert.deepEqual(f.changes, ['arcaea-trailer']); assert.equal(f.timers.size, 0);
  assert.equal(new StateStore(path.dirname(f.store.file)).state.scene, 'intermission');
});

test('early timer wakeups and score revisions preserve the original completion deadline', t => {
  const f = fixture(t), cue = f.store.state.broadcast.intermission.cue;
  const deadline = cue.startedAt + Videos.clips.arcaea.videoDuration * 1000;
  f.wake(10); assert.equal(f.store.state.scene, 'arcaea-trailer');
  f.commit('set-broadcast-volume', { volume: .31 });
  assert.equal([...f.timers.values()][0].delay, deadline - f.now());
  f.wake(deadline - f.now()); assert.equal(f.store.state.scene, 'intermission');
});

test('manual stop, replay, scene changes and shutdown cancel obsolete completion callbacks', t => {
  const f = fixture(t), obsolete = [...f.timers.values()][0].fn;
  f.commit('play-intermission-video'); const id = f.store.state.broadcast.intermission.cue.id;
  obsolete(); assert.equal(f.store.state.broadcast.intermission.cue.id, id);
  f.commit('stop-intermission-video'); assert.equal(f.timers.size, 0);
  f.commit('play-intermission-video'); f.commit('set-scene', { scene: 'start' }); assert.equal(f.timers.size, 0);
  f.commit('play-intermission-video'); const callback = [...f.timers.values()][0].fn;
  f.player.close(); callback(); assert.equal(f.store.state.scene, 'arcaea-trailer'); assert.equal(f.timers.size, 0);
});

test('replacement videos acquire their own measured duration and reject stale or invalid metadata', t => {
  const f = fixture(t), videoPath = 'assets/intermission/replacement.mp4';
  f.commit('configure-intermission', { videoPath, loop: true });
  assert.equal(f.store.state.broadcast.intermission.loop, false);
  assert.equal(f.store.state.broadcast.intermission.videoDuration, undefined);
  assert.equal(f.timers.size, 0);
  f.commit('play-intermission-video'); const cueId = f.store.state.broadcast.intermission.cue.id;
  for (const duration of [undefined, null, '2', 0, -1, NaN, Infinity, 3601])
    assert.throws(() => f.commit('set-intermission-video-duration', { videoPath, cueId, duration }));
  assert.throws(() => f.commit('set-intermission-video-duration', { videoPath: 'assets/intermission/old.mp4', cueId, duration: 2 }), /changed/);
  assert.throws(() => f.commit('set-intermission-video-duration', { videoPath, cueId: null, duration: 2 }), /changed/);
  f.commit('set-intermission-video-duration', { videoPath, cueId, duration: 2 });
  f.wake(f.store.state.broadcast.intermission.cue.startedAt + 2000 - f.now());
  assert.equal(f.store.state.scene, 'intermission');
});

test('a failed durable finish retries without advancing the event or busy-looping', t => {
  const f = fixture(t), commit = f.store.commit.bind(f.store), before = structuredClone(f.store.state);
  f.store.commit = () => { throw new Error('Storage unavailable'); };
  f.wake(before.broadcast.intermission.cue.startedAt + Videos.clips.arcaea.videoDuration * 1000 - f.now());
  assert.deepEqual(f.store.state, before); assert.equal([...f.timers.values()][0].delay, 1000);
  f.store.commit = commit; f.wake(1000); f.wake(0);
  assert.equal(f.store.state.scene, 'intermission'); assert.equal(f.changes.length, 1);
});

test('a real restarted server completes an expired legacy looping trailer without staff or OBS clients', async t => {
  const dir = directory(t), store = new StateStore(dir);
  store.commit({ type: 'play-intermission-video' }, store.state.revision);
  store.state.broadcast.intermission.loop = true;
  store.state.broadcast.intermission.cue.startedAt = Date.now() - 30000;
  store.write(store.state);
  const app = createBroadcastServer({ dataDir: dir, pin: 'intermission-test', scorekeeperPin: 'intermission-score-test' });
  t.after(() => app.close()); await app.listen(0, '127.0.0.1');
  const deadline = Date.now() + 2000;
  while (app.store.state.scene !== 'intermission' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(app.store.state.scene, 'intermission'); assert.equal(app.store.state.broadcast.intermission.cue, null);
  assert.equal(new StateStore(dir).state.scene, 'intermission');
});
