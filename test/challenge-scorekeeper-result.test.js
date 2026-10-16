const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDefaultState } = require('../lib/default-state');
const { applyAction, publicState } = require('../lib/tournament');
const { validateState } = require('../lib/state-validation');
const { StateStore } = require('../lib/store');
const { scorekeeperState, scorekeeperAction } = require('../lib/scorekeeper');
const Q = require('../public/js/qualifier-rules');

const stats = (score = 990000) => ({ score, perfect: 800, good: 12, bad: 1, miss: 0 });
const payload = (extra = {}) => ({ group: 'A', playerId: 'p1', total: 2970000,
  songStats: [stats(), stats(), stats()], ...extra });
const action = body => ({ type: 'set-qualifier-challenge-result', payload: body });
const request = (state, body, contextKey = scorekeeperState(state).contextKey) => ({ contextKey, action: action(body) });
function fixture() {
  const state = createDefaultState();
  applyAction(state, { type: 'set-qualifier-plan', payload: { plan: 'A' } }); validateState(state);
  return state;
}

test('one Challenge result records all three scores and judgement counts without accuracy, preserving the official total', () => {
  const state = fixture(), initialKey = scorekeeperState(state).contextKey;
  const evidence = [stats(987654), stats(976543), stats(965432)], official = 2929628;
  const cleaned = scorekeeperAction(state, request(state, payload({ total: official, songStats: evidence,
    verified: true, confirmClearTiebreaks: true, reason: 'PRIVATE ARBITER BYPASS', privateNote: 'PRIVATE' })));
  assert.deepEqual(cleaned, action(payload({ total: official, songStats: evidence })));
  applyAction(state, cleaned); validateState(state);
  const row = Q.result(state, 'A', 'p1');
  assert.deepEqual(row.songStats, evidence); assert.equal(row.songStatsRecorded, true);
  assert.deepEqual(row.scores, [null, null, null]); assert.deepEqual(row.judgements, [null, null, null]);
  assert.equal(row.challengeTotal, official); assert.equal(Q.rankings(state, 'A')[0].total, official);
  assert.notEqual(official, evidence.reduce((sum, song) => sum + song.score, 0), 'Displayed song scores do not replace the official game total');
  assert.equal(scorekeeperState(state).contextKey, initialKey, 'Ordinary result updates preserve other current-player drafts');
  assert.deepEqual(scorekeeperState(state).qualifier.players[0].songStats, evidence);
  assert.deepEqual(publicState(state).qualifier.rounds.A.results.p1.songStats, evidence);
  assert.equal(state.qualifier.scoringStarted, true); assert.equal(state.qualifier.rounds.A.scoringStarted, true);
  assert.equal(JSON.stringify(state).includes('PRIVATE'), false);
});

test('complete Challenge result validation rejects partial or invalid entries before mutating any state', () => {
  const state = fixture(); applyAction(state, action(payload()));
  const bad = [
    { total: null }, { total: '' }, { total: 3000001 }, { total: '2970000' },
    { songStats: [] }, { songStats: [stats(), stats()] }, { songStats: [stats(), stats(), stats(), stats()] },
    { songStats: [stats(), stats(), null] }, { songStats: [stats(), stats(), { ...stats(), miss: undefined }] },
    { songStats: [stats(), stats(), { ...stats(), good: -1 }] }, { songStats: [stats(), stats(), { ...stats(), perfect: 1.5 }] },
    { songStats: [stats(), stats(), { ...stats(), bad: Number.MAX_SAFE_INTEGER + 1 }] },
    { songStats: [stats(), stats(), stats(1000001)] }, { songStats: [stats(), stats(), { ...stats(), privateNote: 'not allowed' }] }
  ];
  for (const change of bad) {
    const before = structuredClone(state), body = payload({ total: 2800000, ...change });
    assert.throws(() => scorekeeperAction(state, request(state, body)));
    assert.throws(() => applyAction(state, action(body)));
    assert.deepEqual(state, before, 'A bad third song cannot overwrite either earlier songs or the official total');
  }
  const zero = { score: 0, perfect: 0, good: 0, bad: 0, miss: 0 };
  applyAction(state, action(payload({ total: 0, songStats: [zero, zero, zero] }))); validateState(state);
  assert.equal(Q.result(state, 'A', 'p1').challengeTotal, 0);
  assert.deepEqual(Q.result(state, 'A', 'p1').songStats, [zero, zero, zero]);
});

test('count-only Challenge result entry retains optional accuracy from main-control corrections and accepts explicit replacement accuracy', () => {
  const state = fixture(), row = Q.result(state, 'A', 'p1');
  row.songStats = [{ ...stats(), accuracy: 99.1234 }, { ...stats(), accuracy: 0 }, null];
  const evidence = [stats(987654), { ...stats(976543), accuracy: 97.6543 }, stats(965432)];
  applyAction(state, scorekeeperAction(state, request(state, payload({ songStats: evidence })))); validateState(state);
  assert.equal(row.songStats[0].accuracy, 99.1234, 'An omitted accuracy must not erase evidence recorded by main control');
  assert.equal(row.songStats[1].accuracy, 97.6543, 'Explicit accuracy replaces the previous value');
  assert.equal(Object.hasOwn(row.songStats[2], 'accuracy'), false, 'No accuracy is invented for count-only records');
  row.songStats[1].accuracy = 0;
  applyAction(state, scorekeeperAction(state, request(state, payload()))); validateState(state);
  assert.equal(row.songStats[1].accuracy, 0, 'An existing zero accuracy is preserved');
});

