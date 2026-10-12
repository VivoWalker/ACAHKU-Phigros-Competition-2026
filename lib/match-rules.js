'use strict';

const ScoreRules = require('../public/js/score-rules');
const COMMANDS = new Set(['set-match-score', 'record-result', 'draw-match-tiebreak',
  'set-match-tiebreak-score', 'confirm-match-tiebreak']);

function initialise(match) {
  if (match.judgements === undefined) match.judgements = match.scores.map(row => row.map(() => null));
  if (match.tiebreaks === undefined) match.tiebreaks = [];
  return match;
}
function resultDecision(match) {
  return ScoreRules.matchDecision(match);
}
function applyAction(state, action, helpers) {
  if (!COMMANDS.has(action.type)) return false;
  const p = action.payload || {}, { assert, text, score, getMatch, playable, shuffled, finish } = helpers;
  const match = getMatch(state, p.matchId); playable(match); initialise(match);
  const proposal = state.tournament.ruleset === 'proposal-2026';
  const completeBase = () => {
    assert(match.players.every(Boolean) && match.scores.flat().every(value => value !== null), 'Enter every song score for both players.');
    assert(match.songs.length === match.scores[0].length, 'Select the match songs first.');
    assert(match.id !== 'GF' || match.hostRevealed, 'Reveal the MC song before recording the result.');
  };
  const tiebreak = () => {
    assert(Number.isInteger(p.index) && p.index >= 0 && p.index < match.tiebreaks.length, 'Choose an existing tiebreak round.');
    const round = match.tiebreaks[p.index];
    assert(p.index === match.tiebreaks.length - 1 && !round.confirmed, 'Only the current unconfirmed tiebreak can be edited.');
    return round;
  };
  const metadata = (previousScore, previous, next) => {
    if (next === null) return null;
    if (Object.prototype.hasOwnProperty.call(p, 'judgements')) return ScoreRules.normaliseJudgements(p.judgements);
    return next === previousScore ? previous : null;
  };
  switch (action.type) {
    case 'set-match-score': {
      assert(match.players.every(Boolean), 'A vacant match cannot be scored.');
      assert([0, 1].includes(p.playerIndex) && Number.isInteger(p.songIndex) && p.songIndex >= 0 && p.songIndex < match.scores[0].length, 'Invalid score slot.');
      assert(match.songs.length === match.scores[0].length, 'Select the match songs first.');
      assert(match.id !== 'GF' || p.songIndex !== 2 || match.hostRevealed, 'Reveal the MC song before scoring it.');
      assert(match.tiebreaks.length === 0, 'Base scores are locked after a tiebreak starts. Reopen or reset the match to correct them.');
      const row = p.playerIndex, index = p.songIndex, next = score(p.score);
      const judgement = metadata(match.scores[row][index], match.judgements[row][index], next);
      match.scores[row][index] = next; match.judgements[row][index] = judgement;
      break;
    }
    case 'draw-match-tiebreak': {
      completeBase();
      assert(match.tiebreaks.every(round => round.confirmed), 'Confirm the current tiebreak before drawing another song.');
      const decision = resultDecision(match);
      assert(decision.winnerIndex === null && decision.reason === 'tie', decision.reason === 'missing-accuracy' ?
        'Enter every score-screen accuracy before drawing a tiebreak.' : 'A tiebreak is only available when scores and accuracy remain tied.');
      const pool = state.library.filter(song => song.eligible);
      assert(pool.length > 0, 'The Double Elimination song pool must contain at least one eligible song.');
      assert(match.tiebreaks.length < 1000, 'Match tiebreak history limit reached.');
      match.tiebreaks.push({ song: { ...shuffled(pool)[0] }, scores: [null, null], judgements: [null, null], confirmed: false });
      break;
    }
    case 'set-match-tiebreak-score': {
      completeBase(); const round = tiebreak();
      assert([0, 1].includes(p.playerIndex), 'Invalid player.');
      const index = p.playerIndex, next = score(p.score), judgement = metadata(round.scores[index], round.judgements[index], next);
      round.scores[index] = next; round.judgements[index] = judgement;
      break;
    }
    case 'confirm-match-tiebreak': {
      completeBase(); const round = tiebreak();
      assert(p.verified === true, 'An arbiter must double-check the tiebreak scores before confirmation.');
      assert(round.scores.every(value => value !== null), 'Enter both tiebreak scores before confirmation.');
      assert(ScoreRules.compare([round.scores[0]], [round.scores[1]], [round.judgements[0]], [round.judgements[1]]).reason !== 'missing-accuracy',
        'Enter both score-screen accuracies when tiebreak scores are tied.');
      round.confirmed = true; round.confirmedAt = new Date().toISOString();
      break;
    }
    case 'record-result': {
      completeBase();
      if (proposal) assert(p.verified === true, 'An arbiter must double-check every score before recording the result.');
      assert(match.tiebreaks.every(round => round.confirmed), 'Confirm the current tiebreak before recording the result.');
      const decision = resultDecision(match); let winnerIndex = decision.winnerIndex, decisionReason = decision.reason;
      if (!proposal && match.tiebreaks.length === 0 && ScoreRules.total(match.scores[0]) === ScoreRules.total(match.scores[1])) {
        assert(match.players.includes(p.tieWinnerId) && text(p.note || '').length > 0,
          'A tied total needs a referee-selected winner and an adjudication note.');
        winnerIndex = match.players.indexOf(p.tieWinnerId); decisionReason = 'arbiter';
      } else {
        assert(winnerIndex !== null, decision.reason === 'missing-accuracy' ?
          'Enter every score-screen accuracy to resolve the tied total.' : 'Scores and accuracy are tied. Draw and play a tiebreak.');
      }
      const note = text(p.note || '', 240);
      const base = ScoreRules.compare(match.scores[0], match.scores[1], match.judgements[0], match.judgements[1]);
      match.decisionReason = base.reason === 'tie' && match.tiebreaks.length > 0 ? 'tiebreak' : decisionReason;
      if (proposal) match.verifiedAt = new Date().toISOString();
      finish(state, match, match.players[winnerIndex], 'score', note);
      state.scene = 'result';
      break;
    }
  }
  return true;
}

module.exports = { initialise, resultDecision, applyAction };
