const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StateStore, validateState } = require('../lib/store');
const { createDefaultState } = require('./helpers/legacy-state');
const { applyAction, CURRENT_MATCH_ACTIONS } = require('../lib/tournament');
const { createBroadcastServer } = require('../server');
const { finalCandidates } = require('./helpers/song-library');

function fixture(t, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-backup-index-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new StateStore(dir, options) };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function act(state, type, payload = {}) {
  applyAction(state, { type, payload: CURRENT_MATCH_ACTIONS.has(type) ? { matchId: state.tournament.currentMatchId, ...payload } : payload });
}
function choose(state, id) {
  act(state, 'select-match', { matchId: id });
  if (id === 'GF') {
    const ids = finalCandidates(state);
    act(state, 'set-final-candidates', { ids });
    act(state, 'set-final-picks', { audienceIds: ids.slice(0, 2), hostId: ids[2] });
    act(state, 'reveal-host-song');
  } else {
    act(state, 'draw-candidates');
    for (const playerIndex of [0, 1]) act(state, 'ban-song', { playerIndex, songId: null, confirmed: true });
    act(state, 'pick-songs');
  }
}

test('backup lists and recovery previews count base scores, repeated/pending tiebreak scores and confirmations separately', async t => {
  const { store } = fixture(t), state = createDefaultState();
  act(state, 'set-qualifier-plan', { plan: 'A' });
  for (const [index, id] of state.qualifier.rounds.A.playerIds.entries()) for (let songIndex = 0; songIndex < 3; songIndex++) {
    act(state, 'set-qualifier-score', { playerId: id, songIndex,
      score: index === 4 ? 900000 : [990000, 980000, 970000, 900000, 900000, 800000, 700000, 600000][index],
      judgements: { accuracy: 99 } });
  }
  for (let index = 0; index < 3; index++) {
    act(state, 'draw-qualifier-tiebreak', { group: 'A', playerIds: ['p4', 'p5'] });
    act(state, 'set-qualifier-tiebreak-score', { group: 'A', index, playerId: 'p4', score: 0, judgements: { accuracy: 0 } });
    if (index < 2) {
      act(state, 'set-qualifier-tiebreak-score', { group: 'A', index, playerId: 'p5', score: 0, judgements: { accuracy: 0 } });
      act(state, 'confirm-qualifier-tiebreak', { group: 'A', index, verified: true });
    }
  }
  act(state, 'seed-bracket', { ids: state.qualifier.players.map(player => player.id), ruleset: 'proposal-2026',
    note: 'ACA verified a test seeding override.', verified: true });
  choose(state, 'W1');
  for (const playerIndex of [0, 1]) for (let songIndex = 0; songIndex < 2; songIndex++) {
    act(state, 'set-match-score', { playerIndex, songIndex, score: 900000, judgements: { accuracy: 99 } });
  }
  act(state, 'draw-match-tiebreak');
  for (const playerIndex of [0, 1]) act(state, 'set-match-tiebreak-score', { index: 0, playerIndex, score: 0, judgements: { accuracy: 0 } });
  act(state, 'confirm-match-tiebreak', { index: 0, verified: true });
  act(state, 'draw-match-tiebreak');
  act(state, 'set-match-tiebreak-score', { index: 1, playerIndex: 0, score: 0, judgements: { accuracy: 0 } });
  validateState(state);
  const id = store.saveBackup(state), preview = store.previewBackup(id);
  const expected = { qualifierBaseScoredSlots: 24, qualifierTiebreakScoredSlots: 5, qualifierConfirmedTiebreaks: 2,
    matchBaseScoredSlots: 4, matchTiebreakScoredSlots: 3, matchConfirmedTiebreaks: 1,
    qualifierScoredSlots: 29, matchScoredSlots: 7, scoredSlots: 36, confirmedTiebreaks: 3 };
  for (const summary of [preview, store.listBackups()[0], (await store.listBackupsAsync())[0]]) {
    for (const [key, value] of Object.entries(expected)) assert.equal(summary[key], value, key);
    assert.equal('library' in summary, false);
    assert.equal('auditLog' in summary, false);
  }
  assert.equal(preview.matchResults.length, 0);
});

