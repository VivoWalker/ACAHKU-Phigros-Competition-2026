const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createDefaultState } = require('../lib/default-state');
const { createDefaultState: createLegacyState } = require('./helpers/legacy-state');
const { applyAction, CURRENT_MATCH_ACTIONS, resultCorrectionImpact, publicState } = require('../lib/tournament');
const { validateState } = require('../lib/state-validation');
const QualifierRules = require('../public/js/qualifier-rules');

function act(state, type, payload = {}) {
  const next = structuredClone(state);
  applyAction(next, { type, payload: CURRENT_MATCH_ACTIONS.has(type) ?
    { matchId: next.tournament.currentMatchId, ...payload } : payload });
  validateState(next);
  Object.assign(state, next);
}
function reload(state) {
  const saved = JSON.parse(JSON.stringify(state));
  validateState(saved);
  return saved;
}
function rematch(payload = {}) {
  return { stage: 'qualifier', group: 'A', playerId: 'p4', songIndex: 0, tiebreakIndex: 0,
    reason: 'game-error', videoChecked: false, unintentional: false, allAgree: false,
    note: 'The arbiter verified a game error and authorised a replay.', ...payload };
}
function ordered(songId) {
  return values => {
    const first = values.find(song => song.id === songId);
    assert.ok(first, 'The fixture song must be available in the draw pool.');
    return [first, ...values.filter(song => song.id !== songId)];
  };
}
function qualifier() {
  const state = createDefaultState();
  act(state, 'set-qualifier-plan', { plan: 'A' });
  [2970000, 2940000, 2910000, 2700000, 2700000, 2400000, 2100000, 1800000].forEach((total, i) =>
    act(state, 'set-qualifier-total', { group: 'A', playerId: 'p' + (i + 1), total }));
  return state;
}
function drawQualifier(state, songId) {
  QualifierRules.applyAction(state, { type: 'draw-qualifier-tiebreak', payload: { group: 'A', playerIds: ['p4', 'p5'] } },
    { shuffled: ordered(songId) });
  validateState(state);
}
function correctQualifier(state) {
  act(state, 'set-qualifier-total', { group: 'A', playerId: 'p4', total: 2700001,
    confirmClearTiebreaks: true, verified: true, reason: 'The arbiters reviewed and corrected the original total.' });
  act(state, 'set-qualifier-total', { group: 'A', playerId: 'p4', total: 2700000 });
  assert.deepEqual(state.qualifier.rounds.A.tiebreaks, []);
}
function match(state) { return state.tournament.matches.find(item => item.id === state.tournament.currentMatchId); }
function elimination() {
  const state = createLegacyState();
  act(state, 'seed-bracket', { ids: state.qualifier.players.map(player => player.id), ruleset: 'proposal-2026' });
  act(state, 'draw-candidates');
  for (const playerIndex of [0, 1]) act(state, 'ban-song', { playerIndex, songId: null, confirmed: true });
  act(state, 'pick-songs');
  for (const playerIndex of [0, 1]) for (const songIndex of [0, 1]) act(state, 'set-match-score',
    { playerIndex, songIndex, score: 990000, judgements: { accuracy: 99 } });
  return state;
}
function drawMatch(state, songId) {
  // Keep one eligible fixture song so the real command's random draw is stable.
  const library = state.library;
  state.library = library.map(song => ({ ...song, eligible: song.id === songId }));
  act(state, 'draw-match-tiebreak');
  assert.equal(match(state).tiebreaks.at(-1).song.id, songId);
  state.library = library;
  validateState(state);
}
function reopenMatch(state) {
  for (const playerIndex of [0, 1]) act(state, 'set-match-tiebreak-score',
    { playerIndex, index: 0, score: 990000 - playerIndex, judgements: { accuracy: 99 } });
  act(state, 'confirm-match-tiebreak', { index: 0, verified: true });
  act(state, 'record-result', { verified: true });
  const impact = resultCorrectionImpact(state, match(state).id);
  act(state, 'reopen-result', { matchId: impact.matchId, affectedMatchIds: impact.affectedMatchIds,
    confirmClear: true, reason: 'The arbiters reviewed reopening this match result.' });
  assert.deepEqual(match(state).tiebreaks, []);
}

