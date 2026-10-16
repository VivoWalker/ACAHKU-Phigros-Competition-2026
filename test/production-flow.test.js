const test = require('node:test');
const assert = require('node:assert/strict');
const { createDefaultState } = require('../lib/default-state');
const { createDefaultState: legacyState } = require('./helpers/legacy-state');
const { applyAction, publicState, rankings, CURRENT_MATCH_ACTIONS } = require('../lib/tournament');
const { validateState } = require('../lib/state-validation');
const { scorekeeperAction, scorekeeperState } = require('../lib/scorekeeper');
const Q = require('../public/js/qualifier-rules');
const { expandSongLibrary, finalCandidates } = require('./helpers/song-library');

function act(state, type, payload = {}) {
  const next = structuredClone(state);
  applyAction(next, { type, payload: CURRENT_MATCH_ACTIONS.has(type) ? { matchId: next.tournament.currentMatchId, ...payload } : payload });
  validateState(next); Object.assign(state, next); return state;
}
function configured(count = 8) {
  const state = createDefaultState();
  if (count !== 8) act(state, 'set-competition-roster', { names: Array.from({ length: count }, (_, i) => `Entrant ${i + 1}`) });
  return act(state, 'set-qualifier-plan', { plan: 'auto' });
}
const statistics = extra => ({ score: 987654, perfect: 1000, good: 7, bad: 2, miss: 1, ...extra });
const stats = (state, playerId = 'p1', songIndex = 0, value = statistics(), group = state.qualifier.activeGroup) =>
  act(state, 'set-qualifier-song-stats', { group, playerId, songIndex, stats: value });
const cue = (state, payload) => act(state, 'set-broadcast-cue', payload);
function unchanged(state, operation, pattern) {
  const before = structuredClone(state); assert.throws(operation, pattern); assert.deepEqual(state, before);
}
function seed(state) {
  return act(state, 'seed-bracket', { ids: state.qualifier.players.slice(0, 8).map(player => player.id),
    verified: true, note: 'Fixture arbiter reviewed this seed override.' });
}
function choose(state, matchId = state.tournament.currentMatchId) {
  cue(state, { stage: 'double-elimination', scene: 'double-elimination-waiting', matchId, songIndex: 0 });
  act(state, 'draw-candidates');
  const candidates = state.tournament.matches.find(match => match.id === matchId).candidates;
  for (const playerIndex of [0, 1]) act(state, 'ban-song', { playerIndex, songId: candidates[playerIndex].id, confirmed: true });
  act(state, 'pick-songs');
}
function finish(state) {
  const match = state.tournament.matches.find(value => value.id === state.tournament.currentMatchId);
  for (const playerIndex of [0, 1]) for (let songIndex = 0; songIndex < match.songs.length; songIndex++) {
    act(state, 'set-match-score', { playerIndex, songIndex, score: playerIndex ? 800000 : 900000 });
  }
  act(state, 'record-result', { verified: true });
}

test('manual qualifier cues preserve players and show provisional rankings in one state', () => {
  const state = configured(), players = Q.entries(state, 'A').slice(0, 3).map(player => player.id);
  for (const songIndex of [0, 1, 2]) for (const scene of ['qualifier-waiting', 'qualifier-match', 'song-result']) {
    cue(state, { stage: 'qualifier', scene, group: 'A', players, songIndex });
    assert.equal(state.stage, 'qualifier'); assert.equal(state.scene, scene);
    assert.equal(state.qualifier.currentSong, songIndex); assert.deepEqual(state.qualifier.activePlayers, players);
  }
  cue(state, { stage: 'qualifier', scene: 'result', group: 'A' });
  assert.equal(state.scene, 'result'); assert.equal(state.result, null);
  assert.ok(rankings(state, 'A').every(player => !player.complete));
  unchanged(state, () => cue(state, { stage: 'qualifier', scene: 'qualifier-waiting', group: 'B' }), /Finalize the first round/);
  unchanged(state, () => cue(state, { stage: 'qualifier', scene: 'bracket' }), /qualifier broadcast/);
  unchanged(state, () => cue(state, { stage: 'qualifier', scene: 'qualifier-match', players: [] }), /Choose the players/);
  unchanged(state, () => cue(state, { stage: 'qualifier', scene: 'qualifier-match', players: ['p1', 'p1'] }), /different players/);
  unchanged(state, () => cue(state, { stage: 'qualifier', scene: 'qualifier-match', players: ['unknown'] }), /eligible/);
  for (const songIndex of [-1, 3, '1', 0.5]) unchanged(state, () => cue(state, { stage: 'qualifier', scene: 'qualifier-waiting', songIndex }), /song number/);
});

