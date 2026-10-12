const test = require('node:test');
const assert = require('node:assert/strict');
const { createDefaultState } = require('../lib/default-state');
const QualifierRules = require('../public/js/qualifier-rules');
const { scorekeeperState, scorekeeperAction, SCORE_ACTIONS } = require('../lib/scorekeeper');

const judgements = accuracy => ({ accuracy, perfect: 900, good: 12, bad: 1, miss: 0 });
function qualifierFixture(plan = 'A') {
  const state = createDefaultState();
  QualifierRules.applyAction(state, { type: 'set-qualifier-plan', payload: { plan } });
  return state;
}
function request(state, type, payload, contextKey = scorekeeperState(state).contextKey) {
  return { contextKey, action: { type, payload } };
}
function forbidden(fn, code = 'FORBIDDEN') {
  assert.throws(fn, error => error.code === code);
}
function matchFixture(final = false) {
  const state = createDefaultState();
  state.stage = 'double-elimination'; state.tournament.seeded = true;
  const match = { id: final ? 'GF' : 'W1', label: 'Fixture match', round: 1, status: 'ready', currentSong: 0,
    players: ['p1', 'p2'], songs: state.library.slice(0, final ? 3 : 2),
    scores: final ? [[900000, 910000, 987654], [900000, 910000, 988765]] : [[900000, 910000], [900000, 910000]],
    judgements: final ? [[judgements(98), judgements(98), judgements(99.1234)], [judgements(98), judgements(98), judgements(99.4321)]] : [[judgements(98), judgements(98)], [judgements(98), judgements(98)]],
    hostRevealed: !final, tiebreaks: [] };
  state.tournament.matches = [match]; state.tournament.currentMatchId = match.id;
  return { state, match };
}

test('scorekeeper permissions add only score entry for qualifier and match tiebreaks', () => {
  assert.deepEqual([...SCORE_ACTIONS].sort(), ['set-match-score', 'set-match-tiebreak-score', 'set-qualifier-score', 'set-qualifier-tiebreak-score']);
  const state = qualifierFixture(), before = JSON.stringify(state);
  for (const type of ['set-qualifier-plan', 'finalize-qualifier-round', 'draw-qualifier-tiebreak', 'confirm-qualifier-tiebreak',
    'draw-match-tiebreak', 'confirm-match-tiebreak', 'record-result', 'disqualify-player', 'authorize-song-rematch', 'set-player-readiness']) {
    forbidden(() => scorekeeperAction(state, request(state, type, { verified: true })));
  }
  assert.equal(JSON.stringify(state), before);
});

test('configured qualifier sheets project each round results and keep drafts bound to roster eligibility', () => {
  const state = qualifierFixture(), q = state.qualifier;
  q.players[0].scores = [100, 200, 300];
  q.rounds.A.results.p1 = { scores: [987654, null, null], judgements: [judgements(99.8765), null, null] };
  const view = scorekeeperState(state);
  assert.equal(view.qualifier.plan, 'A'); assert.equal(view.qualifier.players.length, 8);
  assert.deepEqual(view.qualifier.players[0].scores, [987654, null, null]);
  assert.equal(view.qualifier.players[0].judgements[0].accuracy, 99.8765);
  const action = scorekeeperAction(state, request(state, 'set-qualifier-score', { playerId: 'p1', songIndex: 1, score: 999000, judgements: judgements(99.9), verified: true, group: 'B' }));
  assert.deepEqual(action.payload, { playerId: 'p1', songIndex: 1, score: 999000, judgements: judgements(99.9) });
  q.rounds.A.results.p1.scores[0] = 980000; q.rounds.A.results.p1.judgements[0] = judgements(99.7); q.currentSong = 2; q.activePlayers = ['p8'];
  assert.equal(scorekeeperState(state).contextKey, view.contextKey, 'Score revisions and host display cursor do not move the scoring sheet');
  q.players[0].number = 20;
  assert.notEqual(scorekeeperState(state).contextKey, view.contextKey);
  forbidden(() => scorekeeperAction(state, request(state, 'set-qualifier-score', { playerId: 'p1', songIndex: 1, score: 9 }, view.contextKey)), 'CONTEXT_CHANGED');
  const numberedKey = scorekeeperState(state).contextKey;
  q.players[0].disqualification = { reason: 'rule-violation', at: '2026-10-12T00:00:00Z' };
  assert.notEqual(scorekeeperState(state).contextKey, numberedKey);
  assert.equal(scorekeeperState(state).qualifier.players.some(player => player.id === 'p1'), false);
  forbidden(() => scorekeeperAction(state, request(state, 'set-qualifier-score', { playerId: 'p1', songIndex: 0, score: 1 })));
});

