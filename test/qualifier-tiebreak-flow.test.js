const test = require('node:test');
const assert = require('node:assert/strict');
const { createDefaultState } = require('../lib/default-state');
const { applyAction, publicState } = require('../lib/tournament');
const { validateState } = require('../lib/state-validation');
const { scorekeeperState } = require('../lib/scorekeeper');
const Q = require('../public/js/qualifier-rules');
const Config = require('../public/js/competition-config');
const Audio = require('../public/js/selection-audio');

function act(state, type, payload = {}) {
  const next = structuredClone(state); applyAction(next, { type, payload }); validateState(next); Object.assign(state, next);
}
function fixture(group) {
  const state = createDefaultState();
  act(state, 'set-competition-roster', { names: Array.from({ length: 12 }, (_, i) => `Entrant ${i + 1}`) });
  act(state, 'set-qualifier-plan', { plan: 'A' });
  if (group === 'B') {
    for (const [index, p] of Q.entries(state, 'A').entries()) act(state, 'set-qualifier-total', { group: 'A', playerId: p.id, total: 3000000 - index * 1000 });
    act(state, 'finalize-qualifier-round', { group: 'A', verified: true });
  }
  for (const [index, p] of Q.entries(state, group).entries()) act(state, 'set-qualifier-total', {
    group, playerId: p.id, total: index < 3 ? 3000000 - index * 10000 : index < 5 ? 2800000 : 2700000 - index * 10000
  });
  return state;
}
const current = state => Q.activeTiebreak(state);
function cue(state, scene, patch = {}) {
  act(state, 'set-broadcast-cue', { stage: 'qualifier', group: state.qualifier.activeGroup,
    players: state.qualifier.activePlayers, songIndex: 0, tiebreakIndex: 0, scene, ...patch });
}

for (const group of ['A', 'B']) test(`Round ${group} fixed tiebreak stays sealed until announced and confirms back to advancement rankings`, () => {
  const state = fixture(group), ids = Q.tiedSets(state, group)[0], base = structuredClone(state.qualifier.rounds[group].results);
  act(state, 'draw-qualifier-tiebreak', { group, playerIds: ids });
  assert.equal(state.scene, 'qualifier-waiting'); assert.deepEqual(state.qualifier.activePlayers, ids);
  assert.deepEqual(current(state).song, Config.QUALIFIER_TIEBREAK_SONGS[group]);
  assert.equal(current(state).revealed, false);
  const secret = current(state).song.title;
  assert.ok(!JSON.stringify(publicState(state)).includes(secret));
  assert.ok(!JSON.stringify(scorekeeperState(state)).includes(secret));
  assert.throws(() => cue(state, 'qualifier-match'), /Announce/);
  assert.throws(() => cue(state, 'qualifier-tiebreak-announcement', { tiebreakIndex: 1 }), /changed/);
  cue(state, 'qualifier-tiebreak-announcement');
  assert.ok(JSON.stringify(publicState(state)).includes(secret));
  assert.equal(scorekeeperState(state).qualifier.tiebreak.song.title, secret);
  const preview = structuredClone(current(state).previewCue);
  assert.equal(preview.kind, 'announcement');
  act(state, 'set-event', { venue: 'Unrelated update' });
  assert.deepEqual(current(state).previewCue, preview);
  cue(state, 'qualifier-waiting'); assert.equal(current(state).previewCue, undefined);
  assert.equal(current(state).revealed, true);
  cue(state, 'qualifier-match'); cue(state, 'qualifier-processing'); cue(state, 'song-result');
  for (const [index, playerId] of ids.entries()) act(state, 'set-qualifier-tiebreak-score', {
    group, index: 0, playerId, score: index ? 990000 : 980000,
    judgements: { perfect: 900, good: 5, bad: 0, miss: 0 }
  });
  act(state, 'confirm-qualifier-tiebreak', { group, index: 0, verified: true });
  assert.equal(state.scene, 'result'); assert.equal(current(state), null);
  assert.equal(Q.rankings(state, group)[3].id, ids[1]);
  assert.equal(Q.tiedSets(state, group).length, 0);
  assert.deepEqual(state.qualifier.rounds[group].results, base);
});

test('a one-song announcement plays once on the shared preview clock', () => {
  const clip = { id: 'one', previewDuration: 12 }, cue = { id: 'cue', kind: 'announcement', songIds: ['one'], startedAt: 1000 };
  assert.equal(Audio.phase(cue, [clip], 2000).songId, 'one');
  assert.equal(Audio.phase(cue, [clip], 1000 + Audio.FADE_MS + 12001).complete, true);
});

test('saved tiebreaks without a concealment flag remain compatible with their already announced songs', () => {
  const state = fixture('A'), ids = Q.tiedSets(state, 'A')[0];
  act(state, 'draw-qualifier-tiebreak', { group: 'A', playerIds: ids });
  delete current(state).revealed;
  cue(state, 'qualifier-match');
  assert.equal(state.scene, 'qualifier-match');
  assert.equal(Q.activeTiebreak(publicState(state)).song.title, current(state).song.title);
});