test('continuous Challenge cues keep the same match and scoring batch until the complete three-song result', () => {
  const state = configured(), players = ['p3', 'p1', 'p2'];
  state.broadcast.showHandcams = true;
  cue(state, { stage: 'qualifier', scene: 'qualifier-waiting', group: 'A', players, songIndex: 0 });
  const scoringKey = scorekeeperState(state).contextKey, sources = structuredClone(state.broadcast);
  for (const songIndex of [0, 1, 2]) {
    cue(state, { stage: 'qualifier', scene: 'qualifier-match', group: 'A', players, songIndex });
    assert.equal(state.scene, 'qualifier-match');
    assert.equal(state.qualifier.currentSong, songIndex);
    assert.deepEqual(state.qualifier.activePlayers, players);
    assert.deepEqual(state.broadcast, sources, 'Advancing a song must not replace camera or handcam configuration');
    assert.equal(scorekeeperState(state).contextKey, scoringKey, 'The continuous set shares one scoring sheet');
    assert.ok(Q.entries(state, 'A').every(player => !Q.complete(state, player)), 'No intermediate score is required to continue playing');
  }
  cue(state, { stage: 'qualifier', scene: 'qualifier-processing', group: 'A', players, songIndex: 2 });
  assert.equal(state.scene, 'qualifier-processing');
  assert.deepEqual(state.qualifier.activePlayers, players);
  assert.equal(scorekeeperState(state).contextKey, scoringKey, 'The processing screen must keep the current scorekeeper sheet');
  unchanged(state, () => cue(state, { stage: 'qualifier', scene: 'qualifier-processing', players: [] }), /Choose the players/);
  unchanged(state, () => cue(state, { stage: 'double-elimination', scene: 'qualifier-processing' }), /Double Elimination broadcast scene/);
  const songStats = [statistics({ score: 990000 }), statistics({ score: 980000 }), statistics({ score: 970000 })];
  const result = scorekeeperAction(state, { contextKey: scoringKey, action: {
    type: 'set-qualifier-challenge-result', payload: { group: 'A', playerId: 'p3', songStats, total: 2940000 }
  } });
  act(state, result.type, result.payload);
  assert.equal(state.scene, 'qualifier-processing', 'Saving scores must not automatically reveal results');
  cue(state, { stage: 'qualifier', scene: 'song-result', group: 'A', players, songIndex: 2 });
  const settled = publicState(state).qualifier.rounds.A.results.p3;
  assert.deepEqual(settled.songStats, songStats);
  assert.equal(settled.challengeTotal, 2940000);
  assert.equal(scorekeeperState(state).contextKey, scoringKey);
  cue(state, { stage: 'qualifier', scene: 'result', group: 'A', players });
  assert.equal(rankings(state, 'A')[0].id, 'p3');
  cue(state, { stage: 'qualifier', scene: 'qualifier-waiting', group: 'A', players: ['p4', 'p5', 'p6'], songIndex: 0 });
  assert.equal(state.qualifier.currentSong, 0);
  assert.notEqual(scorekeeperState(state).contextKey, scoringKey, 'The next batch receives a separate scoring sheet');
});

test('Plan B and legacy cues switch groups without carrying another group’s camera players', () => {
  for (const state of [configured(21), legacyState()]) {
    const players = Q.entries(state, 'B').slice(0, 3).map(player => player.id);
    cue(state, { stage: 'qualifier', scene: 'qualifier-waiting', group: 'B', songIndex: 0 });
    assert.deepEqual(state.qualifier.activePlayers, []);
    cue(state, { stage: 'qualifier', scene: 'qualifier-match', players, songIndex: 1 });
    assert.equal(state.qualifier.activeGroup, 'B'); assert.deepEqual(state.qualifier.activePlayers, players);
  }
});

