const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDefaultState } = require('../lib/default-state');
const { createDefaultState: legacyState } = require('./helpers/legacy-state');
const { applyAction, publicState, rankings, CURRENT_MATCH_ACTIONS } = require('../lib/tournament');
const { validateState } = require('../lib/state-validation');
const { StateStore } = require('../lib/store');
const { scoreCounts } = require('../lib/backup-index');
const { scorekeeperState, scorekeeperAction } = require('../lib/scorekeeper');
const Q = require('../public/js/qualifier-rules');
const ScoreRules = require('../public/js/score-rules');

function act(state, type, payload = {}) {
  const next = structuredClone(state);
  applyAction(next, { type, payload: CURRENT_MATCH_ACTIONS.has(type) ? { matchId: next.tournament.currentMatchId, ...payload } : payload });
  validateState(next); Object.assign(state, next); return state;
}
function configured(count = 8) {
  const state = createDefaultState();
  if (count !== 8) act(state, 'set-competition-roster', { names: Array.from({ length: count }, (_, i) => `Entrant ${i + 1}`) });
  act(state, 'set-qualifier-plan', { plan: 'auto' }); return state;
}
function enter(state, group, playerId, total, extra = {}) { return act(state, 'set-qualifier-total', { group, playerId, total, ...extra }); }
function fill(state, group, value = player => 3000000 - player.number * 1000) {
  for (const player of Q.entries(state, group)) enter(state, group, player.id, value(player));
}
function boundaryTie() {
  const state = configured();
  fill(state, 'A', player => ({ p1: 2970000, p2: 2940000, p3: 2910000, p4: 2700000, p5: 2700000, p6: 2400000, p7: 2100000, p8: 1800000 })[player.id]);
  return state;
}
function tieScore(state, index, playerId, score) { act(state, 'set-qualifier-tiebreak-score', { group: 'A', index, playerId, score }); }
function request(state, type, payload, contextKey = scorekeeperState(state).contextKey) { return { contextKey, action: { type, payload } }; }
function rematch(extra = {}) {
  return { stage: 'qualifier', group: 'A', playerId: 'p4', songIndex: 0, reason: 'game-error',
    videoChecked: false, unintentional: false, allAgree: false, note: 'Referee verified the Challenge Mode game error.', ...extra };
}

test('fresh events require a plan and record the game’s single Challenge Mode total, including zero and maximum', () => {
  const state = createDefaultState(); validateState(state);
  assert.equal(Q.isChallenge(state), true);
  assert.equal(scorekeeperState(state).qualifier.needsPlan, true);
  assert.equal(Q.total(state, state.qualifier.players[0]), null);
  assert.equal(Q.complete(state, state.qualifier.players[0]), false);
  assert.throws(() => enter(state, 'A', 'p1', 2900000), /Configure Plan A or Plan B/);
  assert.throws(() => scorekeeperAction(state, request(state, 'set-qualifier-total', { group: 'A', playerId: 'p1', total: 1 })), /Plan A/);
  act(state, 'set-qualifier-plan', { plan: 'A' });
  enter(state, 'A', 'p1', 0); enter(state, 'A', 'p2', 3000000); enter(state, 'A', 'p3', 2876543);
  const row = Q.result(state, 'A', 'p3');
  assert.equal(Q.total(state, row), 2876543); assert.equal(Q.complete(state, row), true);
  assert.deepEqual(row.scores, [null, null, null]); assert.deepEqual(row.judgements, [null, null, null]);
  assert.deepEqual(rankings(state, 'A').slice(0, 3).map(player => [player.id, player.total, player.accuracy]), [['p2', 3000000, null], ['p3', 2876543, null], ['p1', 0, null]]);
  assert.equal(rankings(state, 'A')[2].complete, true);
  enter(state, 'A', 'p3', null); assert.equal(Q.complete(state, Q.result(state, 'A', 'p3')), false);
  assert.throws(() => act(state, 'set-qualifier-score', { playerId: 'p1', songIndex: 0, score: 99 }), /total once/);
  assert.throws(() => act(state, 'set-tie-priority', { playerId: 'p1', priority: 1 }), /tiebreak/);
});

