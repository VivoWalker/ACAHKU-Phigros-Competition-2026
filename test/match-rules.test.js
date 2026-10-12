const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ScoreRules = require('../public/js/score-rules');
const MatchRules = require('../lib/match-rules');

function fixture(proposal = true) {
  const song = (id, eligible = true) => ({ id, title: id, eligible });
  const match = { id: 'W1', status: 'live', players: ['p1', 'p2'], songs: [song('one'), song('two')],
    scores: [[null, null], [null, null]], hostRevealed: false };
  const state = { scene: 'double-elimination-match', library: [song('one'), song('two'), song('exclusive', false)],
    tournament: { ruleset: proposal ? 'proposal-2026' : undefined, currentMatchId: 'W1', matches: [match] } };
  const helpers = {
    assert(value, message) { if (!value) throw new Error(message); },
    text(value, max = 120) { assert.equal(typeof value, 'string'); return value.trim().slice(0, max); },
    score(value) { if (value === null || value === '') return null; assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= 1000000); return value; },
    getMatch(value, id = value.tournament.currentMatchId) { const found = value.tournament.matches.find(item => item.id === id); assert.ok(found); return found; },
    playable(value) { if (value.status === 'complete' || value.status === 'pending') throw new Error('This result is locked.'); },
    shuffled(values) { return [...values].reverse(); },
    finish(value, item, winnerId, kind, note) { item.status = 'complete'; item.winnerId = winnerId; item.resultType = kind; item.note = note; value.result = { totals: item.scores.map(ScoreRules.total), winnerId }; }
  };
  function act(type, payload = {}) { return MatchRules.applyAction(state, { type, payload: { matchId: match.id, ...payload } }, helpers); }
  function fill(scores = [[990000, 990000], [990000, 990000]], accuracies = [[99, 99], [99, 99]]) {
    for (const playerIndex of [0, 1]) for (const songIndex of [0, 1]) {
      act('set-match-score', { playerIndex, songIndex, score: scores[playerIndex][songIndex],
        ...(accuracies ? { judgements: { accuracy: accuracies[playerIndex][songIndex] } } : {}) });
    }
  }
  return { state, match, act, fill };
}

test('shared score rules work in Node and browser without deriving accuracy from counters', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../public/js/score-rules'), 'utf8'), context);
  assert.equal(typeof context.ScoreRules.matchDecision, 'function');
  assert.equal(context.ScoreRules.meanAccuracy([{ accuracy: 87.6543 }]), 87.6543);
  assert.deepEqual(ScoreRules.normaliseJudgements({ accuracy: 0, perfect: 100, good: 0, bad: 0, miss: 0 }),
    { accuracy: 0, perfect: 100, good: 0, bad: 0, miss: 0 });
  assert.deepEqual(ScoreRules.normaliseJudgements({ accuracy: 100 }), { accuracy: 100 });
  assert.equal(ScoreRules.normaliseJudgements(null), null);
  assert.equal(ScoreRules.normaliseJudgements(undefined), null);
  assert.throws(() => ScoreRules.normaliseJudgements({ perfect: 10, good: 0, bad: 0, miss: 0 }), /Accuracy/);
});

test('score metadata rejects partial counters, invalid accuracy and unsafe judgement counts', () => {
  for (const accuracy of [-0.001, 100.001, NaN, Infinity, '99', null]) {
    assert.throws(() => ScoreRules.normaliseJudgements({ accuracy }), /Accuracy/);
  }
  for (const raw of [[], 42, '99']) assert.throws(() => ScoreRules.normaliseJudgements(raw), /Judgements/);
  assert.throws(() => ScoreRules.normaliseJudgements({ accuracy: 99, perfect: 10 }), /all four/);
  for (const perfect of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '10', null]) {
    assert.throws(() => ScoreRules.normaliseJudgements({ accuracy: 99, perfect, good: 0, bad: 0, miss: 0 }), /counts/);
  }
});

test('each song has equal accuracy weight and comparisons round the mean to four decimals', () => {
  const a = [{ accuracy: 90, perfect: 1, good: 0, bad: 0, miss: 0 }, { accuracy: 100, perfect: 999, good: 0, bad: 0, miss: 0 }];
  assert.equal(ScoreRules.meanAccuracy(a), 95);
  assert.deepEqual(ScoreRules.compare([900000, 900000], [900000, 900000], a, [{ accuracy: 95 }, { accuracy: 95 }]), { winnerIndex: null, reason: 'tie' });
  assert.deepEqual(ScoreRules.compare([1], [1], [{ accuracy: 99.123441 }], [{ accuracy: 99.123449 }]), { winnerIndex: null, reason: 'tie' });
  assert.deepEqual(ScoreRules.compare([1], [1], [{ accuracy: 99.12344 }], [{ accuracy: 99.12346 }]), { winnerIndex: 1, reason: 'accuracy' });
});

