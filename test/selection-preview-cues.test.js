const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StateStore, validateState } = require('../lib/store');
const { applyAction, publicState, CURRENT_MATCH_ACTIONS } = require('../lib/tournament');
const { createDefaultState: legacyState } = require('./helpers/legacy-state');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-selection-preview-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  const act = (type, payload = {}) => store.commit({ type, payload: CURRENT_MATCH_ACTIONS.has(type) ?
    { matchId: store.state.tournament.currentMatchId, ...payload } : payload }, store.state.revision);
  const match = () => store.state.tournament.matches.find(value => value.id === store.state.tournament.currentMatchId);
  act('seed-bracket', { ids: store.state.qualifier.players.slice(0, 8).map(player => player.id) });
  act('draw-candidates');
  const pick = () => {
    act('ban-song', { playerIndex: 0, songId: match().candidates[0].id });
    act('ban-song', { playerIndex: 1, songId: match().candidates[1].id });
    act('pick-songs');
  };
  return { dir, store, act, match, pick };
}

test('legacy saves and initial six-candidate draws have no audio cue; only a real ban starts one', t => {
  assert.equal(validateState(legacyState()).tournament.matches.length, 0);
  const { store, act, match } = fixture(t);
  assert.equal(match().candidates.length, 6);
  assert.equal(match().selectionPreviewCue, undefined);
  act('ban-song', { playerIndex: 0, songId: null, confirmed: true });
  assert.equal(match().selectionPreviewCue, undefined);
  const before = Date.now(), songId = match().candidates[0].id;
  act('ban-song', { playerIndex: 0, songId, selectionPreviewCue: { id: 'forged', startedAt: 1 } });
  const cue = structuredClone(match().selectionPreviewCue);
  assert.equal(cue.kind, 'ban');
  assert.deepEqual(cue.songIds, [songId]);
  assert.match(cue.id, /^[0-9a-f-]{36}$/);
  assert.ok(cue.startedAt >= before && cue.startedAt <= Date.now());
  act('set-event', { message: 'Unrelated broadcast update' });
  assert.deepEqual(match().selectionPreviewCue, cue);
  const published = publicState(store.state).tournament.matches.find(value => value.id === match().id);
  assert.deepEqual(published.selectionPreviewCue, cue);
  published.selectionPreviewCue.songIds[0] = 'modified-copy';
  assert.deepEqual(match().selectionPreviewCue, cue);
});

test('the latest changed ban wins even when P1 changes after P2; duplicate saves do not restart playback', t => {
  const { act, match } = fixture(t), ids = match().candidates.map(song => song.id);
  act('ban-song', { playerIndex: 0, songId: ids[0] });
  const first = structuredClone(match().selectionPreviewCue);
  act('ban-song', { playerIndex: 1, songId: ids[1] });
  const second = structuredClone(match().selectionPreviewCue);
  assert.notEqual(second.id, first.id);
  assert.deepEqual(second.songIds, [ids[1]]);
  act('ban-song', { playerIndex: 0, songId: ids[2] });
  const changed = structuredClone(match().selectionPreviewCue);
  assert.notEqual(changed.id, second.id);
  assert.deepEqual(changed.songIds, [ids[2]]);
  act('ban-song', { playerIndex: 0, songId: ids[2] });
  act('ban-song', { playerIndex: 1, songId: ids[1] });
  assert.deepEqual(match().selectionPreviewCue, changed);
});

test('passing stops only that player’s active ban preview and does not replay the other ban', t => {
  const { act, match } = fixture(t), ids = match().candidates.map(song => song.id);
  act('ban-song', { playerIndex: 0, songId: ids[0] });
  act('ban-song', { playerIndex: 1, songId: ids[1] });
  const current = structuredClone(match().selectionPreviewCue);
  act('ban-song', { playerIndex: 0, songId: null, confirmed: true });
  assert.deepEqual(match().selectionPreviewCue, current);
  act('ban-song', { playerIndex: 1, songId: null, confirmed: true });
  assert.equal(match().selectionPreviewCue, undefined);
  act('pick-songs');
  assert.equal(match().selectionPreviewCue.kind, 'picks');
});

test('picked previews preserve the chosen order and timestamp across score updates and server restarts', t => {
  const { dir, store, act, match, pick } = fixture(t);
  pick();
  const cue = structuredClone(match().selectionPreviewCue);
  assert.equal(cue.kind, 'picks');
  assert.deepEqual(cue.songIds, match().songs.map(song => song.id));
  assert.equal(match().currentSong, 0);
  act('set-song-progress', { index: 1 });
  act('set-match-score', { playerIndex: 0, songIndex: 0, score: 987654 });
  assert.deepEqual(match().selectionPreviewCue, cue);
  const reloaded = new StateStore(dir).state;
  assert.deepEqual(reloaded.tournament.matches[0].selectionPreviewCue, cue);
  assert.deepEqual(publicState(store.state).tournament.matches[0].selectionPreviewCue, cue);
});

