const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createBroadcastServer } = require('../server');

const MAIN_PIN = 'request-encoding-main-fixture';
const SCORER_PIN = 'request-encoding-scorer-fixture';
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-request-encoding-'));
  const app = createBroadcastServer({ dataDir: dir, pin: MAIN_PIN, scorekeeperPin: SCORER_PIN });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const address = await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${address.port}`;
  const post = (endpoint, body, headers = {}) => fetch(url + endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body
  });
  return { app, url, post };
}
function blockDecoders(t) {
  return ['createBrotliDecompress', 'createGunzip', 'createInflate'].map(name =>
    t.mock.method(zlib, name, () => { throw new Error('Request decoding must remain disabled.'); }));
}
function assertUnused(decoders) {
  for (const decoder of decoders) assert.equal(decoder.mock.callCount(), 0, 'No native request decoder may be constructed.');
}

test('unauthenticated Brotli, gzip and deflate JSON requests are rejected before constructing a native decoder', async t => {
  const { app, post } = await fixture(t);
  const body = Buffer.from(JSON.stringify({ pin: MAIN_PIN }));
  // Only valid compressed JSON is needed to verify the request boundary.
  const encoded = [
    ['br', zlib.brotliCompressSync(body)],
    ['gzip', zlib.gzipSync(body)],
    ['deflate', zlib.deflateSync(body)]
  ];
  const decoders = blockDecoders(t);
  for (const [encoding, bytes] of encoded) for (const endpoint of ['/api/session', '/api/restore']) {
    const response = await post(endpoint, bytes, { 'Content-Encoding': encoding });
    assert.equal(response.status, 400, `${encoding} requests use the existing uniform error response.`);
    assert.deepEqual(await response.json(), { error: 'Invalid request.' });
  }
  assertUnused(decoders);
  assert.equal(app.store.state.revision, 0);
  assert.equal(app.store.listBackups().length, 0);
});

test('plain and explicit identity JSON preserve pairing, role isolation and authenticated restore semantics', async t => {
  const { app, url, post } = await fixture(t);
  const decoders = blockDecoders(t);
  const plain = await post('/api/session', JSON.stringify({ pin: MAIN_PIN }));
  assert.equal(plain.status, 200);
  const { token } = await plain.json();
  assert.equal((await fetch(url + '/api/control-state')).status, 401);
  const headers = { Authorization: 'Bearer ' + token, 'Content-Encoding': 'identity' };
  assert.equal((await fetch(url + '/api/control-state', { headers })).status, 200);
  const incorrect = await post('/api/session', JSON.stringify({ pin: 'incorrect' }), { 'Content-Encoding': 'identity' });
  assert.equal(incorrect.status, 401);
  const scorerResponse = await post('/api/session', JSON.stringify({ pin: SCORER_PIN, role: 'scorekeeper' }),
    { 'Content-Encoding': 'identity' });
  assert.equal(scorerResponse.status, 200);
  const scorer = await scorerResponse.json();
  assert.equal((await fetch(url + '/api/control-state', { headers: { Authorization: 'Bearer ' + scorer.token } })).status, 403);
  assert.equal((await post('/api/restore', '{}', { 'Content-Encoding': 'identity' })).status, 401);

  const originalVenue = app.store.state.event.venue;
  app.store.commit({ type: 'set-event', payload: { venue: 'Request encoding fixture venue' } }, 0);
  const backupId = app.store.listBackups()[0].id;
  const restore = expectedRevision => post('/api/restore', JSON.stringify({ backupId, expectedRevision,
    reason: 'Arbiters reviewed the fixture snapshot.' }), headers);
  const stale = await restore(0);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'STALE');
  const restored = await restore(1);
  assert.equal(restored.status, 200);
  assert.deepEqual(await restored.json(), { ok: true, revision: 2 });
  assert.equal(app.store.state.event.venue, originalVenue);
  assertUnused(decoders);
});

test('the existing 100 KiB JSON body limit still applies without decompression', async t => {
  const { app, post } = await fixture(t);
  const decoders = blockDecoders(t);
  const empty = JSON.stringify({ pin: MAIN_PIN, padding: '' });
  const body = JSON.stringify({ pin: MAIN_PIN, padding: 'x'.repeat(100 * 1024 - Buffer.byteLength(empty)) });
  assert.equal(Buffer.byteLength(body), 100 * 1024);
  const accepted = await post('/api/session', body, { 'Content-Encoding': 'identity' });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).role, 'control');
  const oversized = await post('/api/session', body + ' ');
  assert.equal(oversized.status, 400);
  assert.deepEqual(await oversized.json(), { error: 'Invalid request.' });
  assert.equal(app.store.state.revision, 0);
  assertUnused(decoders);
});
