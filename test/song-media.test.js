const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StateStore, validateState } = require('../lib/store');
const { createDefaultState } = require('./helpers/legacy-state');
const { applyAction } = require('../lib/tournament');
const CompetitionConfig = require('../public/js/competition-config');

function storeFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-song-media-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new StateStore(dir);
  const save = song => store.commit({ type: 'upsert-song', payload: { song } }, store.state.revision);
  return { dir, store, save };
}

test('optional preview paths preserve legacy events, survive restart and clear only explicitly', t => {
  const legacy = createDefaultState();
  assert.equal(validateState(legacy), legacy);
  assert.equal('previewAudio' in legacy.library[0], false);
  const { dir, store, save } = storeFixture(t);
  save({ ...store.state.library[0], previewAudio: 'assets/song-preview/song-01.mp3' });
  assert.equal(new StateStore(dir).state.library[0].previewAudio, 'assets/song-preview/song-01.mp3');
  const olderClient = { ...store.state.library[0], artist: 'Updated artist' }; delete olderClient.previewAudio;
  save(olderClient);
  assert.equal(store.state.library[0].previewAudio, 'assets/song-preview/song-01.mp3');
  save({ ...store.state.library[0], previewAudio: '' });
  assert.equal(store.state.library[0].previewAudio, '');
  assert.equal(new StateStore(dir).state.library[0].previewAudio, '');
});

test('older clients editing pre-audio official saves inherit bundled previews while explicit disables stay disabled', t => {
  const { dir, store, save } = storeFixture(t);
  const songId = CompetitionConfig.DOUBLE_ELIMINATION_SONG_IDS[0];
  const song = store.state.library.find(value => value.id === songId);
  const bundledAudio = CompetitionConfig.LIBRARY.find(value => value.id === songId).previewAudio;
  assert.ok(bundledAudio);
  delete song.previewAudio;
  store.write(store.state); // Simulate a valid event saved before previews were bundled.
  const olderClient = { ...song, artist: 'Edited by an older control panel' };
  save(olderClient);
  assert.equal(store.state.library.find(value => value.id === songId).previewAudio, bundledAudio);
  assert.equal(new StateStore(dir).state.library.find(value => value.id === songId).previewAudio, bundledAudio);
  save({ ...olderClient, previewAudio: '' });
  save({ ...olderClient, artist: 'Another older-client metadata edit' });
  assert.equal(store.state.library.find(value => value.id === songId).previewAudio, '');
  assert.equal(new StateStore(dir).state.library.find(value => value.id === songId).previewAudio, '');
});

test('unbundled legacy songs without preview metadata retain their silent default after older-client edits', t => {
  const { dir, store, save } = storeFixture(t);
  store.state = createDefaultState();
  store.write(store.state);
  const song = { ...store.state.library[0], artist: 'Legacy metadata edit' };
  assert.equal(Object.hasOwn(song, 'previewAudio'), false);
  save(song);
  assert.equal(store.state.library[0].previewAudio, '');
  assert.equal(new StateStore(dir).state.library[0].previewAudio, '');
});

test('invalid preview paths are rejected atomically by commands and saved-state validation', t => {
  const { store, save } = storeFixture(t);
  for (const previewAudio of ['https://example.com/preview.mp3', '/assets/song-preview/song.mp3', 'assets/song-preview/../song.mp3', 'assets/song-preview/song.mp3?play=1', 'assets/song/song.mp3', 'assets/song-preview/song.html', null, 'assets/song-preview/' + 'a'.repeat(180) + '.mp3']) {
    const previous = structuredClone(store.state);
    assert.throws(() => save({ ...store.state.library[0], previewAudio }), /Preview audio/);
    assert.deepEqual(store.state, previous);
    const damaged = structuredClone(previous); damaged.library[0].previewAudio = previewAudio;
    assert.throws(() => validateState(damaged), /previewAudio/);
  }
  for (const extension of ['mp3', 'ogg', 'wav', 'm4a']) {
    save({ ...store.state.library[0], previewAudio: `assets/song-preview/prepared.${extension}` });
  }
});

test('drawn candidates retain their original artwork and audio snapshots after library edits', () => {
  const state = createDefaultState();
  for (const song of state.library) song.previewAudio = 'assets/song-preview/prepared.mp3';
  applyAction(state, { type: 'seed-bracket', payload: { ids: state.qualifier.players.map(player => player.id) } });
  applyAction(state, { type: 'draw-candidates', payload: { matchId: 'W1' } });
  const candidate = state.tournament.matches[0].candidates[0], before = structuredClone(candidate);
  applyAction(state, { type: 'upsert-song', payload: { song: { ...candidate, art: 'assets/song/new.webp', previewAudio: 'assets/song-preview/new.mp3' } } });
  assert.deepEqual(candidate, before);
  assert.equal(state.library.find(song => song.id === candidate.id).previewAudio, 'assets/song-preview/new.mp3');
  assert.equal(validateState(state), state);
});
