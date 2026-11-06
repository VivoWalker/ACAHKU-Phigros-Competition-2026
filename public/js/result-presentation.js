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
  function result(state) {
    const match = state.tournament.matches.find(match => match.id === state.tournament.currentMatchId);
    if (state.stage === 'double-elimination' && state.scene === 'result' && match && match.status !== 'complete' && pending(match))
      return { matchId: match.id, label: match.label, round: match.round, bracket: match.bracket, players: [...match.players],
        totals: match.scores.map(Scores.total), type: 'score', winnerId: null, loserId: null, placements: {}, note: '' };
    return state.result;
  }
  return { PHASES, phase, pending, accuracy, format, result };
});
