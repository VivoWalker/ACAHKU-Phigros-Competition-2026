const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlayer } = require('../public/js/intermission');
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

test('master volume updates the trailer in place and cannot unmute a staff preview', async t => {
  for (const enabled of [true, false]) {
    const f = fixture(t, { enabled }); f.advance(2500);
    f.player.update({ config: cue(), active: true, volume: .25 }); await flush();
    const video = f.media[0], time = video.currentTime;
    for (const volume of [0, .37, 1]) {
      f.player.update({ config: cue(), active: true, volume }); await flush();
      assert.equal(video.volume, enabled ? volume : 0);
      assert.equal(video.muted, !enabled); assert.equal(video.currentTime, time);
      assert.equal(video.playCalls, 1); assert.equal(f.media.length, 1);
    }
  }
});
const cue = (id = 'ec2d3b96-dc29-4cbf-ae21-b8bacf63237f', loop = true) => ({
  videoPath: 'assets/intermission/arcaea-trailer.mp4', loop, resumeTime: '', cue: { id, startedAt: 1000 }
});
function fixture(t, options = {}) {
  let clock = 1000, serial = 0;
  const timers = new Map(), media = [], statuses = [];
  const document = { hidden: false };
  class Element {
    constructor(tag) { this.tagName = tag; this.dataset = {}; this.children = []; this.hidden = false; this.ownerDocument = document; }
    append(...nodes) { for (const node of nodes) { this.children.push(node); node.parent = this; } }
    prepend(node) { this.children.unshift(node); node.parent = this; }
    remove() { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  }
  class Video extends Element {
    constructor() { super('video'); this.currentTime = 0; this.duration = 10; this.paused = true; this.ended = false; this.playCalls = 0; this.listeners = new Map(); }
    addEventListener(name, listener, { signal } = {}) {
      this.listeners.set(name, listener);
      signal?.addEventListener('abort', () => this.listeners.delete(name), { once: true });
    }
    emit(name) { this.listeners.get(name)?.(); }
    play() {
      this.playCalls++;
      if (options.throwPlay) throw options.throwPlay;
      if (options.playError) return Promise.reject(options.playError);
      this.paused = false;
      if (options.pending) return new Promise((resolve, reject) => { this.resolvePlay = resolve; this.rejectPlay = reject; });
      return Promise.resolve();
    }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    load() { this.unloaded = true; }
  }
  document.createElement = tag => { if (tag !== 'video') return new Element(tag); const node = new Video(); media.push(node); return node; };
  document.defaultView = {
    AbortController,
    setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, at: clock + delay }); return id; },
    clearTimeout: id => timers.delete(id)
  };
  const canvas = new Element('div');
  const player = createPlayer({ canvas, now: () => clock, onStatus: value => statuses.push(value), ...options });
  t.after(() => player.dispose());
  function advance(milliseconds) {
    const until = clock + milliseconds;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); clock = next[1].at; next[1].callback();
    }
    clock = until;
  }
  return { player, media, timers, statuses, document, canvas, advance,
    update: (config = cue(), active = true) => player.update({ config, active }) };
}


test('looping trailers seek modulo duration, stay muted in staff previews and retain one decoder across score updates', async t => {
  const f = fixture(t, { enabled: false }); f.advance(23000); f.update(); await flush();
  const video = f.media[0];
  assert.equal(video.currentTime, 3); assert.equal(video.loop, true); assert.equal(video.muted, true);
  for (let i = 0; i < 100; i++) f.update(structuredClone(cue()));
  await flush(); assert.equal(f.media.length, 1); assert.equal(video.playCalls, 1); assert.equal(f.timers.size, 1);
});

test('single-play trailers end on standby without replaying after later revisions', async t => {
  const f = fixture(t); f.update(cue(undefined, false)); await flush();
  f.advance(10000); await flush();
  assert.equal(f.player.hasMedia, false); assert.equal(f.timers.size, 0); assert.equal(f.statuses.at(-1), 'ended');
  for (let i = 0; i < 30; i++) f.update(cue(undefined, false));
  assert.equal(f.media.length, 1);
});

test('scene exit, hidden OBS sources and disposal release the audio, decoder, event listeners and timers', async t => {
  const f = fixture(t); f.update(); await flush(); f.update(cue(), false);
  assert.equal(f.player.hasMedia, false); assert.equal(f.timers.size, 0);
  f.advance(2000); f.update(); await flush(); assert.equal(f.media[1].currentTime, 2);
  f.document.hidden = true; f.update(); assert.equal(f.player.hasMedia, false);
  f.document.hidden = false; f.update(); await flush(); f.player.dispose();
  assert.equal(f.canvas.children.length, 0); assert.equal(f.timers.size, 0);
  for (const video of f.media) assert.ok(video.paused && video.unloaded && video.removed && !video.src && !video.listeners.size);
});

test('a blocked trailer waits for an explicit retry and stale play promises cannot revive a stopped clip', async t => {
  const config = { playError: Object.assign(new Error('Gesture needed'), { name: 'NotAllowedError' }) };
  const f = fixture(t, config); f.update(); await flush(); assert.equal(f.statuses.at(-1), 'blocked');
  f.advance(1000); await flush(); assert.equal(f.media[0].playCalls, 1);
  config.playError = null; f.player.retry(); await flush(); assert.equal(f.statuses.at(-1), 'playing');
  const g = fixture(t, { pending: true }); g.update(); await flush(); const old = g.media[0];
  g.update(cue(), false); old.resolvePlay(); await flush();
  assert.equal(g.statuses.at(-1), 'silent'); assert.equal(g.player.hasMedia, false); assert.equal(g.timers.size, 0);
});
