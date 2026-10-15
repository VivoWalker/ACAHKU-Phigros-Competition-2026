const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createClient } = require('../public/js/display-media');

const original = 'assets/song/example.png';
const display = 'assets/display/song/example.webp';
const visual = 'assets/event/key-visual.png';
const background = 'assets/display/event/key-visual-backdrop.webp';
const manifest = () => ({
  schemaVersion: 1,
  images: { [original]: { path: display, width: 1280, height: 675 } },
  backgrounds: { [visual]: { path: background, width: 1920, height: 1080 } }
});
const response = value => ({ ok: true, json: () => Promise.resolve(value) });
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

function fixture(t, options = {}) {
  const timers = new Map(), requests = [];
  let serial = 0;
  const client = createClient({
    fetchImpl: (...args) => { requests.push(args); return Promise.resolve(response(manifest())); },
    setTimer: (callback, delay) => { const id = ++serial; timers.set(id, { callback, delay }); return id; },
    clearTimer: id => timers.delete(id),
    ...options
  });
  t.after(() => client.dispose());
  return { client, timers, requests, timeout: () => [...timers.values()][0].callback() };
}

test('one manifest request is shared and lookup falls back immediately before it finishes', async t => {
  let done;
  const requests = [];
  const f = fixture(t, { fetchImpl: (...args) => { requests.push(args); return new Promise(resolve => { done = resolve; }); } });
  // A deferred request is not a render dependency, and ready is the same promise.
  assert.equal(f.client.status, 'loading');
  assert.equal(f.client.resolve(original), original);
  assert.equal(f.client.background(visual), null);
  assert.equal(f.client.ready, f.client.ready);
  done(response(manifest()));
  assert.equal(await f.client.ready, 'ready');
  assert.equal(f.client.status, 'ready');
  assert.equal(f.client.resolve(original), display);
  assert.equal(f.client.resolve('/' + original), display);
  assert.equal(f.client.background('/' + visual), background);
  assert.equal(f.client.resolve('assets/custom/new.png'), 'assets/custom/new.png');
  assert.equal(f.client.background('assets/custom/new.png'), null);
  assert.equal(requests.length, 1);
  assert.equal(f.timers.size, 0);
});

test('the manifest request stays same origin and bypasses stale HTTP caches', async t => {
  const f = fixture(t);
  await f.client.ready;
  assert.equal(f.requests[0][0], '/api/display-assets');
  assert.equal(f.requests[0][1].credentials, 'same-origin');
  assert.equal(f.requests[0][1].cache, 'no-store');
  assert.ok(f.requests[0][1].signal instanceof AbortSignal);
});

test('invalid top-level responses always settle with original assets', async t => {
  for (const value of [null, [], {}, { schemaVersion: 2, images: {}, backgrounds: {} },
    { schemaVersion: 1, images: [], backgrounds: {} }, { schemaVersion: 1, images: {}, backgrounds: null }]) {
    const f = fixture(t, { fetchImpl: () => Promise.resolve(response(value)) });
    assert.equal(await f.client.ready, 'fallback');
    assert.equal(f.client.resolve(original), original);
    assert.equal(f.client.background(visual), null);
    assert.equal(f.timers.size, 0);
  }
});

test('only local asset paths and verified derivative destinations can enter the map', async t => {
  const invalid = [
    'https://broadcast.test/assets/song/example.png', '//evil.test/assets/a.png', '/assets/a.png',
    'assets/../secret.png', 'assets/./a.png', 'assets//a.png', 'assets/a\\b.png',
    'assets/%2e%2e/secret.png', 'assets/a%2epng', 'assets/a.png?x=1', 'assets/a.png#x',
    'assets/a\n.png', 'assets/a\x00.png', 'assets/a\x7f.png', 'assets/a\x85.png',
    'assets/a.mp3', 'assets/a.svg', 'other/a.png', 'assets/' + 'a'.repeat(500) + '.png'
  ];
  const value = manifest();
  for (const path of invalid) value.images[path] = { path: display };
  invalid.forEach((path, index) => { value.images[`assets/song/invalid-${index}.png`] = { path }; });
  value.images['assets/song/outside.png'] = { path: 'assets/event/example.webp' };
  value.images['assets/song/empty.png'] = null;
  value.images['assets/song/array.png'] = [];
  value.images['assets/song/not-string.png'] = { path: 1 };
  const f = fixture(t, { fetchImpl: () => Promise.resolve(response(value)) });
  assert.equal(await f.client.ready, 'ready');
  assert.equal(f.client.resolve(original), display);
  for (const path of invalid) assert.equal(f.client.resolve(path), path);
  invalid.forEach((_, index) => {
    const path = `assets/song/invalid-${index}.png`;
    assert.equal(f.client.resolve(path), path);
  });
  for (const name of ['outside', 'empty', 'array', 'not-string']) {
    const path = `assets/song/${name}.png`;
    assert.equal(f.client.resolve(path), path);
  }
  assert.equal(f.client.resolve(undefined), undefined);
});

