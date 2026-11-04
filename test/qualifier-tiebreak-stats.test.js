const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StateStore } = require('../lib/store');
const { scorekeeperState, scorekeeperAction } = require('../lib/scorekeeper');
const { publicState } = require('../lib/tournament');
const { validateState } = require('../lib/state-validation');
const ScoreRules = require('../public/js/score-rules');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qualifier-tiebreak-stats-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new StateStore(dir), command = (type, payload) => store.commit({ type, payload }, store.state.revision);
  command('set-qualifier-plan', { plan: 'A' });
  [2970000, 2940000, 2910000, 2700000, 2700000, 2400000, 2100000, 1800000].forEach((total, index) =>
    command('set-qualifier-total', { group: 'A', playerId: `p${index + 1}`, total }));
  command('draw-qualifier-tiebreak', { group: 'A', playerIds: ['p4', 'p5'] });
  const score = (playerId, value, judgements) => {
    const view = scorekeeperState(store.state);
    const action = scorekeeperAction(store.state, { contextKey: view.contextKey, action: {
      type: 'set-qualifier-tiebreak-score', payload: { group: 'A', index: 0, playerId, score: value, judgements }
    } });
    return store.commit(action, store.state.revision);
  };
  return { dir, store, command, score };
}

test('Challenge tiebreak counts survive scorer submission, restart, export, backup and arbiter correction', t => {
  const f = fixture(t), counts = { perfect: 890, good: 12, bad: 1, miss: 0 };
  f.score('p4', 990000, counts);
  f.score('p5', 0, { perfect: 0, good: 0, bad: 0, miss: 0 });
  const tie = f.store.state.qualifier.rounds.A.tiebreaks[0];
  assert.deepEqual(tie.judgements.p4, counts);
  assert.deepEqual(scorekeeperState(f.store.state).qualifier.tiebreak.players[0].judgements, [counts]);
  assert.equal(scorekeeperState(f.store.state).qualifier.tiebreak.players[0].accuracy, null);
  assert.deepEqual(publicState(f.store.state).qualifier.rounds.A.tiebreaks[0].judgements.p4, counts);
  const backup = f.store.saveBackup(f.store.state), restarted = new StateStore(f.dir);
  assert.deepEqual(restarted.state.qualifier.rounds.A.tiebreaks[0], tie);
  assert.equal(restarted.previewBackup(backup).qualifierTiebreakScoredSlots, 2);
  f.command('confirm-qualifier-tiebreak', { group: 'A', index: 0, verified: true });
  assert.equal(f.store.state.qualifier.rounds.A.results.p4.challengeTotal, 2700000);
  f.command('set-qualifier-total', { group: 'A', playerId: 'p4', total: 2700001, verified: true,
    confirmClearTiebreaks: true, reason: 'Arbiter checked the original result screen.' });
  assert.deepEqual(f.store.state.qualifier.adjudications.at(-1).invalidatedTiebreaks[0].judgements.p4, counts);
  validateState(new StateStore(f.dir).state);
});

test('partial, negative, fractional and unsafe Challenge tiebreak counts cannot change saved scores', t => {
  const f = fixture(t), valid = { perfect: 900, good: 1, bad: 0, miss: 0 };
  f.score('p4', 990000, valid);
  for (const bad of [{}, { perfect: 900 }, { ...valid, good: -1 }, { ...valid, bad: .5 },
    { ...valid, miss: '0' }, { ...valid, perfect: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, accuracy: null }]) {
    const before = fs.readFileSync(f.store.file, 'utf8'), revision = f.store.state.revision;
    assert.throws(() => f.score('p4', 980000, bad));
    assert.equal(fs.readFileSync(f.store.file, 'utf8'), before);
    assert.equal(f.store.state.revision, revision);
    const damaged = structuredClone(f.store.state);
    damaged.qualifier.rounds.A.tiebreaks[0].judgements.p4 = bad;
    assert.throws(() => validateState(damaged), /Damaged state/);
  }
});

test('count-only support never invents accuracy or weakens ordinary match accuracy validation', () => {
  const counts = { perfect: 900, good: 1, bad: 0, miss: 0 };
  assert.deepEqual(ScoreRules.normaliseJudgements(counts, { allowMissingAccuracy: true }), counts);
  assert.equal(ScoreRules.meanAccuracy([counts]), null);
  assert.throws(() => ScoreRules.normaliseJudgements(counts), /Accuracy/);
  assert.equal(ScoreRules.compare([990000], [990000], [counts], [counts]).reason, 'missing-accuracy');
});
