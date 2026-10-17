const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createDefaultState } = require('../lib/default-state');
const { createDefaultState: legacyState } = require('./helpers/legacy-state');
const { applyAction, CURRENT_MATCH_ACTIONS, publicState, resultCorrectionImpact } = require('../lib/tournament');
const { validateState } = require('../lib/state-validation');
const { scorekeeperState, scorekeeperAction } = require('../lib/scorekeeper');
const { StateStore } = require('../lib/store');
const Config = require('../public/js/competition-config');
const Final = require('../public/js/final-announcement');
const SelectionAudio = require('../public/js/selection-audio');

const NOW = 1800000000000;
const UUID = 'babc4f22-b327-40fa-9eb4-5a20265c7421';
const find = (state, id = 'GF') => state.tournament.matches.find(match => match.id === id);
function act(state, type, payload = {}) {
  const next = structuredClone(state);
  applyAction(next, { type, payload: CURRENT_MATCH_ACTIONS.has(type) ? { matchId: next.tournament.currentMatchId, ...payload } : payload });
  validateState(next); Object.assign(state, next); return state;
}
function finish(state, tied = false) {
  const match = find(state, state.tournament.currentMatchId);
  for (const playerIndex of [0, 1]) for (let songIndex = 0; songIndex < match.songs.length; songIndex++) {
    act(state, 'set-match-score', { playerIndex, songIndex, score: tied || !playerIndex ? 990000 : 980000,
      judgements: { accuracy: 99 } });
  }
  if (!tied) act(state, 'record-result', { verified: true });
}
let readyFixture;
function finalReady() {
  if (!readyFixture) {
    const state = createDefaultState();
    act(state, 'seed-bracket', { ids: state.qualifier.players.slice(0, 8).map(player => player.id) });
    for (let index = 0; index < 13; index++) {
      const match = state.tournament.matches.find(match => match.id !== 'GF' && ['ready', 'live'].includes(match.status));
      assert.ok(match, 'The temporary tournament must reach every pre-final match');
      act(state, 'select-match', { matchId: match.id }); act(state, 'draw-candidates');
      for (const playerIndex of [0, 1]) act(state, 'ban-song', { playerIndex, songId: null, confirmed: true });
      act(state, 'pick-songs'); finish(state);
    }
    act(state, 'select-match', { matchId: 'GF' }); readyFixture = state;
  }
  return structuredClone(readyFixture);
}
function timedMatch() {
  const state = finalReady(); find(state).finalAnnouncement = { id: UUID, startedAt: NOW }; return find(state);
}
function unchanged(state, operation, pattern) {
  const before = structuredClone(state); assert.throws(operation, pattern); assert.deepEqual(state, before);
}

test('final announcement helper runs identically in Node and a browser without timers or DOM access', () => {
  assert.deepEqual(Final.DURATIONS, [12.042449, 12.042449]); assert.equal(Final.LEAD_MS, 500);
  const sandbox = { CompetitionConfig: Config };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/final-announcement.js'), 'utf8'), sandbox);
  const browser = sandbox.BroadcastFinalAnnouncement, match = timedMatch();
  assert.equal(typeof browser.phase, 'function');
  for (const now of [NOW - 1, NOW, NOW + 500, NOW + 5000, NOW + 15000, NOW + 30000]) {
    assert.deepEqual(JSON.parse(JSON.stringify(browser.phase(match, now))), Final.phase(match, now));
  }
});

test('only the ordered fixed Grand Final can generate the persisted two-song preview cue', () => {
  const match = timedMatch(); assert.equal(Final.isFixed(match), true);
  const cue = Final.audioCue(match);
  assert.equal(cue.kind, 'picks'); assert.equal(cue.startedAt, NOW);
  assert.deepEqual(cue.songIds, Config.FINAL_SONG_IDS);
  assert.equal(typeof cue.id, 'string'); assert.ok(cue.id.length);
  assert.deepEqual(Final.audioCue(structuredClone(match)), cue, 'Reloading must retain the same audio cue identity');
  for (const invalid of [null, {}, { ...match, id: 'W1' }, { ...match, finalMode: undefined },
    { ...match, songs: match.songs.slice(0, 1) }, { ...match, songs: [...match.songs].reverse() }]) {
    assert.equal(Final.isFixed(invalid), false); assert.equal(Final.audioCue(invalid), null);
  }
  const unstarted = structuredClone(match); delete unstarted.finalAnnouncement;
  assert.equal(Final.audioCue(unstarted), null); assert.equal(Final.phase(unstarted, NOW).started, false);
  assert.equal(Final.phase(unstarted, NOW).index, 0);
});

