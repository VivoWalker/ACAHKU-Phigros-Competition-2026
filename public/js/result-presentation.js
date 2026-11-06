(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./score-rules') : root.ScoreRules);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BroadcastResultPresentation = api;
})(typeof window === 'undefined' ? globalThis : window, function (Scores) {
  'use strict';
  const PHASES = ['scores', 'accuracy', 'verdict'];
  const phase = match => match?.resultPresentation || 'verdict';
  const pending = match => phase(match) !== 'verdict';
  const accuracy = (match, index) => Scores.meanAccuracy(match.judgements?.[index]);
  const format = value => Number.isFinite(value) ? value.toFixed(4) + '%' : '—';
  return { PHASES, phase, pending, accuracy, format };
});
