const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { io } = require('socket.io-client');
const { createDefaultState } = require('../lib/default-state');
const { applyAction, publicState } = require('../lib/tournament');
const { validateState, StateStore } = require('../lib/store');
const { createBroadcastServer } = require('../server');
const { createIntermissionMedia } = require('../lib/intermission-media');
const Intermission = require('../public/js/intermission');
const options = { videoPath: 'assets/intermission/arcaea-trailer.mp4', loop: true, resumeTime: '15:30' };
const act = (state, type, payload = {}) => applyAction(state, { type, payload });
const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcast-intermission-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true })); return dir;
}

test('intermission preserves competition results, exposes the trailer, and returns to DE without inventing seeds', () => {
  const state = createDefaultState(), before = structuredClone(state);
  act(state, 'configure-intermission', options); act(state, 'start-intermission');
  assert.equal(state.scene, 'intermission'); assert.equal(state.stage, before.stage);
  assert.deepEqual(state.qualifier, before.qualifier); assert.deepEqual(state.tournament, before.tournament);
  const config = state.broadcast.intermission;
  assert.equal(config.cue, null, 'Entering the illustrated rest page must never auto-play a configured trailer.');
  act(state, 'play-intermission-video');
  assert.equal(state.scene, 'arcaea-trailer');
  assert.equal(typeof state.broadcast.intermission.cue.startedAt, 'number');
  assert.deepEqual(publicState(state).broadcast.intermission, state.broadcast.intermission);
  validateState(state);
  act(state, 'end-intermission');
  assert.equal(state.stage, 'double-elimination'); assert.equal(state.scene, 'double-elimination-waiting');
  assert.equal(state.broadcast.intermission.cue, null);
  assert.deepEqual(state.tournament, before.tournament); validateState(state);
});

test('bundled trailer works without configuration; restart, replay, stop and other scenes have explicit cue lifetimes', t => {
  const store = new StateStore(directory(t));
  const commit = (type, payload) => store.commit({ type, payload }, store.state.revision);
  commit('start-intermission'); assert.equal(store.state.broadcast.intermission.cue, null);
  assert.equal(store.state.broadcast.intermission.videoPath, 'assets/intermission/arcaea-trailer.mp4');
  commit('play-intermission-video');
  assert.equal(store.state.scene, 'arcaea-trailer');
  commit('configure-intermission', options); commit('play-intermission-video');
  const first = store.state.broadcast.intermission.cue;
  assert.deepEqual(new StateStore(path.dirname(store.file)).state.broadcast.intermission.cue, first);
  const oldRevision = store.state.revision;
  commit('play-intermission-video'); assert.notEqual(store.state.broadcast.intermission.cue.id, first.id);
  assert.throws(() => store.commit({ type: 'stop-intermission-video' }, oldRevision), error => error.code === 'STALE');
  assert.ok(store.state.broadcast.intermission.cue, 'A stale stop cannot cancel a newer trailer.');
  const current = store.state.broadcast.intermission.cue;
  commit('configure-intermission', { ...options, resumeTime: '16:00' });
  assert.deepEqual(store.state.broadcast.intermission.cue, current, 'Changing legacy timing metadata does not restart playback.');
  commit('stop-intermission-video'); assert.equal(store.state.broadcast.intermission.cue, null);
  assert.equal(store.state.scene, 'intermission', 'Stopping the separate trailer returns to the illustrated rest page.');
  commit('play-intermission-video'); commit('set-scene', { scene: 'start' });
  assert.equal(store.state.broadcast.intermission.cue, null);
  assert.throws(() => commit('end-intermission'), /no longer on air/);
  commit('set-scene', { scene: 'intermission' }); assert.equal(store.state.broadcast.intermission.cue, null);
  commit('set-scene', { scene: 'arcaea-trailer' }); assert.ok(store.state.broadcast.intermission.cue);
  commit('configure-intermission', { ...options, loop: false }); assert.equal(store.state.broadcast.intermission.cue, null);
  assert.equal(store.state.scene, 'intermission');
});

test('seeded DE resumes on the bracket while older events remain valid without intermission settings', () => {
  const state = createDefaultState(); validateState(state);
  act(state, 'seed-bracket', { ids: state.qualifier.players.map(p => p.id), verified: true });
  const before = structuredClone(state.tournament);
  act(state, 'start-intermission'); act(state, 'end-intermission');
  assert.equal(state.scene, 'bracket'); assert.deepEqual(state.tournament, before); validateState(state);
});

