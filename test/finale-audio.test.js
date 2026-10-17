const test = require('node:test');
const assert = require('node:assert/strict');
const FinalAnnouncement = require('../public/js/final-announcement');
const { createPlayer, phase } = require('../public/js/selection-audio');
const CompetitionConfig = require('../public/js/competition-config');
const manifest = require('../public/assets/song-preview/manifest.json');

const startedAt = 1000;
const match = {
  id: 'GF', finalMode: 'fixed-two',
  finalAnnouncement: { id: '12345678-1234-4234-8234-123456789abc', startedAt },
  songs: CompetitionConfig.FINAL_SONG_IDS.map(id => CompetitionConfig.LIBRARY.find(song => song.id === id))
};
const songs = match.songs.map(song => {
  const track = manifest.tracks.find(track => track.songIds.includes(song.id));
  return { ...song, previewAudio: track.output, previewDuration: track.duration };
});
const cue = FinalAnnouncement.audioCue(match);
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function fixture(t, options = {}) {
  let clock = options.clock ?? startedAt, serial = 0;
  const timers = new Map(), audios = [], statuses = [], focuses = [];
  class Media {
    constructor() { this.volume = 0; this.currentTime = 0; this.paused = true; this.playCalls = 0; this.listeners = new Map(); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name, callback) { if (this.listeners.get(name) === callback) this.listeners.delete(name); }
    play() {
      this.playCalls++;
      if (options.denied) return Promise.reject(Object.assign(new Error('Gesture required'), { name: 'NotAllowedError' }));
      this.paused = false; return Promise.resolve();
    }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    load() { this.unloaded = true; }
    remove() { this.removed = true; }
  }
  const player = createPlayer({
    now: () => clock, enabled: options.enabled,
    createAudio: () => { const audio = new Media(); audios.push(audio); return audio; },
    setTimer: (callback, delay) => { const id = ++serial; timers.set(id, { callback, at: clock + delay }); return id; },
    clearTimer: id => timers.delete(id),
    onStatus: status => statuses.push(status), onFocus: songId => focuses.push(songId)
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
  return { player, audios, statuses, focuses, timers, advance,
    update: (active = true, extra = {}) => player.update({ cue, songs, active, ...extra }) };
}

test('the persisted final cue plays Desultory then Petrichor once, with bounded media and no replay on state revisions', async t => {
  const f = fixture(t);
  f.update();
  assert.equal(f.audios.length, 1); assert.equal(f.audios[0].playCalls, 0);
  f.advance(FinalAnnouncement.LEAD_MS); await flush();
  assert.equal(f.audios[0].src, '/' + songs[0].previewAudio);
  assert.equal(f.audios[0].playCalls, 1); assert.equal(f.audios[0].volume, 0);
  assert.equal(f.audios.length, 2); assert.equal(f.audios[1].playCalls, 0);
  f.advance(1000); assert.equal(f.audios[0].volume, .8);
  for (let index = 0; index < 100; index++) f.update();
  assert.equal(f.audios[0].playCalls, 1); assert.equal(f.audios.length, 2);
  f.advance(FinalAnnouncement.DURATIONS[0] * 1000 - 1000 + 25); await flush();
  assert.equal(f.audios[0].removed, true); assert.equal(f.audios[0].listeners.size, 0);
  assert.equal(f.audios[1].src, '/' + songs[1].previewAudio); assert.equal(f.audios[1].playCalls, 1);
  assert.deepEqual(f.focuses, CompetitionConfig.FINAL_SONG_IDS);
  f.advance(FinalAnnouncement.DURATIONS[1] * 1000 + 25);
  assert.equal(f.statuses.at(-1).state, 'complete'); assert.equal(f.player.hasMedia, false);
  for (let index = 0; index < 100; index++) f.update();
  f.advance(60000); assert.equal(f.audios.length, 2); assert.equal(f.timers.size, 0);
  assert.ok(f.audios.every(audio => audio.removed && audio.paused && !audio.src && !audio.listeners.size));
});

test('late joins and a completed-page refresh follow the final clock rather than replaying the announcement', async t => {
  const secondAt = startedAt + FinalAnnouncement.LEAD_MS + FinalAnnouncement.DURATIONS[0] * 1000;
  const late = fixture(t, { clock: secondAt + 1300 });
  late.update(); await flush();
  assert.equal(late.audios.length, 1); assert.equal(late.audios[0].src, '/' + songs[1].previewAudio);
  assert.ok(Math.abs(late.audios[0].currentTime - 1.3) < .000001);
  assert.deepEqual(late.focuses, [songs[1].id]);
  const complete = fixture(t, { clock: secondAt + FinalAnnouncement.DURATIONS[1] * 1000 + 1 });
  complete.update(); complete.advance(60000);
  assert.equal(complete.audios.length, 0); assert.equal(complete.statuses.at(-1).state, 'complete');
  assert.equal(complete.player.hasMedia, false); assert.equal(complete.timers.size, 0);
});

test('an autoplay retry joins the current final song and preview-only pages allocate no audio', async t => {
  const options = { denied: true }, f = fixture(t, options);
  f.update(); f.advance(FinalAnnouncement.LEAD_MS); await flush();
  assert.equal(f.statuses.at(-1).state, 'blocked');
  f.advance(FinalAnnouncement.DURATIONS[0] * 1000 + 1250);
  options.denied = false; f.player.retry(); await flush();
  assert.equal(f.audios.at(-1).src, '/' + songs[1].previewAudio);
  assert.ok(Math.abs(f.audios.at(-1).currentTime - 1.25) < .000001);
  assert.equal(f.statuses.at(-1).state, 'playing');
  const muted = fixture(t, { enabled: false });
  muted.update(); muted.advance(FinalAnnouncement.LEAD_MS + FinalAnnouncement.DURATIONS[0] * 1000 + 25);
  muted.player.retry(); assert.equal(muted.audios.length, 0);
  assert.deepEqual(muted.focuses, CompetitionConfig.FINAL_SONG_IDS);
});

test('leaving the final keeps audio ownership until fade-out then releases all media, timers and listeners', async t => {
  const f = fixture(t);
  f.update(); f.advance(FinalAnnouncement.LEAD_MS); await flush(); f.advance(1000);
  f.update(false);
  assert.equal(f.player.hasMedia, true); assert.equal(f.audios[1].removed, true);
  f.advance(250); assert.ok(f.audios[0].volume > 0 && f.audios[0].volume < .8);
  f.advance(250); assert.equal(f.player.hasMedia, false); assert.equal(f.timers.size, 0);
  assert.ok(f.audios.every(audio => audio.removed && audio.paused && !audio.src && !audio.listeners.size));
  const disposed = fixture(t);
  disposed.update(); disposed.advance(FinalAnnouncement.LEAD_MS); await flush();
  disposed.player.dispose(); disposed.advance(60000); disposed.player.retry();
  assert.equal(disposed.timers.size, 0); assert.equal(disposed.player.hasMedia, false);
  assert.ok(disposed.audios.every(audio => audio.removed && audio.paused && !audio.src && !audio.listeners.size));
});

test('fixed final clip windows override longer custom files and decoded metadata to keep both reveals synchronized', async t => {
  const f = fixture(t);
  const customSongs = songs.map(song => ({ ...song, previewDuration: 30 }));
  f.update(true, { songs: customSongs });
  const first = f.audios[0]; first.duration = 30; first.listeners.get('loadedmetadata')();
  assert.equal(f.player.phase.duration, FinalAnnouncement.PREVIEW_DURATION);
  f.advance(FinalAnnouncement.LEAD_MS); await flush();
  const second = f.audios[1]; second.duration = 45; second.listeners.get('loadedmetadata')();
  assert.equal(first.playCalls, 1); assert.equal(second.playCalls, 0);
  // The metadata remains cached across ordinary state revisions, but cannot
  // extend a fixed reveal window or keep Desultory playing under Petrichor.
  f.update(true, { songs: customSongs });
  f.advance(FinalAnnouncement.DURATIONS[0] * 1000 + 25); await flush();
  assert.equal(first.paused, true); assert.equal(first.removed, true); assert.equal(first.src, '');
  assert.equal(second.playCalls, 1); assert.equal(f.player.phase.songId, songs[1].id);
  assert.equal(f.player.phase.duration, FinalAnnouncement.PREVIEW_DURATION);
  f.advance(FinalAnnouncement.DURATIONS[1] * 1000 + 25);
  assert.equal(second.paused, true); assert.equal(second.removed, true);
  assert.equal(f.player.hasMedia, false); assert.equal(f.timers.size, 0);
});

test('optional fixed clip durations reject malformed or unbounded cue windows', () => {
  const now = startedAt + FinalAnnouncement.LEAD_MS;
  for (const durations of [null, [], [12], new Array(2), [12, 0], [12, -1], [12, Infinity], [12, NaN], [12, 601], ['12', 12]]) {
    assert.equal(phase({ ...cue, durations }, songs, now), null, JSON.stringify(durations));
  }
  const valid = phase({ ...cue, durations: [10, 15] }, songs, now + 11000);
  assert.equal(valid.songId, songs[1].id); assert.equal(valid.duration, 15); assert.equal(valid.offset, 1);
});
