const test = require('node:test');
const assert = require('node:assert/strict');
const Sequence = require('../public/js/final-sequence');
const { createPlayer, safePath } = require('../public/js/finale-video');
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const cue = (id = 'ec2d3b96-dc29-4cbf-ae21-b8bacf63237f', startedAt = 1000, duration = 10) => ({
  id: 'GF', finalMode: 'fixed-two', finale: { stage: 'video', videoPath: 'assets/finale/reveal.mp4',
    videoDuration: duration, effectLevel: 0, videoCue: { id, startedAt, duration } }
});
function fixture(t, options = {}) {
  let clock = 1000, serial = 0;
  const timers = new Map(), media = [], completed = [], statuses = [];
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
    BroadcastFinalSequence: Sequence, AbortController,
    setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, at: clock + delay }); return id; },
    clearTimeout: id => timers.delete(id)
  };
  const canvas = new Element('div');
  const player = createPlayer({ canvas, now: () => clock, onComplete: id => completed.push(id), onStatus: value => statuses.push(value), ...options });
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
  return { player, media, timers, completed, statuses, document, canvas, advance,
    update: (match = cue(), active = true) => player.update({ match, active }) };
}

test('reveal video paths accept only packaged local MP4/WebM assets without traversal or URL parameters', () => {
  for (const path of ['assets/finale/reveal.mp4', 'assets/finale/subfolder/clip_02.WEBM']) {
    assert.equal(safePath(path), true); assert.equal(Sequence.validVideoPath(path), true);
  }
  for (const path of ['https://example.test/a.mp4', '/assets/finale/a.mp4', 'assets/finale/../a.mp4', 'assets/finale/a//b.mp4', 'assets/finale/a/./b.mp4', 'assets/finale/a.mp4?x=1', 'assets/finale/a.mp4\n', 'assets/finale/a.svg']) {
    assert.equal(safePath(path), false, path); assert.equal(Sequence.validVideoPath(path), false, path);
  }
});

test('unchanged revisions reuse one decoder and seek to the shared clock instead of restarting playback', async t => {
  const f = fixture(t); f.advance(3000); f.update(); await flush();
  const video = f.media[0]; assert.equal(video.src, '/assets/finale/reveal.mp4'); assert.equal(video.currentTime, 3);
  assert.equal(video.playCalls, 1); assert.equal(video.loop, false);
  for (let i = 0; i < 500; i++) f.update(structuredClone(cue()));
  await flush(); assert.equal(f.media.length, 1); assert.equal(video.playCalls, 1); assert.equal(f.timers.size, 1);
});

test('source hiding, inactivation and disposal synchronously unload every decoder, listener and timer', async t => {
  const f = fixture(t); f.update(); await flush();
  f.update(cue(), false);
  assert.equal(f.player.hasMedia, false); assert.equal(f.timers.size, 0);
  assert.equal(f.media[0].paused, true); assert.equal(f.media[0].src, ''); assert.equal(f.media[0].listeners.size, 0);
  f.advance(3000); f.update(); await flush(); assert.equal(f.media[1].currentTime, 3);
  f.document.hidden = true; f.update(); assert.equal(f.player.hasMedia, false); assert.equal(f.timers.size, 0);
  f.document.hidden = false; f.update(); await flush(); f.player.dispose();
  assert.equal(f.canvas.children.length, 0); assert.equal(f.timers.size, 0);
  for (const video of f.media) assert.ok(video.paused && video.unloaded && video.removed && !video.src && !video.listeners.size);
  f.player.retry(); f.update(); f.advance(50000); assert.equal(f.media.length, 3);
});

test('shared video end notifies once, releases the media and cannot restart on later state revisions', async t => {
  const f = fixture(t); f.update(); await flush(); f.advance(10000);
  assert.equal(f.completed.length, 1); assert.equal(f.player.hasMedia, false); assert.equal(f.timers.size, 0);
  for (let i = 0; i < 100; i++) f.update();
  assert.equal(f.completed.length, 1); assert.equal(f.media.length, 1);
  const reload = fixture(t); reload.advance(12000); reload.update();
  assert.equal(reload.media.length, 0); assert.equal(reload.completed.length, 1, 'Late source loads must not replay an expired reveal');
});

test('old pending play promises cannot update status or revive media after cue replacement and disposal', async t => {
  const f = fixture(t, { pending: true }); f.update(); await flush(); const first = f.media[0];
  f.update(cue('2dc8cfea-53f8-4b44-aa95-dcd6a4de32d8')); await flush(); const second = f.media[1];
  first.resolvePlay(); await flush(); assert.equal(f.statuses.at(-1), 'loading'); assert.equal(first.paused, true);
  second.resolvePlay(); await flush(); assert.equal(f.statuses.at(-1), 'playing');
  const disposed = fixture(t, { pending: true }); disposed.update(); await flush();
  const old = disposed.media[0]; disposed.player.dispose(); old.resolvePlay(); await flush();
  assert.equal(disposed.statuses.at(-1), 'silent'); assert.equal(old.paused, true); assert.equal(disposed.timers.size, 0);
});

test('early physical media endings hold their last frame without replaying an audio tail before shared-clock return', async t => {
  const f = fixture(t); f.update(); await flush(); const video = f.media[0];
  video.duration = 3; video.currentTime = 3; video.ended = true; video.paused = true; video.emit('ended');
  f.advance(4000); await flush();
  assert.equal(video.currentTime, 3); assert.equal(video.playCalls, 1); assert.equal(f.completed.length, 0);
  f.advance(6000); assert.equal(f.completed.length, 1); assert.equal(f.player.hasMedia, false);
});

test('blocked playback retries only on an explicit gesture, while synchronous decoder failures show a bounded error state', async t => {
  const options = { playError: Object.assign(new Error('Gesture required'), { name: 'NotAllowedError' }) };
  const f = fixture(t, options); f.update(); await flush(); assert.equal(f.statuses.at(-1), 'blocked');
  f.advance(1000); for (let i = 0; i < 20; i++) f.update(); await flush(); assert.equal(f.media[0].playCalls, 1);
  options.playError = null; f.player.retry(); await flush(); assert.equal(f.statuses.at(-1), 'playing'); assert.equal(f.media[0].playCalls, 2);
  const broken = fixture(t, { throwPlay: new Error('Decoder unavailable') }); broken.update(); await flush();
  assert.equal(broken.statuses.at(-1), 'error'); assert.equal(broken.canvas.children[0].children.find(node => node.tagName === 'p').hidden, false);
  broken.advance(2000); await flush(); assert.equal(broken.media[0].playCalls, 1);
});

test('a future synchronized cue waits without playing and starts once its shared start time arrives', async t => {
  const f = fixture(t), future = cue(undefined, 2000); f.update(future); await flush(); assert.equal(f.media[0].playCalls, 0);
  f.advance(1000); await flush(); assert.equal(f.media[0].playCalls, 1);
});