test('scorekeeper sheets expose only the active batch and invalidate switched-batch drafts while keeping scene/song cursor updates stable', () => {
  const state = fixture(), initial = scorekeeperState(state);
  assert.deepEqual(initial.qualifier.players.map(player => player.id), ['p1', 'p2', 'p3']);
  assert.deepEqual(initial.qualifier.players[0].songStats, [null, null, null]);
  assert.throws(() => scorekeeperAction(state, request(state, payload({ playerId: 'p4' }))), error => error.code === 'FORBIDDEN');
  state.scene = 'qualifier-match'; state.qualifier.currentSong = 2;
  assert.equal(scorekeeperState(state).contextKey, initial.contextKey);
  state.qualifier.activePlayers = ['p4', 'p5', 'p6'];
  assert.deepEqual(scorekeeperState(state).qualifier.players.map(player => player.id), ['p4', 'p5', 'p6']);
  assert.notEqual(scorekeeperState(state).contextKey, initial.contextKey);
  assert.throws(() => scorekeeperAction(state, request(state, payload(), initial.contextKey)), error => error.code === 'CONTEXT_CHANGED');
  assert.throws(() => scorekeeperAction(state, request(state, payload())), error => error.code === 'FORBIDDEN');
  const next = scorekeeperAction(state, request(state, payload({ playerId: 'p4' })));
  applyAction(state, next); assert.equal(Q.result(state, 'A', 'p4').challengeTotal, 2970000);
  const batchKey = scorekeeperState(state).contextKey;
  state.qualifier.activePlayers = ['p6', 'p4', 'p5'];
  assert.deepEqual(scorekeeperState(state).qualifier.players.map(player => player.id), ['p6', 'p4', 'p5'], 'Scoring cards follow current camera slot order');
  assert.notEqual(scorekeeperState(state).contextKey, batchKey, 'Slot-order changes invalidate drafts associated with the former display');
  state.qualifier.activePlayers = [];
  assert.deepEqual(scorekeeperState(state).qualifier.players, []);
  assert.throws(() => scorekeeperAction(state, request(state, payload({ playerId: 'p4' }))), error => error.code === 'FORBIDDEN');
});

test('an active qualifier tiebreak keeps its own participants available and locks every base Challenge result', () => {
  const state = fixture(), q = state.qualifier;
  q.rounds.A.tiebreaks = [{ song: state.library[0], playerIds: ['p4', 'p5'], scores: { p4: null, p5: null }, judgements: { p4: null, p5: null }, confirmed: false }];
  q.activePlayers = ['p1'];
  const view = scorekeeperState(state);
  assert.deepEqual(view.qualifier.players.map(player => player.id), ['p1']);
  assert.deepEqual(view.qualifier.tiebreak.players.map(player => player.id), ['p4', 'p5']);
  const tie = scorekeeperAction(state, { contextKey: view.contextKey, action: { type: 'set-qualifier-tiebreak-score',
    payload: { group: 'A', index: 0, playerId: 'p5', score: 990000 } } });
  assert.equal(tie.payload.playerId, 'p5');
  assert.throws(() => scorekeeperAction(state, request(state, payload())), error => error.code === 'INVALID');
  const before = structuredClone(state); assert.throws(() => applyAction(state, action(payload())), /locked/); assert.deepEqual(state, before);
});

test('complete Challenge results persist atomically through backups and restart; rejected entries create neither revision nor backup', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acahku-challenge-result-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let store = new StateStore(dir);
  store.commit({ type: 'set-qualifier-plan', payload: { plan: 'A' } }, store.state.revision);
  store.commit(scorekeeperAction(store.state, request(store.state, payload())), store.state.revision);
  const disk = fs.readFileSync(store.file, 'utf8'), revision = store.state.revision, backups = fs.readdirSync(store.backupDir).sort();
  assert.throws(() => store.commit(action(payload({ songStats: [stats(1), stats(2), { ...stats(3), miss: -1 }] })), revision));
  assert.equal(store.state.revision, revision); assert.equal(fs.readFileSync(store.file, 'utf8'), disk);
  assert.deepEqual(fs.readdirSync(store.backupDir).sort(), backups);
  store = new StateStore(dir);
  assert.equal(store.state.revision, revision); assert.deepEqual(Q.result(store.state, 'A', 'p1').songStats, payload().songStats);
  assert.equal(scorekeeperState(store.state).qualifier.players[0].challengeTotal, 2970000);
  store.commit(action(payload({ total: 2800000 })), revision);
  const saved = store.listBackups().find(backup => backup.revision === revision);
  assert.ok(saved); assert.deepEqual(Q.result(store.readBackup(saved.id), 'A', 'p1').songStats, payload().songStats);
  assert.throws(() => store.commit({ type: 'set-qualifier-scoring-mode', payload: { mode: 'legacy-score' } }, store.state.revision), /only before/);
});