test('per-song statistics are public broadcast data and never determine Challenge totals, completeness or ranking', () => {
  const state = configured();
  act(state, 'set-qualifier-total', { group: 'A', playerId: 'p1', total: 1 });
  act(state, 'set-qualifier-total', { group: 'A', playerId: 'p2', total: 2999999 });
  const rank = rankings(state, 'A').map(player => [player.id, player.total, player.complete]);
  stats(state, 'p1', 0, statistics({ score: 1000000, accuracy: 100 }));
  stats(state, 'p3', 1, statistics({ score: 0, perfect: 0, good: 0, bad: 0, miss: 0 }));
  assert.deepEqual(rankings(state, 'A').map(player => [player.id, player.total, player.complete]), rank);
  assert.equal(Q.result(state, 'A', 'p1').challengeTotal, 1);
  assert.deepEqual(Q.result(state, 'A', 'p1').scores, [null, null, null]);
  assert.deepEqual(Q.result(state, 'A', 'p1').judgements, [null, null, null]);
  const published = publicState(state), player = published.qualifier.rankings.A.find(value => value.id === 'p1');
  assert.deepEqual(player.songStats[0], statistics({ score: 1000000, accuracy: 100 }));
  assert.equal(published.qualifier.readiness, undefined);
  stats(state, 'p1', 0, null);
  assert.equal(Q.result(state, 'A', 'p1').songStats[0], null);
  assert.equal(Q.roundStarted(state, 'A'), true); assert.equal(Q.hasScores(state), true);
  unchanged(state, () => act(state, 'set-qualifier-plan', { plan: 'A' }), /before scoring/);
  unchanged(state, () => act(state, 'set-qualifier-scoring-mode', { mode: 'legacy-score' }), /before any recorded scores/);
});

test('song statistics reject malformed values, unknown fields and inactive players without affecting saved state', () => {
  const state = configured();
  for (const bad of [undefined, {}, [], 'score', statistics({ score: -1 }), statistics({ score: 1000001 }),
    statistics({ score: 0.5 }), statistics({ perfect: -1 }), statistics({ good: 0.5 }),
    statistics({ miss: Number.MAX_SAFE_INTEGER + 1 }), statistics({ accuracy: NaN }), statistics({ accuracy: 101 }),
    statistics({ accuracy: '99' }), statistics({ privateNote: 'Do not publish' })]) {
    unchanged(state, () => act(state, 'set-qualifier-song-stats', { group: 'A', playerId: 'p1', songIndex: 0, stats: bad }));
  }
  unchanged(state, () => stats(state, 'p1', 0, statistics(), 'B'), /active qualifier group/);
  unchanged(state, () => stats(state, 'unknown'), /not eligible/);
  unchanged(state, () => stats(state, 'p1', 3), /song number/);
  const damaged = structuredClone(state);
  Q.result(damaged, 'A', 'p1').songStats = [statistics(), null];
  assert.throws(() => validateState(damaged), /songStats/);
  Q.result(damaged, 'A', 'p1').songStats = [statistics({ privateNote: 'Do not publish' }), null, null];
  assert.throws(() => validateState(damaged), /Unknown song statistics/);
});

test('statistics lock setup and charts even after clearing, and legacy events retain their official individual scores', () => {
  for (const state of [configured(), legacyState()]) {
    const official = structuredClone(Q.result(state, 'A', 'p1'));
    stats(state); assert.equal(Q.recorded(Q.result(state, 'A', 'p1')), true);
    assert.equal(Q.roundStarted(state, 'A'), true);
    const first = state.library.find(song => song.id === state.qualifier.groups.A.songs[0]);
    unchanged(state, () => act(state, 'upsert-song', { song: { ...first, title: 'Incorrect replacement' } }), /metadata is locked/);
    stats(state, 'p1', 0, null);
    assert.equal(Q.roundStarted(state, 'A'), true);
    unchanged(state, () => act(state, 'upsert-song', { song: { ...first, title: 'Incorrect replacement' } }), /metadata is locked/);
    assert.deepEqual(Q.result(state, 'A', 'p1').scores, official.scores);
    if (!Q.isChallenge(state)) {
      unchanged(state, () => act(state, 'set-roster', { group: 'A', names: state.qualifier.players.filter(player => player.group === 'A' && player.id !== 'p1').map(player => player.name) }), /Scored players cannot be removed/);
      act(state, 'set-qualifier-score', { playerId: 'p1', songIndex: 0, score: 456789 });
      stats(state, 'p1', 0, statistics({ score: 999999 }));
      assert.equal(Q.total(state, Q.result(state, 'A', 'p1')), 456789);
    }
  }
});

