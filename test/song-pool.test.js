const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SongPool = require('../public/js/song-pool');
const { createDefaultState } = require('./helpers/legacy-state');
const { applyAction, CURRENT_MATCH_ACTIONS, publicState, resultCorrectionImpact } = require('../lib/tournament');
const { validateState } = require('../lib/state-validation');
const { StateStore } = require('../lib/store');

function stateWithPool(count = 30) {
  const state = createDefaultState(), template = state.library[0];
  state.library = Array.from({ length: count }, (_, index) => ({ ...template, id: `song-${index + 1}`,
    title: `Fixture Song ${index + 1}`, artist: 'Fixture Artist', eligible: true }));
  state.library.push(...Array.from({ length: 6 }, (_, index) => ({ ...template, id: `final-${index + 1}`,
    title: `Fixture Final ${index + 1}`, artist: 'Fixture Artist', eligible: false })));
  applyAction(state, { type: 'seed-bracket', payload: { ids: state.qualifier.players.map(player => player.id), ruleset: 'proposal-2026' } });
  validateState(state); return state;
}
function act(state, type, payload = {}) {
  const next = structuredClone(state);
  applyAction(next, { type, payload: CURRENT_MATCH_ACTIONS.has(type) ? { matchId: next.tournament.currentMatchId, ...payload } : payload });
  validateState(next); Object.assign(state, next); return state;
}
const current = state => state.tournament.matches.find(match => match.id === state.tournament.currentMatchId);
function pick(state, id = state.tournament.currentMatchId) {
  act(state, 'select-match', { matchId: id }); act(state, 'draw-candidates');
  for (const playerIndex of [0, 1]) act(state, 'ban-song', { playerIndex, songId: null, confirmed: true });
  act(state, 'pick-songs'); return current(state).songs;
}
function fill(state, tied = false) {
  for (const playerIndex of [0, 1]) for (let songIndex = 0; songIndex < current(state).songs.length; songIndex++) {
    act(state, 'set-match-score', { playerIndex, songIndex, score: tied ? 990000 : 990000 - playerIndex * 1000, judgements: { accuracy: 99 } });
  }
}
function fixture(t, state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-song-pool-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'match-state.json'), JSON.stringify(state));
  return { dir, store: new StateStore(dir) };
}

test('thirty distinct regular songs complete all thirteen two-song matches without cross-match reuse', () => {
  const state = stateWithPool();
  assert.deepEqual(SongPool.status(state), { eligibleTotal: 30, reservedRegular: 0, availableRegular: 30,
    regularMatchesRemaining: 13, minimumRegularNeeded: 30, minimumRegularTarget: 30, suggestedRegularTarget: 42 });
  const played = [];
  for (const match of state.tournament.matches.filter(match => match.id !== 'GF')) {
    if (played.length === 24) assert.equal(SongPool.available(state, match.id, { eligibleOnly: true }).length, 6);
    const songs = pick(state, match.id);
    assert.ok(songs.every(song => played.every(previous => !SongPool.sameSong(previous, song))));
    played.push(...songs); fill(state); act(state, 'record-result', { verified: true });
  }
  assert.equal(played.length, 26); assert.equal(new Set(played.map(SongPool.identity)).size, 26);
  assert.equal(SongPool.status(state).availableRegular, 4); assert.equal(SongPool.status(state).minimumRegularNeeded, 0);
  act(state, 'select-match', { matchId: 'GF' });
  const ids = state.library.filter(song => !song.eligible).map(song => song.id);
  act(state, 'set-final-candidates', { ids });
  act(state, 'set-final-picks', { audienceIds: ids.slice(0, 2), hostId: ids[2] });
  const broadcast = publicState(state), final = broadcast.tournament.matches.find(match => match.id === 'GF');
  assert.equal(final.songs[2].id, 'sealed'); assert.equal('usedSongs' in final, false);
  assert.equal('hostPick' in final, false); assert.equal(JSON.stringify(broadcast).includes('usedSongs'), false);
  assert.equal(SongPool.isAvailable(state, current(state).songs[2], 'W1'), false);
});

test('twenty-nine songs stop at the final six-candidate draw rather than recycle earlier matches', () => {
  const state = stateWithPool(29), matches = state.tournament.matches.filter(match => match.id !== 'GF');
  for (const match of matches.slice(0, 12)) { pick(state, match.id); fill(state); act(state, 'record-result', { verified: true }); }
  act(state, 'select-match', { matchId: matches[12].id }); const before = structuredClone(state);
  assert.equal(SongPool.available(state, current(state).id, { eligibleOnly: true }).length, 5);
  assert.throws(() => act(state, 'draw-candidates'), /six eligible songs.*5 available/);
  assert.deepEqual(state, before);
});

