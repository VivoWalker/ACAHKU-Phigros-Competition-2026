const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { createBroadcastServer } = require('../server');
const { getBranding } = require('../lib/branding');
const { createBracket, resolveBracket } = require('../lib/tournament');
function waitEvent(socket, name, timeout = 6000) { return new Promise((resolve, reject) => { const timer = setTimeout(() => { socket.off(name, handler); reject(new Error('Timed out: ' + name)); }, timeout); function handler(value) { clearTimeout(timer); resolve(value); } socket.once(name, handler); }); }
async function pair(url) { const r = await fetch(url + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: 'fixture-code' }) }); return (await r.json()).token; }
test('HTTP pages and authenticated live updates, reconnect and process restart retain state and privacy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-server-')); let app, control, overlay, unpaired;
  try {
    app = createBroadcastServer({ dataDir: dir, pin: 'fixture-code' }); const address = await app.listen(0, '127.0.0.1'); let url = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(url + '/api/health')).status, 200);
    const brandingResponse = await fetch(url + '/api/branding');
    assert.equal(brandingResponse.status, 200);
    const brandingJson = await brandingResponse.json();
    assert.deepEqual(Object.keys(brandingJson).sort(), ['kiramekiLogo', 'logo', 'socLogo', 'visual']);
    assert.deepEqual(brandingJson, getBranding());
    assert.equal((await fetch(url + '/api/control-state')).status, 401);
    assert.equal((await fetch(url + '/data/match-state.json')).status, 404);
    for (const page of ['start', 'qualifier-waiting', 'double-elimination-waiting', 'qualifier-match', 'double-elimination-match', 'result', 'bracket', 'song-selection']) {
      const r = await fetch(url + '/overlay/' + page + '.html'); assert.equal(r.status, 200); assert.match(await r.text(), new RegExp(`data-scene="${page}"`));
    }
    assert.equal((await fetch(url + '/control/')).status, 200);
    assert.equal((await fetch(url + '/assets/fonts/saira-latin-400-normal.woff2')).status, 200);
    const token = await pair(url); assert.ok(token);
    unpaired = io(url + '/control', { reconnection: false, forceNew: true }); const error = await waitEvent(unpaired, 'connect_error'); assert.equal(error.message, 'PAIRING_REQUIRED'); unpaired.close();
    control = io(url + '/control', { auth: { token }, forceNew: true }); let state = await waitEvent(control, 'state');
    overlay = io(url + '/overlay', { forceNew: true }); await waitEvent(overlay, 'state');
    const updated = waitEvent(overlay, 'state');
    const ack = await new Promise(resolve => control.emit('command', { expectedRevision: state.revision, action: { type: 'set-event', payload: { venue: 'LIVE TEST' } } }, resolve));
    assert.equal(ack.ok, true); assert.equal((await updated).event.venue, 'LIVE TEST');
    const stale = await new Promise(resolve => control.emit('command', { expectedRevision: 0, action: { type: 'set-scene', payload: { scene: 'result' } } }, resolve));
    assert.equal(stale.ok, false); assert.equal(stale.code, 'STALE');
    const recovered = waitEvent(overlay, 'state'); overlay.io.engine.close(); assert.equal((await recovered).event.venue, 'LIVE TEST');
    // A private MC pick must never reach HTTP public state or the overlay namespace.
    app.store.state.tournament = createBracket(app.store.state.qualifier.players.map(p => p.id));
    resolveBracket(app.store.state);
    const final = app.store.state.tournament.matches.find(m => m.id === 'GF');
    final.candidates = app.store.state.library.slice(0, 8).map(s => ({ ...s }));
    final.audiencePicks = final.candidates.slice(0, 2).map(s => s.id);
    final.hostPick = { ...final.candidates[2], title: 'PRIVATE SELECTION' };
    final.songs = [{ ...final.candidates[0] }, { ...final.candidates[1] }, final.hostPick];
    app.store.write(app.store.state);
    const publicJson = await (await fetch(url + '/api/state')).json(); assert.equal('hostPick' in publicJson.tournament.matches.at(-1), false); assert.equal(publicJson.tournament.matches.at(-1).songs[2].hidden, true);
    const authJson = await (await fetch(url + '/api/control-state', { headers: { Authorization: 'Bearer ' + token } })).json(); assert.equal(authJson.tournament.matches.at(-1).hostPick.title, 'PRIVATE SELECTION');
    const publicSocket = waitEvent(overlay, 'state'); overlay.io.engine.close(); assert.equal((await publicSocket).tournament.matches.at(-1).songs[2].hidden, true);
    const port = address.port; await app.close(); app = createBroadcastServer({ dataDir: dir, pin: 'fixture-code' });
    const restored = waitEvent(control, 'state', 10000); await app.listen(port, '127.0.0.1');
    assert.equal((await restored).event.venue, 'LIVE TEST'); assert.equal((await fetch(url + '/api/control-state', { headers: { Authorization: 'Bearer ' + token } })).status, 200);
    assert.equal(app.store.state.revision, 1);
  } finally { control?.close(); overlay?.close(); unpaired?.close(); if (app) await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('backup APIs require pairing, preview metadata, reject stale restores and publish restored state without private picks or audit reasons', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-recovery-api-'));
  const app = createBroadcastServer({ dataDir: dir, pin: 'fixture-code' }); let control, overlay;
  t.after(async () => { control?.close(); overlay?.close(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const address = await app.listen(0, '127.0.0.1'), url = `http://127.0.0.1:${address.port}`;
  for (const endpoint of ['/api/backups', '/api/backups/unknown/preview', '/api/result-correction/W1']) assert.equal((await fetch(url + endpoint)).status, 401);
  assert.equal((await fetch(url + '/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  const token = await pair(url), headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  app.store.commit({ type: 'set-event', payload: { venue: 'UPDATED VENUE' } }, 0);
  const listing = await (await fetch(url + '/api/backups', { headers })).json(); assert.equal(listing.backups.length, 1);
  const id = listing.backups[0].id, preview = await (await fetch(url + '/api/backups/' + id + '/preview', { headers })).json();
  assert.equal(preview.revision, 0); assert.equal(preview.event.venue, 'UG201'); assert.equal('library' in preview, false);
  const restore = (body) => fetch(url + '/api/restore', { method: 'POST', headers, body: JSON.stringify(body) });
  const stale = await restore({ backupId: id, expectedRevision: 0, reason: 'Referee review' }); assert.equal(stale.status, 409); assert.equal((await stale.json()).code, 'STALE');
  assert.equal((await restore({ backupId: id, expectedRevision: 1, reason: '' })).status, 400); assert.equal(app.store.state.event.venue, 'UPDATED VENUE');
  control = io(url + '/control', { auth: { token }, forceNew: true }); assert.ok((await waitEvent(control, 'state')).broadcast.sourceStatus);
  overlay = io(url + '/overlay', { forceNew: true }); await waitEvent(overlay, 'state');
  const controlUpdate = waitEvent(control, 'state'), publicUpdate = waitEvent(overlay, 'state');
  const success = await restore({ backupId: id, expectedRevision: 1, reason: 'Referee rollback confidential' }); assert.equal(success.status, 200); assert.equal((await success.json()).revision, 2);
  assert.equal((await controlUpdate).event.venue, 'UG201'); const published = await publicUpdate;
  assert.equal(published.event.venue, 'UG201'); assert.equal('auditLog' in published, false); assert.equal('recovery' in published, false);
  assert.equal(JSON.stringify(published).includes('Referee rollback confidential'), false);
  assert.equal(app.store.listBackups()[0].revision, 1);
  assert.equal((await fetch(url + '/api/result-correction/unknown', { headers })).status, 400);

  // A complete schema-1 tournament retains the staff-only final choice when restoring a snapshot.
  app.store.state.tournament = createBracket(app.store.state.qualifier.players.map(p => p.id)); resolveBracket(app.store.state);
  const gf = app.store.state.tournament.matches.at(-1);
  gf.candidates = app.store.state.library.slice(0, 8).map(song => ({ ...song })); gf.audiencePicks = gf.candidates.slice(0, 2).map(song => song.id);
  gf.hostPick = { ...gf.candidates[2], title: 'PRIVATE RESTORE PICK' }; gf.songs = [gf.candidates[0], gf.candidates[1], gf.hostPick]; app.store.write(app.store.state);
  const privateBackup = app.store.saveBackup(app.store.state);
  app.store.commit({ type: 'set-event', payload: { venue: 'AFTER PRIVATE BACKUP' } }, 2);
  const privatePreview = await (await fetch(url + '/api/backups/' + privateBackup + '/preview', { headers })).json(); assert.equal(JSON.stringify(privatePreview).includes('PRIVATE RESTORE PICK'), false);
  const restoredPublic = waitEvent(overlay, 'state'); assert.equal((await restore({ backupId: privateBackup, expectedRevision: 3, reason: 'Restore verified final choices' })).status, 200);
  const publicState = await restoredPublic; assert.equal(publicState.tournament.matches.at(-1).songs[2].hidden, true); assert.equal(JSON.stringify(publicState).includes('PRIVATE RESTORE PICK'), false);
  assert.equal(app.store.state.tournament.matches.at(-1).hostPick.title, 'PRIVATE RESTORE PICK'); assert.equal(app.store.state.revision, 4);
  const command = (type, payload = {}) => app.store.commit({ type, payload }, app.store.state.revision);
  command('select-match', { matchId: 'W1' }); command('draw-candidates', { matchId: 'W1' });
  const candidates = app.store.state.tournament.matches[0].candidates;
  command('ban-song', { matchId: 'W1', playerIndex: 0, songId: candidates[0].id }); command('ban-song', { matchId: 'W1', playerIndex: 1, songId: candidates[1].id }); command('pick-songs', { matchId: 'W1' });
  for (const playerIndex of [0, 1]) for (const songIndex of [0, 1]) command('set-match-score', { matchId: 'W1', playerIndex, songIndex, score: playerIndex === 0 ? 990000 : 980000 });
  command('record-result', { matchId: 'W1' });
  const correctionResponse = await fetch(url + '/api/result-correction/W1', { headers }); assert.equal(correctionResponse.status, 200);
  const correction = await correctionResponse.json(); assert.equal(correction.revision, app.store.state.revision); assert.equal(correction.impact.matchId, 'W1'); assert.ok(correction.impact.affectedMatchIds.includes('GF'));
  const latestRevision = app.store.state.revision;
  fs.writeFileSync(path.join(app.store.backupDir, privateBackup), '{');
  assert.equal((await restore({ backupId: privateBackup, expectedRevision: latestRevision, reason: 'Referee review' })).status, 400); assert.equal(app.store.state.revision, latestRevision);
});
module.exports = { waitEvent };