test('Challenge total rejects decimals, strings, nonfinite values and double-entry metadata without partial changes', () => {
  const state = configured(); enter(state, 'A', 'p1', 2987654);
  for (const invalid of [-1, 3000001, 99.5, NaN, Infinity, '2987654', {}, [], undefined]) {
    const before = structuredClone(state); assert.throws(() => enter(state, 'A', 'p1', invalid), /integer from 0 to 3,000,000/); assert.deepEqual(state, before);
  }
  for (const extra of [{ judgements: { accuracy: 99 } }, { score: 990000 }, { songIndex: 0 }]) assert.throws(() => enter(state, 'A', 'p1', 2900000, extra), /only the total/);
  enter(state, 'A', 'p1', ''); assert.equal(Q.result(state, 'A', 'p1').challengeTotal, null);
  assert.equal(Q.hasScores(state), true, 'Clearing a recorded total keeps the scoring history guard.');
});

test('qualifier chart identity stays locked after a recorded or cleared Challenge total while media updates remain available', () => {
  const state = configured(), id = state.qualifier.groups.A.songs[0], song = state.library.find(value => value.id === id);
  enter(state, 'A', 'p1', 2900000);
  for (const change of [{ title: 'Wrong title' }, { difficulty: 'AT' }, { level: 1 }, { artist: 'Wrong artist' }]) {
    const before = structuredClone(state); assert.throws(() => act(state, 'upsert-song', { song: { ...song, ...change } }), /metadata is locked/); assert.deepEqual(state, before);
  }
  act(state, 'upsert-song', { song: { ...song, art: 'assets/song/cover-1.svg', previewAudio: 'assets/song-preview/verified.mp3' } });
  assert.equal(state.library.find(value => value.id === id).previewAudio, 'assets/song-preview/verified.mp3');
  enter(state, 'A', 'p1', null);
  assert.throws(() => act(state, 'upsert-song', { song: { ...song, title: 'Wrong title' } }), /metadata is locked/);
  assert.throws(() => act(state, 'set-qualifier-songs', { group: 'A', ids: state.library.filter(value => value.eligible).slice(0, 3).map(value => value.id) }), /locked/);
  const bId = state.qualifier.groups.B.songs[0], bSong = state.library.find(value => value.id === bId);
  act(state, 'upsert-song', { song: { ...bSong, artist: 'Unplayed chart correction' } });
  assert.equal(state.library.find(value => value.id === bId).artist, 'Unplayed chart correction');
});

test('Plan A uses independent Challenge totals for the first and revival rounds and seeds the specified pairings', () => {
  const state = configured(); fill(state, 'A');
  const first = structuredClone(state.qualifier.rounds.A.results);
  act(state, 'finalize-qualifier-round', { group: 'A', verified: true });
  assert.deepEqual(state.qualifier.rounds.A.qualifiedIds, ['p1', 'p2', 'p3', 'p4']);
  assert.equal(state.qualifier.activeGroup, 'B');
  assert.ok(Q.entries(state, 'B').every(player => player.challengeTotal === null));
  fill(state, 'B', player => 2700000 + player.number * 1000);
  assert.deepEqual(state.qualifier.rounds.A.results, first);
  assert.equal(Q.result(state, 'A', 'p5').challengeTotal, 2995000);
  assert.equal(Q.result(state, 'B', 'p5').challengeTotal, 2705000);
  assert.throws(() => enter(state, 'A', 'p1', 0), /locked/);
  act(state, 'qualify', { verified: true });
  assert.deepEqual(state.tournament.seeds, ['p1', 'p2', 'p3', 'p4', 'p8', 'p7', 'p6', 'p5']);
  assert.deepEqual(state.tournament.matches.slice(0, 4).map(match => match.players), [['p1', 'p5'], ['p4', 'p8'], ['p2', 'p6'], ['p3', 'p7']]);
  assert.throws(() => enter(state, 'B', 'p5', 0), /locked/);
  validateState(JSON.parse(JSON.stringify(state)));
});

test('Plan B ranks the odd and even groups by their direct totals and preserves cross-group seeding', () => {
  const state = configured(21);
  for (const group of ['A', 'B']) { fill(state, group); act(state, 'finalize-qualifier-round', { group, verified: true }); }
  const a = state.qualifier.rounds.A.qualifiedIds, b = state.qualifier.rounds.B.qualifiedIds;
  assert.deepEqual(a.map(id => state.qualifier.players.find(player => player.id === id).number), [1, 3, 5, 7]);
  assert.deepEqual(b.map(id => state.qualifier.players.find(player => player.id === id).number), [2, 4, 6, 8]);
  act(state, 'qualify', { verified: true });
  assert.deepEqual(state.tournament.seeds, a.flatMap((id, i) => [id, b[i]]));
  assert.deepEqual(state.tournament.matches.slice(0, 4).map(match => match.players), [[a[0], b[3]], [b[1], a[3]], [b[0], a[2]], [a[1], b[2]]]);
});