test('invalid media paths and times are rejected without changing state or creating snapshots', t => {
  const store = new StateStore(directory(t)), before = structuredClone(store.state);
  const invalid = [
    ...['https://example.test/a.mp4', '../a.mp4', 'assets/intermission/../a.mp4', 'assets/intermission/a.mp4?x=1', 'assets/intermission/a.mp4\n', 'assets/intermission/a.svg'].map(videoPath => ({ ...options, videoPath })),
    ...['25:00', '15:60', 'tomorrow', null].map(resumeTime => ({ ...options, resumeTime })), { ...options, loop: 'yes' }
  ];
  for (const payload of invalid) assert.throws(() => store.commit({ type: 'configure-intermission', payload }, store.state.revision));
  assert.deepEqual(store.state, before); assert.deepEqual(store.listBackups(), []);
});

test('only main control can upload and configure trailers; uploads support range playback and do not silently change on-air settings', async t => {
  const app = createBroadcastServer({ dataDir: directory(t), pin: 'break-main-fixture', scorekeeperPin: 'break-score-fixture' });
  t.after(() => app.close()); const address = await app.listen(0, '127.0.0.1'), base = `http://127.0.0.1:${address.port}`;
  const pair = async role => (await (await fetch(base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, pin: role === 'control' ? 'break-main-fixture' : 'break-score-fixture' }) })).json()).token;
  const control = await pair('control'), scorer = await pair('scorekeeper');
  const post = (body, token, type = 'video/mp4') => fetch(base + '/api/intermission/video', { method: 'POST', headers: { 'Content-Type': type,
    ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body });
  assert.equal((await post(mp4)).status, 401); assert.equal((await post(mp4, scorer)).status, 403);
  assert.equal((await post(Buffer.from('not a video'), control)).status, 415);
  assert.equal((await post(mp4, control, 'image/svg+xml')).status, 415);
  const uploaded = await post(mp4, control); assert.equal(uploaded.status, 200);
  const result = await uploaded.json(); assert.equal(Intermission.safePath(result.videoPath), true); assert.equal(result.bytes, mp4.length);
  assert.equal(app.store.state.revision, 0); assert.equal(app.store.state.broadcast.intermission, undefined);
  const response = await fetch(base + '/' + result.videoPath, { headers: { Range: 'bytes=4-7' } });
  assert.equal(response.status, 206); assert.equal(Buffer.from(await response.arrayBuffer()).toString(), 'ftyp');
  const socket = io(base + '/scorekeeper', { transports: ['websocket'], auth: { token: scorer }, forceNew: true });
  t.after(() => socket.disconnect()); await once(socket, 'state');
  const rejected = await new Promise(resolve => socket.emit('command', { expectedRevision: 0,
    action: { type: 'configure-intermission', payload: { ...options, videoPath: result.videoPath } } }, resolve));
  assert.equal(rejected.code, 'FORBIDDEN'); assert.equal(app.store.state.revision, 0);
  const files = fs.readdirSync(path.join(path.dirname(app.store.file), 'media', 'intermission'));
  assert.equal(files.length, 1); assert.ok(files.every(name => !name.endsWith('.tmp')));
});

test('oversized chunked and interrupted uploads clean temporary bytes and leave the media endpoint usable', async t => {
  const media = createIntermissionMedia(directory(t), { maxBytes: 32 });
  const server = http.createServer(async (req, res) => {
    try { const value = await media.upload(req); res.end(JSON.stringify(value)); }
    catch (error) { req.resume(); if (!res.destroyed) { res.statusCode = error.status || 400; res.end(error.message); } }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { media.close(); server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const tooLarge = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: Buffer.alloc(33) });
  assert.equal(tooLarge.status, 413);
  const chunked = await new Promise((resolve, reject) => {
    const req = http.request(base, { method: 'POST', headers: { 'Content-Type': 'video/mp4' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write(mp4); req.end(Buffer.alloc(32));
  });
  assert.equal(chunked, 413);
  const valid = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: mp4 });
  assert.equal(valid.status, 200);
  assert.equal(fs.readdirSync(media.directory).length, 1);
  const request = http.request(base, { method: 'POST', headers: { 'Content-Type': 'video/mp4' } });
  request.on('error', () => {}); request.write(mp4);
  await new Promise(resolve => setTimeout(resolve, 30)); request.destroy();
  for (let i = 0; i < 50 && fs.readdirSync(media.directory).some(name => name.endsWith('.tmp')); i++)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.readdirSync(media.directory).length, 1);
});