test('comparison requires complete scores and treats missing accuracy as missing rather than zero', () => {
  assert.equal(ScoreRules.total([null, 0, 123]), 123);
  assert.deepEqual(ScoreRules.compare([null, 10], [0, 0], [], []), { winnerIndex: null, reason: 'tie' });
  assert.deepEqual(ScoreRules.compare([1], [0], null, null), { winnerIndex: 0, reason: 'score' });
  assert.deepEqual(ScoreRules.compare([0], [0], null, [{ accuracy: 0 }]), { winnerIndex: null, reason: 'missing-accuracy' });
  assert.deepEqual(ScoreRules.compare([0], [0], [{ accuracy: 0 }], [{ accuracy: 0 }]), { winnerIndex: null, reason: 'tie' });
  assert.equal(ScoreRules.meanAccuracy([]), null); assert.equal(ScoreRules.meanAccuracy([null]), null);
  assert.throws(() => ScoreRules.compare([1], [1, 2], [], []), /same number/);
  assert.throws(() => ScoreRules.total([undefined]), /Scores/);
});

test('initialising legacy matches creates empty metadata without changing scores or songs', () => {
  const { match } = fixture(false), before = structuredClone(match);
  MatchRules.initialise(match);
  assert.deepEqual(match.judgements, [[null, null], [null, null]]); assert.deepEqual(match.tiebreaks, []);
  assert.deepEqual(match.scores, before.scores); assert.deepEqual(match.songs, before.songs);
  match.judgements[0][0] = { accuracy: 98 }; MatchRules.initialise(match);
  assert.equal(match.judgements[0][0].accuracy, 98);
});

test('base score edits clear stale accuracy only when their value changes', () => {
  const { match, act } = fixture();
  act('set-match-score', { playerIndex: 0, songIndex: 0, score: 900000, judgements: { accuracy: 99 } });
  act('set-match-score', { playerIndex: 0, songIndex: 0, score: 900000 });
  assert.equal(match.judgements[0][0].accuracy, 99);
  act('set-match-score', { playerIndex: 0, songIndex: 0, score: 900001 });
  assert.equal(match.judgements[0][0], null);
  act('set-match-score', { playerIndex: 0, songIndex: 0, score: 0, judgements: { accuracy: 0 } });
  assert.equal(match.judgements[0][0].accuracy, 0);
  act('set-match-score', { playerIndex: 0, songIndex: 0, score: null, judgements: { accuracy: 99 } });
  assert.equal(match.judgements[0][0], null); assert.equal(match.scores[0][0], null);
});

test('proposal results require arbiter verification and choose score before accuracy', () => {
  const { match, act, fill } = fixture();
  fill([[900000, 900000], [900001, 900000]], [[100, 100], [90, 90]]);
  assert.throws(() => act('record-result'), /double-check/);
  act('record-result', { verified: true });
  assert.equal(match.winnerId, 'p2'); assert.equal(match.resultType, 'score');
  assert.equal(match.decisionReason, 'score');
  assert.ok(Number.isFinite(Date.parse(match.verifiedAt)));
  assert.throws(() => act('record-result', { verified: true }), /locked/);
});

test('tied totals choose the greater mean score-screen accuracy without arbitrary referee override', () => {
  const { match, act, fill } = fixture();
  fill(undefined, [[98, 100], [99.5, 99.5]]);
  assert.deepEqual(MatchRules.resultDecision(match), { winnerIndex: 1, reason: 'accuracy' });
  act('record-result', { verified: true, tieWinnerId: 'p1', note: 'Override attempt' });
  assert.equal(match.winnerId, 'p2');
  assert.equal(match.decisionReason, 'accuracy');
  const tied = fixture(); tied.fill();
  assert.throws(() => tied.act('record-result', { verified: true, tieWinnerId: 'p1', note: 'Override attempt' }), /Draw and play/);
});

test('missing accuracy blocks tied result and tiebreak draw but unequal game scores still resolve', () => {
  const f = fixture(); f.fill(undefined, null);
  assert.throws(() => f.act('draw-match-tiebreak'), /score-screen accuracy/);
  assert.throws(() => f.act('record-result', { verified: true }), /score-screen accuracy/);
  f.act('set-match-score', { playerIndex: 0, songIndex: 0, score: 990001 });
  f.act('record-result', { verified: true }); assert.equal(f.match.winnerId, 'p1');
});

