const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDefaultState } = require('../lib/default-state');
const { createDefaultState: legacyState } = require('./helpers/legacy-state');
const { applyAction, CURRENT_MATCH_ACTIONS } = require('../lib/tournament');
const { validateState } = require('../lib/state-validation');
const { StateStore } = require('../lib/store');
const SongPool = require('../public/js/song-pool');
const CompetitionConfig = require('../public/js/competition-config');

// Independent copy of the organiser's published constants. Assertions must not
// derive difficulty bands from the implementation being tested.
const CONSTANTS = [16.1, 16.1, 16.2, 16.2, 16.3, 16.3, 16.3, 16.3,
  16.4, 16.4, 16.4, 16.4, 16.5, 16.5, 16.5, 16.5,
  16.6, 16.6, 16.6, 16.6, 16.6, 16.6, 16.7, 16.7, 16.7,
  16.8, 16.8, 16.8, 16.8, 16.9, 16.9, 16.9, 16.9,
  17.0, 17.1, 17.2, 17.3, 17.3, 17.3, 17.4, 17.4, 17.5];
function constant(song) {
  const found = /^competition-2026-de-(\d+)$/.exec(song.id);
  return found ? CONSTANTS[Number(found[1]) - 1] : song.constant;
}
function act(state, type, payload = {}) {
  const next = structuredClone(state);
  applyAction(next, { type, payload: CURRENT_MATCH_ACTIONS.has(type) ?
    { matchId: next.tournament.currentMatchId, ...payload } : payload });
  validateState(next); Object.assign(state, next); return state;
}
function seed(state = createDefaultState()) {
  act(state, 'seed-bracket', { ids: state.qualifier.players.map(player => player.id), ruleset: 'proposal-2026' });
  return state;
}
const current = state => state.tournament.matches.find(match => match.id === state.tournament.currentMatchId);
function checkCandidates(match) {
  assert.equal(match.candidates.length, 6, match.id);
  assert.equal(SongPool.distinct(match.candidates).length, 6, match.id);
  const values = match.candidates.map(constant);
  assert.ok(values.every(Number.isFinite), `${match.id}: every candidate needs an exact constant`);
  const low = values.filter(value => value <= 16.5).length;
  const high = values.filter(value => value >= 16.9).length;
  if (match.round === 1) { assert.ok(low >= 3, match.id); assert.ok(high <= 1, match.id); }
  if (match.round === 2) { assert.ok(low >= 1, match.id); assert.ok(high <= 2, match.id); }
  if (match.round === 3) assert.ok(low <= 1, match.id);
  if (match.round === 4) { assert.equal(low, 0, match.id); assert.ok(high >= 3, match.id); }
  if (match.round === 5) assert.ok(values.every(value => value >= 16.9), `${match.id}: R5 has no low/mid charts`);
}
function choose(state, id) {
  act(state, 'select-match', { matchId: id }); act(state, 'draw-candidates');
  checkCandidates(current(state));
  const banned = current(state).candidates.slice(0, 2).map(song => structuredClone(song));
  for (const playerIndex of [0, 1]) act(state, 'ban-song', { playerIndex, songId: banned[playerIndex].id });
  act(state, 'pick-songs');
  assert.equal(current(state).songs.length, 2);
  assert.ok(current(state).songs.every(song => !banned.some(item => SongPool.sameSong(item, song))));
  assert.ok(banned.every(song => SongPool.isAvailable(state, song, id === 'W1' ? 'W2' : 'W1')),
    `${id}: bans do not reserve candidates for play`);
  return current(state);
}
function fill(state, tied = false, winnerIndex = 0) {
  for (const playerIndex of [0, 1]) for (let songIndex = 0; songIndex < current(state).songs.length; songIndex++)
    act(state, 'set-match-score', { playerIndex, songIndex,
      score: tied || playerIndex === winnerIndex ? 990000 : 980000,
      judgements: { accuracy: tied || playerIndex === winnerIndex ? 99 : 98 } });
}
function complete(state, id, winnerIndex = 0) {
  choose(state, id); fill(state, false, winnerIndex); act(state, 'record-result', { verified: true });
}
function until(state, id) {
  for (const match of state.tournament.matches) {
    if (match.id === id) { act(state, 'select-match', { matchId: id }); return state; }
    complete(state, match.id);
  }
  throw new Error(`Unknown fixture stop ${id}`);
}
function temporaryStore(t, state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-difficulty-draw-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new StateStore(dir); store.state = structuredClone(state); store.write(store.state);
  return { dir, store };
}
function unchangedStore(store, action, pattern) {
  const before = structuredClone(store.state), bytes = fs.readFileSync(store.file), files = fs.readdirSync(store.backupDir);
  assert.throws(() => store.commit(action, store.state.revision), pattern);
  assert.deepEqual(store.state, before); assert.deepEqual(fs.readFileSync(store.file), bytes);
  assert.deepEqual(fs.readdirSync(store.backupDir), files, 'A failed draw must not create an automatic backup');
}

