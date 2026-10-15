const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlayer, safePath, FADE_MS } = require('../public/js/scene-bgm');
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const track = id => ({ id, path: `assets/bgm/${id}.ogg` });

function fixture(t, options = {}) {
  let clock = 1000, serial = 0;
  const audios = [], statuses = [], timers = new Map();
  class Media {
    constructor() { this.volume = 0; this.currentTime = 0; this.paused = true; this.playCalls = 0; this.listeners = new Map(); }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    removeEventListener(name, listener) { if (this.listeners.get(name) === listener) this.listeners.delete(name); }
    emit(name) { this.listeners.get(name)?.(); }
    play() {
      this.playCalls++;
      if (options.pending) return new Promise((resolve, reject) => {
        this.resolvePlay = () => { this.paused = false; resolve(); }; this.rejectPlay = reject;
      });
      if (options.playError) return Promise.reject(options.playError);
      this.paused = false; return Promise.resolve();
    }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    load() { this.unloaded = true; }
    remove() { this.removed = true; }
  }
  const player = createPlayer({
    now: () => clock,
    setTimer: (callback, delay) => { const id = ++serial; timers.set(id, { callback, at: clock + delay }); return id; },
    clearTimer: id => timers.delete(id),
    createAudio: () => { const audio = new Media(); audios.push(audio); return audio; },
    onStatus: status => statuses.push(status), ...options
  });
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
  return { player, audios, statuses, timers, advance,
    update: (nextTrack, extra = {}) => player.update({ track: nextTrack, active: true, ...extra }) };
}

test('scene music accepts only local packaged audio without traversal or URL parameters', () => {
  for (const path of ['assets/bgm/menu.ogg', '/assets/bgm/menu.MP3', 'assets/bgm/game/menu_02.m4a', 'assets/bgm/menu-1.wav']) assert.equal(safePath(path), true, path);
  for (const path of ['https://example.test/menu.ogg', '//example.test/menu.ogg', 'assets/song-preview/a.ogg', 'assets/bgm/../a.ogg', 'assets/bgm/a..ogg', 'assets/bgm/a.ogg\n', 'assets/bgm/a.ogg?x=1', 'assets/bgm/%2e%2e/a.ogg', 'assets/bgm//a.ogg', 'assets/bgm/a.svg']) assert.equal(safePath(path), false, path);
});

test('same music survives state revisions and scene changes without restarting or continuous polling', async t => {
  const f = fixture(t);
  f.update(track('menu')); await flush();
  const audio = f.audios[0]; assert.equal(audio.src, '/assets/bgm/menu.ogg'); assert.equal(audio.loop, true);
  f.advance(FADE_MS); audio.currentTime = 23;
  for (let i = 0; i < 1000; i++) f.update({ ...track('menu') });
  assert.equal(f.audios.length, 1); assert.equal(audio.playCalls, 1); assert.equal(audio.currentTime, 23);
  assert.equal(audio.volume, .3); assert.equal(f.timers.size, 0); assert.equal(f.statuses.at(-1).state, 'playing');
});

test('music changes crossfade nonlinearly and unload the retired source after the fade', async t => {
  const f = fixture(t, { fadeMs: 1000, gain: .4 });
  f.update(track('menu')); await flush(); f.advance(1000);
  const first = f.audios[0];
  f.update(track('results')); await flush();
  const second = f.audios[1]; f.advance(250);
  assert.ok(Math.abs(first.volume - .3375) < .0001); assert.ok(Math.abs(second.volume - .0625) < .0001);
  f.advance(250); assert.ok(Math.abs(first.volume - .2) < .0001); assert.ok(Math.abs(second.volume - .2) < .0001);
  f.advance(500);
  assert.equal(first.paused, true); assert.equal(first.src, ''); assert.equal(first.removed, true); assert.equal(first.listeners.size, 0);
  assert.equal(second.volume, .4); assert.equal(f.timers.size, 0);
});

test('rapid scene churn holds at most two loaded media and releases all superseded listeners', async t => {
  const f = fixture(t);
  for (let i = 0; i < 300; i++) {
    f.update(track(`scene-${i}`)); await flush(); f.advance(100);
    assert.ok(f.audios.filter(audio => !audio.removed).length <= 2);
    assert.ok(f.audios.filter(audio => audio.removed).every(audio => audio.paused && !audio.src && !audio.listeners.size));
    assert.ok(f.timers.size <= 1);
  }
  f.advance(1000); assert.equal(f.audios.filter(audio => !audio.removed).length, 1); assert.equal(f.timers.size, 0);
});

test('inactive gameplay, preview, hidden or disconnected sources become silent synchronously', async t => {
  const f = fixture(t);
  f.update(track('menu')); await flush(); f.advance(FADE_MS);
  f.update(track('results')); await flush(); f.advance(100);
  f.update(track('results'), { active: false });
  assert.ok(f.audios.every(audio => audio.paused && !audio.src && audio.removed && !audio.listeners.size));
  assert.equal(f.timers.size, 0); assert.equal(f.statuses.at(-1).state, 'silent');
  f.player.retry(); f.advance(10000); assert.equal(f.audios.length, 2);
  f.update(track('menu')); await flush(); assert.equal(f.audios.length, 3);
});

