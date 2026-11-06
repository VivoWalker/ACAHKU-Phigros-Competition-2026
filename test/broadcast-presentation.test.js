const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const T = require('../lib/tournament');
const { validateState } = require('../lib/state-validation');
const { createDefaultState } = require('../lib/default-state');
const { scorekeeperState } = require('../lib/scorekeeper');
const Roulette = require('../public/js/selection-roulette');
const Audio = require('../public/js/selection-audio');
const Presentation = require('../public/js/result-presentation');
function act(state, type, payload = {}) {
  const next = structuredClone(state);
  T.applyAction(next, { type, payload: T.CURRENT_MATCH_ACTIONS.has(type) ? { matchId: next.tournament.currentMatchId, ...payload } : payload });
  validateState(next); Object.assign(state, next);
}
const match = state => state.tournament.matches.find(match => match.id === state.tournament.currentMatchId);
function fixture() {
  const state = createDefaultState();
  act(state, 'seed-bracket', { ids: state.qualifier.players.map(player => player.id), ruleset: 'proposal-2026' });
  act(state, 'draw-candidates');
  for (const playerIndex of [0, 1]) act(state, 'ban-song', { playerIndex, songId: match(state).candidates[playerIndex].id });
  act(state, 'pick-songs'); return state;
}
function scores(state, accuracyTie = false) {
  for (const playerIndex of [0, 1]) for (const songIndex of [0, 1]) act(state, 'set-match-score', {
    playerIndex, songIndex, score: playerIndex === songIndex ? 990000 : 980000,
    judgements: { accuracy: accuracyTie ? 99 : playerIndex ? 99 : songIndex ? 99 : 99.1234 }
  });
}
test('rolling draw reserves two distinct available songs once and presents only unbanned candidates', () => {
  const state = fixture(), m = match(state), cue = structuredClone(m.selectionPreviewCue);
  assert.equal(state.scene, 'song-selection'); assert.equal(cue.roulette.poolIds.length, 4);
  assert.ok(cue.roulette.poolIds.every(id => !m.bans.includes(id)));
  assert.ok(cue.songIds.every(id => m.usedSongs.some(song => song.id === id)));
  for (let index = 0; index < 2; index++) {
    const start = cue.startedAt + Roulette.LEAD_MS + index * Roulette.ROLL_MS + (index ? cue.durations[0] * 1000 : 0);
    const visited = new Set();
    for (let elapsed = 0; elapsed < Roulette.ROLL_MS; elapsed += 10) {
      const phase = Roulette.phase(cue, start + elapsed);
      assert.equal(phase.stage, 'rolling'); assert.equal(phase.revealedCount, index);
      assert.ok(!m.bans.includes(phase.highlightId));
      if (index) assert.notEqual(phase.highlightId, cue.songIds[0]);
      visited.add(phase.highlightId);
      assert.equal(Audio.phase(cue, m.songs, start + elapsed).pending, true);
    }
    assert.equal(visited.size, 4 - index);
    const settled = Roulette.phase(cue, start + Roulette.ROLL_MS);
    assert.equal(settled.stage, 'preview'); assert.equal(settled.focusId, cue.songIds[index]);
    assert.equal(settled.revealedCount, index + 1); assert.equal(Audio.phase(cue, m.songs, start + Roulette.ROLL_MS + 500).songId, cue.songIds[index]);
  }
  act(state, 'set-broadcast-volume', { volume: .4 }); assert.deepEqual(match(state).selectionPreviewCue, cue);
  const end = cue.startedAt + Roulette.LEAD_MS + 2 * Roulette.ROLL_MS + cue.durations.reduce((sum, value) => sum + value * 1000, 0);
  assert.equal(Roulette.phase(cue, end).stage, 'complete'); assert.equal(Audio.phase(cue, m.songs, end).complete, true);
  for (const broken of [{ ...cue, roulette: { poolIds: [...m.bans] } }, { ...cue, durations: [12] }, { ...cue, durations: Array(2) }, { ...cue, songIds: [cue.songIds[0], cue.songIds[0]] }]) {
    const damaged = structuredClone(state); match(damaged).selectionPreviewCue = broken;
    assert.throws(() => validateState(damaged), /selectionPreviewCue/);
  }
});
test('ACC decisions persist score-tie, accuracy and verdict steps without changing scores or the actual winner', () => {
  const state = fixture(); scores(state); act(state, 'record-result', { verified: true });
  const m = match(state), winner = m.winnerId, recorded = structuredClone(m.scores);
  assert.equal(Presentation.phase(m), 'scores'); assert.equal(Presentation.format(Presentation.accuracy(m, 0)), '99.0617%');
  const payload = { matchId: m.id, expectedPhase: 'scores' };
  act(state, 'advance-result-presentation', payload);
  assert.equal(Presentation.phase(match(state)), 'accuracy');
  assert.throws(() => act(state, 'advance-result-presentation', payload), /presentation changed/);
  act(state, 'advance-result-presentation', { matchId: m.id, expectedPhase: 'accuracy' });
  assert.equal(Presentation.phase(match(state)), 'verdict');
  assert.deepEqual(match(state).scores, recorded); assert.equal(match(state).winnerId, winner);
  act(state, 'reopen-result', { matchId: m.id, reason: 'Fixture score review.', confirmClear: true, affectedMatchIds: T.resultCorrectionImpact(state, m.id).affectedMatchIds });
  assert.equal(match(state).resultPresentation, undefined);
});
test('DE tiebreak waits with a concealed song, announces one preview, then retains the named waiting and score flow', () => {
  const state = fixture(); scores(state, true); act(state, 'draw-match-tiebreak');
  const tie = match(state).tiebreaks[0], title = tie.song.title;
  assert.equal(state.scene, 'double-elimination-waiting'); assert.equal(tie.revealed, false);
  assert.equal(match(T.publicState(state)).tiebreaks[0].song.hidden, true);
  assert.equal(scorekeeperState(state).match.locked, true);
  assert.deepEqual(scorekeeperState(state).match.tiebreak.song, { id: null, title: '加賽曲目待公布', difficulty: '', level: null });
  assert.throws(() => act(state, 'set-broadcast-cue', { stage: 'double-elimination', scene: 'double-elimination-match', matchId: 'W1' }), /Announce/);
  act(state, 'set-scene', { scene: 'double-elimination-tiebreak-announcement' });
  assert.equal(match(state).tiebreaks[0].previewCue.kind, 'announcement');
  assert.equal(match(T.publicState(state)).tiebreaks[0].song.title, title);
  const cue = structuredClone(match(state).tiebreaks[0].previewCue);
  act(state, 'set-broadcast-volume', { volume: .5 }); assert.deepEqual(match(state).tiebreaks[0].previewCue, cue);
  act(state, 'set-broadcast-cue', { stage: 'double-elimination', scene: 'double-elimination-waiting', matchId: 'W1' });
  assert.equal(match(state).tiebreaks[0].previewCue, undefined); assert.equal(scorekeeperState(state).match.locked, false);
  for (const playerIndex of [0, 1]) act(state, 'set-match-tiebreak-score', { index: 0, playerIndex, score: playerIndex ? 980000 : 990000, judgements: { accuracy: 99 } });
  act(state, 'confirm-match-tiebreak', { index: 0, verified: true }); act(state, 'record-result', { verified: true });
  assert.equal(state.result.decisionReason, 'tiebreak'); assert.equal(match(state).status, 'complete');
});
test('legacy pick cues and accuracy results without presentation fields retain their saved behavior', () => {
  const state = fixture(), cue = match(state).selectionPreviewCue;
  delete cue.roulette; delete cue.durations; validateState(state);
  assert.equal(Audio.phase(cue, match(state).songs, cue.startedAt + Audio.FADE_MS).pending, undefined);
  assert.equal(Presentation.phase({ decisionReason: 'accuracy' }), 'verdict');
  const sandbox = {}; vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/selection-roulette'), 'utf8'), sandbox);
  assert.equal(sandbox.BroadcastSelectionRoulette.ROLL_MS, Roulette.ROLL_MS);
});
test('the three-song Grand Final uses the same staged decision and averages all three played charts', () => {
  const state = require('./helpers/final-standings-state').fixture(16, false);
  act(state, 'show-final-two-totals'); act(state, 'start-final-finale'); act(state, 'reveal-final-finale');
  for (const playerIndex of [0, 1]) for (const songIndex of [0, 1, 2]) act(state, 'set-match-score', {
    playerIndex, songIndex, score: songIndex < 2 ? playerIndex ? 990000 : 980000 : playerIndex ? 980000 : 1000000,
    judgements: { accuracy: playerIndex ? 99 : 99.1 }
  });
  act(state, 'record-result', { verified: true });
  assert.deepEqual(state.result.totals, [2960000, 2960000]);
  assert.equal(Presentation.phase(match(state)), 'scores');
  act(state, 'advance-result-presentation', { matchId: 'GF', expectedPhase: 'scores' });
  assert.equal(Presentation.format(Presentation.accuracy(match(state), 0)), '99.1000%');
  assert.equal(Presentation.format(Presentation.accuracy(match(state), 1)), '99.0000%');
  act(state, 'advance-result-presentation', { matchId: 'GF', expectedPhase: 'accuracy' });
  assert.equal(Presentation.phase(match(state)), 'verdict');
});
