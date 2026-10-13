const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const QualifierRules = require('../public/js/qualifier-rules');
const ScoreRules = require('../public/js/score-rules');

function fixture(count = 8) {
  return { stage: 'qualifier',
    qualifier: { activeGroup: 'A', currentSong: 0, activePlayers: ['p1', 'p2', 'p3'],
      players: Array.from({ length: count }, (_, index) => ({ id: `p${index + 1}`, name: `Player ${index + 1}`,
        group: index < Math.ceil(count / 2) ? 'A' : 'B', scores: [null, null, null], tiePriority: null })),
      groups: { A: { songs: ['s1', 's2', 's3'] }, B: { songs: ['s4', 's5', 's6'] } } },
    library: Array.from({ length: 7 }, (_, index) => ({ id: `s${index + 1}`, title: `Song ${index + 1}`,
      eligible: index !== 6, difficulty: 'IN', level: 15, art: 'assets/song/cover-1.svg' })),
    tournament: { seeded: false, seeds: [], matches: [] } };
}
const helpers = { shuffled: values => [...values].reverse(), createBracket: ids => ({ seeded: true, seeds: ids, matches: [] }) };
function act(state, type, payload = {}) { assert.equal(QualifierRules.applyAction(state, { type, payload }, helpers), true); }
function configure(state, plan = 'auto') { act(state, 'set-qualifier-plan', { plan }); }
function fill(state, group, value = player => 1000000 - Number(player.id.slice(1)) * 1000, accuracy = () => 98) {
  for (const player of QualifierRules.entries(state, group)) for (let songIndex = 0; songIndex < 3; songIndex++) {
    const acc = accuracy(player, songIndex);
    act(state, 'set-qualifier-score', { group, playerId: player.id, songIndex, score: value(player, songIndex),
      ...(acc === null ? {} : { judgements: { accuracy: acc, perfect: 900, good: 10, bad: 0, miss: 0 } }) });
  }
}
function boundaryTie() {
  const state = fixture(); configure(state);
  fill(state, 'A', player => ({ p1: 990000, p2: 980000, p3: 970000, p4: 900000, p5: 900000, p6: 800000, p7: 700000, p8: 600000 })[player.id]);
  return state;
}
function tieScore(state, index, id, score, accuracy) {
  act(state, 'set-qualifier-tiebreak-score', { group: 'A', index, playerId: id, score,
    ...(accuracy === undefined ? {} : { judgements: { accuracy } }) });
}

test('legacy files retain manual-priority rankings and old actions without inferring accuracy', () => {
  const state = fixture();
  for (const player of state.qualifier.players) player.scores = [100, 100, 100];
  state.qualifier.players[0].judgements = [{ accuracy: 90 }, { accuracy: 90 }, { accuracy: 90 }];
  state.qualifier.players[1].tiePriority = 1;
  const ranks = QualifierRules.rankings(state, 'A');
  assert.equal(ranks[0].id, 'p2'); assert.equal(ranks[0].accuracy, null); assert.equal(ranks[0].tied, true);
  assert.equal(QualifierRules.applyAction(state, { type: 'set-qualifier-score', payload: {} }, helpers), false);
  assert.equal(QualifierRules.result(state, 'A', 'p1'), state.qualifier.players[0]);
  assert.deepEqual(QualifierRules.seeds(state), ['p2', 'p5', 'p1', 'p6', 'p3', 'p7', 'p4', 'p8']);
});

test('auto format boundary uses registered count; Plan B follows unique odd/even check-in numbers', () => {
  const twenty = fixture(20); configure(twenty); assert.equal(twenty.qualifier.plan, 'A');
  assert.equal(QualifierRules.entries(twenty, 'A').length, 20); assert.equal(QualifierRules.entries(twenty, 'B').length, 0);
  const twentyOne = fixture(21); configure(twentyOne); assert.equal(twentyOne.qualifier.plan, 'B');
  assert.equal(QualifierRules.entries(twentyOne, 'A').length, 11); assert.equal(QualifierRules.entries(twentyOne, 'B').length, 10);
  assert.ok(QualifierRules.entries(twentyOne, 'A').every(player => player.number % 2 === 1));
  assert.ok(QualifierRules.entries(twentyOne, 'B').every(player => player.number % 2 === 0));
  assert.throws(() => act(fixture(21), 'set-qualifier-plan', { plan: 'A' }), /20 or fewer/);
  assert.throws(() => act(fixture(20), 'set-qualifier-plan', { plan: 'B' }), /more than 20/);
  act(twentyOne, 'draw-player-numbers');
  assert.equal(twentyOne.qualifier.players[0].number, 21);
  assert.deepEqual(QualifierRules.entries(twentyOne, 'A').map(player => player.number), [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21]);
  assert.throws(() => act(twentyOne, 'set-player-number', { playerId: 'p1', number: 1 }), /unique/);
  assert.throws(() => act(twentyOne, 'randomise-groups'), /odd\/even/);
});

