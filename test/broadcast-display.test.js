const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDefaultState } = require('../lib/default-state');
const { applyAction, publicState } = require('../lib/tournament');
const { StateStore } = require('../lib/store');

test('new events default to one gameplay source per player', () => {
  assert.deepEqual(createDefaultState().broadcast, { showHandcams: false });
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'match-state.example.json'), 'utf8'));
  assert.deepEqual(example.broadcast, { showHandcams: false });
});

test('display switches only the handcam setting and rejects non-boolean values without mutation', () => {
  const state = createDefaultState();
  state.qualifier.players[0].scores[0] = 987654;
  const before = structuredClone(state);
  for (const showHandcams of [true, false]) {
    applyAction(state, { type: 'set-broadcast-display', payload: { showHandcams } });
    assert.deepEqual(state, { ...before, broadcast: { showHandcams } });
    assert.equal(publicState(state).broadcast.showHandcams, showHandcams);
  }
  for (const showHandcams of [undefined, null, 0, 1, 'true', 'false', [], {}]) {
    assert.throws(() => applyAction(state, { type: 'set-broadcast-display', payload: { showHandcams } }), /boolean/);
    assert.deepEqual(state, before);
  }
});

test('old tournament files read safely and persist the first display command across restart', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-display-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const legacy = createDefaultState();
  legacy.qualifier.players[0].scores = [987654, 986543, 985432];
  delete legacy.broadcast;
  const filename = path.join(directory, 'match-state.json');
  const original = JSON.stringify(legacy);
  fs.writeFileSync(filename, original);
  const store = new StateStore(directory);
  assert.equal(store.state.broadcast, undefined);
  assert.deepEqual(publicState(store.state).broadcast, { showHandcams: false });
  assert.equal(store.state.broadcast, undefined);
  assert.equal(fs.readFileSync(filename, 'utf8'), original);
  store.commit({ type: 'set-broadcast-display', payload: { showHandcams: true } }, 0);
  const restarted = new StateStore(directory);
  assert.deepEqual(restarted.state.broadcast, { showHandcams: true });
  assert.equal(restarted.state.revision, 1);
  assert.deepEqual(restarted.state.qualifier, legacy.qualifier);
  assert.deepEqual(restarted.state.tournament, legacy.tournament);
  assert.deepEqual(restarted.state.event, legacy.event);
  restarted.commit({ type: 'set-broadcast-display', payload: { showHandcams: false } }, 1);
  assert.deepEqual(new StateStore(directory).state.broadcast, { showHandcams: false });
});