test('both reveals follow one shared clock, preserve order and finish without looping or mutating tournament state', () => {
  const match = timedMatch(), before = structuredClone(match);
  const first = NOW + Final.LEAD_MS, second = first + Final.DURATIONS[0] * 1000;
  const end = second + Final.DURATIONS[1] * 1000;
  const pending = Final.phase(match, NOW);
  assert.equal(pending.started, true); assert.equal(pending.pending, true); assert.equal(pending.index, 0);
  const song1 = Final.phase(match, first + 1);
  assert.equal(song1.pending, false); assert.equal(song1.index, 0); assert.equal(song1.complete, false);
  assert.equal(song1.revealedCount, 1);
  assert.equal(Final.phase(match, second - 1).index, 0);
  const song2 = Final.phase(match, second + 1);
  assert.equal(song2.index, 1); assert.equal(song2.revealedCount, 2); assert.equal(song2.complete, false);
  assert.ok(Math.abs(song2.stageStartedAt - second) < 1);
  for (const now of [end + 1, end + 600000]) {
    const done = Final.phase(match, now); assert.equal(done.index, 1); assert.equal(done.complete, true);
    assert.equal(done.revealedCount, 2); assert.equal(done.coverage, 2 / 3);
  }
  let previous = 0;
  for (let now = NOW; now <= end + 1000; now += 125) {
    const phase = Final.phase(match, now);
    assert.ok(phase.coverage >= previous && phase.coverage >= 0 && phase.coverage <= 2 / 3);
    previous = phase.coverage;
  }
  assert.deepEqual(match, before, 'Visual time advancement must not write score cursors or state');
});

test('visual song changes and audio preview changes remain synchronized after seeking or source reload', () => {
  const match = timedMatch(), cue = Final.audioCue(match);
  const songs = match.songs.map((song, index) => ({ ...song, previewDuration: Final.DURATIONS[index] }));
  for (const elapsed of [0, 100, 501, 4000, 12000, 12543, 15000, 23000, 24586, 100000]) {
    const visual = Final.phase(match, NOW + elapsed), audio = SelectionAudio.phase(cue, songs, NOW + elapsed);
    assert.equal(visual.index, audio.index, `Song order must agree at ${elapsed}ms`);
    assert.equal(Boolean(visual.pending), Boolean(audio.pending));
    assert.equal(Boolean(visual.complete), Boolean(audio.complete));
    assert.equal(audio.songId, Config.FINAL_SONG_IDS[visual.index]);
  }
});

test('entering the real ready final starts once, reentry preserves timing, and standalone previews do not contaminate an event', () => {
  const state = finalReady(); act(state, 'set-song-progress', { index: 1 });
  const before = Date.now();
  act(state, 'set-broadcast-cue', { stage: 'double-elimination', scene: 'grand-final-announcement', matchId: 'GF' });
  const final = find(state), cue = structuredClone(final.finalAnnouncement);
  assert.ok(cue.startedAt >= before && cue.startedAt <= Date.now());
  assert.equal(final.currentSong, 1, 'The announcement must not replace the live score cursor');
  assert.equal(state.scene, 'grand-final-announcement'); assert.equal(state.stage, 'double-elimination');
  for (const scene of ['bracket', 'double-elimination-waiting', 'double-elimination-match', 'song-result']) {
    const payload = { stage: 'double-elimination', scene, matchId: 'GF', ...(scene === 'bracket' ? {} : { songIndex: 1 }) };
    act(state, 'set-broadcast-cue', payload);
    assert.deepEqual(find(state).finalAnnouncement, cue, 'Infection remains active throughout the final');
    act(state, 'set-scene', { scene: 'grand-final-announcement' }); assert.deepEqual(find(state).finalAnnouncement, cue);
  }
  assert.deepEqual(find(publicState(state)).finalAnnouncement, cue, 'OBS receives the persisted shared clock');
  assert.equal(scorekeeperState(state).match.finalAnnouncement, undefined, 'The scorer receives no announcement controls or clock');
  for (const preview of [createDefaultState(), (() => {
    const copy = createDefaultState(); act(copy, 'seed-bracket', { ids: copy.qualifier.players.slice(0, 8).map(player => player.id) }); return copy;
  })()]) {
    act(preview, 'set-scene', { scene: 'grand-final-announcement' });
    assert.ok(preview.tournament.matches.every(match => match.finalAnnouncement === undefined));
  }
});