test('null tracks can fade out while explicit immediate transitions unload immediately', async t => {
  const f = fixture(t, { fadeMs: 1000 });
  f.update(track('menu')); await flush(); f.advance(1000);
  assert.equal(f.player.hasMedia, true);
  f.update(null); f.advance(250); f.update(null); f.advance(250); assert.equal(f.audios[0].volume, .15);
  f.advance(500); assert.equal(f.audios[0].removed, true); assert.equal(f.timers.size, 0);
  assert.equal(f.player.hasMedia, false);
  f.update(track('menu')); await flush(); f.advance(1000);
  f.update(null, { immediate: true }); assert.equal(f.audios[1].removed, true); assert.equal(f.timers.size, 0);
});

test('autoplay failures stay quiet through state revisions and retry only after a user gesture', async t => {
  const options = { playError: Object.assign(new Error('Gesture required'), { name: 'NotAllowedError' }) };
  const f = fixture(t, options);
  f.update(track('menu')); await flush(); assert.equal(f.statuses.at(-1).state, 'blocked');
  for (let i = 0; i < 100; i++) f.update(track('menu'));
  f.advance(20000); assert.equal(f.audios.length, 1); assert.equal(f.timers.size, 0);
  options.playError = null; f.player.retry(); await flush(); f.advance(FADE_MS);
  assert.equal(f.audios.length, 2); assert.equal(f.audios[0].removed, true); assert.equal(f.audios[1].volume, .3);
  assert.equal(f.statuses.at(-1).state, 'playing'); f.player.retry(); assert.equal(f.audios.length, 2);
});

test('decoder errors release failed media and cannot create an automatic download retry loop', async t => {
  const f = fixture(t);
  f.update(track('menu')); await flush(); f.audios[0].emit('error');
  assert.equal(f.audios[0].removed, true); assert.equal(f.audios[0].listeners.size, 0); assert.equal(f.statuses.at(-1).state, 'error');
  for (let i = 0; i < 100; i++) f.update(track('menu'));
  assert.equal(f.audios.length, 1); assert.equal(f.timers.size, 0);
  f.update(track('results')); await flush(); assert.equal(f.audios.length, 2); assert.equal(f.statuses.at(-1).state, 'playing');
});

test('synchronous media creation failures settle in one bounded error state', t => {
  let calls = 0;
  const f = fixture(t, { createAudio: () => { calls++; throw new Error('No media decoder'); } });
  f.update(track('menu'));
  for (let i = 0; i < 100; i++) f.update(track('menu'));
  assert.equal(calls, 1); assert.equal(f.statuses.at(-1).state, 'error');
  assert.equal(f.player.hasMedia, false); assert.equal(f.timers.size, 0);
  f.player.dispose(); f.player.retry(); assert.equal(calls, 1);
});

test('a settled old play promise cannot revive music after track replacement or page disposal', async t => {
  const f = fixture(t, { pending: true });
  f.update(track('menu')); const first = f.audios[0];
  f.update(track('results')); const second = f.audios[1];
  first.resolvePlay(); await flush(); assert.equal(first.paused, true); assert.equal(first.removed, true);
  f.player.dispose(); second.resolvePlay(); await flush(); f.advance(20000);
  assert.equal(second.paused, true); assert.equal(second.volume, 0); assert.equal(second.removed, true); assert.equal(second.listeners.size, 0);
  assert.equal(f.statuses.some(status => status.state === 'playing'), false); assert.equal(f.timers.size, 0);
  f.player.dispose(); f.update(track('menu')); f.player.retry(); assert.equal(f.audios.length, 2);
});

test('disabled, malformed and missing tracks create no media or network requests', t => {
  const f = fixture(t, { enabled: false }); f.update(track('menu')); f.player.retry();
  assert.equal(f.audios.length, 0); assert.equal(f.statuses.at(-1).state, 'muted');
  const invalid = fixture(t);
  for (const next of [{ id: 'a', path: 'https://example.test/a.ogg' }, { path: 'assets/bgm/a.ogg' }, { id: '', path: 'assets/bgm/a.ogg' }]) invalid.update(next);
  assert.equal(invalid.audios.length, 0); assert.equal(invalid.statuses.at(-1).state, 'missing');
  invalid.update(null); assert.equal(invalid.statuses.at(-1).state, 'silent');
});

test('per-track normalization and gain edits fade smoothly without restarting the same source', async t => {
  const f = fixture(t, { gain: .4, fadeMs: 1000 });
  f.update({ ...track('menu'), gain: .5 }); await flush(); f.advance(1000); assert.equal(f.audios[0].volume, .2);
  f.update({ ...track('menu'), gain: 1 }); f.advance(500); assert.ok(Math.abs(f.audios[0].volume - .3) < .0001);
  f.advance(500); assert.equal(f.audios[0].volume, .4); assert.equal(f.audios[0].playCalls, 1); assert.equal(f.timers.size, 0);
});
