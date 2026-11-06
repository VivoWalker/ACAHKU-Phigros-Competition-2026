const { createDefaultState } = require('../../lib/default-state');
const T = require('../../lib/tournament');
const Q = require('../../public/js/qualifier-rules');
const { validateState } = require('../../lib/state-validation');
function act(state, type, payload = {}) {
  T.applyAction(state, { type, payload: T.CURRENT_MATCH_ACTIONS.has(type) ? { matchId: state.tournament.currentMatchId, ...payload } : payload });
}
function fixture(count = 16, finish = true) {
  const state = createDefaultState();
  const names = ['A7', 'Sunshine', 'D.E.L.I.C.I.O.U.S', 'Valiant', '空白', 'Mizuki', 'Kuro', 'Rin', '星音', 'Echo', 'Hikari', '霧雨', 'Nyx', 'Sora', 'Luna', '悠'];
  act(state, 'set-competition-roster', { names: Array.from({ length: count }, (_, i) => names[i] || `Entrant ${String(i + 1).padStart(2, '0')}`) });
  act(state, 'set-qualifier-plan', { plan: 'auto' });
  for (const group of ['A', 'B']) {
    for (const player of Q.entries(state, group)) act(state, 'set-qualifier-total', { group, playerId: player.id, total: 3000000 - player.number * 1000 });
    act(state, 'finalize-qualifier-round', { group, verified: true });
  }
  act(state, 'qualify', { verified: true });
  for (const definition of T.DEFINITIONS) {
    const id = definition[0];
    act(state, 'select-match', { matchId: id });
    if (id !== 'GF') {
      act(state, 'draw-candidates');
      for (const playerIndex of [0, 1]) act(state, 'ban-song', { playerIndex, songId: null, confirmed: true });
      act(state, 'pick-songs');
    }
    for (const playerIndex of [0, 1]) for (const songIndex of [0, 1]) act(state, 'set-match-score', {
      playerIndex, songIndex, score: id === 'GF' ? playerIndex ? 990000 : 980000 : playerIndex ? 980000 : 990000,
      judgements: { accuracy: 99, perfect: 900, good: 8, bad: 0, miss: 0 }
    });
    if (id !== 'GF' || finish) act(state, 'record-result', { verified: true });
  }
  if (finish) act(state, 'set-broadcast-cue', { stage: 'double-elimination', scene: 'result', matchId: 'GF' });
  validateState(state);
  return state;
}
module.exports = { act, fixture };