test('explicit replay and jump-to-second restart the shared clock without changing the selected gameplay song', () => {
  const state = finalReady(); act(state, 'set-song-progress', { index: 1 });
  act(state, 'start-final-announcement', { matchId: 'GF', songIndex: 0 });
  const first = structuredClone(find(state).finalAnnouncement);
  assert.equal(find(state).currentSong, 1); assert.equal(Final.phase(find(state), Date.now()).index, 0);
  act(state, 'start-final-announcement', { matchId: 'GF', songIndex: 0 });
  assert.notEqual(find(state).finalAnnouncement.id, first.id, 'A deliberate replay has a fresh cue identity');
  const before = Date.now(); act(state, 'start-final-announcement', { matchId: 'GF', songIndex: 1 });
  const phase = Final.phase(find(state), Date.now());
  assert.equal(phase.index, 1); assert.equal(phase.complete, false); assert.equal(find(state).currentSong, 1);
  const shift = Math.ceil(Final.LEAD_MS + Final.DURATIONS[0] * 1000);
  assert.ok(find(state).finalAnnouncement.startedAt >= before - shift);
  assert.ok(find(state).finalAnnouncement.startedAt <= Date.now() - shift);
  assert.equal(state.scene, 'grand-final-announcement');
});

test('announcement commands reject stale matches, invalid song numbers, unavailable or legacy finals and active tiebreaks', () => {
  const state = finalReady();
  for (const payload of [{ matchId: 'W1', songIndex: 0 }, { matchId: 'unknown', songIndex: 0 },
    ...[-1, 2, 0.5, '1', null].map(songIndex => ({ matchId: 'GF', songIndex }))]) {
    unchanged(state, () => act(state, 'start-final-announcement', payload));
  }
  unchanged(state, () => applyAction(state, { type: 'start-final-announcement', payload: { songIndex: 0 } }));
  const unready = createDefaultState(); act(unready, 'seed-bracket', { ids: unready.qualifier.players.slice(0, 8).map(player => player.id) });
  unchanged(unready, () => act(unready, 'start-final-announcement', { matchId: 'GF', songIndex: 0 }));
  const old = legacyState(); act(old, 'seed-bracket', { ids: old.qualifier.players.slice(0, 8).map(player => player.id) });
  unchanged(old, () => act(old, 'start-final-announcement', { matchId: 'GF', songIndex: 0 }));
  finish(state, true); act(state, 'draw-match-tiebreak');
  unchanged(state, () => act(state, 'start-final-announcement', { matchId: 'GF', songIndex: 0 }));
  unchanged(state, () => act(state, 'set-broadcast-cue', { stage: 'double-elimination', scene: 'grand-final-announcement', matchId: 'GF' }));
  const announced = finalReady(); act(announced, 'start-final-announcement', { matchId: 'GF', songIndex: 0 });
  finish(announced, true); act(announced, 'draw-match-tiebreak');
  unchanged(announced, () => act(announced, 'set-scene', { scene: 'grand-final-announcement' }));
  unchanged(announced, () => act(announced, 'set-broadcast-cue', {
    stage: 'double-elimination', scene: 'grand-final-announcement', matchId: 'GF' }));
});