test('numbered batches use numerical order, at most three entrants, and wrap after the final batch', () => {
  const state = fixture(10); configure(state); act(state, 'draw-player-numbers');
  assert.deepEqual(state.qualifier.activePlayers, ['p10', 'p9', 'p8']);
  state.qualifier.currentSong = 2;
  act(state, 'next-qualifier-batch'); assert.deepEqual(state.qualifier.activePlayers, ['p7', 'p6', 'p5']);
  assert.equal(state.qualifier.currentSong, 0, 'A new batch starts with the first base song');
  act(state, 'next-qualifier-batch'); assert.deepEqual(state.qualifier.activePlayers, ['p4', 'p3', 'p2']);
  act(state, 'next-qualifier-batch'); assert.deepEqual(state.qualifier.activePlayers, ['p1']);
  act(state, 'next-qualifier-batch'); assert.deepEqual(state.qualifier.activePlayers, ['p10', 'p9', 'p8']);
  assert.equal(state.qualifier.currentSong, 0);
});

test('Plan A preserves first-round results, excludes its four qualifiers, and resets revival scores', () => {
  const state = fixture(10); configure(state); fill(state, 'A');
  const firstScores = structuredClone(state.qualifier.rounds.A.results);
  assert.throws(() => act(state, 'set-qualifier-display', { group: 'B' }), /Finalize/);
  assert.throws(() => act(state, 'finalize-qualifier-round', { group: 'A' }), /double-check/);
  act(state, 'finalize-qualifier-round', { group: 'A', verified: true });
  assert.deepEqual(state.qualifier.rounds.A.qualifiedIds, ['p1', 'p2', 'p3', 'p4']);
  assert.deepEqual(state.qualifier.rounds.B.playerIds, ['p5', 'p6', 'p7', 'p8', 'p9', 'p10']);
  assert.ok(QualifierRules.entries(state, 'B').every(player => player.scores.every(score => score === null)));
  assert.deepEqual(state.qualifier.rounds.A.results, firstScores);
  assert.equal(state.qualifier.activeGroup, 'B'); assert.deepEqual(state.qualifier.activePlayers, ['p5', 'p6', 'p7']);
  assert.throws(() => act(state, 'set-qualifier-score', { group: 'B', playerId: 'p1', songIndex: 0, score: 1000000 }), /not eligible/);
  assert.throws(() => act(state, 'set-qualifier-score', { group: 'A', playerId: 'p5', songIndex: 0, score: 0 }), /locked/);
  fill(state, 'B', player => 500000 + Number(player.id.slice(1)) * 1000);
  assert.equal(QualifierRules.result(state, 'B', 'p5').scores[0], 505000);
  assert.equal(QualifierRules.result(state, 'A', 'p5').scores[0], 995000);
  assert.throws(() => act(state, 'qualify'), /double-check/);
  act(state, 'qualify', { verified: true });
  assert.deepEqual(state.tournament.seeds, ['p1', 'p2', 'p3', 'p4', 'p10', 'p9', 'p8', 'p7']);
  assert.equal(state.tournament.ruleset, 'proposal-2026'); assert.equal(state.stage, 'double-elimination');
  assert.ok(state.qualifier.players.every(player => player.scores.every(score => score === null)), 'Legacy score arrays are not reused for either configured round');
});

