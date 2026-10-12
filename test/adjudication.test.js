const test = require('node:test');
const assert = require('node:assert/strict');
const { createDefaultState } = require('../lib/default-state');
const { applyAction, readinessCount, WAIT_MS, READINESS_KEYS } = require('../lib/adjudication');

const START = Date.parse('2026-11-07T04:00:00.000Z');
function fixture() {
  const state = createDefaultState();
  let time = START;
  const helpers = {
    now: () => time,
    getMatch(s, id = s.tournament.currentMatchId) {
      const match = s.tournament.matches.find(m => m.id === id);
      assert.ok(match, 'Choose the current match.'); return match;
    },
    playable(match) {
      assert.notEqual(match.status, 'complete', 'This completed result is locked.');
      assert.notEqual(match.status, 'pending', 'Previous matches must finish first.');
    },
    qualifierRules: {
      entries(s, group) { return s.qualifier.rounds[group].playerIds.map(id => s.qualifier.players.find(p => p.id === id)); },
      result(s, group, id) { return s.qualifier.rounds[group].results[id]; }
    }
  };
  return { state, helpers, act(type, payload) { return applyAction(state, { type, payload }, helpers); },
    advance(ms) { time += ms; } };
}
function matchFixture(id = 'W1') {
  const f = fixture(); f.state.stage = 'double-elimination';
  f.state.tournament = { seeded: true, seeds: f.state.qualifier.players.map(p => p.id), currentMatchId: id, matches: [{
    id, status: 'live', players: ['p1', 'p2'], songs: f.state.library.slice(0, id === 'GF' ? 3 : 2),
    scores: [[980000, 900000, ...(id === 'GF' ? [990000] : [])], [970000, 910000, ...(id === 'GF' ? [980000] : [])]],
    judgements: [[{ accuracy: 98 }, { accuracy: 90 }, ...(id === 'GF' ? [{ accuracy: 99 }] : [])],
      [{ accuracy: 97 }, { accuracy: 91 }, ...(id === 'GF' ? [{ accuracy: 98 }] : [])]],
    winnerId: null, loserId: null, hostRevealed: false
  }] };
  f.match = f.state.tournament.matches[0]; return f;
}
function qualifierPlan(f) {
  const q = f.state.qualifier; q.plan = 'A';
  q.rounds = { A: { playerIds: q.players.map(p => p.id), locked: false, results: Object.fromEntries(q.players.map(p =>
    [p.id, { scores: [900000, 800000, 700000], judgements: [{ accuracy: 90 }, { accuracy: 80 }, { accuracy: 70 }] }])) },
    B: { playerIds: [], locked: false, results: {} } };
}
function rematch(overrides = {}) {
  return { stage: 'qualifier', group: 'A', playerId: 'p1', songIndex: 0, reason: 'game-error',
    videoChecked: false, unintentional: false, allAgree: false, note: 'Score page was blocked by a game error.', ...overrides };
}
function unchangedAfterError(f, type, payload, pattern) {
  const before = structuredClone(f.state);
  assert.throws(() => f.act(type, payload), pattern);
  assert.deepEqual(f.state, before, 'Rejected staff actions must not partially mutate scores or decisions.');
}

test('unrelated commands are not handled and do not change state', () => {
  const f = fixture(), before = structuredClone(f.state);
  assert.equal(f.act('set-event', { title: 'Example' }), false); assert.deepEqual(f.state, before);
});

test('ten-minute waits have exact durable timestamps and never auto-disqualify', () => {
  const f = fixture(); assert.equal(f.act('start-player-wait', { playerId: 'p1', reason: 'absence' }), true);
  assert.deepEqual(f.state.qualifier.waits.p1, { reason: 'absence', startsAt: new Date(START).toISOString(),
    deadline: new Date(START + WAIT_MS).toISOString() });
  f.advance(WAIT_MS + 1);
  assert.equal(f.state.qualifier.players[0].disqualification, undefined);
  unchangedAfterError(f, 'start-player-wait', { playerId: 'p1', reason: 'absence' }, /already running/);
});