test('official tournament applies R1–R5 difficulty gradients for all thirteen matches and leaves the fixed final unchanged', () => {
  for (let iteration = 0; iteration < 3; iteration++) {
    const state = seed(), played = [], seenRounds = new Set();
    const finalBefore = structuredClone(state.tournament.matches.find(match => match.id === 'GF').songs);
    for (const item of state.tournament.matches.filter(match => match.id !== 'GF')) {
      const match = choose(state, item.id); seenRounds.add(match.round);
      for (const song of match.songs) {
        assert.ok(played.every(previous => !SongPool.sameSong(previous, song)), `${item.id}: actual songs never repeat across matches`);
        assert.ok(!CompetitionConfig.FINAL_SONG_IDS.includes(song.id)); played.push(structuredClone(song));
      }
      fill(state, false, iteration % 2); act(state, 'record-result', { verified: true });
      assert.equal(current(state).status, 'complete');
    }
    assert.equal(played.length, 26); assert.deepEqual([...seenRounds], [1, 2, 3, 4, 5]);
    act(state, 'select-match', { matchId: 'GF' });
    assert.equal(current(state).finalMode, 'fixed-two'); assert.deepEqual(current(state).songs, finalBefore);
    assert.deepEqual(current(state).songs.map(song => song.id), CompetitionConfig.FINAL_SONG_IDS);
    assert.deepEqual(current(state).candidates, []);
    fill(state); act(state, 'record-result', { verified: true });
    assert.equal(state.tournament.matches.filter(match => match.status === 'complete').length, 14);
  }
});

test('previously saved official catalogs without raw constants still draw using exact canonical chart metadata', () => {
  const state = createDefaultState();
  for (const song of state.library) delete song.constant;
  seed(state); act(state, 'draw-candidates'); checkCandidates(current(state));
  assert.ok(state.library.every(song => song.constant === undefined), 'Fallback does not rewrite the saved catalog');
});

test('legacy events retain their uniform six-song draw without requiring gradient metadata or full official inventory', () => {
  const state = legacyState();
  state.library.forEach((song, index) => { song.eligible = index < 6; delete song.constant; });
  seed(state); act(state, 'draw-candidates');
  assert.deepEqual(new Set(current(state).candidates.map(song => song.id)), new Set(state.library.slice(0, 6).map(song => song.id)));
});

test('unknown eligible chart constants block official draws without changing saved candidates, bans, preview cues or revision', t => {
  const state = seed(); act(state, 'draw-candidates');
  act(state, 'ban-song', { playerIndex: 0, songId: current(state).candidates[0].id });
  act(state, 'upsert-song', { song: { id: 'fixture-unknown-constant', title: 'Unknown difficulty fixture', artist: 'Fixture',
    difficulty: 'AT', level: 17, art: 'assets/song/cover-1.svg', eligible: true } });
  const { dir, store } = temporaryStore(t, state);
  unchangedStore(store, { type: 'draw-candidates', payload: { matchId: 'W1' } }, /Missing or invalid chart constant/i);
  assert.deepEqual(new StateStore(dir).state, store.state);
});

test('old R5 candidate snapshots containing a low chart cannot be formally picked and rejection is atomic', t => {
  const state = until(seed(), 'L6'); act(state, 'draw-candidates');
  act(state, 'upsert-song', { song: { id: 'fixture-old-r5-low', title: 'Old R5 candidate fixture', artist: 'Fixture',
    difficulty: 'IN', level: 16, constant: 16.1, art: 'assets/song/cover-1.svg', eligible: true } });
  const low = state.library.find(song => song.id === 'fixture-old-r5-low');
  current(state).candidates[0] = { ...low };
  for (const playerIndex of [0, 1]) act(state, 'ban-song', { playerIndex, songId: null, confirmed: true });
  validateState(state); const { dir, store } = temporaryStore(t, state);
  unchangedStore(store, { type: 'pick-songs', payload: { matchId: 'L6' } }, /difficulty-gradient/i);
  assert.deepEqual(new StateStore(dir).state, store.state, 'Old snapshots remain loadable for an explicit redraw');
});

