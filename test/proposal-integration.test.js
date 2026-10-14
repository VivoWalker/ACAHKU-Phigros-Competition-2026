const test = require('node:test');
const assert = require('node:assert/strict');
const { createDefaultState } = require('./helpers/legacy-state');
const { applyAction, CURRENT_MATCH_ACTIONS, publicState, resultCorrectionImpact, losses } = require('../lib/tournament');
const { validateState } = require('../lib/state-validation');
const BracketView = require('../public/js/bracket-view');
const Countdown = require('../public/js/countdown');
const { expandSongLibrary, finalCandidates } = require('./helpers/song-library');

function act(state, type, payload = {}) {
  const next = structuredClone(state);
  applyAction(next, { type, payload: CURRENT_MATCH_ACTIONS.has(type) ? { matchId: next.tournament.currentMatchId, ...payload } : payload });
  validateState(next);
  Object.assign(state, next);
  return state;
}
function fixture(songCount = 12) {
  const state = expandSongLibrary(createDefaultState(), songCount);
  act(state, 'seed-bracket', { ids: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'], ruleset: 'proposal-2026' });
  return state;
}
const match = (state, id = state.tournament.currentMatchId) => state.tournament.matches.find(value => value.id === id);
function choose(state, id = state.tournament.currentMatchId, pass = true) {
  act(state, 'select-match', { matchId: id });
  if (id === 'GF') {
    const ids = finalCandidates(state);
    act(state, 'set-final-candidates', { ids });
    act(state, 'set-final-picks', { audienceIds: ids.slice(0, 2), hostId: ids[2] });
    act(state, 'reveal-host-song');
  } else {
    act(state, 'draw-candidates');
    for (const playerIndex of [0, 1]) act(state, 'ban-song', { playerIndex,
      songId: pass ? null : match(state).candidates[playerIndex].id, confirmed: true });
    act(state, 'pick-songs');
  }
}
function fill(state, winnerIndex = 0, accuracies = null, tied = false) {
  const count = match(state).scores[0].length;
  for (const playerIndex of [0, 1]) for (let songIndex = 0; songIndex < count; songIndex++) act(state, 'set-match-score', {
    playerIndex, songIndex, score: tied ? 990000 : playerIndex === winnerIndex ? 990000 : 980000,
    judgements: { accuracy: accuracies?.[playerIndex]?.[songIndex] ?? 99, perfect: 900, good: 10, bad: 0, miss: 0 }
  });
}
function complete(state, id, winnerId) {
  choose(state, id);
  const index = match(state).players.indexOf(winnerId);
  assert.notEqual(index, -1, `${winnerId} must be an entrant of ${id}`);
  fill(state, index); act(state, 'record-result', { verified: true });
}
function finishFirstRound(state) {
  for (const [id, winner] of [['W1', 'p8'], ['W2', 'p4'], ['W3', 'p2'], ['W4', 'p6']]) complete(state, id, winner);
}
function traceSources(state, item) {
  return item.sources.map(source => source.type === 'seed' ? state.tournament.seeds[source.value - 1] :
    match(state, source.value)[source.type === 'winner' ? 'winnerId' : 'loserId']);
}

test('proposal bracket waits for the whole entry field and reseeds actual R2 and R3 sources', () => {
  const state = fixture(42);
  complete(state, 'W1', 'p8'); complete(state, 'W2', 'p4');
  assert.equal(match(state, 'W5').status, 'pending'); assert.equal(match(state, 'L1').status, 'pending');
  assert.deepEqual(match(state, 'W5').players, [null, null]);
  assert.deepEqual(match(state, 'L1').players, [null, null]);
  const waitingR2 = publicState(state);
  assert.equal(BracketView.destination(waitingR2, match(waitingR2, 'W1'), 'p8').target, null);
  assert.equal(BracketView.destination(waitingR2, match(waitingR2, 'W1'), 'p1').target, null);
  assert.throws(() => act(state, 'select-match', { matchId: 'W5' }), /ready match/);
  complete(state, 'W3', 'p2'); complete(state, 'W4', 'p6');
  assert.deepEqual(match(state, 'W5').players, ['p2', 'p8']);
  assert.deepEqual(match(state, 'W6').players, ['p4', 'p6']);
  assert.deepEqual(match(state, 'L1').players, ['p1', 'p7']);
  assert.deepEqual(match(state, 'L2').players, ['p3', 'p5']);
  assert.deepEqual(match(state, 'W5').sources, [{ type: 'winner', value: 'W3' }, { type: 'winner', value: 'W1' }]);
  assert.deepEqual(match(state, 'L1').sources, [{ type: 'loser', value: 'W1' }, { type: 'loser', value: 'W3' }]);
  for (const [id, winner] of [['W5', 'p8'], ['W6', 'p4'], ['L1', 'p7']]) complete(state, id, winner);
  assert.equal(match(state, 'L3').status, 'pending');
  const waitingR3 = publicState(state);
  assert.equal(BracketView.destination(waitingR3, match(waitingR3, 'W5'), 'p2').target, null);
  assert.equal(BracketView.destination(waitingR3, match(waitingR3, 'L1'), 'p7').target, null);
  complete(state, 'L2', 'p3');
  assert.deepEqual(match(state, 'L3').players, ['p2', 'p7']);
  assert.deepEqual(match(state, 'L4').players, ['p3', 'p6']);
  assert.deepEqual(match(state, 'L3').sources, [{ type: 'loser', value: 'W5' }, { type: 'winner', value: 'L1' }]);
  for (const id of ['W5', 'W6', 'L1', 'L2', 'L3', 'L4']) assert.deepEqual(match(state, id).players, traceSources(state, match(state, id)));
  const view = publicState(state);
  assert.equal(BracketView.destination(view, match(view, 'W1'), 'p8').target, 'W5');
  assert.equal(BracketView.destination(view, match(view, 'W3'), 'p7').target, 'L1');
  assert.equal(BracketView.destination(view, match(view, 'W5'), 'p2').target, 'L3');
});

test('all fourteen proposal matches retain a single decisive six-candidate Grand Final and podium', () => {
  const state = fixture(42); finishFirstRound(state);
  for (const [id, winner] of [['W5', 'p8'], ['W6', 'p4'], ['L1', 'p7'], ['L2', 'p3'], ['W7', 'p4'],
    ['L3', 'p7'], ['L4', 'p6'], ['L5', 'p7'], ['L6', 'p8'], ['GF', 'p8']]) complete(state, id, winner);
  assert.equal(state.tournament.matches.length, 14);
  assert.equal(state.tournament.matches.filter(value => value.status === 'complete').length, 14);
  assert.equal(match(state, 'GF').candidates.length, 6); assert.equal(match(state, 'GF').songs.length, 3);
  assert.deepEqual(state.result.placements, { p8: 'Champion', p4: 'First Runner-up' });
  assert.equal(publicState(state).tournament.standings.find(value => value.playerId === 'p7').placement, 'Third place');
  assert.equal(losses(state, 'p4'), 1);
  assert.ok(state.tournament.matches.every(value => value.verifiedAt));
});

test('proposal correction impact covers every reseeded field and invalidates the old pairings', () => {
  const state = fixture(42); finishFirstRound(state); complete(state, 'W5', 'p8');
  choose(state, 'W6');
  const impact = resultCorrectionImpact(state, 'W1');
  for (const id of ['W5', 'W6', 'L1', 'L2', 'L3', 'L4', 'W7', 'L5', 'L6', 'GF']) assert.ok(impact.affectedMatchIds.includes(id), id);
  for (const id of ['W2', 'W3', 'W4']) assert.ok(!impact.affectedMatchIds.includes(id), id);
  assert.equal(impact.requiresConfirmation, true);
  assert.throws(() => act(state, 'reopen-result', { matchId: 'W1', affectedMatchIds: impact.affectedMatchIds, reason: 'Score transcription corrected' }), /Confirm clearing/);
  act(state, 'reopen-result', { matchId: 'W1', affectedMatchIds: impact.affectedMatchIds, reason: 'Score transcription corrected', confirmClear: true });
  for (const id of ['W5', 'W6', 'L1', 'L2', 'L3', 'L4']) {
    assert.equal(match(state, id).reseeded, undefined); assert.equal(match(state, id).status, 'pending');
    assert.equal(match(state, id).songs.length, 0); assert.equal(match(state, id).tiebreaks.length, 0);
  }
  fill(state, 0); act(state, 'record-result', { verified: true });
  assert.equal(match(state, 'W1').winnerId, 'p1');
  assert.deepEqual(match(state, 'W5').players, ['p1', 'p6']); assert.deepEqual(match(state, 'W6').players, ['p2', 'p4']);
  assert.deepEqual(match(state, 'L1').players, ['p3', 'p8']); assert.deepEqual(match(state, 'L2').players, ['p5', 'p7']);
});

test('explicit ban passes are confirmed decisions and six final candidates stay private until reveal', () => {
  const state = fixture(42); act(state, 'draw-candidates');
  act(state, 'ban-song', { playerIndex: 0, songId: null });
  assert.throws(() => act(state, 'pick-songs'), /ban or pass/);
  act(state, 'ban-song', { playerIndex: 0, songId: null, confirmed: true });
  act(state, 'ban-song', { playerIndex: 1, songId: null, confirmed: true });
  act(state, 'pick-songs'); assert.equal(match(state).songs.length, 2); assert.deepEqual(match(state).bans, [null, null]);
  fill(state, 1); act(state, 'record-result', { verified: true });
  for (const id of ['W2', 'W3', 'W4', 'W5', 'W6', 'L1', 'L2', 'W7', 'L3', 'L4', 'L5', 'L6']) {
    act(state, 'select-match', { matchId: id }); complete(state, id, match(state).players[0]);
  }
  act(state, 'select-match', { matchId: 'GF' });
  assert.throws(() => act(state, 'set-final-candidates', { ids: state.library.slice(0, 8).map(value => value.id) }), /6 distinct/);
  const ids = finalCandidates(state);
  act(state, 'set-final-candidates', { ids });
  act(state, 'set-final-picks', { audienceIds: ids.slice(0, 2), hostId: ids[2] });
  const hidden = match(publicState(state), 'GF');
  assert.equal(hidden.songs[2].hidden, true); assert.equal(hidden.hostPick, undefined);
  assert.throws(() => act(state, 'set-match-score', { playerIndex: 0, songIndex: 2, score: 999999, judgements: { accuracy: 99 } }), /Reveal the MC/);
  act(state, 'reveal-host-song'); assert.equal(match(publicState(state), 'GF').songs[2].id, ids[2]);
});

test('actual result confirmation resolves score-screen mean accuracy and rejects a referee bypass', () => {
  const state = fixture(); choose(state); fill(state, 0, [[98, 100], [99.5, 99.5]], true);
  assert.throws(() => act(state, 'record-result', { tieWinnerId: 'p1', note: 'Manual preference' }), /double-check/);
  act(state, 'record-result', { verified: true, tieWinnerId: 'p1', note: 'Ignored manual preference' });
  assert.equal(match(state).winnerId, 'p8'); assert.equal(match(state).decisionReason, 'accuracy');
  assert.deepEqual(state.result.totals, [1980000, 1980000]);
  const corrupted = structuredClone(state); match(corrupted).winnerId = 'p1'; match(corrupted).loserId = 'p8';
  assert.throws(() => validateState(corrupted));
});

test('actual repeated tiebreak score entry, verification and result persistence retain the base total', () => {
  const state = fixture(); choose(state); fill(state, 0, null, true);
  assert.throws(() => act(state, 'record-result', { verified: true, tieWinnerId: 'p1', note: 'No bypass' }), /Draw and play/);
  act(state, 'draw-match-tiebreak');
  for (const playerIndex of [0, 1]) act(state, 'set-match-tiebreak-score', { index: 0, playerIndex, score: 999999, judgements: { accuracy: 99.9999 } });
  assert.throws(() => act(state, 'confirm-match-tiebreak', { index: 0 }), /double-check/);
  act(state, 'confirm-match-tiebreak', { index: 0, verified: true });
  act(state, 'draw-match-tiebreak');
  act(state, 'set-match-tiebreak-score', { index: 1, playerIndex: 0, score: 980000, judgements: { accuracy: 98 } });
  act(state, 'set-match-tiebreak-score', { index: 1, playerIndex: 1, score: 980000, judgements: { accuracy: 98.1 } });
  act(state, 'confirm-match-tiebreak', { index: 1, verified: true });
  act(state, 'record-result', { verified: true });
  assert.equal(match(state).winnerId, 'p8'); assert.equal(match(state).decisionReason, 'tiebreak');
  assert.deepEqual(state.result.totals, [1980000, 1980000]);
  assert.equal(match(state).tiebreaks.length, 2);
  assert.ok(match(state).tiebreaks.every(round => Number.isFinite(Date.parse(round.confirmedAt))));
  assert.doesNotThrow(() => validateState(JSON.parse(JSON.stringify(state))));
  const corrupted = structuredClone(state); match(corrupted).tiebreaks[1].scores[1] = null;
  assert.throws(() => validateState(corrupted));
});

test('reopening a tied result preserves base entries and invalidates its confirmed tiebreak decision', () => {
  const state = fixture(); choose(state); fill(state, 0, null, true);
  act(state, 'draw-match-tiebreak');
  for (const playerIndex of [0, 1]) act(state, 'set-match-tiebreak-score', {
    index: 0, playerIndex, score: playerIndex === 0 ? 980000 : 990000, judgements: { accuracy: 99 }
  });
  act(state, 'confirm-match-tiebreak', { index: 0, verified: true }); act(state, 'record-result', { verified: true });
  const before = structuredClone(match(state).scores), impact = resultCorrectionImpact(state, 'W1');
  act(state, 'reopen-result', { matchId: 'W1', affectedMatchIds: impact.affectedMatchIds, reason: 'Correct original score transcription', confirmClear: true });
  assert.deepEqual(match(state).scores, before); assert.deepEqual(match(state).tiebreaks, []);
  assert.equal(match(state).verifiedAt, undefined); assert.equal(match(state).decisionReason, undefined);
  assert.equal(state.correctionLog.at(-1).previousMatch.tiebreaks.length, 1);
  act(state, 'set-match-score', { playerIndex: 0, songIndex: 0, score: 990001, judgements: { accuracy: 99 } });
  act(state, 'record-result', { verified: true }); assert.equal(match(state).winnerId, 'p1');
});

test('countdown context changes for repeat tiebreaks even when the same song is drawn again', () => {
  const state = fixture(); choose(state); fill(state, 0, null, true);
  act(state, 'set-scene', { scene: 'double-elimination-match' });
  for (const song of [...state.library]) act(state, 'upsert-song', { song: { ...song, eligible: song.id === 'song-1' } });
  const base = Countdown.context(state);
  act(state, 'draw-match-tiebreak'); const first = Countdown.context(state);
  assert.equal(first.songId, 'song-1'); assert.equal(first.tiebreakIndex, 0);
  assert.notEqual(first.key, base.key);
  for (const playerIndex of [0, 1]) act(state, 'set-match-tiebreak-score', {
    index: 0, playerIndex, score: 990000, judgements: { accuracy: 99 }
  });
  act(state, 'confirm-match-tiebreak', { index: 0, verified: true });
  assert.notEqual(Countdown.context(state).key, first.key);
  act(state, 'draw-match-tiebreak'); const repeated = Countdown.context(state);
  assert.equal(repeated.songId, first.songId); assert.equal(repeated.tiebreakIndex, 1);
  assert.notEqual(repeated.key, first.key);
});
