const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDefaultState } = require('../lib/default-state');
const { createDefaultState: legacyState } = require('./helpers/legacy-state');
const CompetitionConfig = require('../public/js/competition-config');
const QualifierRules = require('../public/js/qualifier-rules');
const SongPool = require('../public/js/song-pool');
const Countdown = require('../public/js/countdown');
const { applyAction, CURRENT_MATCH_ACTIONS, createBracket, resolveBracket, publicState, resultCorrectionImpact } = require('../lib/tournament');
const { scorekeeperState, scorekeeperAction } = require('../lib/scorekeeper');
const { validateState } = require('../lib/state-validation');
const { StateStore } = require('../lib/store');

function act(state, type, payload = {}) {
  const next = structuredClone(state);
  applyAction(next, { type, payload: CURRENT_MATCH_ACTIONS.has(type) ? { matchId: next.tournament.currentMatchId, ...payload } : payload });
  validateState(next); Object.assign(state, next); return state;
}
const match = (state, id = state.tournament.currentMatchId) => state.tournament.matches.find(value => value.id === id);
function seed(state) { act(state, 'seed-bracket', { ids: state.qualifier.players.slice(0, 8).map(player => player.id) }); return state; }
function choose(state, id) {
  act(state, 'select-match', { matchId: id });
  if (id !== 'GF') {
    act(state, 'draw-candidates');
    for (const playerIndex of [0, 1]) act(state, 'ban-song', { playerIndex, songId: null, confirmed: true });
    act(state, 'pick-songs');
  }
}
function fill(state, tied = false) {
  for (const playerIndex of [0, 1]) for (let songIndex = 0; songIndex < match(state).scores[0].length; songIndex++) {
    act(state, 'set-match-score', { playerIndex, songIndex, score: tied ? 990000 : 990000 - playerIndex * 1000,
      judgements: { accuracy: 99 } });
  }
}
function finalReady() {
  const state = seed(createDefaultState());
  for (const item of state.tournament.matches.filter(value => value.id !== 'GF')) {
    choose(state, item.id); fill(state); act(state, 'record-result', { verified: true });
  }
  choose(state, 'GF'); return state;
}
function fillQualifier(state, group) {
  for (const player of QualifierRules.entries(state, group)) act(state, 'set-qualifier-total', {
    group, playerId: player.id, total: 3000000 - player.number * 3000 });
}
function pairIds(state) { return state.tournament.matches.slice(0, 4).map(item => [...item.players].sort().join('/')).sort(); }

test('new events load the official charts and fixed final without changing existing unscored events until confirmed', () => {
  const formal = createDefaultState(); validateState(formal);
  assert.equal(formal.event.competitionVersion, CompetitionConfig.VERSION);
  assert.deepEqual(formal.qualifier.groups.A.songs, CompetitionConfig.QUALIFIER_SONG_IDS.A);
  assert.deepEqual(formal.qualifier.groups.B.songs, CompetitionConfig.QUALIFIER_SONG_IDS.B);
  const old = legacyState(), original = structuredClone(old);
  assert.throws(() => act(old, 'apply-competition-config'), /Review and confirm/); assert.deepEqual(old, original);
  act(old, 'rename-player', { playerId: 'p1', name: 'Registered player' });
  act(old, 'set-qualifier-plan', { plan: 'A' });
  const roster = structuredClone(old.qualifier.players), rounds = structuredClone(old.qualifier.rounds);
  act(old, 'apply-competition-config', { confirmed: true });
  assert.deepEqual(old.qualifier.players, roster.map(player => ({ ...player, challengeTotal: null })));
  for (const round of Object.values(rounds)) for (const row of Object.values(round.results)) row.challengeTotal = null;
  assert.deepEqual(old.qualifier.rounds, rounds);
  assert.deepEqual(old.library, CompetitionConfig.library());
  act(old, 'set-scene', { scene: 'grand-final-announcement' }); assert.equal(old.stage, 'double-elimination');
  assert.throws(() => act(original, 'set-scene', { scene: 'grand-final-announcement' }), /fixed two-song/);
});

test('configuration replacement cannot erase scores, qualifier evidence, seeds or persistent song reservations', () => {
  const checks = [
    state => act(state, 'set-qualifier-score', { playerId: 'p1', songIndex: 0, score: 0 }),
    state => { act(state, 'set-qualifier-plan', { plan: 'A' }); act(state, 'set-qualifier-score', { group: 'A', playerId: 'p1', songIndex: 0, score: 900000 }); },
    state => { state.qualifier.players[0].judgements = [{ accuracy: 99 }, null, null]; },
    state => seed(state),
    state => { state.tournament.songHistory = { W1: [state.library[0]] }; }
  ];
  for (const change of checks) {
    const state = legacyState(); change(state); const before = structuredClone(state);
    assert.throws(() => act(state, 'apply-competition-config', { confirmed: true }), /only before/);
    assert.deepEqual(state, before);
  }
});