test('unused and banned candidates stay available while formally picked songs are reserved', () => {
  const state = stateWithPool(8); act(state, 'draw-candidates');
  const banned = current(state).candidates[0];
  act(state, 'ban-song', { playerIndex: 0, songId: banned.id });
  act(state, 'ban-song', { playerIndex: 1, songId: null, confirmed: true });
  const before = SongPool.available(state, 'W2', { eligibleOnly: true }).length;
  assert.equal(before, 8); act(state, 'pick-songs');
  const chosen = [...current(state).songs];
  assert.equal(SongPool.available(state, 'W2', { eligibleOnly: true }).length, 6);
  assert.equal(SongPool.isAvailable(state, banned, 'W2'), true);
  assert.ok(chosen.every(song => !SongPool.isAvailable(state, song, 'W2')));
  assert.ok(chosen.every(song => SongPool.isAvailable(state, song, 'W1')));
});

test('stale candidate sets are checked again when bans and formal picks are submitted', () => {
  const state = stateWithPool(6); act(state, 'draw-candidates');
  act(state, 'select-match', { matchId: 'W2' }); act(state, 'draw-candidates');
  for (const playerIndex of [0, 1]) act(state, 'ban-song', { playerIndex, songId: null, confirmed: true });
  act(state, 'select-match', { matchId: 'W1' });
  for (const playerIndex of [0, 1]) act(state, 'ban-song', { playerIndex, songId: null, confirmed: true });
  act(state, 'pick-songs'); const firstSongs = [...current(state).songs]; act(state, 'select-match', { matchId: 'W2' });
  assert.throws(() => act(state, 'ban-song', { playerIndex: 0, songId: firstSongs[0].id }), /Another match selected/);
  act(state, 'pick-songs');
  assert.ok(current(state).songs.every(song => firstSongs.every(previous => !SongPool.sameSong(previous, song))));
});

test('reset, redrawing, reseeding and restart preserve already selected song ownership', t => {
  const state = stateWithPool(); const chosen = pick(state);
  act(state, 'reset-current-match'); assert.ok(chosen.every(song => !SongPool.isAvailable(state, song, 'W2')));
  act(state, 'draw-candidates');
  act(state, 'seed-bracket', { ids: state.qualifier.players.map(player => player.id), ruleset: 'proposal-2026' });
  assert.ok(chosen.every(song => !SongPool.isAvailable(state, song, 'W2')));
  const { dir, store } = fixture(t, state), restarted = new StateStore(dir);
  assert.deepEqual(restarted.state, store.state);
  assert.ok(chosen.every(song => !SongPool.isAvailable(restarted.state, song, 'W2')));
});

test('reopening an upstream result keeps cleared downstream songs occupied by their original match', () => {
  const state = stateWithPool(); const rootSongs = pick(state, 'W1'); fill(state); act(state, 'record-result', { verified: true });
  for (const id of ['W2', 'W3', 'W4']) { pick(state, id); fill(state); act(state, 'record-result', { verified: true }); }
  const downstream = pick(state, 'W5'), impact = resultCorrectionImpact(state, 'W1');
  act(state, 'reopen-result', { matchId: 'W1', reason: 'Referee reviewed the saved score image.', affectedMatchIds: impact.affectedMatchIds, confirmClear: true });
  assert.ok(downstream.every(song => !SongPool.isAvailable(state, song, 'W1')));
  assert.ok(downstream.every(song => SongPool.isAvailable(state, song, 'W5')));
  assert.ok(rootSongs.every(song => SongPool.isAvailable(state, song, 'W1')));
});

test('different chart IDs and normalized title aliases cannot bypass an occupied song', () => {
  const state = stateWithPool(); const chosen = pick(state)[0];
  act(state, 'upsert-song', { song: { ...chosen, id: 'chart-alias', title: '  ' + chosen.title.toUpperCase() + '  ', difficulty: 'HD' } });
  assert.equal(SongPool.isAvailable(state, state.library.find(song => song.id === 'chart-alias'), 'W2'), false);
  const renamedChart = { ...state.library.find(song => song.id === 'chart-alias'), title: 'Renamed second chart of the occupied song' };
  act(state, 'upsert-song', { song: renamedChart });
  assert.equal(SongPool.isAvailable(state, renamedChart, 'W2'), false);
  act(state, 'upsert-song', { song: { ...renamedChart, id: 'alias-chain', title: renamedChart.title.toUpperCase() } });
  const chain = { ...state.library.find(song => song.id === 'alias-chain'), artist: 'Corrected artist credit' };
  act(state, 'upsert-song', { song: chain });
  assert.equal(SongPool.isAvailable(state, chain, 'W2'), false);
  const renamed = { ...state.library.find(song => song.id === chosen.id), title: 'New spelling for the selected track' };
  act(state, 'upsert-song', { song: renamed });
  act(state, 'upsert-song', { song: { ...renamed, id: 'renamed-alias', difficulty: 'AT' } });
  assert.equal(SongPool.isAvailable(state, state.library.find(song => song.id === 'renamed-alias'), 'W2'), false);
  assert.equal(SongPool.isAvailable(state, chosen, 'W2'), false);
  act(state, 'reset-current-match');
  assert.equal(SongPool.isAvailable(state, state.library.find(song => song.id === 'renamed-alias'), 'W2'), false);
});

