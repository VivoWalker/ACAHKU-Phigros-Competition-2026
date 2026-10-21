const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createStore, TTL_MS, MAX_RECORDS, MAX_BYTES } = require('../public/js/draft-storage');

function fixture(options = {}) {
  const entries = new Map();
  const storage = {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key)
  };
  const store = createStore({ role: 'control', origin: 'http://laptop.test:3000', storage, now: () => 1000000, ...options });
  return { store, storage, entries };
}
const draft = () => [{ key: 'score:W1:p1:0', base: { score: null }, raw: '987654', rawJudgements: { accuracy: '98.7654' }, conflict: false }];

test('reload restores an independent draft snapshot and saved sheets remove it', () => {
  const f = fixture(), original = draft();
  assert.equal(f.store.save('event-one', original), true);
  original[0].raw = 'changed after save';
  const reload = createStore({ role: 'control', origin: 'http://laptop.test:3000', storage: f.storage, now: () => 1000001 });
  const loaded = reload.load('event-one');
  assert.deepEqual(loaded, draft());
  loaded[0].raw = 'changed after load';
  assert.deepEqual(reload.load('event-one'), draft());
  assert.equal(reload.save('event-one', []), true);
  assert.deepEqual(f.store.load('event-one'), []);
  assert.equal(f.entries.size, 0);
});

test('source, role and server event identity prevent cross-event recovery', () => {
  const f = fixture();
  f.store.save('event-one', draft());
  for (const options of [{ role: 'scorekeeper' }, { origin: 'http://another-laptop.test:3000' }]) {
    const other = createStore({ role: 'control', origin: 'http://laptop.test:3000', storage: f.storage, now: () => 1000000, ...options });
    assert.deepEqual(other.load('event-one'), []);
  }
  assert.deepEqual(f.store.load('event-one'), draft());
  assert.equal(f.store.clear('event-two'), false, 'an old callback cannot clear another event');
  assert.deepEqual(f.store.load('event-two'), []);
  assert.equal(f.entries.size, 0, 'a replaced event discards the previous slot');
  assert.deepEqual(f.store.load('event-one'), []);
});

test('corrupt, expired, future-dated and forged metadata safely discard stale data', () => {
  const f = fixture();
  f.store.save('event-one', draft());
  const [key, valid] = [...f.entries][0];
  for (const raw of ['{', 'null', '[]', JSON.stringify({ ...JSON.parse(valid), version: 2 }),
    JSON.stringify({ ...JSON.parse(valid), role: 'scorekeeper' }),
    JSON.stringify({ ...JSON.parse(valid), origin: 'http://other.test' }),
    JSON.stringify({ ...JSON.parse(valid), updatedAt: 1060001 }),
    JSON.stringify({ ...JSON.parse(valid), records: [null] }), 'x'.repeat(MAX_BYTES + 1)]) {
    f.entries.set(key, raw);
    assert.deepEqual(f.store.load('event-one'), []);
    assert.equal(f.entries.size, 0);
  }
  f.entries.set(key, valid);
  const expired = createStore({ role: 'control', origin: 'http://laptop.test:3000', storage: f.storage, now: () => 1000000 + TTL_MS });
  assert.deepEqual(expired.load('event-one'), []);
  assert.equal(f.entries.size, 0);
});

test('oversized and non-JSON saves cannot leave old records to reappear', () => {
  const f = fixture(), circular = {}; circular.self = circular;
  const invalid = [Array(MAX_RECORDS + 1).fill({ key: 'x' }), [{ raw: '節'.repeat(MAX_BYTES / 2) }],
    [{ read: () => 1 }], [{ raw: undefined }], [{ raw: Infinity }], [circular], [new Date()], [null], {}];
  for (const records of invalid) {
    f.store.save('event-one', draft());
    assert.equal(f.store.save('event-one', records), false);
    assert.deepEqual(f.store.load('event-one'), []);
  }
  for (const identity of ['', null, 'x'.repeat(513), 'event\nother']) {
    assert.equal(f.store.save(identity, draft()), false);
    assert.deepEqual(f.store.load(identity), []);
  }
});

test('denied storage and quota failures leave the caller edits intact', () => {
  const original = draft(), denied = () => { throw new Error('Storage disabled'); };
  for (const storage of [null, { getItem: denied, setItem: denied, removeItem: denied }]) {
    const store = createStore({ role: 'scorekeeper', origin: 'http://laptop.test', storage });
    assert.deepEqual(store.load('event-one'), []);
    assert.equal(store.save('event-one', original), false);
    assert.equal(store.clear('event-one'), false);
    assert.deepEqual(original, draft());
  }
  const f = fixture(); f.store.save('event-one', original); f.storage.setItem = denied;
  assert.equal(f.store.save('event-one', [{ raw: 'latest' }]), false);
  assert.equal(f.entries.size, 0);
});

test('browser storage access failures do not stop the staff page from loading', () => {
  const context = { window: {}, location: { origin: 'http://laptop.test' } };
  Object.defineProperty(context, 'sessionStorage', { get() { throw new Error('SecurityError'); } });
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/draft-storage'), 'utf8'), context);
  const store = context.window.BroadcastDraftStorage.createStore({ role: 'control' });
  assert.equal(store.save('event-one', draft()), false);
  assert.equal(store.load('event-one').length, 0);
});