test('invalid dimensions are skipped, and valid images do not need optional dimensions', async t => {
  const value = manifest();
  for (const [name, dimensions] of Object.entries({
    missing: {}, zero: { width: 0 }, negative: { height: -1 }, fractional: { width: 1.5 },
    string: { width: '20' }, excessive: { height: 16385 }, valid: { width: 16384, height: 1 }
  })) value.images[`assets/song/${name}.png`] = { path: display, ...dimensions };
  const f = fixture(t, { fetchImpl: () => Promise.resolve(response(value)) });
  await f.client.ready;
  for (const name of ['zero', 'negative', 'fractional', 'string', 'excessive']) {
    const path = `assets/song/${name}.png`;
    assert.equal(f.client.resolve(path), path);
  }
  for (const name of ['missing', 'valid']) assert.equal(f.client.resolve(`assets/song/${name}.png`), display);
});

test('network, HTTP, invalid JSON and synchronous fetch errors all use non-rejecting fallback', async t => {
  for (const fetchImpl of [
    () => Promise.reject(new Error('offline')),
    () => Promise.resolve({ ok: false, json: () => { throw new Error('must not parse'); } }),
    () => Promise.resolve({ ok: true }),
    () => Promise.resolve({ ok: true, json: () => Promise.reject(new Error('invalid JSON')) }),
    () => Promise.resolve({ ok: true, json: () => { throw new Error('invalid JSON'); } }),
    () => { throw new Error('fetch unavailable'); }
  ]) {
    const f = fixture(t, { fetchImpl });
    assert.equal(await f.client.ready, 'fallback');
    assert.equal(f.client.resolve(original), original);
    assert.equal(f.timers.size, 0);
  }
});

test('a stalled request times out, aborts, and ignores a late successful manifest', async t => {
  let done, signal;
  const f = fixture(t, { timeoutMs: 700, fetchImpl: (_, options) => {
    signal = options.signal;
    return new Promise(resolve => { done = resolve; });
  } });
  assert.equal([...f.timers.values()][0].delay, 700);
  f.timeout();
  assert.equal(await f.client.ready, 'fallback');
  assert.equal(signal.aborted, true);
  assert.equal(f.client.resolve(original), original);
  done(response(manifest())); await flush();
  assert.equal(f.client.status, 'fallback');
  assert.equal(f.client.resolve(original), original);
});

test('the deadline includes response body parsing and works without AbortController', async t => {
  let finishBody;
  const f = fixture(t, { AbortControllerImpl: null, fetchImpl: (_, options) => {
    assert.equal(options.signal, undefined);
    return Promise.resolve({ ok: true, json: () => new Promise(resolve => { finishBody = resolve; }) });
  } });
  await flush(); f.timeout();
  assert.equal(await f.client.ready, 'fallback');
  finishBody(manifest()); await flush();
  assert.equal(f.client.resolve(original), original);
  assert.equal(f.timers.size, 0);
});

test('disposal settles a pending client, aborts, and never restores a late response', async t => {
  let done, signal;
  const f = fixture(t, { fetchImpl: (_, options) => {
    signal = options.signal;
    return new Promise(resolve => { done = resolve; });
  } });
  f.client.dispose(); f.client.dispose();
  assert.equal(await f.client.ready, 'disposed');
  assert.equal(f.client.status, 'disposed');
  assert.equal(signal.aborted, true);
  assert.equal(f.timers.size, 0);
  done(response(manifest())); await flush();
  assert.equal(f.client.resolve(original), original);
  assert.equal(f.client.background(visual), null);
});

test('disposing a ready client clears its maps without changing its settled ready promise', async t => {
  const f = fixture(t);
  assert.equal(await f.client.ready, 'ready');
  f.client.dispose();
  assert.equal(f.client.status, 'disposed');
  assert.equal(await f.client.ready, 'ready');
  assert.equal(f.client.resolve(original), original);
  assert.equal(f.client.background(visual), null);
});

test('request timeout is bounded and excessive map entries are ignored', async t => {
  const value = { schemaVersion: 1, images: {}, backgrounds: {} };
  for (let index = 0; index < 1002; index++) value.images[`assets/song/${index}.png`] = { path: display };
  const f = fixture(t, { timeoutMs: 600000, fetchImpl: () => Promise.resolve(response(value)) });
  assert.equal([...f.timers.values()][0].delay, 10000);
  await f.client.ready;
  assert.equal(f.client.resolve('assets/song/999.png'), display);
  assert.equal(f.client.resolve('assets/song/1000.png'), 'assets/song/1000.png');
});

test('the browser build exports the client without module globals', async () => {
  const window = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/display-media'), 'utf8'), { window, setTimeout, clearTimeout });
  const client = window.BroadcastDisplayMedia.createClient();
  assert.equal(await client.ready, 'fallback');
  assert.equal(client.resolve(original), original);
  client.dispose();
});