test('absence and chart-unlock disqualification require their matching fully expired wait', () => {
  for (const reason of ['absence', 'chart-unlock']) {
    const f = fixture();
    unchangedAfterError(f, 'disqualify-player', { playerId: 'p1', reason }, /matching ten-minute/);
    f.act('start-player-wait', { playerId: 'p1', reason, ...(reason === 'chart-unlock' ? { songId: 'song-1' } : {}) });
    unchangedAfterError(f, 'disqualify-player', { playerId: 'p1', reason: reason === 'absence' ? 'chart-unlock' : 'absence' }, /matching ten-minute/);
    f.advance(WAIT_MS - 1); unchangedAfterError(f, 'disqualify-player', { playerId: 'p1', reason }, /has not ended/);
    f.advance(1); f.act('disqualify-player', { playerId: 'p1', reason, note: 'Arbiter confirmed the incident after ten minutes.' });
    assert.equal(f.state.qualifier.players[0].disqualification.reason, reason);
    assert.equal(f.state.qualifier.players[0].disqualification.at, new Date(START + WAIT_MS).toISOString());
    assert.equal(f.state.qualifier.waits.p1, undefined);
    assert.equal(f.state.qualifier.activePlayers.includes('p1'), false);
  }
});

test('a resolved incident can cancel a wait without any penalty', () => {
  const f = fixture(); f.act('start-player-wait', { playerId: 'p1', reason: 'chart-unlock', songId: 'song-1' });
  f.act('cancel-player-wait', { playerId: 'p1' });
  assert.deepEqual(f.state.qualifier.waits, {}); assert.equal(f.state.qualifier.players[0].disqualification, undefined);
  assert.equal(f.state.qualifier.adjudications.at(-1).type, 'cancel-player-wait');
  unchangedAfterError(f, 'cancel-player-wait', { playerId: 'p1' }, /no running wait/);
});

test('waits reject unknown songs, unsupported reasons and players outside the current field', () => {
  const f = fixture();
  unchangedAfterError(f, 'start-player-wait', { playerId: 'p5', reason: 'absence' }, /current qualifier group/);
  unchangedAfterError(f, 'start-player-wait', { playerId: 'p1', reason: 'headphones' }, /only for absence/);
  unchangedAfterError(f, 'start-player-wait', { playerId: 'p1', reason: 'chart-unlock', songId: 'missing' }, /Unknown song/);
  unchangedAfterError(f, 'start-player-wait', { playerId: 'p1', reason: 'absence', songId: 'song-1' }, /Only chart unlocking/);
  const m = matchFixture(); unchangedAfterError(m, 'start-player-wait', { playerId: 'p3', reason: 'absence' }, /current match/);
});

test('disqualification is permanent and does not rewrite scores or completed bracket results', () => {
  const f = matchFixture(), q = f.state.qualifier;
  q.players[0].scores = [980000, 990000, 970000]; f.match.status = 'complete';
  f.match.winnerId = 'p1'; f.match.loserId = 'p2';
  const completed = structuredClone(f.match), scores = [...q.players[0].scores];
  f.act('disqualify-player', { playerId: 'p1', reason: 'other', note: 'ACAHKU confirmed exclusion for this incident.' });
  assert.deepEqual(f.match, completed); assert.deepEqual(q.players[0].scores, scores);
  unchangedAfterError(f, 'disqualify-player', { playerId: 'p1', reason: 'headphones', note: 'Another incident' }, /already been disqualified/);
  unchangedAfterError(f, 'start-player-wait', { playerId: 'p1', reason: 'absence' }, /already been disqualified/);
});