test('tiebreak draws exclude other matches but retain same-match repeat eligibility and durable history', () => {
  const state = stateWithPool(); const first = pick(state, 'W1'); const second = pick(state, 'W2'); fill(state, true);
  act(state, 'draw-match-tiebreak'); const tie = current(state).tiebreaks[0];
  assert.ok(first.every(song => !SongPool.sameSong(song, tie.song)));
  assert.equal(SongPool.isAvailable(state, tie.song, 'W1'), false);
  assert.equal(SongPool.isAvailable(state, tie.song, 'W2'), true);
  act(state, 'authorize-song-rematch', { stage: 'double-elimination', matchId: 'W2', songIndex: 0,
    reason: 'game-error', note: 'Referee verified the game error.', videoChecked: false, unintentional: false, allAgree: false });
  assert.equal(current(state).tiebreaks.length, 0);
  assert.equal(SongPool.isAvailable(state, tie.song, 'W1'), false);
  assert.ok(second.every(song => !SongPool.isAvailable(state, song, 'W1')));
});

test('history validation rejects missing references while older states without history remain loadable', () => {
  const state = stateWithPool(); pick(state); const broken = structuredClone(state);
  broken.tournament.matches[0].usedSongs = [];
  assert.throws(() => validateState(broken), /selected song missing/);
  const legacy = structuredClone(state); delete legacy.tournament.matches[0].usedSongs;
  assert.equal(validateState(legacy), legacy);
  act(legacy, 'reset-current-match');
  assert.equal(current(legacy).usedSongs.length, 2);
});

test('restoring seeded and pre-seeding backups preserves usage through restart, alias edits and reseeding', t => {
  const initial = createDefaultState(); initial.library = stateWithPool().library;
  const { dir, store } = fixture(t, initial);
  const save = (type, payload = {}) => store.commit({ type, payload: CURRENT_MATCH_ACTIONS.has(type) ?
    { matchId: store.state.tournament.currentMatchId, ...payload } : payload }, store.state.revision);
  save('seed-bracket', { ids: initial.qualifier.players.map(player => player.id), ruleset: 'proposal-2026' });
  const beforeSeeding = store.listBackups().find(backup => backup.revision === 0).id;
  for (const id of ['W1', 'W2']) {
    save('select-match', { matchId: id }); save('draw-candidates');
    for (const playerIndex of [0, 1]) save('ban-song', { playerIndex, songId: null, confirmed: true });
    save('pick-songs');
  }
  const picked = structuredClone(store.state.tournament.matches.slice(0, 2).flatMap(match => match.songs));
  const afterBackup = { ...picked[0], id: 'post-backup-chart' };
  save('upsert-song', { song: afterBackup });
  const seededEmpty = store.listBackups().find(backup => backup.revision === 1).id;
  store.restore(seededEmpty, store.state.revision, 'Referee restored the unscored bracket.');
  assert.ok(picked.every(song => !SongPool.isAvailable(store.state, song, 'W3')));
  store.restore(beforeSeeding, store.state.revision, 'Referee restored the roster setup.');
  assert.equal(store.state.tournament.seeded, false);
  assert.equal('songHistory' in publicState(store.state).tournament, false);
  assert.ok(picked.every(song => !SongPool.isAvailable(store.state, song, 'W3')));
  assert.equal(store.state.library.some(song => song.id === afterBackup.id), false);
  const readded = { ...afterBackup, title: 'Corrected metadata after restoring the older catalogue' };
  save('upsert-song', { song: readded });
  save('upsert-song', { song: { ...readded, id: 'post-restore-alias' } });
  assert.equal(SongPool.isAvailable(store.state, store.state.library.find(song => song.id === 'post-restore-alias'), 'W3'), false);
  const renamed = { ...store.state.library.find(song => song.id === picked[0].id), title: 'Renamed restored selection' };
  save('upsert-song', { song: renamed });
  save('upsert-song', { song: { ...renamed, id: 'restored-alias' } });
  const restarted = new StateStore(dir);
  assert.equal(SongPool.isAvailable(restarted.state, restarted.state.library.find(song => song.id === 'restored-alias'), 'W3'), false);
  save('seed-bracket', { ids: initial.qualifier.players.map(player => player.id), ruleset: 'proposal-2026' });
  assert.equal('songHistory' in store.state.tournament, false);
  assert.ok(picked.every(song => !SongPool.isAvailable(store.state, song, 'W3')));
  assert.ok(store.state.tournament.matches[0].usedSongs.length >= 3);
});
