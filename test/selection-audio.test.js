const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlayer, phase, safePath, FADE_MS } = require('../public/js/selection-audio');

const songs = ['a', 'b', 'c'].map(id => ({ id, previewAudio: `assets/song-preview/${id}.mp3`, previewDuration: 12 }));
const cue = (id, kind, songIds, startedAt = 1000) => ({ id, kind, songIds, startedAt });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function fixture(t, options = {}) {
  let clock = 1000, serial = 0;
  const timers = new Map(), audios = [], focuses = [], statuses = [];
  class Media {
    constructor() { this.listeners = new Map(); this.volume = 0; this.currentTime = 0; this.duration = 12; this.paused = true; this.playCalls = 0; this.sourceAssignments = 0; this.loadCalls = 0; }
    set src(value) { this.source = value; this.sourceAssignments++; }
    get src() { return this.source; }
    addEventListener(event, callback) { this.listeners.set(event, callback); }
    removeEventListener(event, callback) { if (this.listeners.get(event) === callback) this.listeners.delete(event); }
    emit(event) { this.listeners.get(event)?.(); }
    play() {
      this.playCalls++;
      if (options.playError) return Promise.reject(options.playError);
      this.paused = false; return Promise.resolve();
    }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === 'src') this.source = ''; }
    load() { this.unloaded = true; this.loadCalls++; }
    remove() { this.removed = true; }
  }
  const player = createPlayer({
    now: () => clock,
    setTimer: (callback, delay) => { const id = ++serial; timers.set(id, { callback, at: clock + delay }); return id; },
    clearTimer: id => timers.delete(id),
    createAudio: () => { const media = new Media(); audios.push(media); return media; },
    onFocus: id => focuses.push(id), onStatus: status => statuses.push(status),
    ...options
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
  const update = (nextCue, extra = {}) => player.update({ cue: nextCue, songs, active: true, ...extra });
  return { player, update, audios, focuses, statuses, timers, advance, now: () => clock };
}

test('selection timeline is silent before a cue and resumes or expires at the shared server time', () => {
  assert.equal(phase(null, songs, 5000), null);
  const picked = cue('picks-1', 'picks', ['a', 'b']);
  assert.equal(phase(picked, songs, 1499).pending, true);
  assert.deepEqual(phase(picked, songs, 1500), { songId: 'a', index: 0, offset: 0, duration: 12, cycle: 0 });
  assert.equal(phase(picked, songs, 14500).songId, 'b');
  assert.equal(phase(picked, songs, 14500).offset, 1);
  assert.equal(phase(picked, songs, 25500).complete, true);
  const banned = phase(cue('ban', 'ban', ['a']), songs, 26500);
  assert.equal(banned.songId, 'a'); assert.equal(banned.cycle, 2); assert.equal(banned.offset, 1);
});

test('preview source paths reject remote media, traversal and line breaks', () => {
  for (const path of ['https://example.test/a.mp3', '/assets/song-preview/a.mp3', 'assets/song-preview/../a.mp3', 'assets/song-preview/a.mp3\n', 'assets/song-preview/a.mp3?play=1', 'assets/song/a.mp3']) assert.equal(safePath(path), false, path);
  assert.equal(safePath('assets/song-preview/competition-2026/track_01.mp3'), true);
  assert.equal(safePath('assets/song-preview/track_01.MP3'), true);
});

test('candidate draws create no media, and a ban fades nonlinearly then loops without refocusing the cover', async t => {
  const f = fixture(t);
  f.update(null); f.advance(20000); assert.equal(f.audios.length, 0);
  const banned = cue('ban-a', 'ban', ['a'], f.now());
  f.update(banned); f.advance(FADE_MS - 25); assert.equal(f.audios.length, 1); assert.equal(f.audios[0].playCalls, 0);
  assert.deepEqual(f.focuses.filter(Boolean), []);
  f.advance(25); await flush(); assert.equal(f.audios.length, 1); assert.equal(f.audios[0].src, '/assets/song-preview/a.mp3');
  assert.equal(f.audios[0].volume, 0);
  f.advance(125); assert.ok(f.audios[0].volume > 0 && f.audios[0].volume < .15);
  f.advance(375); assert.equal(f.audios[0].volume, .8);
  f.advance(11250); assert.equal(f.audios[0].volume, .4);
  f.advance(250); await flush();
  assert.equal(f.audios.length, 1); assert.equal(f.audios[0].removed, undefined); assert.equal(f.audios[0].volume, 0);
  assert.equal(f.audios[0].playCalls, 2); assert.equal(f.audios[0].sourceAssignments, 1);
  assert.deepEqual(f.focuses.filter(Boolean), ['a']);
});

test('P1/P2 ban replacement fully fades the old media before the new clip starts, including delayed cue delivery', async t => {
  const f = fixture(t);
  f.update(cue('p1', 'ban', ['a'])); f.advance(1500); await flush();
  const first = f.audios[0]; assert.equal(first.volume, .8);
  f.update(cue('p2', 'ban', ['b'], f.now() - 250));
  f.advance(125); assert.equal(f.audios.length, 2); assert.equal(f.audios[1].playCalls, 0); assert.ok(first.volume > 0 && first.volume < .8);
  f.advance(125); await flush();
  assert.equal(first.paused, true); assert.equal(first.removed, true);
  assert.equal(f.audios.length, 2); assert.equal(f.audios[1].src, '/assets/song-preview/b.mp3');
  assert.deepEqual(f.focuses, ['a', 'b']);
});

test('the two picked previews switch jackets once in order, end after the second, and never replay on state revisions', async t => {
  const f = fixture(t);
  f.update(cue('ban', 'ban', ['c'])); f.advance(1500); await flush();
  const picked = cue('picks', 'picks', ['a', 'b'], f.now());
  f.update(picked); f.advance(FADE_MS); await flush();
  assert.equal(f.audios[0].removed, true); assert.equal(f.audios[1].src, '/assets/song-preview/a.mp3');
  assert.equal(f.audios.length, 3); assert.equal(f.audios[2].playCalls, 0); assert.equal(f.audios[2].volume, 0);
  f.update(picked); f.advance(11000); await flush(); assert.equal(f.audios.length, 3);
  f.advance(1000); await flush(); assert.equal(f.audios.length, 3); assert.equal(f.audios[2].src, '/assets/song-preview/b.mp3');
  assert.equal(f.audios[1].removed, true); assert.deepEqual(f.focuses, ['c', 'a', 'b']);
  assert.equal(f.audios[2].sourceAssignments, 1); assert.equal(f.audios[2].loadCalls, 0); assert.equal(f.audios[2].playCalls, 1);
  f.advance(12000); assert.equal(f.audios[2].removed, true); assert.equal(f.statuses.at(-1).state, 'complete');
  f.update(picked); f.advance(5000); assert.equal(f.audios.length, 3); assert.deepEqual(f.focuses, ['c', 'a', 'b']);
  assert.equal(f.timers.size, 0);
});

test('late OBS loads seek the current pick and do not replay already finished selections', async t => {
  const f = fixture(t);
  f.advance(13500); f.update(cue('picks', 'picks', ['a', 'b'])); await flush();
  assert.equal(f.audios[0].src, '/assets/song-preview/b.mp3'); assert.equal(f.audios[0].currentTime, 1);
  f.advance(11000); assert.equal(f.audios[0].removed, true);
  const expired = fixture(t); expired.advance(30000); expired.update(cue('old', 'picks', ['a', 'b']));
  assert.equal(expired.audios.length, 0); assert.deepEqual(expired.focuses, ['b']); assert.equal(expired.statuses.at(-1).state, 'complete');
});

test('disabled staff previews sequence covers with no audio objects or network loads', t => {
  const f = fixture(t, { enabled: false, createAudio: () => { throw new Error('Disabled player must not create audio'); } });
  f.update(cue('picks', 'picks', ['a', 'b'])); f.advance(FADE_MS); assert.deepEqual(f.focuses, ['a']);
  f.advance(12000); assert.deepEqual(f.focuses, ['a', 'b']);
  f.advance(12000); assert.equal(f.statuses.at(-1).state, 'complete'); assert.equal(f.audios.length, 0);
});

test('scene exit fades and unloads audio, while rapid newer cues cancel stale delayed starts', async t => {
  const f = fixture(t);
  f.update(cue('a', 'ban', ['a'])); f.advance(100);
  f.update(cue('b', 'ban', ['b'], f.now())); f.advance(100);
  f.update(cue('c', 'ban', ['c'], f.now())); f.advance(FADE_MS); await flush();
  assert.equal(f.audios.length, 3); assert.equal(f.audios[2].src, '/assets/song-preview/c.mp3');
  assert.ok(f.audios.slice(0, 2).every(audio => audio.removed && audio.playCalls === 0));
  f.advance(1000); f.update(null, { active: false }); assert.ok(f.audios[2].volume > 0);
  f.advance(250); assert.ok(f.audios[2].volume > 0 && f.audios[2].volume < .8);
  f.advance(250); assert.equal(f.audios[2].removed, true); assert.equal(f.focuses.at(-1), null); assert.equal(f.timers.size, 0);
});

test('autoplay rejection is caught once, remains quiet across loops, and retries only from the current position', async t => {
  const denial = Object.assign(new Error('Gesture required'), { name: 'NotAllowedError' });
  const opts = { playError: denial }, f = fixture(t, opts);
  f.update(cue('ban', 'ban', ['a'])); f.advance(FADE_MS); await flush();
  assert.equal(f.statuses.at(-1).state, 'blocked'); assert.equal(f.audios[0].paused, true);
  f.advance(12500); assert.equal(f.audios.length, 1);
  opts.playError = null; f.player.retry(); await flush();
  assert.equal(f.audios.length, 2); assert.equal(f.audios[1].currentTime, .5); assert.equal(f.statuses.at(-1).state, 'playing');
});

test('missing and failed media do not stall the second pick or retry broken downloads every loop', async t => {
  const f = fixture(t);
  f.update(cue('picks', 'picks', ['a', 'b']), { songs: [{ id: 'a' }, songs[1]] });
  f.advance(FADE_MS); assert.equal(f.statuses.at(-1).state, 'missing'); assert.equal(f.audios.length, 0);
  f.advance(12000); await flush(); assert.equal(f.audios[0].src, '/assets/song-preview/b.mp3');
  const broken = fixture(t); broken.update(cue('broken', 'ban', ['a'])); broken.advance(FADE_MS); await flush();
  broken.audios[0].emit('error'); assert.equal(broken.statuses.at(-1).state, 'error');
  broken.advance(24000); assert.equal(broken.audios.length, 1);
});

test('custom 10 and 15 second files use decoded metadata rather than inserting silence at the 12 second default', async t => {
  const f = fixture(t), unknown = songs.map(({ previewDuration, ...song }) => song);
  const picked = cue('custom', 'picks', ['a', 'b']);
  f.update(picked, { songs: unknown }); f.advance(FADE_MS); await flush();
  f.audios[0].duration = 10; f.audios[0].emit('loadedmetadata');
  f.advance(10000); await flush(); assert.equal(f.audios.length, 2); assert.equal(f.audios[1].src, '/assets/song-preview/b.mp3');
  f.audios[1].duration = 15; f.audios[1].emit('loadedmetadata');
  f.update(picked, { songs: unknown }); f.advance(14975); assert.equal(f.audios[1].removed, undefined);
  f.advance(25); assert.equal(f.audios[1].removed, true); assert.equal(f.statuses.at(-1).state, 'complete');
});

test('pending metadata primes actual durations without starting playback or changing the cover before the cue', async t => {
  const f = fixture(t);
  f.update(cue('warm-picks', 'picks', ['a', 'b']));
  const first = f.audios[0];
  first.duration = 10; first.emit('loadedmetadata');
  assert.equal(first.preload, 'auto'); assert.equal(first.playCalls, 0); assert.deepEqual(f.focuses, []);
  f.advance(FADE_MS - 25); assert.equal(first.playCalls, 0); assert.equal(f.audios.length, 1);
  f.advance(25); await flush();
  const second = f.audios[1]; second.duration = 15; second.emit('loadedmetadata');
  assert.equal(first.playCalls, 1); assert.equal(second.playCalls, 0); assert.deepEqual(f.focuses, ['a']);
  assert.equal(f.player.phase.duration, 10);
  f.advance(9975); assert.equal(second.playCalls, 0);
  f.advance(25); await flush(); assert.equal(second.playCalls, 1); assert.equal(f.player.phase.duration, 15);
  assert.deepEqual(f.focuses, ['a', 'b']); assert.equal(second.sourceAssignments, 1); assert.equal(second.loadCalls, 0);
  f.advance(15000); assert.equal(second.removed, true); assert.equal(f.statuses.at(-1).state, 'complete');
});

test('queued second clips are unloaded on replacement, scene exit and disposal with bounded live media', async t => {
  const f = fixture(t);
  f.update(cue('picks', 'picks', ['a', 'b'])); f.advance(FADE_MS); await flush();
  const first = f.audios[0], second = f.audios[1];
  assert.equal(second.playCalls, 0);
  f.update(cue('new-ban', 'ban', ['c'], f.now()));
  assert.equal(second.removed, true); assert.equal(second.playCalls, 0);
  assert.equal(f.audios.filter(audio => !audio.removed).length, 2);
  f.advance(FADE_MS); await flush(); assert.equal(first.removed, true);
  f.update(cue('picks-again', 'picks', ['a', 'b'], f.now())); f.advance(FADE_MS); await flush();
  assert.ok(f.audios.filter(audio => !audio.removed).length <= 3);
  const queued = f.audios.at(-1); assert.equal(queued.playCalls, 0);
  f.update(null, { active: false }); assert.equal(queued.removed, true);
  f.player.dispose(); assert.ok(f.audios.every(audio => audio.removed));
  assert.equal(queued.playCalls, 0); assert.equal(f.timers.size, 0);
});

test('a failed prepared clip leaves the first pick running and is not fetched again at the switch', async t => {
  const f = fixture(t);
  f.update(cue('picks', 'picks', ['a', 'b'])); f.advance(FADE_MS); await flush();
  const first = f.audios[0], second = f.audios[1];
  second.emit('error'); assert.equal(second.removed, true); assert.equal(first.paused, false);
  assert.equal(f.statuses.at(-1).songId, 'a');
  f.advance(12000); assert.equal(f.audios.length, 2); assert.equal(second.playCalls, 0);
  assert.equal(f.statuses.at(-1).state, 'error'); assert.equal(f.statuses.at(-1).songId, 'b');
});

test('dispose cancels every timer and pending playback promises cannot revive old audio', async t => {
  const f = fixture(t);
  f.update(cue('ban', 'ban', ['a'])); f.advance(FADE_MS);
  // The initial play promise is still pending when the player is disposed.
  f.player.dispose(); await flush(); f.advance(20000);
  assert.equal(f.audios[0].removed, true); assert.equal(f.timers.size, 0);
  assert.equal(f.statuses.some(status => status.state === 'playing'), false);
});
