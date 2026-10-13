const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadPairingCredentials } = require('../lib/pairing-credentials');
const { createBroadcastServer } = require('../server');
const { StateStore } = require('../lib/store');

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-audit-repair-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('empty or whitespace main pairing files fail closed without rewriting damaged credentials', t => {
  for (const bytes of ['', ' \n\t ']) {
    const dir = directory(t), file = path.join(dir, '.control-pin');
    fs.writeFileSync(file, bytes);
    assert.throws(() => createBroadcastServer({ dataDir: dir, scorekeeperPin: 'fixture-scorer' }), /main-control pairing code is empty/);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.equal(fs.existsSync(path.join(dir, '.session-key')), false);
  }
});

test('explicit empty pairing codes and damaged session keys cannot start a privileged server', t => {
  const dir = directory(t);
  for (const pin of ['', '  ', null, 123456]) assert.throws(() => createBroadcastServer({ dataDir: dir, pin, scorekeeperPin: 'fixture-scorer' }), /Main control pairing code must be nonempty text/);
  assert.throws(() => createBroadcastServer({ dataDir: dir, pin: 'fixture-main', scorekeeperPin: ' ' }), /Scorekeeper pairing code must be nonempty text/);
  const file = path.join(dir, '.session-key'); fs.writeFileSync(file, Buffer.alloc(0));
  assert.throws(() => createBroadcastServer({ dataDir: dir, pin: 'fixture-main', scorekeeperPin: 'fixture-scorer' }), /session key is damaged/);
  assert.equal(fs.statSync(file).size, 0);
});

test('interrupted first pairing write leaves no empty official file and can retry safely', t => {
  const dir = directory(t), write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', function (file, value, options) {
    if (typeof file === 'number') { const failure = new Error('Injected first credential write failure'); failure.code = 'ENOSPC'; throw failure; }
    return write.call(fs, file, value, options);
  });
  assert.throws(() => loadPairingCredentials(dir, { scorekeeperPin: 'fixture-scorer' }), failure => failure.code === 'ENOSPC');
  assert.deepEqual(fs.readdirSync(dir), []);
  t.mock.restoreAll();
  const loaded = loadPairingCredentials(dir, { scorekeeperPin: 'fixture-scorer' });
  assert.match(loaded.pin, /^\d{6}$/); assert.equal(loaded.sessionKey.length, 32);
  assert.equal(fs.readFileSync(path.join(dir, '.control-pin'), 'utf8').trim(), loaded.pin);
  for (const name of ['.control-pin', '.session-key']) assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600);
});

test('failed atomic scorer-code replacement preserves the previous credential bytes', t => {
  const dir = directory(t), file = path.join(dir, '.scorekeeper-pin'), original = 'fixture-main\n';
  fs.writeFileSync(file, original); const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', function (from, to) {
    if (to === file) { const failure = new Error('Injected credential replacement failure'); failure.code = 'EIO'; throw failure; }
    return rename.call(fs, from, to);
  });
  assert.throws(() => loadPairingCredentials(dir, { pin: 'fixture-main' }), failure => failure.code === 'EIO');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(dir), ['.scorekeeper-pin']);
});

test('restart retains valid pairing tokens and missing PIN never pairs', async t => {
  const dir = directory(t), options = { dataDir: dir, pin: 'fixture-main', scorekeeperPin: 'fixture-scorer' };
  let app = createBroadcastServer(options);
  t.after(async () => { if (app) await app.close(); });
  let address = await app.listen(0, '127.0.0.1');
  let url = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(url + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  const paired = await (await fetch(url + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: options.pin }) })).json();
  await app.close(); app = createBroadcastServer(options); address = await app.listen(0, '127.0.0.1'); url = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(url + '/api/control-state', { headers: { Authorization: 'Bearer ' + paired.token } })).status, 200);
});

test('legacy unscored roster replacement cleans removed readiness and preserves retained records and audit', t => {
  const store = new StateStore(directory(t));
  const save = (type, payload) => store.commit({ type, payload }, store.state.revision);
  const ready = { device: true, globalVersion: true, headphones: true, charts: true, streamConsent: true };
  save('set-player-readiness', { playerId: 'p1', ...ready });
  save('set-player-readiness', { playerId: 'p2', ...ready });
  const retained = structuredClone(store.state.qualifier.readiness.p2);
  save('set-roster', { group: 'A', names: ['Replacement', 'Player 02', 'Player 03', 'Player 04'] });
  assert.equal(store.state.qualifier.players.some(player => player.id === 'p1'), false);
  assert.equal('p1' in store.state.qualifier.readiness, false);
  assert.deepEqual(store.state.qualifier.readiness.p2, retained);
  assert.equal(store.state.qualifier.adjudications.some(entry => entry.type === 'set-player-readiness' && entry.playerId === 'p1'), true);
  assert.equal(new StateStore(path.dirname(store.file)).state.qualifier.players.some(player => player.name === 'Replacement'), true);
});

test('legacy roster removal explicitly blocks running waits until cancelled and preserves evidence', t => {
  const store = new StateStore(directory(t));
  const save = (type, payload) => store.commit({ type, payload }, store.state.revision);
  save('start-player-wait', { playerId: 'p1', reason: 'absence' });
  const bytes = fs.readFileSync(store.file, 'utf8'), before = structuredClone(store.state), backups = store.listBackups().length;
  const replacement = { group: 'A', names: ['Replacement', 'Player 02', 'Player 03', 'Player 04'] };
  assert.throws(() => save('set-roster', replacement), /Cancel the running player wait/);
  assert.deepEqual(store.state, before); assert.equal(fs.readFileSync(store.file, 'utf8'), bytes); assert.equal(store.listBackups().length, backups);
  save('cancel-player-wait', { playerId: 'p1' }); save('set-roster', replacement);
  assert.equal(store.state.qualifier.players.some(player => player.id === 'p1'), false);
  assert.equal(store.state.qualifier.adjudications.filter(entry => entry.playerId === 'p1').length, 2);
});