test('equal Challenge totals draw single-song tiebreaks without average accuracy and repeated equal scores remain tied', () => {
  const state = boundaryTie();
  assert.deepEqual(Q.tiedSets(state, 'A'), [['p4', 'p5']]);
  assert.throws(() => act(state, 'finalize-qualifier-round', { group: 'A', verified: true }), /tiebreak/);
  act(state, 'draw-qualifier-tiebreak', { group: 'A', playerIds: ['p4', 'p5'] });
  tieScore(state, 0, 'p4', 0); tieScore(state, 0, 'p5', 0);
  act(state, 'confirm-qualifier-tiebreak', { group: 'A', index: 0, verified: true });
  assert.deepEqual(Q.tiedSets(state, 'A'), [['p4', 'p5']]);
  act(state, 'draw-qualifier-tiebreak', { group: 'A', playerIds: ['p4', 'p5'] });
  tieScore(state, 1, 'p4', 990000); tieScore(state, 1, 'p5', 990001);
  assert.throws(() => act(state, 'confirm-qualifier-tiebreak', { group: 'A', index: 1 }), /double-check/);
  act(state, 'confirm-qualifier-tiebreak', { group: 'A', index: 1, verified: true });
  assert.deepEqual(Q.tiedSets(state, 'A'), []);
  act(state, 'finalize-qualifier-round', { group: 'A', verified: true });
  assert.deepEqual(state.qualifier.rounds.A.qualifiedIds, ['p1', 'p2', 'p3', 'p5']);
  assert.equal(Q.result(state, 'A', 'p5').challengeTotal, 2700000, 'Tiebreaks must not inflate the original total.');
});

test('scorekeeper total payloads, mode-bound drafts and base locks keep arbiter actions outside the scorer role', () => {
  const state = configured(), initial = scorekeeperState(state);
  assert.equal(initial.qualifier.scoringMode, 'challenge-total'); assert.equal(initial.qualifier.players[0].challengeTotal, null);
  const payload = { group: 'A', playerId: 'p1', total: 2890123 };
  const action = scorekeeperAction(state, request(state, 'set-qualifier-total', { ...payload, verified: true, confirmClearTiebreaks: true, reason: 'Must be stripped', unrelated: 'private' }));
  assert.deepEqual(action.payload, payload); act(state, action.type, action.payload);
  assert.equal(scorekeeperState(state).contextKey, initial.contextKey, 'An ordinary total update does not discard other scorekeeper drafts.');
  assert.equal(scorekeeperState(state).qualifier.players[0].total, 2890123);
  for (const extra of [{ group: 'B' }, { total: 3000001 }, { judgements: { accuracy: 99 } }]) assert.throws(() => scorekeeperAction(state, request(state, 'set-qualifier-total', { ...payload, ...extra })));
  const blank = configured(), oldKey = scorekeeperState(blank).contextKey;
  act(blank, 'set-qualifier-scoring-mode', { mode: 'legacy-score' });
  assert.throws(() => scorekeeperAction(blank, request(blank, 'set-qualifier-total', payload, oldKey)), error => error.code === 'CONTEXT_CHANGED');
  assert.throws(() => scorekeeperAction(blank, request(blank, 'set-qualifier-total', payload)), /individual song scores/);
  const tied = boundaryTie(); act(tied, 'draw-qualifier-tiebreak', { group: 'A', playerIds: ['p4', 'p5'] });
  assert.throws(() => scorekeeperAction(tied, request(tied, 'set-qualifier-total', { group: 'A', playerId: 'p4', total: 2990000 })), error => error.code === 'INVALID');
  assert.deepEqual(scorekeeperAction(tied, request(tied, 'set-qualifier-tiebreak-score', { group: 'A', index: 0, playerId: 'p4', score: 1000000 })).payload,
    { group: 'A', index: 0, playerId: 'p4', score: 1000000 });
  for (const type of ['set-qualifier-scoring-mode', 'draw-qualifier-tiebreak', 'confirm-qualifier-tiebreak']) assert.throws(() => scorekeeperAction(tied, request(tied, type, {})), error => error.code === 'FORBIDDEN');
});