test('repeated DE-pool tiebreaks do not change base totals and need confirmation before result', () => {
  const { state, match, act, fill } = fixture(); fill();
  const baseScores = structuredClone(match.scores);
  act('draw-match-tiebreak'); assert.equal(match.tiebreaks[0].song.id, 'two');
  assert.equal(match.tiebreaks.some(round => !round.song.eligible), false);
  assert.throws(() => act('draw-match-tiebreak'), /Confirm/);
  assert.throws(() => act('set-match-score', { playerIndex: 0, songIndex: 0, score: 990001 }), /locked after a tiebreak/);
  for (const playerIndex of [0, 1]) act('set-match-tiebreak-score', { index: 0, playerIndex, score: 999999, judgements: { accuracy: 99.9999 } });
  assert.throws(() => act('confirm-match-tiebreak', { index: 0 }), /double-check/);
  act('confirm-match-tiebreak', { index: 0, verified: true });
  assert.ok(Number.isFinite(Date.parse(match.tiebreaks[0].confirmedAt)));
  assert.deepEqual(MatchRules.resultDecision(match), { winnerIndex: null, reason: 'tie' });
  assert.throws(() => act('record-result', { verified: true }), /Draw and play/);
  act('draw-match-tiebreak');
  act('set-match-tiebreak-score', { index: 1, playerIndex: 0, score: 990000, judgements: { accuracy: 99 } });
  act('set-match-tiebreak-score', { index: 1, playerIndex: 1, score: 990001, judgements: { accuracy: 98 } });
  assert.deepEqual(MatchRules.resultDecision(match), { winnerIndex: null, reason: 'tie' });
  assert.throws(() => act('record-result', { verified: true }), /Confirm/);
  act('confirm-match-tiebreak', { index: 1, verified: true });
  assert.deepEqual(MatchRules.resultDecision(match), { winnerIndex: 1, reason: 'score' });
  assert.throws(() => act('draw-match-tiebreak'), /only available/);
  assert.throws(() => act('set-match-tiebreak-score', { index: 0, playerIndex: 0, score: 1 }), /current unconfirmed/);
  act('record-result', { verified: true });
  assert.equal(match.winnerId, 'p2'); assert.deepEqual(match.scores, baseScores);
  assert.equal(match.decisionReason, 'tiebreak');
  assert.deepEqual(state.result.totals, [1980000, 1980000]);
});

test('a tiebreak may resolve on accuracy and rejects missing accuracy when scores tie', () => {
  const { match, act, fill } = fixture(); fill(); act('draw-match-tiebreak');
  for (const playerIndex of [0, 1]) act('set-match-tiebreak-score', { index: 0, playerIndex, score: 900000 });
  assert.throws(() => act('confirm-match-tiebreak', { index: 0, verified: true }), /score-screen accuracies/);
  act('set-match-tiebreak-score', { index: 0, playerIndex: 0, score: 900000, judgements: { accuracy: 99.0001 } });
  act('set-match-tiebreak-score', { index: 0, playerIndex: 1, score: 900000, judgements: { accuracy: 99 } });
  act('confirm-match-tiebreak', { index: 0, verified: true });
  assert.deepEqual(MatchRules.resultDecision(match), { winnerIndex: 0, reason: 'accuracy' });
  act('record-result', { verified: true }); assert.equal(match.winnerId, 'p1');
});

test('incomplete, vacant and sealed MC-score matches cannot enter a tiebreak', () => {
  const f = fixture(); assert.throws(() => f.act('draw-match-tiebreak'), /every song/);
  f.fill(); f.match.players[1] = null; assert.throws(() => f.act('draw-match-tiebreak'), /every song/);
  const final = fixture(); final.match.id = 'GF'; final.state.tournament.currentMatchId = 'GF'; final.fill();
  assert.throws(() => final.act('draw-match-tiebreak'), /Reveal the MC/);
  final.match.scores = [[null, null, null], [null, null, null]]; final.match.songs.push({ id: 'three' });
  final.match.judgements = [[null, null, null], [null, null, null]];
  assert.throws(() => final.act('set-match-score', { playerIndex: 0, songIndex: 2, score: 900000 }), /Reveal the MC/);
});

test('legacy tied adjudications remain accepted only for unconfigured matches without tiebreaks', () => {
  const { match, act, fill } = fixture(false); fill(undefined, null);
  assert.throws(() => act('record-result'), /adjudication note/);
  act('record-result', { tieWinnerId: 'p2', note: 'Imported referee decision' });
  assert.equal(match.winnerId, 'p2'); assert.equal(match.note, 'Imported referee decision');
  assert.equal(match.decisionReason, 'arbiter');
  assert.equal(match.verifiedAt, undefined);
  const proposal = fixture(); proposal.fill(undefined, null);
  assert.throws(() => proposal.act('record-result', { verified: true, tieWinnerId: 'p2', note: 'Manual bypass' }), /score-screen accuracy/);
});

test('match rule module leaves unrelated commands to their domain owner', () => {
  const { state } = fixture();
  assert.equal(MatchRules.applyAction(state, { type: 'set-scene' }, {}), false);
});
test('collecting accuracy in a legacy event does not silently replace its referee tie decision', () => {
  const legacy = fixture(false); legacy.fill(undefined, [[100, 100], [90, 90]]);
  assert.throws(() => legacy.act('record-result'), /adjudication note/);
  legacy.act('record-result', { tieWinnerId: 'p2', note: 'Legacy referee adjudication retained.' });
  assert.equal(legacy.match.winnerId, 'p2'); assert.equal(legacy.match.decisionReason, 'arbiter');
});
