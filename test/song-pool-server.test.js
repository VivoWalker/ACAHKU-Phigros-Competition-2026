const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { createDefaultState } = require('./helpers/legacy-state');
const { createBroadcastServer } = require('../server');
const SongPool = require('../public/js/song-pool');

test('fresh paired commands cannot reuse stale candidates; shortages do not write state or backups', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-unique-song-socket-'));
  const state = createDefaultState();
  state.library = state.library.slice(0, 6);
  fs.writeFileSync(path.join(dir, 'match-state.json'), JSON.stringify(state));
  let app = createBroadcastServer({ dataDir: dir, pin: 'unique-main-fixture', scorekeeperPin: 'unique-score-fixture' });
  let socket;
  t.after(async () => { socket?.close(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const address = await app.listen(0, '127.0.0.1'), base = `http://127.0.0.1:${address.port}`;
  const { token } = await (await fetch(base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: 'unique-main-fixture' }) })).json();
  socket = io(base + '/control', { auth: { token }, autoConnect: false, forceNew: true, reconnection: false });
  await new Promise((resolve, reject) => { socket.once('state', resolve); socket.once('connect_error', reject); socket.connect(); });
  async function command(type, payload = {}) {
    const request = { expectedRevision: app.store.state.revision, action: { type,
      payload: { matchId: app.store.state.tournament.currentMatchId, ...payload } } };
    return new Promise((resolve, reject) => socket.timeout(5000).emit('command', request, (error, response) => error ? reject(error) : resolve(response)));
  }
  async function save(type, payload = {}) { const response = await command(type, payload); assert.equal(response.ok, true, response.error); }
  await save('seed-bracket', { ids: state.qualifier.players.map(player => player.id), ruleset: 'proposal-2026' });
  for (const matchId of ['W1', 'W2', 'W3']) { await save('select-match', { matchId }); await save('draw-candidates'); }
  for (const matchId of ['W1', 'W2']) {
    await save('select-match', { matchId });
    for (const playerIndex of [0, 1]) await save('ban-song', { playerIndex, songId: null, confirmed: true });
    await save('pick-songs');
  }
  const selected = app.store.state.tournament.matches.slice(0, 2).flatMap(match => match.songs);
  assert.equal(new Set(selected.map(SongPool.identity)).size, 4);
  await save('select-match', { matchId: 'W3' });
  const conflict = await command('ban-song', { playerIndex: 0, songId: selected[0].id });
  assert.equal(conflict.ok, false); assert.match(conflict.error, /Another match selected/);
  const remaining = SongPool.available(app.store.state, 'W3', { eligibleOnly: true });
  assert.equal(remaining.length, 2);
  for (const playerIndex of [0, 1]) await save('ban-song', { playerIndex, songId: remaining[playerIndex].id });
  const before = fs.readFileSync(app.store.file, 'utf8'), revision = app.store.state.revision, backups = fs.readdirSync(app.store.backupDir);
  const rejected = await command('pick-songs');
  assert.equal(rejected.ok, false); assert.match(rejected.error, /Fewer than two/);
  const shortage = await command('draw-candidates');
  assert.equal(shortage.ok, false); assert.match(shortage.error, /2 available/);
  assert.equal(app.store.state.revision, revision); assert.equal(fs.readFileSync(app.store.file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(app.store.backupDir), backups);
  for (const playerIndex of [0, 1]) await save('ban-song', { playerIndex, songId: null, confirmed: true });
  await save('pick-songs');
  assert.equal(new Set(app.store.state.tournament.matches.slice(0, 3).flatMap(match => match.songs).map(SongPool.identity)).size, 6);
  const publicView = await (await fetch(base + '/api/state')).json();
  assert.ok(publicView.tournament.matches.every(match => !Object.hasOwn(match, 'usedSongs')));
});
