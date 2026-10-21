const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createDefaultState } = require('../lib/default-state');
const { createDefaultState: createLegacyState } = require('./helpers/legacy-state');
const { StateStore, validateState } = require('../lib/store');
const { publicState } = require('../lib/tournament');
const { scorekeeperState } = require('../lib/scorekeeper');

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-event-identity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('fresh events have distinct identities shared by staff and public projections', () => {
  const first = createDefaultState(), second = createDefaultState();
  assert.notEqual(first.eventId, second.eventId);
  assert.equal(validateState(first), first);
  assert.equal(publicState(first).eventId, first.eventId);
  assert.equal(scorekeeperState(first).eventId, first.eventId);
  assert.deepEqual(first.qualifier.players, second.qualifier.players);
});

test('legacy events gain a durable identity without changing scores or revisions', t => {
  const dir = directory(t), original = createLegacyState();
  original.qualifier.players[0].scores[0] = 0;
  const file = path.join(dir, 'match-state.json');
  fs.writeFileSync(file, JSON.stringify(original));
  assert.equal(validateState(original), original, 'Unmodified schema-1 backups remain valid');
  const store = new StateStore(dir), eventId = store.state.eventId;
  assert.equal(typeof eventId, 'string');
  assert.equal(eventId.length, 36);
  const { eventId: ignored, ...loaded } = store.state;
  assert.deepEqual(loaded, original);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).eventId, eventId);
  assert.equal(new StateStore(dir).state.eventId, eventId);
  assert.equal(store.listBackups().length, 0, 'Metadata adoption does not create an artificial scoring revision');
});

test('restoring legacy or foreign snapshots keeps the current event identity', t => {
  const store = new StateStore(directory(t)), eventId = store.state.eventId;
  const foreign = createLegacyState();
  foreign.eventId = randomUUID();
  const foreignId = store.saveBackup(foreign);
  const legacy = createLegacyState(), legacyId = store.saveBackup(legacy);
  for (const id of [foreignId, legacyId]) {
    store.restore(id, store.state.revision, 'Referee reviewed the selected snapshot');
    assert.equal(store.state.eventId, eventId);
    assert.equal(new StateStore(path.dirname(store.file)).state.eventId, eventId);
  }
});

test('automatic recovery keeps a valid identity from the damaged current event', t => {
  const store = new StateStore(directory(t)), eventId = store.state.eventId;
  const foreign = createDefaultState();
  foreign.event.venue = 'Recovered venue';
  store.saveBackup(foreign);
  const damaged = { ...store.state, qualifier: null };
  fs.writeFileSync(store.file, JSON.stringify(damaged));
  const recovered = new StateStore(path.dirname(store.file));
  assert.equal(recovered.state.event.venue, 'Recovered venue');
  assert.equal(recovered.state.eventId, eventId);
  assert.equal(new StateStore(path.dirname(store.file)).state.eventId, eventId);
});

test('invalid event identities fail validation while schema-1 events remain supported', () => {
  for (const value of [null, '', 5, 'another event', 'a'.repeat(100)]) {
    const state = createDefaultState(); state.eventId = value;
    assert.throws(() => validateState(state), /eventId/);
  }
  const legacy = createLegacyState();
  assert.equal(validateState(legacy), legacy);
});