test('Plan A pairs qualifier seeds 1–8, 2–7, 3–6 and 4–5 and retains rank order for reseeding', () => {
  const state = createDefaultState(); act(state, 'set-qualifier-plan', { plan: 'A' });
  fillQualifier(state, 'A'); act(state, 'finalize-qualifier-round', { group: 'A', verified: true });
  fillQualifier(state, 'B'); act(state, 'qualify', { verified: true });
  const ids = state.tournament.seeds;
  assert.deepEqual(pairIds(state), [[ids[0], ids[7]], [ids[1], ids[6]], [ids[2], ids[5]], [ids[3], ids[4]]].map(pair => pair.sort().join('/')).sort());
  assert.equal(state.tournament.seedingPlan, undefined);
  assert.equal(new Set(state.tournament.matches.slice(0, 4).flatMap(item => item.players)).size, 8);
});

test('Plan B applies all four specified cross-group pairs, validates their sources and keeps alternating seed order', () => {
  const state = createDefaultState();
  act(state, 'set-competition-roster', { names: Array.from({ length: 21 }, (_, i) => `Entrant ${i + 1}`) });
  act(state, 'set-qualifier-plan', { plan: 'B' });
  for (const group of ['A', 'B']) { fillQualifier(state, group); act(state, 'finalize-qualifier-round', { group, verified: true }); }
  const a = [...state.qualifier.rounds.A.qualifiedIds], b = [...state.qualifier.rounds.B.qualifiedIds];
  act(state, 'qualify', { verified: true });
  assert.deepEqual(state.tournament.seeds, a.flatMap((id, index) => [id, b[index]]));
  assert.equal(state.tournament.seedingPlan, 'B');
  assert.deepEqual(pairIds(state), [[a[0], b[3]], [a[1], b[2]], [b[0], a[2]], [b[1], a[3]]].map(pair => pair.sort().join('/')).sort());
  assert.equal(new Set(state.tournament.matches.slice(0, 4).flatMap(item => item.players)).size, 8);
  validateState(JSON.parse(JSON.stringify(state)));
  const damaged = structuredClone(state); match(damaged, 'W2').sources[1].value = 5;
  assert.throws(() => validateState(damaged), /incorrect bracket dependency/);
  // An old Plan B event has no new pairing marker and must keep its original graph.
  const legacy = structuredClone(state); delete legacy.event.competitionVersion;
  legacy.tournament = createBracket(state.tournament.seeds, { ruleset: 'proposal-2026' }); resolveBracket(legacy);
  assert.deepEqual(match(legacy, 'W2').sources.map(source => source.value), [4, 5]); validateState(legacy);
});

test('fixed final reserves both tracks, requires no selection or reveal, and exposes exactly two scorekeeper/countdown slots', () => {
  const state = finalReady(), final = match(state);
  assert.equal(final.finalMode, 'fixed-two');
  assert.deepEqual(final.songs.map(song => [song.title, song.difficulty, song.level]), [['Desultory Signals', 'IN', 17], ['Petrichor', 'AT', 17]]);
  assert.deepEqual(final.songs.map(song => song.id), CompetitionConfig.FINAL_SONG_IDS);
  assert.equal(final.hostRevealed, false); assert.equal(final.hostPick, null); assert.deepEqual(final.candidates, []);
  assert.ok(final.songs.every(song => !SongPool.isAvailable(state, song, 'W1')));
  for (const type of ['draw-candidates', 'ban-song', 'pick-songs', 'set-final-candidates', 'set-final-picks', 'reveal-host-song']) assert.throws(() => act(state, type));
  act(state, 'set-scene', { scene: 'double-elimination-match' });
  for (const index of [0, 1]) {
    act(state, 'set-song-progress', { index }); assert.equal(Countdown.context(publicState(state)).songId, final.songs[index].id);
  }
  const view = scorekeeperState(state); assert.equal(view.match.songs.length, 2); assert.equal(view.match.locked, false);
  assert.ok(view.match.songs.every(song => !song.hidden));
  const request = { contextKey: view.contextKey, action: { type: 'set-match-score', payload: { matchId: 'GF', playerIndex: 0, songIndex: 1, score: 990000 } } };
  assert.equal(scorekeeperAction(state, request).payload.songIndex, 1);
  request.action.payload.songIndex = 2; assert.throws(() => scorekeeperAction(state, request), /not available/);
  assert.throws(() => act(state, 'set-song-progress', { index: 2 }), /selected song/);
  fill(state); act(state, 'record-result', { verified: true }); assert.equal(match(state).status, 'complete');
  assert.equal(state.result.totals[0], 1980000); assert.equal(state.result.placements[match(state).winnerId], 'Champion');
  assert.equal(publicState(state).tournament.matches.at(-1).songs.length, 2);
});

