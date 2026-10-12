(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ScoreRules = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const COUNTERS = ['perfect', 'good', 'bad', 'miss'];
  function assert(value, message) { if (!value) throw new Error(message); }
  function validScore(value) {
    return value === null || Number.isSafeInteger(value) && value >= 0 && value <= 1000000;
  }
  function normaliseJudgements(raw) {
    if (raw === null || raw === undefined) return null;
    assert(typeof raw === 'object' && !Array.isArray(raw), 'Judgements must contain the accuracy shown on the score screen.');
    assert(typeof raw.accuracy === 'number' && Number.isFinite(raw.accuracy) && raw.accuracy >= 0 && raw.accuracy <= 100,
      'Accuracy must be a number from 0 to 100.');
    const supplied = COUNTERS.filter(key => Object.prototype.hasOwnProperty.call(raw, key));
    assert(supplied.length === 0 || supplied.length === COUNTERS.length, 'Enter all four judgement counts, or leave all four empty.');
    const result = { accuracy: raw.accuracy };
    for (const key of supplied) {
      assert(Number.isSafeInteger(raw[key]) && raw[key] >= 0, 'Judgement counts must be nonnegative safe integers.');
      result[key] = raw[key];
    }
    return result;
  }
  function total(values) {
    assert(Array.isArray(values) && values.every(validScore), 'Scores must be integers from 0 to 1,000,000, or unrecorded.');
    return values.reduce((sum, value) => sum + (value === null ? 0 : value), 0);
  }
  function meanAccuracy(values) {
    if (!Array.isArray(values) || values.length === 0 || values.some(value => value === null || value === undefined || value.accuracy === undefined)) return null;
    const sum = values.reduce((value, judgement) => value + normaliseJudgements(judgement).accuracy, 0);
    return Math.round((sum / values.length + Number.EPSILON) * 10000) / 10000;
  }
  function compare(scoresA, scoresB, judgementsA, judgementsB) {
    assert(Array.isArray(scoresA) && Array.isArray(scoresB) && scoresA.length === scoresB.length && scoresA.length > 0,
      'Both players must have the same number of score slots.');
    const totals = [total(scoresA), total(scoresB)];
    // A missing score is never a played zero. Callers gate result confirmation
    // and tiebreak draws on complete scores before using this comparison.
    if (scoresA.includes(null) || scoresB.includes(null)) return { winnerIndex: null, reason: 'tie' };
    if (totals[0] !== totals[1]) return { winnerIndex: totals[0] > totals[1] ? 0 : 1, reason: 'score' };
    const accuracies = [judgementsA, judgementsB].map((values, index) =>
      Array.isArray(values) && values.length === [scoresA, scoresB][index].length ? meanAccuracy(values) : null);
    if (accuracies.includes(null)) return { winnerIndex: null, reason: 'missing-accuracy' };
    if (accuracies[0] !== accuracies[1]) return { winnerIndex: accuracies[0] > accuracies[1] ? 0 : 1, reason: 'accuracy' };
    return { winnerIndex: null, reason: 'tie' };
  }
  function matchDecision(match) {
    const base = compare(match.scores[0], match.scores[1], match.judgements?.[0], match.judgements?.[1]);
    if (base.winnerIndex !== null || base.reason !== 'tie') return base;
    for (const round of match.tiebreaks || []) {
      if (!round.confirmed) return { winnerIndex: null, reason: 'tie' };
      const decision = compare([round.scores[0]], [round.scores[1]], [round.judgements?.[0]], [round.judgements?.[1]]);
      if (decision.winnerIndex !== null || decision.reason !== 'tie') return decision;
    }
    return base;
  }
  return { normaliseJudgements, meanAccuracy, total, compare, matchDecision };
});