test('arbiter notes are required for immediate penalties and meaningful for exceptional decisions', () => {
  const f = fixture();
  unchangedAfterError(f, 'disqualify-player', { playerId: 'p1', reason: 'headphones' }, /arbiter decision/);
  for (const reason of ['other', 'rule-violation', 'score-unavailable'])
    unchangedAfterError(f, 'disqualify-player', { playerId: 'p1', reason, note: 'ok' }, /meaningful ACAHKU/);
  unchangedAfterError(f, 'disqualify-player', { playerId: 'p1', reason: 'late', note: 'Unsupported penalty.' }, /supported/);
  f.act('disqualify-player', { playerId: 'p1', reason: 'headphones', note: 'No headphones available before the competition starts.' });
  assert.equal(f.state.qualifier.players[0].disqualification.reason, 'headphones');
});

test('readiness is a non-punitive five-check record and its count is read-only', () => {
  const f = fixture(); assert.equal(readinessCount(f.state, 'p1'), 0);
  const values = Object.fromEntries(READINESS_KEYS.map(key => [key, true]));
  f.act('set-player-readiness', { playerId: 'p1', ...values, headphones: false });
  assert.equal(readinessCount(f.state, 'p1'), 4); assert.equal(readinessCount(f.state), 4);
  assert.equal(f.state.qualifier.players[0].disqualification, undefined);
  const before = structuredClone(f.state); readinessCount(f.state, 'p1'); assert.deepEqual(f.state, before);
  unchangedAfterError(f, 'set-player-readiness', { playerId: 'p2', ...values, charts: 'yes' }, /boolean/);
  unchangedAfterError(f, 'set-player-readiness', { playerId: 'missing', ...values }, /Unknown player/);
});

test('legacy qualifier rematch clears only the requested player and song with its metadata', () => {
  const f = fixture(), p1 = f.state.qualifier.players[0], p2 = f.state.qualifier.players[1];
  p1.scores = [900000, 800000, 700000]; p1.judgements = [{ accuracy: 90 }, { accuracy: 80 }, { accuracy: 70 }];
  p2.scores = [990000, 980000, 970000];
  f.act('authorize-song-rematch', rematch());
  assert.deepEqual(p1.scores, [null, 800000, 700000]); assert.deepEqual(p1.judgements, [null, { accuracy: 80 }, { accuracy: 70 }]);
  assert.deepEqual(p2.scores, [990000, 980000, 970000]);
  assert.equal(f.state.qualifier.incidents[0].songId, 'song-1');
  assert.equal(f.state.qualifier.adjudications.at(-1).stage, 'qualifier');
});

test('configured qualifier rematch updates the actual round result instead of legacy roster scores', () => {
  const f = fixture(); qualifierPlan(f); f.state.qualifier.players[0].scores = [1, 2, 3];
  f.act('authorize-song-rematch', rematch({ songIndex: 1 }));
  assert.deepEqual(f.state.qualifier.rounds.A.results.p1.scores, [900000, null, 700000]);
  assert.deepEqual(f.state.qualifier.rounds.A.results.p1.judgements, [{ accuracy: 90 }, null, { accuracy: 70 }]);
  assert.deepEqual(f.state.qualifier.players[0].scores, [1, 2, 3]);
});

test('one qualifier song rematch is shared across reasons for a player, without blocking other players', () => {
  const f = fixture(); qualifierPlan(f); f.act('authorize-song-rematch', rematch());
  f.act('authorize-song-rematch', rematch({ playerId: 'p2' }));
  unchangedAfterError(f, 'authorize-song-rematch', rematch({ reason: 'score-page-left', videoChecked: true,
    unintentional: true, allAgree: true }), /already used the rematch/);
  f.act('authorize-song-rematch', rematch({ songIndex: 1 })); assert.equal(f.state.qualifier.incidents.length, 3);
});

test('score-page-left requires video review, an unintentional incident and agreement from every player', () => {
  for (const absent of ['videoChecked', 'unintentional', 'allAgree']) {
    const f = fixture();
    unchangedAfterError(f, 'authorize-song-rematch', rematch({ reason: 'score-page-left', videoChecked: true,
      unintentional: true, allAgree: true, [absent]: false }), /First check the livestream record/);
  }
  const f = fixture(); f.act('authorize-song-rematch', rematch({ reason: 'score-page-left', videoChecked: true,
    unintentional: true, allAgree: true })); assert.equal(f.state.qualifier.incidents.length, 1);
});

