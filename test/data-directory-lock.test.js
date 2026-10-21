const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createBroadcastServer } = require('../server');

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-owner-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const options = dataDir => ({ dataDir, pin: 'lock-main-fixture', scorekeeperPin: 'lock-scorer-fixture' });
const claims = dir => fs.readdirSync(path.join(dir, '.server-lock'));

const CHILD = `
const {createBroadcastServer}=require('./server');
let broadcast;
process.on('message', async message => {
  if(message==='start') {
    try {
      broadcast=createBroadcastServer({dataDir:process.argv[1],pin:'lock-main-fixture',scorekeeperPin:'lock-scorer-fixture'});
      const address=await broadcast.listen(0,'127.0.0.1');
      process.send({status:'ready',port:address.port});
    } catch(error) { process.send({status:'blocked',code:error.code,message:error.message},()=>process.disconnect()); }
  }
  if(message==='close') { await broadcast.close(); process.send({status:'closed'},()=>process.disconnect()); }
});
process.send({status:'waiting'});
`;
function message(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Fixture child did not report its lock outcome.')); }, 10000);
    const cleanup = () => { clearTimeout(timer); child.off('message', received); child.off('exit', exited); };
    const received = value => { cleanup(); resolve(value); };
    const exited = code => { cleanup(); reject(new Error(`Fixture child exited before reporting (exit ${code}).`)); };
    child.once('message', received); child.once('exit', exited);
  });
}
async function childServer(t, dir) {
  const child = spawn(process.execPath, ['-e', CHILD, dir], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    assert.equal(stderr, '');
  });
  assert.equal((await message(child)).status, 'waiting');
  return child;
}
async function start(child) { const result = message(child); child.send('start'); return result; }

test('a second server cannot touch an owned event, including through a directory alias', async t => {
  const dir = directory(t), first = createBroadcastServer(options(dir));
  t.after(() => first.close());
  const before = fs.readFileSync(first.store.file), registry = claims(dir);
  assert.throws(() => createBroadcastServer({ ...options(path.join(dir, '..', path.basename(dir))), pin: 'another-fixture' }), error => error.code === 'DATA_DIRECTORY_IN_USE');
  assert.deepEqual(fs.readFileSync(first.store.file), before);
  assert.deepEqual(claims(dir), registry, 'A rejected contender removes only its own claim.');
  first.store.commit({ type: 'set-event', payload: { venue: 'Sole writer' } }, first.store.state.revision);
  assert.equal(JSON.parse(fs.readFileSync(first.store.file)).event.venue, 'Sole writer');
  await first.close(); await first.close();
  const second = createBroadcastServer(options(dir));
  t.after(() => second.close());
  assert.equal(second.store.state.event.venue, 'Sole writer');
  assert.throws(() => first.store.commit({ type: 'set-event', payload: { venue: 'Closed writer' } }, first.store.state.revision), error => error.code === 'DATA_DIRECTORY_IN_USE');
});

test('a symlink to the same event cannot acquire a separate ownership claim', async t => {
  const parent = directory(t), dir = path.join(parent, 'event'), alias = path.join(parent, 'event-alias');
  const first = createBroadcastServer(options(dir));
  t.after(() => first.close());
  fs.symlinkSync(dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => createBroadcastServer(options(alias)), error => error.code === 'DATA_DIRECTORY_IN_USE');
  assert.equal(claims(dir).length, 1);
});

test('failed startup validation releases the data directory for a corrected restart', async t => {
  const dir = directory(t);
  assert.throws(() => createBroadcastServer({ ...options(dir), pin: '' }), /nonempty text/);
  assert.deepEqual(claims(dir), []);
  const broadcast = createBroadcastServer(options(dir));
  t.after(() => broadcast.close());
  await broadcast.listen(0, '127.0.0.1');
});

test('failed port binding closes the failed instance and releases its data directory', async t => {
  const dir = directory(t), occupied = http.createServer();
  occupied.listen(0, '127.0.0.1'); await once(occupied, 'listening');
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const failed = createBroadcastServer(options(dir));
  t.after(() => failed.close());
  await assert.rejects(failed.listen(occupied.address().port, '127.0.0.1'), error => error.code === 'EADDRINUSE');
  assert.deepEqual(claims(dir), []);
  const restarted = createBroadcastServer(options(dir));
  t.after(() => restarted.close());
  await restarted.listen(0, '127.0.0.1');
  await assert.rejects(failed.listen(0, '127.0.0.1'), /has closed/);
});

test('live process ownership is preserved, and a killed server leaves a reclaimable unique claim', async t => {
  const dir = directory(t), owner = await childServer(t, dir);
  assert.equal((await start(owner)).status, 'ready');
  const saved = fs.readFileSync(path.join(dir, 'match-state.json')), existing = claims(dir);
  // An old timestamp must not let a contender steal a live event.
  for (const claim of existing) fs.utimesSync(path.join(dir, '.server-lock', claim), new Date(0), new Date(0));
  const contender = await childServer(t, dir), outcome = await start(contender);
  assert.equal(outcome.status, 'blocked'); assert.equal(outcome.code, 'DATA_DIRECTORY_IN_USE');
  assert.deepEqual(claims(dir), existing); assert.deepEqual(fs.readFileSync(path.join(dir, 'match-state.json')), saved);
  const exited = once(owner, 'exit'); owner.kill('SIGKILL'); await exited;
  assert.deepEqual(claims(dir), existing, 'SIGKILL does not run the normal release handler.');
  const restarted = createBroadcastServer(options(dir));
  t.after(() => restarted.close());
  await restarted.listen(0, '127.0.0.1');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'match-state.json')), saved);
  assert.equal(claims(dir).length, 1);
  assert.notDeepEqual(claims(dir), existing);
});

test('simultaneous processes never both acquire the same event directory', async t => {
  const dir = directory(t), contenders = await Promise.all(Array.from({ length: 4 }, () => childServer(t, dir)));
  const outcomes = await Promise.all(contenders.map(start));
  assert.ok(outcomes.filter(outcome => outcome.status === 'ready').length <= 1, JSON.stringify(outcomes));
  for (const outcome of outcomes) if (outcome.status !== 'ready') assert.equal(outcome.code, 'DATA_DIRECTORY_IN_USE');
  assert.ok(claims(dir).length <= 1);
});
