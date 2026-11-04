const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDefaultState } = require('../lib/default-state');
const { applyAction, publicState, CURRENT_MATCH_ACTIONS } = require('../lib/tournament');
const { validateState } = require('../lib/state-validation');
const { scorekeeperState } = require('../lib/scorekeeper');
const { StateStore } = require('../lib/store');
const Waiting = require('../public/js/waiting-preview');
const Score = require('../public/js/score-rules');

function fixture() {
  const state = createDefaultState();
  function act(type, payload = {}) {
    const next = structuredClone(state);
    applyAction(next, { type, payload: CURRENT_MATCH_ACTIONS.has(type) ? { matchId: next.tournament.currentMatchId, ...payload } : payload });
    validateState(next); Object.assign(state, next);
  }
  const match = () => state.tournament.matches.find(item => item.id === state.tournament.currentMatchId);
  const cue = (scene, songIndex = 0) => act('set-broadcast-cue', { stage: 'double-elimination', scene, songIndex, matchId: match().id });
  act('seed-bracket', { ids: state.qualifier.players.map(player => player.id), ruleset: 'proposal-2026', verified: true });
  act('draw-candidates');
  for (const playerIndex of [0, 1]) act('ban-song', { playerIndex, songId: match().candidates[playerIndex].id });
  act('pick-songs');
  return { state, act, match, cue };
}

test('each waiting song owns a stable saved loop cue and processing stops it without changing the scoring sheet', () => {
  const f = fixture();
  f.cue('double-elimination-waiting');
  const first = structuredClone(f.match().waitingPreviewCue), scoring = scorekeeperState(f.state).contextKey;
  assert.equal(first.kind, 'waiting'); assert.deepEqual(first.songIds, [f.match().songs[0].id]);
  f.act('set-event', { venue: 'Temporary waiting preview fixture' });
  f.act('set-match-score', { playerIndex: 0, songIndex: 0, score: 990000, judgements: { accuracy: 99 } });
  assert.deepEqual(f.match().waitingPreviewCue, first, 'Ordinary updates must not restart the clip');
  f.cue('double-elimination-match'); assert.equal(f.match().waitingPreviewCue, undefined);
  f.cue('double-elimination-processing');
  assert.equal(f.state.scene, 'double-elimination-processing');
  assert.equal(Waiting.context(f.state), null); assert.equal(f.match().waitingPreviewCue, undefined);
  assert.equal(scorekeeperState(f.state).contextKey, scoring);
  f.act('set-match-score', { playerIndex: 1, songIndex: 0, score: 980000, judgements: { accuracy: 98 } });
  assert.equal(f.state.scene, 'double-elimination-processing', 'Saving must not reveal statistics');
  f.cue('song-result');
  f.cue('double-elimination-waiting', 1);
  assert.notEqual(f.match().waitingPreviewCue.id, first.id);
  assert.deepEqual(f.match().waitingPreviewCue.songIds, [f.match().songs[1].id]);
  f.cue('double-elimination-processing', 1);
  assert.equal(f.match().waitingPreviewCue, undefined);
});

test('waiting cues survive restart and public projection; malformed or stale targets fail validation', t => {
  const f = fixture(); f.cue('double-elimination-waiting');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waiting-preview-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new StateStore(dir); store.state = f.state; store.write(f.state);
  assert.deepEqual(new StateStore(dir).state.tournament.matches[0].waitingPreviewCue, f.match().waitingPreviewCue);
  assert.deepEqual(publicState(f.state).tournament.matches[0].waitingPreviewCue, f.match().waitingPreviewCue);
  for (const edit of [
    state => { state.scene = 'song-result'; },
    state => { state.tournament.matches[0].waitingPreviewCue.songIds = [f.match().songs[1].id]; },
    state => { state.tournament.matches[0].waitingPreviewCue.contextKey = 'wrong context'; },
    state => { state.tournament.matches[0].waitingPreviewCue.startedAt = -1; }
  ]) {
    const damaged = structuredClone(f.state); edit(damaged);
    assert.throws(() => validateState(damaged), /waitingPreviewCue/);
  }
});

test('hidden, sealed, vacant and completed waiting matches never supply an audio target', () => {
  const f = fixture(); f.cue('double-elimination-waiting');
  for (const edit of [match => { match.songs[0].hidden = true; }, match => { match.players[0] = null; },
    match => { match.status = 'complete'; }]) {
    const state = structuredClone(f.state); edit(state.tournament.matches[0]);
    assert.equal(Waiting.context(state), null);
  }
  const state = structuredClone(f.state), match = state.tournament.matches[0];
  state.tournament.currentMatchId = match.id = 'GF'; match.finalMode = 'fixed-two';
  match.songs.push({ ...match.songs[0], id: 'sealed-final-song' }); match.currentSong = 2;
  match.finale = { stage: 'sealed' };
  assert.equal(Waiting.context(state), null);
  match.finale.stage = 'revealed';
  assert.equal(Waiting.context(state).song.id, 'sealed-final-song');
  delete match.finalMode; delete match.finale; match.hostRevealed = false;
  assert.equal(Waiting.context(state), null, 'An older private MC pick must also stay silent');
  match.hostRevealed = true;
  assert.equal(Waiting.context(state).song.id, 'sealed-final-song');
  match.tiebreaks = [{ confirmed: true, song: match.songs[0] }];
  assert.equal(Waiting.context(state), null, 'A confirmed extra song must not restart a base-song preview');
});

test('two-song judgement summaries preserve zero, missing evidence and safe counts', () => {
  const a = { perfect: 900, good: 10, bad: 1, miss: 0 }, b = { perfect: 901, good: 11, bad: 0, miss: 2 };
  assert.deepEqual(Score.sumJudgements([a, b]), { perfect: 1801, good: 21, bad: 1, miss: 2 });
  assert.deepEqual(Score.sumJudgements([{ perfect: 0, good: 0, bad: 0, miss: 0 }]), { perfect: 0, good: 0, bad: 0, miss: 0 });
  assert.deepEqual(Score.sumJudgements([a, null]), { perfect: null, good: null, bad: null, miss: null });
  assert.equal(Score.sumJudgements([{ ...a, perfect: Number.MAX_SAFE_INTEGER }, b]).perfect, null);
});