test('Plan A revival sheets expose only second-round entrants and no first-round score carryover', () => {
  const state = qualifierFixture(), q = state.qualifier;
  q.rounds.A.locked = true; q.rounds.A.qualifiedIds = ['p1', 'p2', 'p3', 'p4'];
  q.rounds.B.playerIds = ['p5', 'p6', 'p7', 'p8'];
  q.rounds.B.results = Object.fromEntries(q.rounds.B.playerIds.map(id => [id, { scores: [null, null, null], judgements: [null, null, null] }]));
  const firstKey = scorekeeperState(state).contextKey;
  q.activeGroup = 'B';
  const view = scorekeeperState(state);
  assert.notEqual(view.contextKey, firstKey); assert.equal(view.qualifier.locked, false);
  assert.deepEqual(view.qualifier.players.map(player => player.id), ['p5', 'p6', 'p7', 'p8']);
  assert.deepEqual(view.qualifier.players[0].scores, [null, null, null]);
  forbidden(() => scorekeeperAction(state, request(state, 'set-qualifier-score', { playerId: 'p1', songIndex: 0, score: 1 })));
  q.rounds.B.locked = true;
  forbidden(() => scorekeeperAction(state, request(state, 'set-qualifier-score', { playerId: 'p5', songIndex: 0, score: 1 })), 'INVALID');
});

test('only the current qualifier tiebreak and its participants can be scored; repeat/confirmation changes context', () => {
  const state = qualifierFixture(), round = state.qualifier.rounds.A;
  round.tiebreaks = [{ song: state.library[5], playerIds: ['p1', 'p2'], scores: { p1: 901234, p2: null },
    judgements: { p1: judgements(98.7654), p2: null }, confirmed: false }];
  const view = scorekeeperState(state), tie = view.qualifier.tiebreak;
  assert.equal(tie.index, 0); assert.deepEqual(tie.players.map(player => player.id), ['p1', 'p2']);
  assert.deepEqual(tie.players[0].scores, [901234]); assert.equal(tie.players[0].judgements[0].accuracy, 98.7654);
  const payload = { group: 'A', index: 0, playerId: 'p2', score: 901235, judgements: judgements(98.7654) };
  assert.deepEqual(scorekeeperAction(state, request(state, 'set-qualifier-tiebreak-score', payload)).payload, payload);
  for (const changed of [{ group: 'B' }, { index: 1 }, { playerId: 'p3' }]) {
    forbidden(() => scorekeeperAction(state, request(state, 'set-qualifier-tiebreak-score', { ...payload, ...changed })));
  }
  round.tiebreaks[0].confirmed = true;
  assert.equal(scorekeeperState(state).qualifier.tiebreak, undefined);
  assert.notEqual(scorekeeperState(state).contextKey, view.contextKey);
  forbidden(() => scorekeeperAction(state, request(state, 'set-qualifier-tiebreak-score', payload)));
  round.tiebreaks.push({ ...round.tiebreaks[0], song: state.library[6], confirmed: false });
  assert.equal(scorekeeperState(state).qualifier.tiebreak.index, 1);
  forbidden(() => scorekeeperAction(state, request(state, 'set-qualifier-tiebreak-score', payload)));
});

test('active match tiebreak scoring preserves narrow payloads and locks confirmed/completed rounds', () => {
  const { state, match } = matchFixture();
  match.tiebreaks = [{ song: state.library[5], scores: [null, 920000], judgements: [null, judgements(99)], confirmed: false }];
  const view = scorekeeperState(state), payload = { matchId: 'W1', index: 0, playerIndex: 0, score: 930000, judgements: judgements(99.1) };
  assert.deepEqual(view.match.tiebreak.players[1].scores, [920000]);
  assert.deepEqual(scorekeeperAction(state, request(state, 'set-match-tiebreak-score', { ...payload, verified: true })).payload, payload);
  for (const changed of [{ matchId: 'W2' }, { index: 1 }, { playerIndex: 2 }]) assert.throws(() => scorekeeperAction(state, request(state, 'set-match-tiebreak-score', { ...payload, ...changed })));
  match.tiebreaks[0].scores[0] = 930000;
  assert.equal(scorekeeperState(state).contextKey, view.contextKey);
  match.tiebreaks[0].confirmed = true;
  assert.notEqual(scorekeeperState(state).contextKey, view.contextKey);
  assert.equal(scorekeeperState(state).match.tiebreak, undefined);
  forbidden(() => scorekeeperAction(state, request(state, 'set-match-tiebreak-score', payload)));
  match.tiebreaks[0].confirmed = false; match.status = 'complete';
  forbidden(() => scorekeeperAction(state, request(state, 'set-match-tiebreak-score', payload)), 'INVALID');
});