test('Plan B qualifier seeds retain the required cross-group first-round pairings', () => {
  const state = fixture(22); configure(state); fill(state, 'A'); fill(state, 'B');
  act(state, 'qualify', { verified: true });
  assert.deepEqual(state.tournament.seeds, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']);
  const seeds = state.tournament.seeds;
  assert.deepEqual([[seeds[0], seeds[7]], [seeds[3], seeds[4]], [seeds[1], seeds[6]], [seeds[2], seeds[5]]],
    [['p1', 'p8'], ['p4', 'p5'], ['p2', 'p7'], ['p3', 'p6']]);
  assert.equal(state.qualifier.rounds.A.locked, true); assert.equal(state.qualifier.rounds.B.locked, true);
});

test('equal base totals compare per-song mean accuracy before any extra song; tiePriority cannot bypass it', () => {
  const state = boundaryTie();
  act(state, 'set-qualifier-score', { group: 'A', playerId: 'p4', songIndex: 0, score: 900000, judgements: { accuracy: 96 } });
  state.qualifier.players.find(player => player.id === 'p4').tiePriority = 1;
  const ranks = QualifierRules.rankings(state, 'A');
  assert.equal(ranks[3].id, 'p5'); assert.equal(ranks[3].tied, false);
  assert.equal(ranks[4].accuracy, 97.3333);
  assert.throws(() => act(state, 'set-tie-priority', { playerId: 'p4', priority: 1 }), /accuracy/);
  act(state, 'finalize-qualifier-round', { group: 'A', verified: true });
  assert.ok(state.qualifier.rounds.A.qualifiedIds.includes('p5')); assert.ok(!state.qualifier.rounds.A.qualifiedIds.includes('p4'));
});

test('missing accuracy remains unresolved and cannot be treated as zero or bypassed by a tiebreak', () => {
  const state = boundaryTie();
  act(state, 'set-qualifier-score', { group: 'A', playerId: 'p4', songIndex: 0, score: 900000, judgements: null });
  assert.equal(QualifierRules.rankings(state, 'A').find(player => player.id === 'p4').accuracy, null);
  assert.deepEqual(QualifierRules.tiedSets(state, 'A'), [['p4', 'p5']]);
  assert.throws(() => act(state, 'finalize-qualifier-round', { group: 'A', verified: true }), /accuracy/);
  assert.throws(() => act(state, 'draw-qualifier-tiebreak', { group: 'A', playerIds: ['p4', 'p5'] }), /original accuracy/);
  assert.equal(state.qualifier.rounds.A.tiebreaks.length, 0);
});

test('full-library qualifier tiebreaks can repeat without adding extra songs to base totals', () => {
  const state = boundaryTie();
  act(state, 'draw-qualifier-tiebreak', { group: 'A', playerIds: ['p4', 'p5'] });
  const first = state.qualifier.rounds.A.tiebreaks[0];
  assert.equal(first.song.id, 's7'); assert.equal(first.song.eligible, false, 'Finals-only/local songs are available to qualifier ties');
  tieScore(state, 0, 'p4', 1000000, 100); tieScore(state, 0, 'p5', 1000000, 100);
  assert.throws(() => act(state, 'confirm-qualifier-tiebreak', { group: 'A', index: 0 }), /double-check/);
  act(state, 'confirm-qualifier-tiebreak', { group: 'A', index: 0, verified: true });
  assert.deepEqual(QualifierRules.tiedSets(state, 'A'), [['p4', 'p5']]);
  act(state, 'draw-qualifier-tiebreak', { group: 'A', playerIds: ['p4', 'p5'] });
  tieScore(state, 1, 'p4', 950000); tieScore(state, 1, 'p5', 960000);
  act(state, 'confirm-qualifier-tiebreak', { group: 'A', index: 1, verified: true });
  assert.deepEqual(QualifierRules.tiedSets(state, 'A'), []);
  const rank = QualifierRules.rankings(state, 'A');
  assert.equal(rank[3].id, 'p5'); assert.equal(rank[3].total, 2700000); assert.equal(rank[4].total, 2700000);
  act(state, 'finalize-qualifier-round', { group: 'A', verified: true });
  assert.deepEqual(state.qualifier.rounds.A.qualifiedIds, ['p1', 'p2', 'p3', 'p5']);
});

test('multi-player boundary ties cannot exclude an unresolved player and repeat only the still-tied subset', () => {
  const state = fixture(); configure(state);
  fill(state, 'A', player => ['p3', 'p4', 'p5', 'p6'].includes(player.id) ? 900000 : 1000000 - Number(player.id.slice(1)) * 20000);
  // Keep the remaining two competitors below the boundary tie.
  for (const id of ['p7', 'p8']) for (let songIndex = 0; songIndex < 3; songIndex++) act(state, 'set-qualifier-score', { group: 'A', playerId: id, songIndex, score: 700000, judgements: { accuracy: 98 } });
  assert.deepEqual(QualifierRules.tiedSets(state, 'A'), [['p3', 'p4', 'p5', 'p6']]);
  assert.throws(() => act(state, 'draw-qualifier-tiebreak', { group: 'A', playerIds: ['p3', 'p4'] }), /all players/);
  act(state, 'draw-qualifier-tiebreak', { group: 'A', playerIds: ['p3', 'p4', 'p5', 'p6'] });
  assert.deepEqual(state.qualifier.activePlayers, ['p3', 'p4', 'p5']);
  assert.equal(QualifierRules.activeTiebreak(state).song.id, 's7');
  assert.throws(() => act(state, 'set-qualifier-display', { players: ['p1'] }), /eligible/);
  for (const id of ['p3', 'p4', 'p5']) tieScore(state, 0, id, id === 'p3' ? 950000 : 900000, 99);
  act(state, 'next-qualifier-batch'); assert.deepEqual(state.qualifier.activePlayers, ['p6']);
  for (const id of ['p3', 'p4', 'p5', 'p6']) tieScore(state, 0, id, id === 'p3' ? 950000 : 900000, 99);
  act(state, 'confirm-qualifier-tiebreak', { group: 'A', index: 0, verified: true });
  assert.deepEqual(QualifierRules.tiedSets(state, 'A'), [['p4', 'p5', 'p6']]);
  act(state, 'draw-qualifier-tiebreak', { group: 'A', playerIds: ['p4', 'p5', 'p6'] });
  tieScore(state, 1, 'p4', 700000); tieScore(state, 1, 'p5', 600000); tieScore(state, 1, 'p6', 500000);
  act(state, 'confirm-qualifier-tiebreak', { group: 'A', index: 1, verified: true });
  assert.deepEqual(QualifierRules.rankings(state, 'A').slice(0, 4).map(player => player.id), ['p1', 'p2', 'p3', 'p4']);
});

test('tiebreak score accuracy breaks extra-song ties; missing values prevent confirmation and confirmed rounds lock', () => {
  const state = boundaryTie(); act(state, 'draw-qualifier-tiebreak', { group: 'A', playerIds: ['p4', 'p5'] });
  tieScore(state, 0, 'p4', 950000); tieScore(state, 0, 'p5', 950000);
  assert.throws(() => act(state, 'confirm-qualifier-tiebreak', { group: 'A', index: 0, verified: true }), /original accuracy/);
  tieScore(state, 0, 'p4', 950000, 99); tieScore(state, 0, 'p5', 950000, 99.5);
  act(state, 'confirm-qualifier-tiebreak', { group: 'A', index: 0, verified: true });
  assert.equal(QualifierRules.rankings(state, 'A')[3].id, 'p5');
  assert.throws(() => tieScore(state, 0, 'p4', 1000000), /locked/);
  assert.throws(() => act(state, 'draw-qualifier-tiebreak', { group: 'A', playerIds: ['p4', 'p5'] }), /unresolved/);
});

test('base corrections after a tiebreak require explicit arbiter approval and retain the invalidated evidence', () => {
  const state = boundaryTie(); act(state, 'draw-qualifier-tiebreak', { group: 'A', playerIds: ['p4', 'p5'] });
  tieScore(state, 0, 'p4', 950000); tieScore(state, 0, 'p5', 960000);
  act(state, 'confirm-qualifier-tiebreak', { group: 'A', index: 0, verified: true });
  const originalTie = structuredClone(state.qualifier.rounds.A.tiebreaks);
  act(state, 'set-qualifier-score', { group: 'A', playerId: 'p4', songIndex: 0, score: 900000 });
  assert.equal(state.qualifier.rounds.A.tiebreaks.length, 1); assert.equal(QualifierRules.result(state, 'A', 'p4').judgements[0].accuracy, 98);
  // The normalized record, rather than JSON property order, defines a no-op.
  act(state, 'set-qualifier-score', { group: 'A', playerId: 'p4', songIndex: 0, score: 900000,
    judgements: { miss: 0, bad: 0, good: 10, perfect: 900, accuracy: 98 } });
  assert.equal(state.qualifier.adjudications, undefined);
  const before = structuredClone(state);
  const payload = { group: 'A', playerId: 'p4', songIndex: 0, score: 900001 };
  for (const flags of [{}, { verified: true }, { confirmClearTiebreaks: true },
    { confirmClearTiebreaks: true, verified: true },
    { confirmClearTiebreaks: true, verified: true, reason: '   ' },
    { confirmClearTiebreaks: true, verified: true, reason: 'short' },
    { confirmClearTiebreaks: true, verified: true, reason: 'x'.repeat(501) }]) {
    assert.throws(() => act(state, 'set-qualifier-score', { ...payload, ...flags }), /arbiter|correction reason/);
    assert.deepEqual(state, before, 'Rejected correction leaves both score and confirmed tiebreak unchanged');
  }
  act(state, 'set-qualifier-score', { ...payload, confirmClearTiebreaks: true, verified: true,
    reason: '  Referee checked the original score screen  ' });
  assert.equal(state.qualifier.rounds.A.tiebreaks.length, 0); assert.equal(QualifierRules.result(state, 'A', 'p4').judgements[0], null);
  const record = state.qualifier.adjudications[0];
  assert.equal(record.type, 'set-qualifier-score'); assert.equal(record.group, 'A'); assert.equal(record.playerId, 'p4');
  assert.equal(record.songId, 's1'); assert.equal(record.songIndex, 0); assert.equal(record.previousScore, 900000);
  assert.deepEqual(record.previousJudgements, { accuracy: 98, perfect: 900, good: 10, bad: 0, miss: 0 });
  assert.equal(record.reason, 'Referee checked the original score screen'); assert.ok(Number.isFinite(Date.parse(record.at)));
  assert.deepEqual(record.invalidatedTiebreaks, originalTie);
  originalTie[0].scores.p4 = 0; assert.equal(record.invalidatedTiebreaks[0].scores.p4, 950000);
  act(state, 'set-qualifier-score', { group: 'A', playerId: 'p4', songIndex: 0, score: null, judgements: { accuracy: 100 } });
  assert.equal(QualifierRules.result(state, 'A', 'p4').scores[0], null); assert.equal(QualifierRules.result(state, 'A', 'p4').judgements[0], null);
});

test('accuracy-only corrections also protect pending tiebreaks; next tiebreak batch preserves its song context', () => {
  const state = boundaryTie(); act(state, 'draw-qualifier-tiebreak', { group: 'A', playerIds: ['p4', 'p5'] });
  const before = structuredClone(state);
  const payload = { group: 'A', playerId: 'p4', songIndex: 0, score: 900000, judgements: { accuracy: 99 } };
  assert.throws(() => act(state, 'set-qualifier-score', payload), /arbiter/);
  assert.deepEqual(state, before);
  state.qualifier.currentSong = 2;
  act(state, 'next-qualifier-batch');
  assert.equal(state.qualifier.currentSong, 2, 'Tiebreak navigation has its own song semantics');
  act(state, 'set-qualifier-score', { ...payload, confirmClearTiebreaks: true, verified: true,
    reason: 'Original accuracy transcribed incorrectly' });
  assert.equal(state.qualifier.rounds.A.tiebreaks.length, 0);
  assert.equal(state.qualifier.adjudications[0].invalidatedTiebreaks[0].confirmed, false);
  assert.equal(QualifierRules.result(state, 'A', 'p4').judgements[0].accuracy, 99);
});

test('invalid result metadata and score commands do not modify the existing score slot', () => {
  const state = fixture(); configure(state);
  for (const score of [-1, 1000001, 1.5, '999999']) assert.throws(() => act(state, 'set-qualifier-score', { group: 'A', playerId: 'p1', songIndex: 0, score }), /integers/);
  assert.throws(() => act(state, 'set-qualifier-score', { group: 'A', playerId: 'p1', songIndex: 0, score: 900000, judgements: { accuracy: 99, perfect: 1 } }), /all four/);
  assert.deepEqual(QualifierRules.result(state, 'A', 'p1').scores, [null, null, null]);
  act(state, 'set-qualifier-score', { group: 'A', playerId: 'p1', songIndex: 0, score: 0, judgements: { accuracy: 0 } });
  assert.equal(QualifierRules.result(state, 'A', 'p1').scores[0], 0);
  assert.throws(() => act(state, 'set-qualifier-plan', { plan: 'A' }), /before scoring/);
  assert.throws(() => act(state, 'set-player-number', { playerId: 'p1', number: 64 }), /before scoring/);
  assert.throws(() => act(state, 'set-roster', { group: 'A', names: ['Different'] }), /combined/);
});

test('combined roster retains stable IDs/numbers and updates configured round eligibility before scoring', () => {
  const state = fixture(); configure(state);
  const id = state.qualifier.players[0].id, number = state.qualifier.players[0].number;
  act(state, 'set-competition-roster', { names: ['Player 1', 'New entrant'] });
  assert.equal(state.qualifier.players[0].id, id); assert.equal(state.qualifier.players[0].number, number);
  assert.equal(state.qualifier.rounds.A.playerIds.length, 2); assert.equal(state.qualifier.rounds.B.playerIds.length, 0);
  assert.equal(new Set(state.qualifier.players.map(player => player.number)).size, 2);
  assert.throws(() => act(state, 'set-competition-roster', { names: ['same', 'same'] }), /unique/);
});

test('prepared rosters select the correct proposal plan when crossing the 20-player boundary in either direction', () => {
  const state = fixture(20); configure(state, 'A');
  const original = state.qualifier.players.map(player => ({ id: player.id, number: player.number }));
  act(state, 'set-competition-roster', { names: [...state.qualifier.players.map(player => player.name), 'Player 21'] });
  assert.equal(state.qualifier.plan, 'B');
  assert.deepEqual(QualifierRules.entries(state, 'A').map(player => player.number), [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21]);
  assert.deepEqual(QualifierRules.entries(state, 'B').map(player => player.number), [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
  assert.deepEqual(state.qualifier.players.slice(0, 20).map(player => ({ id: player.id, number: player.number })), original);
  act(state, 'set-competition-roster', { names: state.qualifier.players.slice(0, 20).map(player => player.name) });
  assert.equal(state.qualifier.plan, 'A');
  assert.equal(QualifierRules.entries(state, 'A').length, 20); assert.equal(QualifierRules.entries(state, 'B').length, 0);
  assert.deepEqual(state.qualifier.activePlayers, ['p1', 'p2', 'p3']); assert.equal(state.qualifier.currentSong, 0);
  act(state, 'set-qualifier-score', { group: 'A', playerId: 'p1', songIndex: 0, score: 990000 });
  const before = structuredClone(state);
  assert.throws(() => act(state, 'set-competition-roster', { names: ['Different'] }), /before scoring/);
  assert.deepEqual(state, before, 'Scored rounds cannot silently change format or entrants');
});

test('disqualified players are masked from batches, rankings and locked qualifying seeds', () => {
  const state = fixture(10); configure(state); fill(state, 'A');
  state.qualifier.players.find(player => player.id === 'p1').disqualification = { reason: 'absence', at: '2026-11-07T06:00:00Z', note: 'Expired wait' };
  assert.equal(QualifierRules.entries(state, 'A').length, 9); assert.equal(QualifierRules.rankings(state, 'A')[0].id, 'p2');
  assert.throws(() => act(state, 'set-qualifier-score', { group: 'A', playerId: 'p1', songIndex: 0, score: 0 }), /not eligible/);
  act(state, 'finalize-qualifier-round', { group: 'A', verified: true });
  state.qualifier.players.find(player => player.id === 'p2').disqualification = { reason: 'other', at: '2026-11-07T06:01:00Z', note: 'ACA decision' };
  assert.equal(QualifierRules.seeds(state)[0], null); assert.ok(!QualifierRules.seeds(state).includes('p2'));
  assert.ok(!state.qualifier.activePlayers.includes('p1'));
});

test('browser and Node projections agree, including a recorded qualifier tiebreak winner', () => {
  const state = boundaryTie(); act(state, 'draw-qualifier-tiebreak', { group: 'A', playerIds: ['p4', 'p5'] });
  tieScore(state, 0, 'p4', 950000); tieScore(state, 0, 'p5', 960000);
  act(state, 'confirm-qualifier-tiebreak', { group: 'A', index: 0, verified: true });
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../public/js/score-rules'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(require.resolve('../public/js/qualifier-rules'), 'utf8'), context);
  const browser = context.QualifierRules;
  assert.deepEqual(JSON.parse(JSON.stringify(browser.rankings(state, 'A'))), QualifierRules.rankings(state, 'A'));
  assert.deepEqual(JSON.parse(JSON.stringify(browser.seeds(state))), QualifierRules.seeds(state));
  assert.equal(ScoreRules.compare([1], [1], [{ accuracy: 0 }], [{ accuracy: 0 }]).reason, 'tie');
});

function integratedCommand(state, type, payload = {}) {
  const { applyAction } = require('../lib/tournament');
  const { validateState } = require('../lib/state-validation');
  applyAction(state, { type, payload }); validateState(state);
  const reloaded = JSON.parse(JSON.stringify(state)); validateState(reloaded);
  assert.deepEqual(reloaded, state);
  return state;
}

test('roster boundary changes and new-batch song reset survive real StateStore commits and restarts', t => {
  const os = require('node:os'), path = require('node:path');
  const { StateStore } = require('../lib/store');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-roster-boundary-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let store = new StateStore(directory, { backupLimit: 8 });
  const persist = (type, payload = {}) => {
    store.commit({ type, payload }, store.state.revision);
    const expected = structuredClone(store.state); store = new StateStore(directory, { backupLimit: 8 });
    assert.deepEqual(store.state, expected);
  };
  persist('set-qualifier-plan', { plan: 'auto' });
  const names = Array.from({ length: 21 }, (_, index) => `Entrant ${index + 1}`);
  persist('set-competition-roster', { names }); assert.equal(store.state.qualifier.plan, 'B');
  persist('set-qualifier-display', { currentSong: 2 }); persist('next-qualifier-batch');
  assert.equal(store.state.qualifier.currentSong, 0);
  persist('set-competition-roster', { names: names.slice(0, 20) }); assert.equal(store.state.qualifier.plan, 'A');
  persist('set-qualifier-score', { group: 'A', playerId: store.state.qualifier.players[0].id, songIndex: 0, score: 999000 });
  assert.equal(store.state.qualifier.plan, 'A');
  assert.throws(() => persist('set-competition-roster', { names }), /before scoring/);
});

test('approved base correction preserves complete repeated tiebreak evidence through persistence without publishing it', t => {
  const os = require('node:os'), path = require('node:path');
  const { StateStore } = require('../lib/store');
  const { publicState } = require('../lib/tournament');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-qualifier-correction-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let store = new StateStore(directory, { backupLimit: 8 });
  const persist = (type, payload = {}) => store.commit({ type, payload }, store.state.revision);
  persist('set-qualifier-plan', { plan: 'A' });
  const scores = { p1: 990000, p2: 980000, p3: 970000, p4: 900000, p5: 900000, p6: 800000, p7: 700000, p8: 600000 };
  for (const player of store.state.qualifier.players) for (let songIndex = 0; songIndex < 3; songIndex++) {
    persist('set-qualifier-score', { group: 'A', playerId: player.id, songIndex, score: scores[player.id], judgements: { accuracy: 98 } });
  }
  persist('draw-qualifier-tiebreak', { group: 'A', playerIds: ['p4', 'p5'] });
  for (const playerId of ['p4', 'p5']) persist('set-qualifier-tiebreak-score', { group: 'A', index: 0, playerId,
    score: 950000, judgements: { accuracy: 99 } });
  persist('confirm-qualifier-tiebreak', { group: 'A', index: 0, verified: true });
  persist('draw-qualifier-tiebreak', { group: 'A', playerIds: ['p4', 'p5'] });
  persist('set-qualifier-tiebreak-score', { group: 'A', index: 1, playerId: 'p4', score: 970000 });
  const evidence = structuredClone(store.state.qualifier.rounds.A.tiebreaks), before = structuredClone(store.state);
  const correction = { group: 'A', playerId: 'p4', songIndex: 0, score: 900001 };
  assert.throws(() => persist('set-qualifier-score', correction), /arbiter/);
  assert.deepEqual(store.state, before);
  assert.deepEqual(JSON.parse(fs.readFileSync(store.file, 'utf8')), before);
  persist('set-qualifier-score', { ...correction, confirmClearTiebreaks: true, verified: true,
    reason: 'Private referee correction from original score screen' });
  const expected = structuredClone(store.state); store = new StateStore(directory, { backupLimit: 8 });
  assert.deepEqual(store.state, expected);
  assert.deepEqual(store.state.qualifier.adjudications[0].invalidatedTiebreaks, evidence);
  assert.equal(store.state.qualifier.rounds.A.tiebreaks.length, 0);
  assert.equal(publicState(store.state).qualifier.adjudications, undefined);
  assert.ok(!JSON.stringify(publicState(store.state)).includes('Private referee correction'));
});

test('actual Plan A commands persist and reload every phase with independent results and proposal bracket', t => {
  const os = require('node:os'), path = require('node:path');
  const { StateStore } = require('../lib/store');
  const { validateState } = require('../lib/state-validation');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-plan-a-rules-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let store = new StateStore(directory, { backupLimit: 8 });
  const persist = (type, payload = {}) => {
    store.commit({ type, payload }, store.state.revision);
    const expected = structuredClone(store.state);
    validateState(expected);
    store = new StateStore(directory, { backupLimit: 8 });
    assert.deepEqual(store.state, expected, `Reloaded ${type} preserves the whole official state`);
  };
  persist('set-qualifier-plan', { plan: 'auto' });
  assert.equal(store.state.qualifier.plan, 'A');
  for (const player of QualifierRules.entries(store.state, 'A')) for (let songIndex = 0; songIndex < 3; songIndex++) {
    persist('set-qualifier-score', { group: 'A', playerId: player.id, songIndex,
      score: 1000000 - Number(player.id.slice(1)) * 1000, judgements: { accuracy: 99 - songIndex * 0.001, perfect: 900, good: 10, bad: 0, miss: 0 } });
  }
  const originalResults = structuredClone(store.state.qualifier.rounds.A.results);
  persist('finalize-qualifier-round', { group: 'A', verified: true });
  assert.equal(store.state.qualifier.activeGroup, 'B');
  assert.deepEqual(store.state.qualifier.activePlayers, ['p5', 'p6', 'p7']);
  assert.deepEqual(store.state.qualifier.rounds.A.results, originalResults);
  assert.deepEqual(QualifierRules.entries(store.state, 'B').map(player => player.scores), Array.from({ length: 4 }, () => [null, null, null]));
  const locked = structuredClone(store.state);
  assert.throws(() => persist('set-qualifier-score', { group: 'A', playerId: 'p1', songIndex: 0, score: 0 }), /locked/);
  assert.deepEqual(store.state, locked); assert.deepEqual(new StateStore(directory).state, locked);
  for (const player of QualifierRules.entries(store.state, 'B')) for (let songIndex = 0; songIndex < 3; songIndex++) {
    persist('set-qualifier-score', { group: 'B', playerId: player.id, songIndex,
      score: 500000 + Number(player.id.slice(1)) * 1000, judgements: { accuracy: 95 + songIndex * 0.001 } });
  }
  persist('qualify', { verified: true });
  assert.deepEqual(store.state.tournament.seeds, ['p1', 'p2', 'p3', 'p4', 'p8', 'p7', 'p6', 'p5']);
  assert.equal(store.state.tournament.matches.at(-1).finalCandidateCount, 6);
  assert.deepEqual(store.state.qualifier.rounds.A.results, originalResults);
  assert.equal(QualifierRules.result(store.state, 'B', 'p5').scores[0], 505000);
  assert.equal(QualifierRules.result(store.state, 'A', 'p5').scores[0], 995000);
  assert.throws(() => persist('set-qualifier-score', { group: 'B', playerId: 'p5', songIndex: 0, score: 0 }), /locked/);
});

test('actual Plan B setup and numerical batches remain valid after each command and JSON reload', () => {
  const { createDefaultState } = require('../lib/default-state');
  const state = createDefaultState();
  integratedCommand(state, 'set-competition-roster', { names: Array.from({ length: 21 }, (_, index) => `Competitor ${index + 1}`) });
  integratedCommand(state, 'set-qualifier-plan', { plan: 'auto' });
  assert.equal(state.qualifier.plan, 'B');
  assert.deepEqual(QualifierRules.entries(state, 'A').map(player => player.number), [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21]);
  assert.deepEqual(QualifierRules.entries(state, 'B').map(player => player.number), [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
  const numbers = () => state.qualifier.activePlayers.map(id => state.qualifier.players.find(player => player.id === id).number);
  assert.deepEqual(numbers(), [1, 3, 5]);
  integratedCommand(state, 'next-qualifier-batch'); assert.deepEqual(numbers(), [7, 9, 11]);
  integratedCommand(state, 'next-qualifier-batch'); assert.deepEqual(numbers(), [13, 15, 17]);
  integratedCommand(state, 'next-qualifier-batch'); assert.deepEqual(numbers(), [19, 21]);
  integratedCommand(state, 'set-qualifier-display', { group: 'B' });
  integratedCommand(state, 'next-qualifier-batch'); assert.deepEqual(numbers(), [2, 4, 6]);
  integratedCommand(state, 'draw-player-numbers');
  assert.equal(new Set(state.qualifier.players.map(player => player.number)).size, 21);
  assert.ok(QualifierRules.entries(state, 'A').every(player => player.number % 2 === 1));
  assert.ok(QualifierRules.entries(state, 'B').every(player => player.number % 2 === 0));
});

test('actual validator rejects corrupted qualifier round score metadata, entrant references and number parity', () => {
  const { createDefaultState } = require('../lib/default-state');
  const { validateState } = require('../lib/state-validation');
  const state = createDefaultState(); integratedCommand(state, 'set-qualifier-plan', { plan: 'A' });
  integratedCommand(state, 'set-qualifier-score', { group: 'A', playerId: 'p1', songIndex: 0, score: 990000, judgements: { accuracy: 99, perfect: 990, good: 10, bad: 0, miss: 0 } });
  const corruptions = [
    value => { value.qualifier.rounds.A.results.p1.judgements = [{ accuracy: 99 }]; },
    value => { value.qualifier.rounds.A.results.p1.judgements[0].accuracy = 100.01; },
    value => { delete value.qualifier.rounds.A.results.p1.judgements[0].good; },
    value => { value.qualifier.rounds.A.results.p1.judgements[0].miss = -1; },
    value => { value.qualifier.rounds.A.results.p1.scores = [990000]; },
    value => { value.qualifier.rounds.A.playerIds.push('p1'); },
    value => { value.qualifier.rounds.A.playerIds.push('unknown'); },
    value => { delete value.qualifier.rounds.A.results.p1; },
    value => { value.qualifier.rounds.B.playerIds = ['p1']; value.qualifier.rounds.B.results = { p1: { scores: [null, null, null], judgements: [null, null, null] } }; },
    value => { value.qualifier.players[1].number = value.qualifier.players[0].number; }
  ];
  for (const corrupt of corruptions) {
    const damaged = structuredClone(state); corrupt(damaged);
    assert.throws(() => validateState(damaged), /Damaged state/);
  }
  const b = createDefaultState();
  integratedCommand(b, 'set-competition-roster', { names: Array.from({ length: 21 }, (_, index) => `Entrant ${index + 1}`) });
  integratedCommand(b, 'set-qualifier-plan', { plan: 'B' });
  const parityDamaged = structuredClone(b); parityDamaged.qualifier.players.find(player => player.number === 1).number = 64;
  assert.throws(() => validateState(parityDamaged), /parity/);
});

test('actual public rankings and browser mean accuracy agree for independently recorded revival scores', () => {
  const { createDefaultState } = require('../lib/default-state'), { publicState } = require('../lib/tournament');
  const state = createDefaultState(); integratedCommand(state, 'set-qualifier-plan', { plan: 'A' });
  for (const player of QualifierRules.entries(state, 'A')) for (let songIndex = 0; songIndex < 3; songIndex++) {
    integratedCommand(state, 'set-qualifier-score', { group: 'A', playerId: player.id, songIndex,
      score: 1000000 - Number(player.id.slice(1)) * 1000, judgements: { accuracy: 90 + songIndex } });
  }
  integratedCommand(state, 'finalize-qualifier-round', { group: 'A', verified: true });
  for (const player of QualifierRules.entries(state, 'B')) for (let songIndex = 0; songIndex < 3; songIndex++) {
    integratedCommand(state, 'set-qualifier-score', { group: 'B', playerId: player.id, songIndex, score: 900000,
      judgements: { accuracy: 95 + Number(player.id.slice(1)) / 10 + songIndex * 0.001 } });
  }
  const published = publicState(state), context = vm.createContext({}); context.window = context;
  for (const source of ['score-rules', 'qualifier-rules', 'common']) vm.runInContext(fs.readFileSync(require.resolve(`../public/js/${source}`), 'utf8'), context);
  const browserRanks = JSON.parse(JSON.stringify(context.Broadcast.rankings(published, 'B')));
  assert.deepEqual(browserRanks, published.qualifier.rankings.B);
  assert.equal(browserRanks[0].id, 'p8'); assert.equal(browserRanks[0].accuracy, 95.801);
  assert.equal(context.Broadcast.player(published, 'p5').scores[0], 900000);
  assert.equal(published.qualifier.rankings.A[0].accuracy, 91);
  integratedCommand(state, 'qualify', { verified: true });
});

test('proposal round scoring locks qualifier chart identity while local artwork remains editable', () => {
 const { createDefaultState } = require('../lib/default-state');
 const s=createDefaultState();integratedCommand(s,'set-qualifier-plan',{plan:'A'});
 integratedCommand(s,'set-qualifier-score',{group:'A',playerId:'p1',songIndex:0,score:990000,judgements:{accuracy:99}});
 const id=s.qualifier.groups.A.songs[0], song=s.library.find(x=>x.id===id);
 assert.throws(()=>integratedCommand(s,'upsert-song',{song:{...song,difficulty:'AT'}}),/metadata is locked/);
 integratedCommand(s,'upsert-song',{song:{...song,art:'assets/song/cover-2.svg'}});
 assert.equal(s.library.find(x=>x.id===id).art,'assets/song/cover-2.svg');
});