test('unchanged snapshots use indexed summaries; external edits, corruptions and deletions invalidate only affected entries', async t => {
  const { store } = fixture(t);
  store.commit({ type: 'set-event', payload: { venue: 'FIRST' } }, 0);
  const originalScan = store.scanBackupsOffThread.bind(store), validated = [];
  t.mock.method(store, 'scanBackupsOffThread', async () => {
    const result = await originalScan(); validated.push(result.validatedFiles); return result;
  });
  let backups = await store.listBackupsAsync(); assert.equal(backups.length, 1); assert.equal(validated.at(-1), 0);
  backups[0].eventTitle = 'Caller mutation';
  assert.notEqual((await store.listBackupsAsync())[0].eventTitle, 'Caller mutation'); assert.equal(validated.at(-1), 0);
  const first = backups[0].id, firstPath = path.join(store.backupDir, first);
  fs.writeFileSync(firstPath, '{');
  assert.deepEqual(await store.listBackupsAsync(), []); assert.equal(validated.at(-1), 1);
  assert.deepEqual(await store.listBackupsAsync(), []); assert.equal(validated.at(-1), 0);
  const valid = createDefaultState(); valid.event.title = 'Repaired external snapshot';
  fs.writeFileSync(firstPath, JSON.stringify(valid));
  const fixedTime = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(firstPath, fixedTime, fixedTime);
  assert.equal((await store.listBackupsAsync())[0].eventTitle, valid.event.title); assert.equal(validated.at(-1), 1);
  const originalSize = fs.statSync(firstPath).size;
  valid.event.title = 'T' + valid.event.title.slice(1);
  fs.writeFileSync(firstPath, JSON.stringify(valid));
  fs.utimesSync(firstPath, fixedTime, fixedTime);
  assert.equal(fs.statSync(firstPath).size, originalSize);
  assert.equal(fs.statSync(firstPath).mtime.toISOString(), fixedTime.toISOString());
  assert.equal((await store.listBackupsAsync())[0].eventTitle, valid.event.title, 'same-sized edits preserving mtime are invalidated by ctime');
  assert.equal(validated.at(-1), 1);
  const second = store.saveBackup(store.state);
  assert.equal((await store.listBackupsAsync()).length, 2); assert.equal(validated.at(-1), 0);
  fs.unlinkSync(firstPath);
  assert.deepEqual((await store.listBackupsAsync()).map(backup => backup.id), [second]);
  // Cached summaries are never used as the authority for a restore.
  fs.writeFileSync(path.join(store.backupDir, second), '{}');
  const before = structuredClone(store.state);
  assert.throws(() => store.restore(second, store.state.revision, 'Referee reviewed the selected snapshot'), /damaged/);
  assert.deepEqual(store.state, before);
  assert.deepEqual(await store.listBackupsAsync(), []);
});

test('cold scans validate external snapshots once and cache damaged files without hiding repaired files', async t => {
  const { dir, store } = fixture(t);
  const good = store.saveBackup(store.state), bad = 'revision-000000000001-1999999999999-deadbeef.json';
  fs.writeFileSync(path.join(store.backupDir, bad), '{');
  const fresh = new StateStore(dir), original = fresh.scanBackupsOffThread.bind(fresh), validations = [];
  t.mock.method(fresh, 'scanBackupsOffThread', async () => { const result = await original(); validations.push(result.validatedFiles); return result; });
  assert.deepEqual((await fresh.listBackupsAsync()).map(backup => backup.id), [good]); assert.equal(validations.at(-1), 2);
  assert.deepEqual((await fresh.listBackupsAsync()).map(backup => backup.id), [good]); assert.equal(validations.at(-1), 0);
  const saved = structuredClone(store.state); saved.revision = 1;
  fs.writeFileSync(path.join(store.backupDir, bad), JSON.stringify(saved));
  assert.deepEqual((await fresh.listBackupsAsync()).map(backup => backup.id), [bad, good]); assert.equal(validations.at(-1), 1);
});

test('a save and retention pruning during a shared in-flight scan cannot publish a stale backup directory', async t => {
  const { store } = fixture(t, { backupLimit: 1 });
  store.commit({ type: 'set-event', payload: { venue: 'FIRST' } }, 0);
  const scanned = deferred(), release = deferred(), original = store.scanBackupsOffThread.bind(store);
  let scans = 0;
  t.mock.method(store, 'scanBackupsOffThread', async () => {
    const result = await original(); scans++;
    if (scans === 1) { scanned.resolve(); await release.promise; }
    return result;
  });
  const one = store.listBackupsAsync(), two = store.listBackupsAsync();
  await scanned.promise;
  store.commit({ type: 'set-event', payload: { venue: 'SECOND' } }, 1);
  release.resolve();
  const [first, second] = await Promise.all([one, two]);
  assert.equal(scans, 1, 'save/prune changes merge into the completed scan without repeating validation'); assert.deepEqual(first, second);
  assert.deepEqual(first.map(backup => backup.revision), [1]);
  assert.deepEqual(first.map(backup => backup.id), fs.readdirSync(store.backupDir));
});