test('fixed final reset, shared rematch and confirmed tiebreak keep the two fixed charts and average Accuracy rule', () => {
  const state = finalReady(); fill(state, true);
  act(state, 'authorize-song-rematch', { stage: 'double-elimination', matchId: 'GF', songIndex: 1, reason: 'game-error',
    videoChecked: false, unintentional: false, allAgree: false, note: 'Referee verified replay evidence.' });
  assert.deepEqual(match(state).scores, [[990000, null], [990000, null]]);
  act(state, 'reset-current-match'); assert.deepEqual(match(state).songs.map(song => song.id), CompetitionConfig.FINAL_SONG_IDS);
  assert.deepEqual(match(state).scores, [[null, null], [null, null]]);
  fill(state, true); act(state, 'draw-match-tiebreak');
  const tie = match(state).tiebreaks[0]; assert.equal(tie.song.eligible, true); assert.ok(!CompetitionConfig.FINAL_SONG_IDS.includes(tie.song.id));
  for (const playerIndex of [0, 1]) act(state, 'set-match-tiebreak-score', { index: 0, playerIndex, score: 990000,
    judgements: { accuracy: 99 - playerIndex } });
  act(state, 'confirm-match-tiebreak', { index: 0, verified: true }); act(state, 'record-result', { verified: true });
  assert.equal(match(state).decisionReason, 'tiebreak'); assert.equal(match(state).hostRevealed, false);
  const impact = resultCorrectionImpact(state, 'GF');
  act(state, 'reopen-result', { matchId: 'GF', affectedMatchIds: impact.affectedMatchIds, reason: 'Review original final score' });
  assert.equal(match(state).songs.length, 2); assert.deepEqual(match(state).scores, [[990000, 990000], [990000, 990000]]);
  assert.equal(state.result, null); assert.deepEqual(match(state).tiebreaks, []);
  act(state, 'set-match-score', { playerIndex: 0, songIndex: 0, score: 990000, judgements: { accuracy: 100 } });
  act(state, 'record-result', { verified: true }); assert.equal(match(state).decisionReason, 'accuracy');
});

test('full fixed-final event and downstream correction reload and restore without three-slot conversion or private audit publication', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-fixed-final-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new StateStore(dir), completed = finalReady(); fill(completed); act(completed, 'record-result', { verified: true });
  store.state = completed; store.write(completed); const saved = store.saveBackup(completed);
  let reloaded = new StateStore(dir); assert.deepEqual(reloaded.state, completed);
  const impact = resultCorrectionImpact(reloaded.state, 'W1');
  reloaded.commit({ type: 'reopen-result', payload: { matchId: 'W1', affectedMatchIds: impact.affectedMatchIds,
    confirmClear: true, reason: 'Private downstream correction evidence' } }, reloaded.state.revision);
  const cleared = match(reloaded.state, 'GF'); assert.equal(cleared.finalMode, 'fixed-two'); assert.equal(cleared.songs.length, 2);
  assert.deepEqual(cleared.scores, [[null, null], [null, null]]);
  reloaded = new StateStore(dir); reloaded.restore(saved, reloaded.state.revision, 'Restore reviewed final result');
  assert.equal(match(reloaded.state, 'GF').status, 'complete'); assert.equal(match(reloaded.state, 'GF').songs.length, 2);
  assert.equal(JSON.stringify(publicState(reloaded.state)).includes('Private downstream correction evidence'), false);
  assert.equal(JSON.stringify(publicState(reloaded.state)).includes('Restore reviewed final result'), false);
});

test('fixed final backups reject missing slots or changed fixed charts without misclassifying legacy sealed finals', () => {
  const state = seed(createDefaultState());
  const damages = [
    copy => { match(copy, 'GF').scores[0].push(null); },
    copy => { match(copy, 'GF').songs[0].difficulty = 'AT'; },
    copy => { match(copy, 'GF').songs = []; },
    copy => { match(copy, 'GF').hostRevealed = true; },
    copy => { copy.library.find(song => song.id === CompetitionConfig.FINAL_SONG_IDS[0]).eligible = true; }
  ];
  for (const damage of damages) { const copy = structuredClone(state); damage(copy); assert.throws(() => validateState(copy), /Damaged state/); }
  const legacy = legacyState(); seed(legacy); const final = match(legacy, 'GF');
  final.candidates = legacy.library.slice(0, 8); final.audiencePicks = final.candidates.slice(0, 2).map(song => song.id);
  final.hostPick = final.candidates[2]; final.songs = [final.candidates[0], final.candidates[1], final.hostPick];
  validateState(legacy); const publicFinal = match(publicState(legacy), 'GF');
  assert.equal(publicFinal.songs.length, 3); assert.equal(publicFinal.songs[2].hidden, true);
  const scoringCopy = structuredClone(legacy); scoringCopy.tournament.currentMatchId = 'GF'; resolveBracket(scoringCopy);
  validateState(scoringCopy); const legacySheet = scorekeeperState(scoringCopy).match;
  assert.equal(legacySheet.songs.length, 3); assert.equal(legacySheet.songs[2].hidden, true);
  assert.equal(legacySheet.players[0].scores.length, 3); assert.equal(legacySheet.players[0].scores[2], null);
  const before = structuredClone(legacy);
  assert.throws(() => act(legacy, 'apply-competition-config', { confirmed: true }), /only before/); assert.deepEqual(legacy, before);
});