test('base-total corrections preserve repeated tiebreak evidence, survive restart and backups, and keep it private', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-challenge-correction-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let store = new StateStore(dir); store.state = boundaryTie(); store.write(store.state);
  const persist = (type, payload = {}) => store.commit({ type, payload }, store.state.revision);
  persist('draw-qualifier-tiebreak', { group: 'A', playerIds: ['p4', 'p5'] });
  for (const playerId of ['p4', 'p5']) persist('set-qualifier-tiebreak-score', { group: 'A', index: 0, playerId, score: 990000 });
  persist('confirm-qualifier-tiebreak', { group: 'A', index: 0, verified: true });
  persist('draw-qualifier-tiebreak', { group: 'A', playerIds: ['p4', 'p5'] });
  persist('set-qualifier-tiebreak-score', { group: 'A', index: 1, playerId: 'p4', score: 0 });
  const evidence = structuredClone(store.state.qualifier.rounds.A.tiebreaks), before = structuredClone(store.state), disk = fs.readFileSync(store.file, 'utf8'), backupCount = store.listBackups().length;
  const correction = { group: 'A', playerId: 'p4', total: 2700001 };
  assert.throws(() => persist('set-qualifier-total', correction), /arbiter/);
  assert.deepEqual(store.state, before); assert.equal(fs.readFileSync(store.file, 'utf8'), disk); assert.equal(store.listBackups().length, backupCount);
  persist('set-qualifier-total', { ...correction, verified: true, confirmClearTiebreaks: true, reason: 'Private original Challenge result screen reviewed.' });
  const audit = store.state.qualifier.adjudications.at(-1);
  assert.equal(audit.scoringMode, 'challenge-total'); assert.equal(audit.previousChallengeTotal, 2700000); assert.deepEqual(audit.invalidatedTiebreaks, evidence);
  assert.deepEqual(store.state.qualifier.rounds.A.tiebreaks, []);
  const saved = store.saveBackup(store.state), expected = structuredClone(store.state); store = new StateStore(dir);
  assert.deepEqual(store.state, expected); assert.equal(store.previewBackup(saved).qualifierBaseScoredSlots, 8);
  assert.equal(store.previewBackup(saved).qualifierScoringMode, 'challenge-total');
  persist('set-qualifier-total', { group: 'A', playerId: 'p4', total: 2800000 });
  store.restore(saved, store.state.revision, 'Restore reviewed Challenge results');
  assert.equal(Q.result(store.state, 'A', 'p4').challengeTotal, 2700001);
  assert.equal(JSON.stringify(publicState(store.state)).includes('Private original'), false);
  assert.equal(publicState(store.state).qualifier.adjudications, undefined);
});

test('qualifier rematches invalidate the whole direct total, preserve zero evidence and change the scoring context', () => {
  const state = boundaryTie(); act(state, 'draw-qualifier-tiebreak', { group: 'A', playerIds: ['p4', 'p5'] });
  const oldKey = scorekeeperState(state).contextKey, evidence = structuredClone(state.qualifier.rounds.A.tiebreaks);
  act(state, 'authorize-song-rematch', rematch());
  assert.equal(Q.result(state, 'A', 'p4').challengeTotal, null);
  assert.deepEqual(state.qualifier.rounds.A.results.p4.scores, [null, null, null]);
  assert.deepEqual(state.qualifier.adjudications.at(-1).previousResult, { challengeTotal: 2700000 });
  assert.deepEqual(state.qualifier.adjudications.at(-1).invalidatedTiebreaks, evidence);
  assert.notEqual(scorekeeperState(state).contextKey, oldKey);
  enter(state, 'A', 'p4', 0); act(state, 'authorize-song-rematch', rematch({ songIndex: 1 }));
  assert.equal(state.qualifier.adjudications.at(-1).previousResult.challengeTotal, 0);
  assert.throws(() => act(state, 'authorize-song-rematch', rematch({ songIndex: 1 })), /already used/);
  assert.equal(publicState(state).qualifier.incidents, undefined);
});