test('rematches reject stale stage/round, locked rounds, wrong player and bad song slots', () => {
  const f = fixture(); qualifierPlan(f);
  unchangedAfterError(f, 'authorize-song-rematch', rematch({ stage: 'double-elimination' }), /stage changed/);
  unchangedAfterError(f, 'authorize-song-rematch', rematch({ group: 'B' }), /round changed/);
  unchangedAfterError(f, 'authorize-song-rematch', rematch({ songIndex: 3 }), /three qualifier songs/);
  unchangedAfterError(f, 'authorize-song-rematch', rematch({ songIndex: -1 }), /Choose the song/);
  unchangedAfterError(f, 'authorize-song-rematch', rematch({ note: '' }), /why the arbiter/);
  unchangedAfterError(f, 'authorize-song-rematch', rematch({ allAgree: undefined }), /boolean/);
  f.state.qualifier.rounds.A.playerIds = ['p2'];
  unchangedAfterError(f, 'authorize-song-rematch', rematch(), /current qualifier round/);
  f.state.qualifier.rounds.A.locked = true;
  unchangedAfterError(f, 'authorize-song-rematch', rematch(), /round is locked/);
});

test('match rematch clears both competitors only for the affected song and records one shared quota', () => {
  const f = matchFixture(), payload = rematch({ stage: 'double-elimination', matchId: 'W1' });
  f.act('authorize-song-rematch', payload);
  assert.deepEqual(f.match.scores, [[null, 900000], [null, 910000]]);
  assert.deepEqual(f.match.judgements, [[null, { accuracy: 90 }], [null, { accuracy: 91 }]]);
  assert.equal(f.match.rematches[0].songId, 'song-1');
  unchangedAfterError(f, 'authorize-song-rematch', { ...payload, reason: 'score-page-left', videoChecked: true,
    unintentional: true, allAgree: true }, /shared rematch.*already been used/);
});

test('match rematch quota cannot be bypassed by resetting scores or moving the same song', () => {
  const f = matchFixture(), payload = rematch({ stage: 'double-elimination', matchId: 'W1' });
  f.act('authorize-song-rematch', payload);
  f.match.scores = [[null, null], [null, null]];
  f.match.songs.reverse();
  unchangedAfterError(f, 'authorize-song-rematch', { ...payload, songIndex: 1 }, /shared rematch.*already been used/);
});

test('finished, pending, vacant, disqualified and stale matches cannot authorise a replay', () => {
  const payload = rematch({ stage: 'double-elimination', matchId: 'W1' });
  const f = matchFixture(); unchangedAfterError(f, 'authorize-song-rematch', { ...payload, matchId: 'W2' }, /current match changed/);
  f.match.status = 'complete'; unchangedAfterError(f, 'authorize-song-rematch', payload, /completed result/);
  f.match.status = 'pending'; unchangedAfterError(f, 'authorize-song-rematch', payload, /Previous matches/);
  f.match.status = 'live'; f.match.players[1] = null; unchangedAfterError(f, 'authorize-song-rematch', payload, /both players/);
  f.match.players[1] = 'p2'; f.state.qualifier.players[1].disqualification = { reason: 'headphones', at: new Date(START).toISOString(), note: 'No headphones.' };
  unchangedAfterError(f, 'authorize-song-rematch', payload, /already been disqualified/);
});

test('a finals host song stays protected until its explicit reveal', () => {
  const f = matchFixture('GF'), payload = rematch({ stage: 'double-elimination', matchId: 'GF', songIndex: 2 });
  unchangedAfterError(f, 'authorize-song-rematch', payload, /Reveal the host song/);
  f.match.hostRevealed = true; f.act('authorize-song-rematch', payload);
  assert.deepEqual(f.match.scores, [[980000, 900000, null], [970000, 910000, null]]);
});

