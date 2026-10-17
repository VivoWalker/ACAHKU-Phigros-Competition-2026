const test = require('node:test');
const assert = require('node:assert/strict');
const Config = require('../public/js/competition-config');
const { createDefaultState } = require('../lib/default-state');
const { applyAction } = require('../lib/tournament');
const { validateState } = require('../lib/state-validation');

const constants = [16.1,16.1,16.2,16.2,16.3,16.3,16.3,16.3,16.4,16.4,16.4,16.4,16.5,16.5,16.5,16.5,16.6,16.6,16.6,16.6,16.6,16.6,16.7,16.7,16.7,16.8,16.8,16.8,16.8,16.9,16.9,16.9,16.9,17,17.1,17.2,17.3,17.3,17.3,17.4,17.4,17.5];
const official = () => Config.DOUBLE_ELIMINATION_SONG_IDS.map(id => Config.library().find(song => song.id === id));

test('all 42 internal constants retain the organiser decimal list and integer broadcast levels', () => {
  assert.deepEqual(official().map(song => song.constant), constants);
  for (const song of official()) assert.equal(song.level, Math.trunc(song.constant));
  assert.equal(official().filter(song => song.constant <= 16.5).length, 16);
  assert.equal(official().filter(song => song.constant >= 16.9).length, 13);
});

test('old official libraries obtain exact chart constants without mutation or integer guesses', () => {
  const state = createDefaultState();
  for (const song of state.library) delete song.constant;
  const before = structuredClone(state);
  validateState(state);
  assert.deepEqual(official().map(song => Config.chartConstant(state.library.find(s => s.id === song.id))), constants);
  assert.equal(Config.chartConstant(undefined), null);
  assert.equal(Config.chartConstant(state.library[0]), null);
  assert.equal(Config.chartConstant({ id: 'new', title: 'Unknown', difficulty: 'AT', level: 16 }), null);
  for (const patch of [{ id: 'changed' }, { title: 'Different song' }, { artist: 'Different artist' }, { difficulty: 'IN' }, { level: 17 }]) {
    assert.equal(Config.chartConstant({ ...state.library[6], ...patch }), null);
  }
  assert.deepEqual(state, before);
});

test('artwork-only edits from an older control preserve explicit chart constants', () => {
  const state = createDefaultState(), song = { ...state.library[6], art: 'assets/song/cover-1.svg' };
  delete song.constant;
  applyAction(state, { type: 'upsert-song', payload: { song } });
  assert.equal(state.library[6].constant, 16.1);
  assert.equal(state.library[6].art, song.art);
  validateState(state);
});

test('custom chart constants can be saved, corrected and cleared without changing broadcast levels', () => {
  const state = createDefaultState();
  const song = { ...state.library[6], id: 'custom-constant', title: 'Extra announced chart', constant: 16.9 };
  applyAction(state, { type: 'upsert-song', payload: { song } });
  let saved = state.library.find(s => s.id === song.id);
  assert.equal(saved.constant, 16.9); assert.equal(saved.level, 16);
  validateState(state);
  applyAction(state, { type: 'upsert-song', payload: { song: { ...saved, constant: 16.8 } } });
  saved = state.library.find(s => s.id === song.id);
  assert.equal(Config.chartConstant(saved), 16.8);
  applyAction(state, { type: 'upsert-song', payload: { song: { ...saved, constant: null } } });
  saved = state.library.find(s => s.id === song.id);
  assert.equal('constant' in saved, false); assert.equal(Config.chartConstant(saved), null);
  validateState(state);
});

test('invalid constant evidence is rejected on update and restore validation', () => {
  for (const constant of ['16.9', 16.95, NaN, Infinity, 0, 20.1, 17.1]) {
    const state = createDefaultState(), song = { ...state.library[6], constant };
    const before = structuredClone(state);
    assert.throws(() => applyAction(state, { type: 'upsert-song', payload: { song } }), /constant/i);
    assert.deepEqual(state, before);
    state.library[6].constant = constant;
    assert.throws(() => validateState(state), /constant/);
    assert.equal(Config.chartConstant(song), null);
  }
});
