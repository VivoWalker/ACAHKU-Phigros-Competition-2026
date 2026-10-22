const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { MIN_NODE_VERSION, SUPPORTED_NODE_RANGE, isSupportedNode, assertSupportedNode } = require('../scripts/check-node-version');

const root = path.join(__dirname, '..');
const checker = path.join(root, 'scripts', 'check-node-version.js');

test('only stable Node 24 releases at or above the security floor are supported', () => {
  for (const version of ['24.22.1', 'v24.22.1', '24.22.2', '24.22.10', '24.23.0', '24.100.0']) {
    assert.equal(isSupportedNode(version), true, version);
    assert.doesNotThrow(() => assertSupportedNode(version));
  }
  for (const version of ['20.20.1', '22.22.2', '23.99.99', '24.19.0', '24.21.99', '24.22.0', '25.0.0', '26.0.0']) {
    assert.equal(isSupportedNode(version), false, version);
    assert.throws(() => assertSupportedNode(version), { code: 'UNSUPPORTED_NODE_VERSION' });
  }
});

test('prereleases, malformed versions and unsafe numeric components fail closed', () => {
  for (const version of [null, false, 24.221, '', '24', '24.22', '24.22.1.0', '24.22.1-rc.1',
    'v24.22.1-nightly20261021', '24.22.1+custom', ' 24.22.1', '24.22.1\n', '024.22.1', '24.022.1',
    '24.22.01', '24.-22.1', '24.9007199254740992.0', '24.22.9007199254740992']) {
    assert.equal(isSupportedNode(version), false, String(version));
  }
});

test('the version file, install requirements and lockfile share the security floor', () => {
  assert.equal(MIN_NODE_VERSION, '24.22.1');
  assert.equal(SUPPORTED_NODE_RANGE, '>=24.22.1 <25');
  assert.equal(fs.readFileSync(path.join(root, '.node-version'), 'utf8').trim(), MIN_NODE_VERSION);
  assert.equal(require('../package.json').engines.node, SUPPORTED_NODE_RANGE);
  assert.equal(require('../package-lock.json').packages[''].engines.node, SUPPORTED_NODE_RANGE);
});

function runChecker(t, version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-runtime-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const preload = path.join(dir, 'runtime-fixture.cjs');
  // Exercise the actual CLI entry and stderr in a child process. The production
  // checker has no CLI argument or environment override for its observed runtime.
  fs.writeFileSync(preload, `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });\n`);
  return spawnSync(process.execPath, ['--require', preload, checker], { cwd: dir, encoding: 'utf8' });
}

test('the runtime CLI rejects the old installed release with a clear upgrade error', t => {
  const result = runChecker(t, '24.19.0');
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Unsupported Node\.js v24\.19\.0\./);
  assert.match(result.stderr, />=24\.22\.1 <25 \(24 LTS\)/);
  assert.match(result.stderr, /Upgrade Node\.js/);
  assert.match(result.stderr, /npm audit does not check the Node\.js runtime/);
});

test('the runtime CLI accepts the security baseline and rejects other major releases', t => {
  for (const [version, status] of [['24.22.1', 0], ['24.23.0', 0], ['22.22.2', 1], ['25.0.0', 1], ['26.0.0', 1], ['24.22.1-rc.1', 1]]) {
    const result = runChecker(t, version);
    assert.equal(result.error, undefined);
    assert.equal(result.status, status, version);
    assert.equal(result.stdout, '');
    if (status === 0) assert.equal(result.stderr, '', version);
    else assert.match(result.stderr, /Unsupported Node\.js/);
  }
});