test('a different qualifier tiebreak song gets its own replay after a reviewed correction reuses index zero', () => {
  let state = qualifier();
  const [first, second] = state.library;
  drawQualifier(state, first.id);
  act(state, 'authorize-song-rematch', rematch());
  correctQualifier(state);
  drawQualifier(state, second.id);
  state = reload(state);
  act(state, 'authorize-song-rematch', rematch());
  assert.deepEqual(state.qualifier.incidents.map(incident => [incident.songId, incident.tiebreakIndex]),
    [[first.id, 0], [second.id, 0]]);
  assert.deepEqual(state.qualifier.incidents[0].song, first);
  assert.deepEqual(state.qualifier.incidents[1].song, second);
  act(state, 'authorize-song-rematch', rematch({ playerId: 'p5' }));
  assert.throws(() => act(state, 'authorize-song-rematch', rematch()), /already used this tiebreak rematch/);
  assert.equal(publicState(state).qualifier.incidents, undefined);
  reload(state);
});

test('qualifier correction cannot refresh the same song allowance, including a saved title alias', () => {
  let state = qualifier();
  const first = { ...state.library[6] };
  drawQualifier(state, first.id);
  act(state, 'authorize-song-rematch', rematch());
  correctQualifier(state);
  drawQualifier(state, first.id);
  assert.throws(() => act(state, 'authorize-song-rematch', rematch()), /already used this tiebreak rematch/);
  correctQualifier(state);
  act(state, 'upsert-song', { song: { ...first, title: 'Renamed original library entry' } });
  const alias = { ...first, id: 'qualifier-rematch-alias', title: '  ' + first.title.toUpperCase() + '  ' };
  act(state, 'upsert-song', { song: alias });
  state = reload(state);
  drawQualifier(state, alias.id);
  assert.throws(() => act(state, 'authorize-song-rematch', rematch()), /already used this tiebreak rematch/);
  correctQualifier(state);
  const renamedAlias = { ...state.library.find(song => song.id === first.id), id: 'qualifier-renamed-alias' };
  act(state, 'upsert-song', { song: renamedAlias });
  drawQualifier(state, renamedAlias.id);
  assert.throws(() => act(state, 'authorize-song-rematch', rematch()), /already used this tiebreak rematch/);
});

test('legacy qualifier incidents without a song snapshot retain their same-song allowance after correction', () => {
  let state = qualifier();
  const [first, second] = state.library;
  drawQualifier(state, first.id);
  act(state, 'authorize-song-rematch', rematch());
  delete state.qualifier.incidents[0].song;
  delete state.qualifier.adjudications.at(-1).song;
  state = reload(state);
  correctQualifier(state);
  drawQualifier(state, first.id);
  assert.throws(() => act(state, 'authorize-song-rematch', rematch()), /already used this tiebreak rematch/);
  correctQualifier(state);
  drawQualifier(state, second.id);
  act(state, 'authorize-song-rematch', rematch());
  reload(state);
});

test('a different elimination tiebreak song gets one shared replay after reopening a result and reusing index zero', () => {
  let state = elimination();
  const [first, second] = state.library;
  drawMatch(state, first.id);
  const replay = rematch({ stage: 'double-elimination', matchId: 'W1' });
  act(state, 'authorize-song-rematch', replay);
  reopenMatch(state);
  drawMatch(state, second.id);
  state = reload(state);
  const base = structuredClone(match(state).scores);
  act(state, 'authorize-song-rematch', replay);
  assert.deepEqual(match(state).rematches.map(incident => [incident.songId, incident.tiebreakIndex]),
    [[first.id, 0], [second.id, 0]]);
  assert.deepEqual(match(state).scores, base);
  assert.deepEqual(match(state).tiebreaks[0].scores, [null, null]);
  assert.throws(() => act(state, 'authorize-song-rematch', replay), /shared rematch.*already been used/);
  assert.equal(match(publicState(state)).rematches, undefined);
  reload(state);
});

