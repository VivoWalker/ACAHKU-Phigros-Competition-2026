const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getBranding } = require('../lib/branding');

function assetFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-branding-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('branding returns null when actual event assets are missing', t => {
  const directory = assetFixture(t);
  fs.writeFileSync(path.join(directory, 'signal.svg'), '<svg/>');
  assert.deepEqual(getBranding(directory), { logo: null, visual: null, socLogo: null, kiramekiLogo: null });
  assert.deepEqual(getBranding(path.join(directory, 'missing')), { logo: null, visual: null, socLogo: null, kiramekiLogo: null });
});

test('branding recognizes supplied filenames and prefers standard filenames', t => {
  const directory = assetFixture(t);
  fs.writeFileSync(path.join(directory, 'Site-logo.png'), 'fixture');
  fs.writeFileSync(path.join(directory, 'PhigrosComp Poster (A5 size).jpg'), 'fixture');
  fs.writeFileSync(path.join(directory, 'soc-logo.webp'), 'fixture');
  fs.writeFileSync(path.join(directory, 'kirameki-logo.webp'), 'fixture');
  assert.deepEqual(getBranding(directory), {
    logo: 'assets/event/Site-logo.png',
    visual: 'assets/event/PhigrosComp Poster (A5 size).jpg',
    socLogo: 'assets/event/soc-logo.webp',
    kiramekiLogo: 'assets/event/kirameki-logo.webp'
  });
  fs.writeFileSync(path.join(directory, 'phigros-logo.webp'), 'fixture');
  fs.writeFileSync(path.join(directory, 'key-visual.webp'), 'fixture');
  fs.writeFileSync(path.join(directory, 'soc-logo.png'), 'fixture');
  fs.writeFileSync(path.join(directory, 'kirameki-logo.png'), 'fixture');
  assert.deepEqual(getBranding(directory), {
    logo: 'assets/event/phigros-logo.webp',
    visual: 'assets/event/key-visual.webp',
    socLogo: 'assets/event/soc-logo.png',
    kiramekiLogo: 'assets/event/kirameki-logo.png'
  });
  // A new transparent character must override an older poster left after an in-place update.
  fs.writeFileSync(path.join(directory, 'key-visual.jpg'), 'old-poster-fixture');
  fs.writeFileSync(path.join(directory, 'key-visual.png'), 'new-character-fixture');
  assert.equal(getBranding(directory).visual, 'assets/event/key-visual.png');
});

test('branding ignores directories and detects files added after an earlier read', t => {
  const directory = assetFixture(t);
  fs.mkdirSync(path.join(directory, 'phigros-logo.webp'));
  fs.mkdirSync(path.join(directory, 'key-visual.png'));
  fs.mkdirSync(path.join(directory, 'soc-logo.png'));
  fs.mkdirSync(path.join(directory, 'kirameki-logo.png'));
  assert.deepEqual(getBranding(directory), { logo: null, visual: null, socLogo: null, kiramekiLogo: null });
  fs.writeFileSync(path.join(directory, 'phigros-logo.png'), 'fixture');
  fs.writeFileSync(path.join(directory, 'key-visual.webp'), 'fixture');
  assert.deepEqual(getBranding(directory), {
    logo: 'assets/event/phigros-logo.png',
    visual: 'assets/event/key-visual.webp',
    socLogo: null,
    kiramekiLogo: null
  });
});