test('scoring-mode adoption is explicit for blank legacy events and never reinterprets or clears recorded history', t => {
  const blank = legacyState(), old = structuredClone(blank), key = scorekeeperState(blank).contextKey;
  validateState(blank); assert.equal(blank.qualifier.scoringMode, undefined); assert.equal(Q.isChallenge(blank), false);
  act(blank, 'apply-competition-config', { confirmed: true });
  assert.equal(blank.qualifier.scoringMode, 'challenge-total'); assert.equal(scorekeeperState(blank).qualifier.needsPlan, true);
  assert.notEqual(scorekeeperState(blank).contextKey, key);
  assert.deepEqual(blank.qualifier.players.map(({ challengeTotal, ...player }) => player), old.qualifier.players);
  const mutations = [
    state => act(state, 'set-qualifier-score', { playerId: 'p1', songIndex: 0, score: 0 }),
    state => { state.qualifier.players[0].judgements = [{ accuracy: 99 }, null, null]; },
    state => { state.qualifier.players[0].tiePriority = 1; },
    state => { state.tournament.songHistory = { W1: [state.library[0]] }; },
    state => { state.qualifier.adjudications = [{ type: 'manual-score-correction', at: new Date().toISOString(), note: 'Original scores retained.' }]; }
  ];
  for (const mutate of mutations) {
    const state = legacyState(); mutate(state); const before = structuredClone(state);
    assert.throws(() => act(state, 'set-qualifier-scoring-mode', { mode: 'challenge-total' }), /only before/); assert.deepEqual(state, before);
    assert.throws(() => act(state, 'apply-competition-config', { confirmed: true })); assert.deepEqual(state, before);
  }
  const recorded = configured(); enter(recorded, 'A', 'p1', 0); enter(recorded, 'A', 'p1', null);
  delete recorded.qualifier.scoringStarted;
  assert.equal(Q.hasScores(recorded), true, 'Round history alone protects a cleared total if the optional global marker is absent.');
  assert.throws(() => act(recorded, 'set-qualifier-scoring-mode', { mode: 'legacy-score' }), /only before/);
  assert.throws(() => act(recorded, 'apply-competition-config', { confirmed: true }), /only before/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-challenge-legacy-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new StateStore(dir), legacy = legacyState();
  act(legacy, 'set-qualifier-plan', { plan: 'A' });
  for (const player of Q.entries(legacy, 'A')) for (let songIndex = 0; songIndex < 3; songIndex++) act(legacy, 'set-qualifier-score', {
    playerId: player.id, songIndex, score: 990000, judgements: { accuracy: 100 - player.number } });
  store.state = legacy; store.write(legacy);
  assert.equal(rankings(legacy, 'A')[0].total, 2970000); assert.equal(rankings(legacy, 'A')[0].accuracy, 99);
  const restarted = new StateStore(dir);
  assert.equal(typeof restarted.state.eventId, 'string');
  assert.deepEqual(restarted.state, { ...legacy, eventId: restarted.state.eventId });
  assert.equal(new StateStore(dir).state.qualifier.scoringMode, undefined, 'Restart must never infer Challenge totals from existing ordinary scores.');
});

test('Challenge state, historical evidence and backup counts reject malformed totals while DE and GF remain ordinary scores', () => {
  const state = configured(); enter(state, 'A', 'p1', 0);
  const counts = scoreCounts(state); assert.equal(counts.qualifierBaseScoredSlots, 1); assert.equal(counts.qualifierScoredSlots, 1);
  for (const bad of [-1, 3000001, 12.5, '2876543', NaN, Infinity, undefined]) {
    const copy = structuredClone(state); copy.qualifier.rounds.A.results.p1.challengeTotal = bad; assert.throws(() => validateState(copy), /challengeTotal/);
  }
  for (const damage of [copy => { copy.qualifier.scoringMode = 'challenge-accuracy'; },
    copy => { copy.qualifier.rounds.A.results.p1.scores[0] = 900000; },
    copy => { copy.qualifier.rounds.A.results.p1.judgements[0] = { accuracy: 99 }; },
    copy => { copy.qualifier.adjudications = [{ type: 'set-qualifier-total', at: new Date().toISOString(), previousChallengeTotal: 3000001 }]; },
    copy => { copy.qualifier.adjudications = [{ type: 'authorize-song-rematch', at: new Date().toISOString(), previousResult: { challengeTotal: -1 } }]; }]) {
    const copy = structuredClone(state); damage(copy); assert.throws(() => validateState(copy), /Damaged state/);
  }
  const impossible = createDefaultState(); impossible.qualifier.players[0].challengeTotal = 123;
  assert.throws(() => validateState(impossible), /configure a qualifier plan/);
  const de = createDefaultState(); act(de, 'seed-bracket', { ids: de.qualifier.players.map(player => player.id) });
  act(de, 'draw-candidates'); for (const playerIndex of [0, 1]) act(de, 'ban-song', { playerIndex, songId: null, confirmed: true }); act(de, 'pick-songs');
  for (const playerIndex of [0, 1]) for (const songIndex of [0, 1]) act(de, 'set-match-score', {
    playerIndex, songIndex, score: 990000, judgements: { accuracy: 99 - playerIndex } });
  act(de, 'record-result', { verified: true });
  assert.equal(de.result.totals[0], 1980000); assert.equal(de.result.decisionReason, 'accuracy');
  assert.equal(de.tournament.matches.at(-1).finalMode, 'fixed-two'); assert.deepEqual(de.tournament.matches.at(-1).scores, [[null, null], [null, null]]);
  assert.throws(() => ScoreRules.total([99.5]), /integers/);
  validateState(JSON.parse(JSON.stringify(de)));
});