test('merging command snapshots preserves worker findings about external corruption and deletion', async t => {
  const { store } = fixture(t);
  const corrupt = store.saveBackup(store.state), removed = store.saveBackup(store.state);
  fs.writeFileSync(path.join(store.backupDir, corrupt), '{');
  fs.unlinkSync(path.join(store.backupDir, removed));
  const scanned = deferred(), release = deferred(), original = store.scanBackupsOffThread.bind(store);
  t.mock.method(store, 'scanBackupsOffThread', async () => {
    const result = await original(); scanned.resolve(); await release.promise; return result;
  });
  const listing = store.listBackupsAsync();
  await scanned.promise;
  const saved = store.saveBackup(store.state);
  release.resolve();
  assert.deepEqual((await listing).map(backup => backup.id), [saved]);
  assert.equal(store._backupCache.get(corrupt).summary, null);
  assert.equal(store._backupCache.has(removed), false);
});

test('a newer synchronous full scan takes precedence over an older in-flight worker directory view', async t => {
  const { store } = fixture(t), old = store.saveBackup(store.state);
  const scanned = deferred(), release = deferred(), original = store.scanBackupsOffThread.bind(store);
  t.mock.method(store, 'scanBackupsOffThread', async () => {
    const result = await original(); scanned.resolve(); await release.promise; return result;
  });
  const listing = store.listBackupsAsync();
  await scanned.promise;
  fs.writeFileSync(path.join(store.backupDir, old), '{');
  const fresh = store.saveBackup(store.state);
  assert.deepEqual(store.listBackups().map(backup => backup.id), [fresh]);
  const newest = store.saveBackup(store.state);
  release.resolve();
  assert.deepEqual(new Set((await listing).map(backup => backup.id)), new Set([fresh, newest]));
  assert.equal(store._backupCache.get(old).summary, null);
});

test('failed asynchronous scans reject shared readers and allow a later refresh', async t => {
  const { store } = fixture(t), original = store.scanBackupsOffThread.bind(store);
  let fail = true;
  t.mock.method(store, 'scanBackupsOffThread', async () => {
    if (fail) throw new Error('Fixture worker failure');
    return original();
  });
  const results = await Promise.allSettled([store.listBackupsAsync(), store.listBackupsAsync()]);
  assert.ok(results.every(result => result.status === 'rejected' && /Fixture worker failure/.test(result.reason.message)));
  fail = false;
  assert.deepEqual(await store.listBackupsAsync(), []);
});

test('a cold 500-snapshot HTTP listing completes during continuous score saves without repeating the full scan', { timeout: 30000 }, async t => {
  const { dir, store } = fixture(t), state = createDefaultState();
  state.library = Array.from({ length: 500 }, (_, index) => ({ ...state.library[0], id: `song-${index + 1}`,
    title: `Local catalog chart ${index + 1}`, artist: 'Artist / composer name' }));
  for (let revision = 0; revision < 500; revision++) {
    state.revision = revision;
    fs.writeFileSync(path.join(store.backupDir, `revision-${String(revision).padStart(12, '0')}-1999999999999-deadbeef.json`), JSON.stringify(state));
  }
  store.write(state);
  const app = createBroadcastServer({ dataDir: dir, pin: 'live-backup-main-dummy', scorekeeperPin: 'live-backup-scorer-dummy' });
  t.after(() => app.close());
  const address = await app.listen(0, '127.0.0.1'), url = `http://127.0.0.1:${address.port}`;
  const { token } = await (await fetch(url + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: 'live-backup-main-dummy' }) })).json();
  const started = deferred(), original = app.store.scanBackupsOffThread.bind(app.store);
  let scans = 0, writes = 0, listedRevision, listedFiles;
  t.mock.method(app.store, 'scanBackupsOffThread', () => { scans++; started.resolve(); return original(); });
  const originalList = app.store.listBackupsAsync.bind(app.store);
  t.mock.method(app.store, 'listBackupsAsync', () => originalList().then(backups => {
    // Compare the response with the directory at publication; score saves legitimately
    // continue while the HTTP response is travelling back to the client.
    listedRevision = app.store.state.revision;
    listedFiles = fs.readdirSync(app.store.backupDir);
    return backups;
  }));
  const listing = fetch(url + '/api/backups', { headers: { Authorization: 'Bearer ' + token } }).then(async response => {
    assert.equal(response.status, 200); return response.json();
  });
  await started.promise;
  const saveScore = () => {
    writes++;
    app.store.commit({ type: 'set-qualifier-score', payload: { playerId: 'p1', songIndex: 0, score: 900000 + writes } }, app.store.state.revision);
  };
  // Force mutations within the cold scan, then keep scoring until the HTTP response.
  saveScore(); saveScore();
  const timer = setInterval(saveScore, 20);
  t.after(() => clearInterval(timer));
  const result = await listing;
  assert.ok(writes >= 2);
  assert.equal(scans, 1, 'continuous saves do not restart full validation');
  assert.equal(timer.hasRef(), true, 'the listing completes before the continuous score writer is stopped');
  clearInterval(timer);
  assert.equal(result.backups.length, 500);
  assert.equal(result.backups[0].revision, listedRevision - 1);
  assert.deepEqual(new Set(result.backups.map(backup => backup.id)), new Set(listedFiles));
});