test('qualifier rematches clear just the affected song statistics and invalidate the direct total', () => {
  const state = configured(); stats(state); stats(state, 'p1', 1);
  act(state, 'set-qualifier-total', { group: 'A', playerId: 'p1', total: 2876543 });
  act(state, 'authorize-song-rematch', { stage: 'qualifier', group: 'A', playerId: 'p1', songIndex: 0,
    reason: 'game-error', videoChecked: false, unintentional: false, allAgree: false,
    note: 'Fixture referee verified the game error and replay.' });
  const row = Q.result(state, 'A', 'p1');
  assert.equal(row.songStats[0], null); assert.deepEqual(row.songStats[1], statistics());
  assert.equal(row.challengeTotal, null);
  assert.equal(publicState(state).qualifier.adjudications, undefined);
});

test('qualified rounds, seeded tournaments, disqualified entrants and active tiebreaks lock base song statistics', () => {
  const state = configured();
  for (const player of Q.entries(state, 'A')) act(state, 'set-qualifier-total', { group: 'A', playerId: player.id, total: 3000000 - player.number * 1000 });
  act(state, 'finalize-qualifier-round', { group: 'A', verified: true });
  cue(state, { stage: 'qualifier', scene: 'result', group: 'A' });
  unchanged(state, () => stats(state), /locked/);
  cue(state, { stage: 'qualifier', scene: 'qualifier-waiting', group: 'B', players: ['p5'] });
  stats(state, 'p5'); assert.equal(Q.result(state, 'B', 'p5').songStats[0].score, 987654);
  assert.equal(Q.result(state, 'A', 'p5').songStats, undefined);
  seed(state); unchanged(state, () => stats(state, 'p5'), /locked/);
  const tie = configured();
  for (const player of Q.entries(tie, 'A')) act(tie, 'set-qualifier-total', { group: 'A', playerId: player.id, total: player.number < 4 ? 3000000 - player.number : player.number < 6 ? 2700000 : 2000000 - player.number });
  act(tie, 'draw-qualifier-tiebreak', { group: 'A', playerIds: ['p4', 'p5'] });
  unchanged(tie, () => stats(tie, 'p4'), /tiebreak starts/);
  const dq = configured();
  act(dq, 'disqualify-player', { playerId: 'p1', reason: 'rule-violation', note: 'Fixture arbiter reviewed entrant misconduct.' });
  unchanged(dq, () => stats(dq), /not eligible/);
});

test('Double Elimination cues select ready matches atomically and reject missing songs, stale match IDs and unavailable matches', () => {
  const state = seed(configured());
  cue(state, { stage: 'double-elimination', scene: 'double-elimination-waiting', matchId: 'W2', songIndex: 0 });
  assert.equal(state.tournament.currentMatchId, 'W2');
  assert.equal(state.tournament.matches.find(match => match.id === 'W2').status, 'live');
  assert.equal(state.tournament.matches.find(match => match.id === 'W1').status, 'ready');
  unchanged(state, () => cue(state, { stage: 'double-elimination', scene: 'song-selection', matchId: 'W1' }), /selected match changed/);
  unchanged(state, () => cue(state, { stage: 'double-elimination', scene: 'double-elimination-waiting', matchId: 'W5' }), /ready match/);
  for (const scene of ['double-elimination-match', 'song-result']) unchanged(state,
    () => cue(state, { stage: 'double-elimination', scene, matchId: 'W2' }), /Select the match songs/);
  cue(state, { stage: 'double-elimination', scene: 'song-selection', matchId: 'W2' });
  choose(state, 'W2');
  for (const songIndex of [0, 1]) for (const scene of ['double-elimination-waiting', 'double-elimination-match', 'song-result']) {
    cue(state, { stage: 'double-elimination', scene, matchId: 'W2', songIndex });
    assert.equal(state.scene, scene); assert.equal(state.tournament.matches.find(match => match.id === 'W2').currentSong, songIndex);
  }
  unchanged(state, () => cue(state, { stage: 'double-elimination', scene: 'result', matchId: 'W2' }), /completed match result/);
  finish(state);
  cue(state, { stage: 'double-elimination', scene: 'double-elimination-waiting', matchId: 'W1', songIndex: 0 });
  cue(state, { stage: 'double-elimination', scene: 'result', matchId: 'W2' });
  assert.equal(state.result.matchId, 'W2'); assert.equal(state.tournament.currentMatchId, 'W1');
  cue(state, { stage: 'double-elimination', scene: 'bracket', matchId: 'W1' });
  assert.equal(state.scene, 'bracket');
  unchanged(state, () => cue(state, { stage: 'double-elimination', scene: 'double-elimination-waiting', matchId: 'W2' }), /ready match/);
});