test('redraw and reset remove playback cues without clearing song usage history', t => {
  const { act, match, pick } = fixture(t);
  act('ban-song', { playerIndex: 0, songId: match().candidates[0].id });
  act('draw-candidates');
  assert.equal(match().selectionPreviewCue, undefined);
  pick();
  const usedIds = match().songs.map(song => song.id);
  act('reset-current-match');
  assert.equal(match().selectionPreviewCue, undefined);
  assert.ok(usedIds.every(id => match().usedSongs.some(song => song.id === id)));
});

test('invalid or stale selection commands leave both the cue and saved state unchanged', t => {
  const { dir, store, act, match } = fixture(t);
  const banned = match().candidates[0].id;
  act('ban-song', { playerIndex: 0, songId: banned });
  const before = structuredClone(store.state), saved = fs.readFileSync(path.join(dir, 'match-state.json'), 'utf8');
  for (const operation of [
    () => act('ban-song', { playerIndex: 1, songId: banned }),
    () => act('ban-song', { playerIndex: 1, songId: 'unknown-song' }),
    () => act('pick-songs'),
    () => act('ban-song', { matchId: 'W2', playerIndex: 1, songId: match().candidates[1].id }),
    () => store.commit({ type: 'draw-candidates', payload: { matchId: 'W1' } }, store.state.revision - 1)
  ]) {
    assert.throws(operation);
    assert.deepEqual(store.state, before);
    assert.equal(fs.readFileSync(path.join(dir, 'match-state.json'), 'utf8'), saved);
  }
});

test('saved-state validation rejects malformed, stale, reordered or private-final preview cues', t => {
  const { store, act, match, pick } = fixture(t);
  act('ban-song', { playerIndex: 0, songId: match().candidates[0].id });
  const state = structuredClone(store.state), valid = structuredClone(match().selectionPreviewCue);
  for (const cue of [
    null, [], { ...valid, id: 'untrusted' }, { ...valid, kind: 'loop-any-url' },
    { ...valid, startedAt: -1 }, { ...valid, startedAt: Infinity }, { ...valid, startedAt: '123' },
    { ...valid, songIds: [] }, { ...valid, songIds: ['unknown'] },
    { ...valid, songIds: [valid.songIds[0], valid.songIds[0]] },
    { ...valid, secret: 'must not reach overlay' }
  ]) {
    const damaged = structuredClone(state);
    damaged.tournament.matches[0].selectionPreviewCue = cue;
    assert.throws(() => validateState(damaged), /selectionPreviewCue/);
  }
  const final = structuredClone(state), gf = final.tournament.matches.find(value => value.id === 'GF');
  gf.selectionPreviewCue = { ...valid, songIds: [gf.songs[0].id] };
  assert.throws(() => validateState(final), /selectionPreviewCue/);
  assert.equal(publicState(final).tournament.matches.find(value => value.id === 'GF').selectionPreviewCue, undefined);
  pick();
  const reversed = structuredClone(store.state);
  reversed.tournament.matches[0].selectionPreviewCue.songIds.reverse();
  assert.throws(() => validateState(reversed), /selectionPreviewCue/);
});

test('starting a tiebreak or completing a match stops its selection audio cue', t => {
  const tied = fixture(t);
  tied.pick();
  for (const playerIndex of [0, 1]) for (const songIndex of [0, 1]) {
    tied.act('set-match-score', { playerIndex, songIndex, score: 900000, judgements: { accuracy: 98 } });
  }
  tied.act('draw-match-tiebreak');
  assert.equal(tied.match().selectionPreviewCue, undefined);
  const damaged = structuredClone(tied.store.state);
  damaged.tournament.matches[0].selectionPreviewCue = {
    id: '8e2642da-4538-4ed7-bac1-064ed24c8fd3', kind: 'picks',
    songIds: tied.match().songs.map(song => song.id), startedAt: Date.now()
  };
  assert.throws(() => validateState(damaged), /selectionPreviewCue/);

  const completed = fixture(t);
  completed.pick();
  for (const playerIndex of [0, 1]) for (const songIndex of [0, 1]) {
    completed.act('set-match-score', { playerIndex, songIndex, score: playerIndex === 0 ? 990000 : 980000 });
  }
  completed.act('record-result', { verified: true });
  assert.equal(completed.match().status, 'complete');
  assert.equal(completed.match().selectionPreviewCue, undefined);
});