test('MC song, judgments and related metadata remain sealed across scorekeeper projections and context', () => {
  const { state, match } = matchFixture(true);
  match.songs[2] = { ...match.songs[2], id: 'PRIVATE-SONG', title: 'PRIVATE MC TITLE' };
  match.tiebreaks = [{ song: match.songs[2], scores: [987321, null], judgements: [judgements(99.654321), null], confirmed: false }];
  const view = scorekeeperState(state), json = JSON.stringify(view);
  for (const value of ['PRIVATE-SONG', 'PRIVATE MC TITLE', '99.1234', '99.4321', '99.654321', '987654', '988765', '987321']) assert.equal(json.includes(value), false, value);
  assert.equal(view.match.players[0].judgements[2], null); assert.equal(view.match.tiebreak, undefined);
  forbidden(() => scorekeeperAction(state, request(state, 'set-match-score', { matchId: 'GF', playerIndex: 0, songIndex: 2, score: 999999 })), 'INVALID');
  forbidden(() => scorekeeperAction(state, request(state, 'set-match-tiebreak-score', { matchId: 'GF', playerIndex: 0, index: 0, score: 999999 })));
  match.hostRevealed = true;
  assert.notEqual(scorekeeperState(state).contextKey, view.contextKey);
  assert.equal(scorekeeperState(state).match.players[0].judgements[2].accuracy, 99.1234);
  assert.equal(scorekeeperState(state).match.tiebreak.song.id, 'PRIVATE-SONG');
});

test('judgement input is validated and unrequested metadata is stripped at scorekeeper boundary', () => {
  const state = qualifierFixture(), payload = { playerId: 'p1', songIndex: 0, score: 0 };
  assert.equal(Object.hasOwn(scorekeeperAction(state, request(state, 'set-qualifier-score', payload)).payload, 'judgements'), false);
  assert.equal(scorekeeperAction(state, request(state, 'set-qualifier-score', { ...payload, judgements: null })).payload.judgements, null);
  for (const invalid of [{ accuracy: -1 }, { accuracy: 101 }, { accuracy: '99' }, { accuracy: 99, perfect: 1 }, { accuracy: 99, perfect: 1, good: 1, bad: 1, miss: -1 }]) {
    assert.throws(() => scorekeeperAction(state, request(state, 'set-qualifier-score', { ...payload, judgements: invalid })));
  }
  assert.deepEqual(scorekeeperAction(state, request(state, 'set-qualifier-score', { ...payload, judgements: { accuracy: 0, privateNote: 'SECRET' } })).payload.judgements, { accuracy: 0 });
});


test('a newly authorized rematch invalidates unsubmitted drafts even when the previous score was still blank', () => {
  const state = qualifierFixture(), initial = scorekeeperState(state).contextKey;
  state.qualifier.incidents = [{ group: 'A', playerId: 'p1', songIndex: 0, note: 'PRIVATE ARBITER NOTE', songId: 'PRIVATE ID' }];
  const view = scorekeeperState(state);
  assert.notEqual(view.contextKey, initial);
  assert.equal(view.contextKey.includes('PRIVATE'), false);
  forbidden(() => scorekeeperAction(state, request(state, 'set-qualifier-score', { playerId: 'p1', songIndex: 0, score: 999999 }, initial)), 'CONTEXT_CHANGED');
  const fixture = matchFixture(), matchKey = scorekeeperState(fixture.state).contextKey;
  fixture.match.rematches = [{ songIndex: 0, note: 'PRIVATE ARBITER NOTE', songId: 'PRIVATE ID' }];
  assert.notEqual(scorekeeperState(fixture.state).contextKey, matchKey);
  assert.equal(scorekeeperState(fixture.state).contextKey.includes('PRIVATE'), false);
});
