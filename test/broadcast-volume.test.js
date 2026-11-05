const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDefaultState } = require('./helpers/legacy-state');
const { applyAction, publicState } = require('../lib/tournament');
const { validateState } = require('../lib/state-validation');
const { StateStore } = require('../lib/store');
const { scorekeeperAction } = require('../lib/scorekeeper');

test('master volume persists across restart and public projection, including zero on legacy events', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-volume-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const legacy = createDefaultState();
  delete legacy.broadcast;
  legacy.qualifier.players[0].scores[0] = 987654;
  fs.writeFileSync(path.join(directory, 'match-state.json'), JSON.stringify(legacy));
  const store = new StateStore(directory);
  const qualifier = structuredClone(store.state.qualifier);
  store.commit({ type: 'set-broadcast-volume', payload: { volume: .37 } }, 0);
  assert.equal(publicState(store.state).broadcast.audioVolume, .37);
  assert.equal(new StateStore(directory).state.broadcast.audioVolume, .37);
  store.commit({ type: 'set-broadcast-volume', payload: { volume: 0 } }, 1);
  assert.equal(new StateStore(directory).state.broadcast.audioVolume, 0);
  assert.deepEqual(store.state.qualifier, qualifier);
});

test('master volume validates its range before mutation and remains a main-control action', () => {
  const state = createDefaultState(), original = structuredClone(state);
  for (const volume of [undefined, null, '', '0.5', NaN, Infinity, -.01, 1.01, [], {}]) {
    assert.throws(() => applyAction(state, { type: 'set-broadcast-volume', payload: { volume } }), /Volume/);
    assert.deepEqual(state, original);
    const damaged = structuredClone(state);
    damaged.broadcast.audioVolume = volume === undefined ? 'undefined' : volume;
    assert.throws(() => validateState(damaged), /broadcast.audioVolume/);
  }
  assert.throws(() => scorekeeperAction(state, { type: 'set-broadcast-volume', payload: { volume: 1 } }),
    error => error.code === 'FORBIDDEN');
  applyAction(state, { type: 'set-broadcast-volume', payload: { volume: 1 } });
  validateState(state);
  assert.equal(publicState(state).broadcast.audioVolume, 1);
});