test('malformed persisted announcement markers cannot be restored as valid tournament data', () => {
  const state = finalReady(); find(state).finalAnnouncement = { id: UUID, startedAt: NOW }; validateState(state);
  for (const bad of [null, [], {}, { id: UUID }, { startedAt: NOW }, { id: 'not-a-uuid', startedAt: NOW },
    { id: UUID, startedAt: -1 }, { id: UUID, startedAt: 0.1 }, { id: UUID, startedAt: '1000' },
    { id: UUID, startedAt: Infinity }, { id: UUID, startedAt: 8640000000000001 },
    { id: UUID, startedAt: NOW, privateNote: 'Unknown cue metadata' }]) {
    const damaged = structuredClone(state); find(damaged).finalAnnouncement = bad;
    assert.throws(() => validateState(damaged), /finalAnnouncement/);
  }
  const wrongMatch = structuredClone(state); find(wrongMatch, 'W1').finalAnnouncement = { id: UUID, startedAt: NOW };
  assert.throws(() => validateState(wrongMatch), /finalAnnouncement/);
  const old = legacyState(); act(old, 'seed-bracket', { ids: old.qualifier.players.slice(0, 8).map(player => player.id) });
  find(old).finalAnnouncement = { id: UUID, startedAt: NOW };
  assert.throws(() => validateState(old), /finalAnnouncement/);
});

test('announced finals retain contamination in results and clear it only when reset or reopened', () => {
  const state = finalReady(); act(state, 'start-final-announcement', { matchId: 'GF', songIndex: 0 });
  act(state, 'reset-current-match'); assert.equal(find(state).finalAnnouncement, undefined);
  assert.deepEqual(find(state).songs.map(song => song.id), Config.FINAL_SONG_IDS);
  act(state, 'start-final-announcement', { matchId: 'GF', songIndex: 0 });
  const cue = structuredClone(find(state).finalAnnouncement); finish(state);
  assert.deepEqual(find(state).finalAnnouncement, cue);
  assert.deepEqual(find(publicState(state)).finalAnnouncement, cue);
  unchanged(state, () => act(state, 'start-final-announcement', { matchId: 'GF', songIndex: 0 }));
  const impact = resultCorrectionImpact(state, 'GF');
  act(state, 'reopen-result', { matchId: 'GF', affectedMatchIds: impact.affectedMatchIds, reason: 'Fixture referee rechecks the final scores' });
  assert.equal(find(state).finalAnnouncement, undefined);
});

test('invalid and stale commands do not write a partial announcement; reloads retain elapsed playback instead of replaying', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-final-announcement-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let store = new StateStore(dir); store.state = finalReady(); store.write(store.state);
  const revision = store.state.revision;
  store.commit({ type: 'start-final-announcement', payload: { matchId: 'GF', songIndex: 0 } }, revision);
  const cue = structuredClone(find(store.state).finalAnnouncement), saved = fs.readFileSync(store.file, 'utf8');
  const backups = store.listBackups().length;
  assert.throws(() => store.commit({ type: 'start-final-announcement', payload: { matchId: 'GF', songIndex: 1 } }, revision), error => error.code === 'STALE');
  assert.throws(() => store.commit({ type: 'start-final-announcement', payload: { matchId: 'W1', songIndex: 0 } }, store.state.revision));
  assert.throws(() => store.commit({ type: 'start-final-announcement', payload: { matchId: 'GF', songIndex: 2 } }, store.state.revision));
  assert.equal(fs.readFileSync(store.file, 'utf8'), saved); assert.equal(store.listBackups().length, backups);
  store = new StateStore(dir); assert.deepEqual(find(store.state).finalAnnouncement, cue);
  const exported = JSON.parse(JSON.stringify(publicState(store.state))); assert.deepEqual(find(exported).finalAnnouncement, cue);
  const finishedAt = cue.startedAt + Final.LEAD_MS + Final.DURATIONS.reduce((sum, seconds) => sum + seconds * 1000, 0) + 1000;
  assert.equal(Final.phase(find(exported), finishedAt).complete, true);
  assert.deepEqual(find(store.state).finalAnnouncement, cue); assert.equal(fs.readFileSync(store.file, 'utf8'), saved);
});

test('scorekeepers can enter final scores but cannot start, replay or skip announcements', () => {
  const state = finalReady();
  const contextKey = scorekeeperState(state).contextKey;
  for (const songIndex of [0, 1]) assert.throws(() => scorekeeperAction(state, { contextKey,
    action: { type: 'start-final-announcement', payload: { matchId: 'GF', songIndex } } }), error => error.code === 'FORBIDDEN');
  const result = scorekeeperAction(state, { contextKey, action: { type: 'set-match-score',
    payload: { matchId: 'GF', playerIndex: 0, songIndex: 1, score: 987654 } } });
  act(state, result.type, result.payload); assert.equal(find(state).scores[0][1], 987654);
});