test('a base-song rematch invalidates obsolete qualifier and match tiebreaks while privately preserving evidence', () => {
  const q = fixture(); qualifierPlan(q);
  const qualifierTie = { playerIds: ['p1', 'p2'], scores: { p1: 990000, p2: 980000 }, confirmed: true };
  q.state.qualifier.rounds.A.tiebreaks = [structuredClone(qualifierTie)];
  q.act('authorize-song-rematch', rematch());
  assert.deepEqual(q.state.qualifier.rounds.A.tiebreaks, []);
  assert.deepEqual(q.state.qualifier.adjudications.at(-1).invalidatedTiebreaks, [qualifierTie]);
  const m = matchFixture();
  const matchTie = { scores: [990000, 980000], judgements: [null, null], confirmed: false };
  m.match.tiebreaks = [structuredClone(matchTie)];
  m.act('authorize-song-rematch', rematch({ stage: 'double-elimination', matchId: 'W1' }));
  assert.deepEqual(m.match.tiebreaks, []);
  assert.deepEqual(m.state.qualifier.adjudications.at(-1).invalidatedTiebreaks, [matchTie]);
});

test('disqualification cancels a pending qualifier tiebreak without changing confirmed history or other rounds', () => {
  const f = fixture(); qualifierPlan(f);
  const confirmed = { playerIds: ['p1', 'p2'], scores: { p1: 980000, p2: 970000 }, confirmed: true };
  const pending = { playerIds: ['p1', 'p3'], scores: { p1: null, p3: 960000 }, confirmed: false };
  const other = { playerIds: ['p3', 'p4'], scores: { p3: null, p4: null }, confirmed: false };
  f.state.qualifier.rounds.A.tiebreaks = [structuredClone(confirmed), structuredClone(pending)];
  f.state.qualifier.rounds.B.tiebreaks = [structuredClone(other)];
  f.act('disqualify-player', { playerId: 'p1', reason: 'headphones', note: 'No headphones available for competition.' });
  assert.deepEqual(f.state.qualifier.rounds.A.tiebreaks, [confirmed]);
  assert.deepEqual(f.state.qualifier.rounds.B.tiebreaks, [other]);
  assert.deepEqual(f.state.qualifier.adjudications.at(-1).cancelledTiebreaks, [{ group: 'A', index: 1, tiebreak: pending }]);
});

test('real qualifier result access preserves Plan A round-one scores when authorising a revival-round replay', () => {
  const f = fixture(), QualifierRules = require('../public/js/qualifier-rules');
  QualifierRules.applyAction(f.state, { type: 'set-qualifier-plan', payload: { plan: 'A' } });
  delete f.helpers.qualifierRules;
  const q = f.state.qualifier;
  q.rounds.A.locked = true; q.rounds.A.qualifiedIds = ['p1', 'p2', 'p3', 'p4'];
  q.rounds.A.results.p5 = { scores: [1, 2, 3], judgements: [null, null, null] };
  q.rounds.B.playerIds = ['p5', 'p6', 'p7', 'p8'];
  q.rounds.B.results = Object.fromEntries(q.rounds.B.playerIds.map(id => [id,
    { scores: [990000, 980000, 970000], judgements: [{ accuracy: 99 }, { accuracy: 98 }, { accuracy: 97 }] }]));
  q.activeGroup = 'B'; q.activePlayers = ['p5', 'p6', 'p7'];
  q.incidents = [{ group: 'A', playerId: 'p5', songId: q.groups.A.songs[0], songIndex: 0 }];
  f.act('authorize-song-rematch', rematch({ group: 'B', playerId: 'p5' }));
  assert.deepEqual(q.rounds.B.results.p5.scores, [null, 980000, 970000]);
  assert.deepEqual(q.rounds.A.results.p5.scores, [1, 2, 3]);
  assert.deepEqual(q.players.find(player => player.id === 'p5').scores, [null, null, null]);
  assert.equal(q.incidents.length, 2);
});