test('a cold 500-snapshot HTTP scan leaves timers and health requests responsive before listing completes', { timeout: 30000 }, async t => {
  const { dir, store } = fixture(t), state = createDefaultState();
  act(state, 'set-competition-roster', { names: Array.from({ length: 30 }, (_, index) => `Entrant ${index + 1}`) });
  act(state, 'set-qualifier-plan', { plan: 'auto' });
  state.library = Array.from({ length: 500 }, (_, index) => ({ ...state.library[0], id: `song-${index + 1}`,
    title: `Complete local catalog chart ${index + 1}`, artist: 'Artist / composer name' }));
  for (const group of ['A', 'B']) for (const [index, playerId] of state.qualifier.rounds[group].playerIds.entries()) {
    for (let songIndex = 0; songIndex < 3; songIndex++) act(state, 'set-qualifier-score', {
      group, playerId, songIndex, score: 990000 - index * 1000, judgements: { accuracy: 99, perfect: 1000, good: 3, bad: 0, miss: 0 }
    });
  }
  act(state, 'qualify', { verified: true });
  for (const id of state.tournament.matches.map(match => match.id)) {
    choose(state, id);
    for (const playerIndex of [0, 1]) for (let songIndex = 0; songIndex < (id === 'GF' ? 3 : 2); songIndex++) {
      act(state, 'set-match-score', { playerIndex, songIndex, score: 990000 - playerIndex * 1000,
        judgements: { accuracy: 99, perfect: 1000, good: 3, bad: 0, miss: 0 } });
    }
    act(state, 'record-result', { verified: true });
  }
  validateState(state);
  for (let revision = 0; revision < 500; revision++) {
    state.revision = revision;
    const id = `revision-${String(revision).padStart(12, '0')}-1999999999999-deadbeef.json`;
    fs.writeFileSync(path.join(store.backupDir, id), JSON.stringify(state));
  }
  store.write(state);
  const app = createBroadcastServer({ dataDir: dir, pin: 'backup-main-dummy', scorekeeperPin: 'backup-scorer-dummy' });
  t.after(() => app.close());
  const address = await app.listen(0, '127.0.0.1'), url = `http://127.0.0.1:${address.port}`;
  const pairing = await (await fetch(url + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: 'backup-main-dummy' }) })).json();
  const started = deferred(), original = app.store.scanBackupsOffThread.bind(app.store);
  let validatedFiles = 0;
  t.mock.method(app.store, 'scanBackupsOffThread', () => {
    started.resolve();
    return original().then(result => { validatedFiles += result.validatedFiles; return result; });
  });
  let complete = false;
  const listing = fetch(url + '/api/backups', { headers: { Authorization: 'Bearer ' + pairing.token } })
    .then(async response => { const body = await response.json(); complete = true; assert.equal(response.status, 200); return body; });
  await started.promise;
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(complete, false, 'a main-thread timer runs while the cold scan is still working');
  const health = await (await fetch(url + '/api/health')).json();
  assert.equal(health.ok, true);
  assert.equal(complete, false, 'health is served before all 500 snapshots have been parsed and validated');
  const result = await listing;
  assert.equal(result.backups.length, 500); assert.equal(validatedFiles, 500);
  assert.deepEqual(result.backups.map(backup => backup.revision), Array.from({ length: 500 }, (_, index) => 499 - index));
});