test('elimination result reopening preserves legacy same-song and saved-alias replay limits', () => {
  let state = elimination();
  const first = { ...state.library[0] };
  drawMatch(state, first.id);
  const replay = rematch({ stage: 'double-elimination', matchId: 'W1' });
  act(state, 'authorize-song-rematch', replay);
  const snapshot = match(state).rematches[0].song;
  delete match(state).rematches[0].song;
  state = reload(state);
  reopenMatch(state);
  drawMatch(state, first.id);
  assert.throws(() => act(state, 'authorize-song-rematch', replay), /shared rematch.*already been used/);
  match(state).rematches[0].song = snapshot;
  reopenMatch(state);
  act(state, 'upsert-song', { song: { ...first, title: 'Renamed original elimination chart' } });
  const alias = { ...first, id: 'elimination-rematch-alias' };
  act(state, 'upsert-song', { song: alias });
  state = reload(state);
  drawMatch(state, alias.id);
  assert.throws(() => act(state, 'authorize-song-rematch', replay), /shared rematch.*already been used/);
  reopenMatch(state);
  const renamedAlias = { ...state.library.find(song => song.id === first.id), id: 'elimination-renamed-alias' };
  act(state, 'upsert-song', { song: renamedAlias });
  act(state, 'upsert-song', { song: { ...state.library.find(song => song.id === first.id), title: 'Later renamed elimination chart' } });
  drawMatch(state, renamedAlias.id);
  assert.throws(() => act(state, 'authorize-song-rematch', replay), /shared rematch.*already been used/);
});

test('base-song and tiebreak replay allowances stay independent for the same elimination song', () => {
  const state = elimination(), songId = match(state).songs[0].id;
  drawMatch(state, songId);
  act(state, 'authorize-song-rematch', rematch({ stage: 'double-elimination', matchId: 'W1' }));
  act(state, 'authorize-song-rematch', rematch({ stage: 'double-elimination', matchId: 'W1', tiebreakIndex: undefined }));
  assert.equal(match(state).rematches.length, 2);
  assert.deepEqual(match(state).tiebreaks, []);
  reload(state);
});

test('drawing the same extra song at a later index cannot refresh either qualifier or elimination replay quotas', () => {
  const qualifierState = qualifier(), qualifierSongId = qualifierState.library[6].id;
  drawQualifier(qualifierState, qualifierSongId);
  act(qualifierState, 'authorize-song-rematch', rematch());
  for (const playerId of ['p4', 'p5']) act(qualifierState, 'set-qualifier-tiebreak-score',
    { group: 'A', playerId, index: 0, score: 990000 });
  act(qualifierState, 'confirm-qualifier-tiebreak', { group: 'A', index: 0, verified: true });
  drawQualifier(qualifierState, qualifierSongId);
  assert.throws(() => act(qualifierState, 'authorize-song-rematch', rematch({ tiebreakIndex: 1 })),
    /already used this tiebreak rematch/);
  act(qualifierState, 'authorize-song-rematch', rematch({ playerId: 'p5', tiebreakIndex: 1 }));

  const eliminationState = elimination(), eliminationSongId = eliminationState.library[0].id;
  drawMatch(eliminationState, eliminationSongId);
  act(eliminationState, 'authorize-song-rematch', rematch({ stage: 'double-elimination', matchId: 'W1' }));
  for (const playerIndex of [0, 1]) act(eliminationState, 'set-match-tiebreak-score',
    { playerIndex, index: 0, score: 990000, judgements: { accuracy: 99 } });
  act(eliminationState, 'confirm-match-tiebreak', { index: 0, verified: true });
  drawMatch(eliminationState, eliminationSongId);
  assert.throws(() => act(eliminationState, 'authorize-song-rematch',
    rematch({ stage: 'double-elimination', matchId: 'W1', tiebreakIndex: 1 })), /shared rematch.*already been used/);
  reload(qualifierState);
  reload(eliminationState);
});

test('saved incidents validate their song snapshots without requiring new fields on legacy events', () => {
  const state = qualifier(), song = state.library[0];
  drawQualifier(state, song.id);
  act(state, 'authorize-song-rematch', rematch());
  const wrongSnapshot = structuredClone(state);
  wrongSnapshot.qualifier.incidents[0].song.id = state.library[1].id;
  assert.throws(() => validateState(wrongSnapshot), /snapshot differs from incident song/);
  const duplicate = structuredClone(state);
  duplicate.qualifier.incidents.push(structuredClone(duplicate.qualifier.incidents[0]));
  assert.throws(() => validateState(duplicate), /qualifier.incidents/);
  const historical = structuredClone(state);
  historical.qualifier.incidents.push({ ...historical.qualifier.incidents[0], tiebreakIndex: 1 });
  assert.doesNotThrow(() => validateState(historical), 'Previously valid same-song incidents at different indices remain loadable.');
  delete state.eventId;
  assert.doesNotThrow(() => validateState(state));
  state.eventId = randomUUID();
  assert.doesNotThrow(() => validateState(state));
  for (const invalid of ['', 123, 'not-an-event-id']) {
    state.eventId = invalid;
    assert.throws(() => validateState(state), /eventId/);
  }
});