test('formal picks recheck future inventory when the library changes after the candidate draw', t => {
  const state = seed(); act(state, 'draw-candidates');
  for (const playerIndex of [0, 1]) act(state, 'ban-song', { playerIndex, songId: null, confirmed: true });
  const highCandidates = current(state).candidates.filter(song => constant(song) >= 16.9).map(song => song.id);
  const otherHigh = state.library.filter(song => song.eligible && constant(song) >= 16.9 && !highCandidates.includes(song.id));
  const keep = new Set([...highCandidates, ...otherHigh.map(song => song.id)].slice(0, 6));
  for (const song of [...state.library].filter(song => song.eligible && constant(song) >= 16.9 && !keep.has(song.id)))
    act(state, 'upsert-song', { song: { ...song, eligible: false } });
  const { store } = temporaryStore(t, state);
  unchangedStore(store, { type: 'pick-songs', payload: { matchId: 'W1' } }, /safe difficulty-gradient|R5/i);
});

test('extra tiebreaks cannot consume the last six R5 high charts and leave failed commands unpersisted', t => {
  const state = until(seed(), 'L5'); choose(state, 'L5'); fill(state, true);
  const reserved = SongPool.available(state, null, { eligibleOnly: true }).filter(song => constant(song) >= 16.9).slice(0, 6);
  assert.equal(reserved.length, 6);
  const keep = new Set(reserved.map(song => song.id));
  for (const song of [...state.library].filter(song => song.eligible && !keep.has(song.id)))
    act(state, 'upsert-song', { song: { ...song, eligible: false } });
  const { store } = temporaryStore(t, state);
  unchangedStore(store, { type: 'draw-match-tiebreak', payload: { matchId: 'L5' } }, /safe difficulty-gradient|R5/i);
});

test('official tiebreak action filters unsafe reservations before drawing from a mixed eligible pool', t => {
  const state = until(seed(), 'L5'); choose(state, 'L5'); fill(state, true);
  const reserved = SongPool.available(state, null, { eligibleOnly: true }).filter(song => constant(song) >= 16.9).slice(0, 6);
  assert.equal(reserved.length, 6);
  const reservedIds = new Set(reserved.map(song => song.id)), owned = current(state).songs[0];
  act(state, 'upsert-song', { song: { id: 'fixture-safe-extra-tie', title: 'Safe extra tiebreak fixture', artist: 'Fixture',
    difficulty: 'IN', level: 16, constant: 16.1, art: 'assets/song/cover-1.svg', eligible: true } });
  const safeIds = new Set([owned.id, 'fixture-safe-extra-tie']);
  for (const song of [...state.library].filter(song => song.eligible && !reservedIds.has(song.id) && !safeIds.has(song.id)))
    act(state, 'upsert-song', { song: { ...song, eligible: false } });
  const eligible = SongPool.available(state, 'L5', { eligibleOnly: true });
  assert.equal(eligible.length, 8, 'Fixture includes six unsafe shared high charts and two safe alternatives');
  for (let attempt = 0; attempt < 32; attempt++) {
    const copy = structuredClone(state); act(copy, 'draw-match-tiebreak');
    const chosen = current(copy).tiebreaks[0].song;
    assert.ok(safeIds.has(chosen.id), 'Draw succeeds using a safe alternative instead of sometimes choosing protected R5 stock');
    assert.ok(!reservedIds.has(chosen.id));
    assert.equal(SongPool.available(copy, null, { eligibleOnly: true }).filter(song => constant(song) >= 16.9).length, 6);
  }
  const { dir, store } = temporaryStore(t, state);
  store.commit({ type: 'draw-match-tiebreak', payload: { matchId: 'L5' } }, store.state.revision);
  assert.ok(safeIds.has(current(store.state).tiebreaks[0].song.id));
  assert.deepEqual(new StateStore(dir).state, store.state, 'Successful safe tiebreak selection persists across restart');
});

test('R5 extra tiebreaks retain the 16.9 minimum even when lower charts remain eligible', () => {
  const state = until(seed(), 'L6'); choose(state, 'L6'); fill(state, true);
  act(state, 'upsert-song', { song: { id: 'fixture-r5-extra-low', title: 'Low R5 tiebreak fixture', artist: 'Fixture',
    difficulty: 'IN', level: 16, constant: 16.1, art: 'assets/song/cover-1.svg', eligible: true } });
  const eligible = SongPool.available(state, 'L6', { eligibleOnly: true });
  assert.ok(eligible.some(song => constant(song) <= 16.5), 'Fixture retains otherwise available low charts');
  assert.ok(eligible.some(song => current(state).songs.some(own => SongPool.sameSong(own, song))), 'Same-match high charts remain available');
  for (let attempt = 0; attempt < 32; attempt++) {
    const copy = structuredClone(state); act(copy, 'draw-match-tiebreak');
    const chosen = current(copy).tiebreaks[0].song;
    assert.ok(constant(chosen) >= 16.9, 'R5 extra tiebreak uses the same hard difficulty floor as its regular songs');
    assert.ok(SongPool.isAvailable(state, chosen, 'L6'), 'Other matches still own all their played songs');
  }
});
