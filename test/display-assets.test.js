const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const publicDirectory = path.join(__dirname, '..', 'public');
const manifest = require('../public/assets/display/manifest.json');
const digest = data => crypto.createHash('sha256').update(data).digest('hex');

function dimensions(data) {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return [data.readUInt32BE(16), data.readUInt32BE(20)];
  }
  assert.equal(data.toString('ascii', 0, 4), 'RIFF');
  assert.equal(data.toString('ascii', 8, 12), 'WEBP');
  assert.equal(data.readUInt32LE(4) + 8, data.length);
  for (let offset = 12; offset + 8 <= data.length;) {
    const chunk = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (chunk === 'VP8X') return [data.readUIntLE(start + 4, 3) + 1, data.readUIntLE(start + 7, 3) + 1];
    if (chunk === 'VP8 ') {
      assert.equal(data.toString('hex', start + 3, start + 6), '9d012a');
      return [data.readUInt16LE(start + 6) & 0x3fff, data.readUInt16LE(start + 8) & 0x3fff];
    }
    if (chunk === 'VP8L') {
      assert.equal(data[start], 0x2f);
      const bits = data.readUInt32LE(start + 1);
      return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
    }
    offset = start + size + (size % 2);
  }
  throw new Error('Missing WebP image frame');
}

test('display variants retain every original jacket and event asset with verified hashes and dimensions', () => {
  assert.equal(manifest.schemaVersion, 1);
  const sourcePaths = ['song/song-list-2026', 'song/grand-final-2026'].flatMap(directory =>
    fs.readdirSync(path.join(publicDirectory, 'assets', directory))
      .filter(filename => filename.endsWith('.png'))
      .map(filename => `assets/${directory}/${filename}`));
  sourcePaths.push(...['key-visual.png', 'soc-logo.png', 'kirameki-logo.png', 'phigros-logo.webp']
    .map(filename => `assets/event/${filename}`));
  assert.deepEqual(Object.keys(manifest.images).sort(), sourcePaths.sort());

  for (const [source, entry] of Object.entries(manifest.images)) {
    const original = fs.readFileSync(path.join(publicDirectory, source));
    const derived = fs.readFileSync(path.join(publicDirectory, entry.path));
    assert.match(entry.path, /^assets\/display\/(?:song|event)\/.+\.webp$/);
    assert.equal(digest(original), entry.sourceSha256, `${source}: original changed without a rebuild`);
    assert.equal(digest(derived), entry.sha256, `${source}: variant checksum`);
    assert.deepEqual(dimensions(original), [entry.sourceWidth, entry.sourceHeight]);
    assert.deepEqual(dimensions(derived), [entry.width, entry.height]);
    assert.equal(original.length, entry.sourceBytes);
    assert.equal(derived.length, entry.bytes);
    assert.ok(entry.psnr >= 30, `${source}: lossy image quality below 30 dB`);
    assert.match(entry.alphaSha256, /^[a-f0-9]{64}$/);
    assert.ok(entry.width <= entry.sourceWidth && entry.height <= entry.sourceHeight);
    assert.ok(Math.abs(entry.width / entry.height - entry.sourceWidth / entry.sourceHeight) < 0.003);
    if (source.includes('/song/')) assert.deepEqual([entry.width, entry.height], [1280, 675]);
    if (source.includes('soc-logo') || source.includes('kirameki-logo')) {
      assert.deepEqual([entry.width, entry.height], [512, 512]);
    }
  }
});

test('pre-blurred backdrop tracks its source and keeps opacity and capture compositing outside the asset', () => {
  assert.deepEqual(Object.keys(manifest.backgrounds), ['assets/event/key-visual.png']);
  const [source, entry] = Object.entries(manifest.backgrounds)[0];
  const data = fs.readFileSync(path.join(publicDirectory, entry.path));
  assert.equal(entry.sourceSha256, manifest.images[source].sourceSha256);
  assert.equal(entry.sha256, digest(data));
  assert.deepEqual(dimensions(data), [1920, 1080]);
  assert.equal(entry.blurSigma, 48);
  assert.equal(entry.opacityApplied, false);
  assert.deepEqual(entry.imageViewport, { x: -120, y: -180, width: 2160, height: 1440 });
});

test('display image transfer size is below one tenth of the untouched originals', () => {
  const entries = Object.values(manifest.images);
  const originalBytes = entries.reduce((total, entry) => total + entry.sourceBytes, 0);
  const displayBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
  assert.ok(displayBytes < originalBytes / 10, `${displayBytes} / ${originalBytes}`);
});
