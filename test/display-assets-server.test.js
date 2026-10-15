const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createDisplayAssetsReader } = require('../lib/display-assets');
const { createBroadcastServer } = require('../server');
const { getBranding } = require('../lib/branding');

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const empty = () => ({ schemaVersion: 1, images: {}, backgrounds: {} });

test('public media revalidates cached bytes while event APIs and documents remain no-store', async t => {
  const f = fixture(t), [original] = f.image('cache');
  f.write('index.html', '<!doctype html><title>Fixture</title>');
  const app = createBroadcastServer({ dataDir: path.join(f.root, 'data'), publicDir: f.publicDir, pin: 'display-fixture', scorekeeperPin: 'display-score-fixture' });
  const address = await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;
  const first = await fetch(base + '/' + original);
  assert.equal(first.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
  const etag = first.headers.get('etag');
  assert.ok(etag); await first.text();
  const cached = await fetch(base + '/' + original, { headers: { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' } });
  assert.equal(cached.status, 304);
  f.write(original, 'updated source with a new length');
  const updated = await fetch(base + '/' + original, { headers: { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' } });
  assert.equal(updated.status, 200);
  assert.equal(await updated.text(), 'updated source with a new length');
  for (const route of ['/api/state', '/api/display-assets', '/index.html']) {
    const response = await fetch(base + route);
    assert.equal(response.headers.get('cache-control'), 'no-store', route);
    await response.text();
  }
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-display-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const publicDir = path.join(root, 'public'), manifestPath = path.join(publicDir, 'assets/display/manifest.json');
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  function write(relative, bytes) {
    const filename = path.join(publicDir, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, bytes);
    return filename;
  }
  function image(name, source = 'original-' + name, display = 'optimized-' + name) {
    const original = `assets/song/${name}.png`, optimized = `assets/display/song/${name}.webp`;
    write(original, source); write(optimized, display);
    return [original, { path: optimized, sourceSha256: sha(source), sha256: sha(display), width: 960, height: 506, privateBuildInfo: 'not public' }];
  }
  function manifest(images = {}, backgrounds = {}) {
    fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, images, backgrounds }));
  }
  return { root, publicDir, manifestPath, write, image, manifest };
}

test('display asset reader publishes only verified paths and dimensions', async t => {
  const f = fixture(t), [original, derivative] = f.image('valid');
  f.manifest({ [original]: derivative }, { [original]: { ...derivative, width: -5, height: 20000 } });
  assert.deepEqual(await createDisplayAssetsReader(f).read(), {
    schemaVersion: 1,
    images: { [original]: { path: derivative.path, width: 960, height: 506 } },
    backgrounds: { [original]: { path: derivative.path } }
  });
});

test('missing, malformed and unknown manifests are optional', async t => {
  const f = fixture(t), reader = createDisplayAssetsReader(f);
  assert.deepEqual(await reader.read(), empty());
  fs.writeFileSync(f.manifestPath, '{broken');
  assert.deepEqual(await reader.read(), empty());
  fs.writeFileSync(f.manifestPath, JSON.stringify({ schemaVersion: 2, images: {} }));
  assert.deepEqual(await reader.read(), empty());
  f.manifest([], 'invalid');
  assert.deepEqual(await reader.read(), empty());
});

test('replacing original or derivative files invalidates cached verification', async t => {
  const f = fixture(t), [original, derivative] = f.image('replace', 'aaaa', 'bbbb');
  f.manifest({ [original]: derivative });
  const reader = createDisplayAssetsReader(f);
  assert.ok((await reader.read()).images[original]);
  f.write(original, 'cccc');
  assert.deepEqual(await reader.read(), empty(), 'same-size custom source must not keep its stale optimized copy');
  f.write(original, 'aaaa');
  assert.ok((await reader.read()).images[original]);
  const replacement = f.write('assets/display/replacement.webp', 'dddd');
  fs.renameSync(replacement, path.join(f.publicDir, derivative.path));
  assert.deepEqual(await reader.read(), empty(), 'atomic derivative replacement must invalidate the cached hash');
  f.write(derivative.path, 'bbbb');
  assert.ok((await reader.read()).images[original]);
  fs.unlinkSync(path.join(f.publicDir, original));
  assert.deepEqual(await reader.read(), empty());
  f.write(original, 'aaaa');
  fs.unlinkSync(path.join(f.publicDir, derivative.path));
  assert.deepEqual(await reader.read(), empty());
});

test('unsafe paths, non-image files, symlinks outside assets and invalid hashes are omitted', async t => {
  const f = fixture(t), [original, derivative] = f.image('safe');
  const outside = path.join(f.root, 'outside.png');
  fs.writeFileSync(outside, 'outside');
  fs.symlinkSync(outside, path.join(f.publicDir, 'assets/song/outside.png'));
  const images = {
    [original]: derivative,
    '../private.png': derivative,
    'assets/../outside.png': derivative,
    'assets/%2e%2e/outside.png': derivative,
    'assets\\song\\safe.png': derivative,
    'https://example.com/safe.png': derivative,
    'assets/song/unknown.txt': derivative,
    'assets/song/outside.png': { ...derivative, sourceSha256: sha('outside') },
    'assets/song/malformed.png': null
  };
  const [second] = f.image('second');
  images[second] = { ...derivative, path: 'assets/display/../song/safe.png' };
  const [third] = f.image('third');
  images[third] = { ...derivative, sha256: 'not a hash' };
  f.manifest(images);
  assert.deepEqual(Object.keys((await createDisplayAssetsReader(f).read()).images), [original]);
});

test('concurrent requests share verification and stream hashing stays bounded and cached', async t => {
  const f = fixture(t), images = Object.fromEntries(Array.from({ length: 8 }, (_, index) => f.image(String(index))));
  f.manifest(images, { [Object.keys(images)[0]]: Object.values(images)[0] });
  let count = 0, active = 0, peak = 0;
  const reader = createDisplayAssetsReader({ ...f, concurrency: 3, hashFile: async filename => {
    count++; active++; peak = Math.max(active, peak);
    await new Promise(resolve => setTimeout(resolve, 3));
    const bytes = await fs.promises.readFile(filename);
    active--; return sha(bytes);
  } });
  const results = await Promise.all(Array.from({ length: 10 }, () => reader.read()));
  assert.ok(results.every(value => Object.keys(value.images).length === 8));
  assert.equal(count, 16, 'same files and concurrent clients share one hash each');
  assert.equal(peak, 3);
  await reader.read();
  assert.equal(count, 16, 'unchanged files are only statted on later reads');
  f.write(Object.keys(images)[0], 'changed original');
  assert.equal(Object.keys((await reader.read()).images).length, 7);
  assert.equal(count, 17);
  // A reader for another server root must never inherit these file fingerprints.
  const other = fixture(t), [otherOriginal, otherDerivative] = other.image('0', 'different source', 'different output');
  other.manifest({ [otherOriginal]: otherDerivative });
  assert.ok((await createDisplayAssetsReader(other).read()).images[otherOriginal]);
});

test('a file modified while hashing is rejected until a stable verification succeeds', async t => {
  const f = fixture(t), [original, derivative] = f.image('racing');
  f.manifest({ [original]: derivative });
  let mutate = true;
  const reader = createDisplayAssetsReader({ ...f, hashFile: async filename => {
    const hash = sha(await fs.promises.readFile(filename));
    if (mutate && filename === path.join(f.publicDir, original)) { mutate = false; f.write(original, 'replacement'); }
    return hash;
  } });
  assert.deepEqual(await reader.read(), empty());
  f.write(original, 'original-racing');
  assert.ok((await reader.read()).images[original]);
});

test('public display asset endpoint serves filtered metadata and preserves branding behavior', async t => {
  const f = fixture(t), [original, derivative] = f.image('http');
  f.manifest({ [original]: derivative });
  const app = createBroadcastServer({ dataDir: path.join(f.root, 'data'), publicDir: f.publicDir, pin: 'display-fixture', scorekeeperPin: 'display-score-fixture' });
  t.after(() => app.close());
  const address = await app.listen(0, '127.0.0.1'), base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(base + '/api/display-assets');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { schemaVersion: 1, images: { [original]: { path: derivative.path, width: 960, height: 506 } }, backgrounds: {} });
  assert.deepEqual(await (await fetch(base + '/api/branding')).json(), getBranding());
  fs.unlinkSync(f.manifestPath);
  const absent = await fetch(base + '/api/display-assets');
  assert.equal(absent.status, 200); assert.deepEqual(await absent.json(), empty());
});