test('the fixed Grand Final announcement remains available through the same workflow without a ban phase', () => {
  const state = seed(configured());
  unchanged(state, () => cue(state, { stage: 'double-elimination', scene: 'grand-final-announcement', matchId: 'W1' }), /fixed-song Grand Final/);
  unchanged(state, () => cue(state, { stage: 'double-elimination', scene: 'grand-final-announcement', matchId: 'GF' }), /ready match/);
  for (let i = 0; i < 13; i++) {
    const next = state.tournament.matches.find(match => match.id !== 'GF' && ['ready', 'live'].includes(match.status));
    assert.ok(next); choose(state, next.id); finish(state);
  }
  assert.notEqual(state.tournament.currentMatchId, 'GF');
  cue(state, { stage: 'double-elimination', scene: 'grand-final-announcement', matchId: 'GF', songIndex: 0 });
  assert.equal(state.tournament.currentMatchId, 'GF'); assert.equal(state.scene, 'grand-final-announcement');
  const final = state.tournament.matches.find(match => match.id === 'GF');
  assert.equal(final.finalMode, 'fixed-two'); assert.equal(final.candidates.length, 0); assert.equal(final.songs.length, 2);
  cue(state, { stage: 'double-elimination', scene: 'double-elimination-match', matchId: 'GF', songIndex: 1 });
  assert.equal(state.tournament.matches.find(match => match.id === 'GF').currentSong, 1);
});

test('legacy sealed MC finals reject every third-song cue until the host song is revealed', () => {
  const state = seed(expandSongLibrary(legacyState()));
  for (let i = 0; i < 13; i++) {
    const next = state.tournament.matches.find(match => match.id !== 'GF' && ['ready', 'live'].includes(match.status));
    choose(state, next.id); finish(state);
  }
  unchanged(state, () => cue(state, { stage: 'double-elimination', scene: 'grand-final-announcement', matchId: 'GF' }), /selected match changed/);
  cue(state, { stage: 'double-elimination', scene: 'double-elimination-waiting', matchId: 'GF', songIndex: 0 });
  const candidates = finalCandidates(state, 8);
  act(state, 'set-final-candidates', { ids: candidates });
  act(state, 'set-final-picks', { audienceIds: candidates.slice(0, 2), hostId: candidates[2] });
  for (const scene of ['double-elimination-waiting', 'double-elimination-match', 'song-result']) {
    unchanged(state, () => cue(state, { stage: 'double-elimination', scene, matchId: 'GF', songIndex: 2 }), /Reveal the MC song/);
    assert.equal(publicState(state).tournament.matches.find(match => match.id === 'GF').songs[2].hidden, true);
  }
  act(state, 'reveal-host-song');
  cue(state, { stage: 'double-elimination', scene: 'double-elimination-waiting', matchId: 'GF', songIndex: 2 });
  assert.equal(state.tournament.matches.find(match => match.id === 'GF').currentSong, 2);
});

test('broadcast cues and supplementary song statistics remain main-control commands', () => {
  const state = configured(), contextKey = scorekeeperState(state).contextKey;
  for (const action of [{ type: 'set-broadcast-cue', payload: { stage: 'qualifier', scene: 'qualifier-waiting' } },
    { type: 'set-qualifier-song-stats', payload: { group: 'A', playerId: 'p1', songIndex: 0, stats: statistics() } }]) {
    assert.throws(() => scorekeeperAction(state, { contextKey, action }), error => error.code === 'FORBIDDEN');
  }
  const legacy = legacyState(); validateState(legacy); validateState(JSON.parse(JSON.stringify(publicState(legacy))));
  assert.equal(legacy.qualifier.players[0].songStats, undefined);
});
