const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createDefaultState } = require('../lib/default-state');
const { applyAction, CURRENT_MATCH_ACTIONS, publicState, resultCorrectionImpact } = require('../lib/tournament');
const { validateState } = require('../lib/state-validation');
const { scorekeeperState, scorekeeperAction } = require('../lib/scorekeeper');
const Sequence = require('../public/js/final-sequence');
const Final = require('../public/js/final-announcement');
const Countdown = require('../public/js/countdown');
const CompetitionConfig = require('../public/js/competition-config');
const match = state => state.tournament.matches.find(value => value.id === 'GF');
function act(state, type, payload = {}) {
  const next = structuredClone(state);
  applyAction(next, { type, payload: CURRENT_MATCH_ACTIONS.has(type) ? { matchId: state.tournament.currentMatchId, ...payload } : payload });
  validateState(next); Object.assign(state, next); return state;
}
let fixture;
function ready() {
  if (!fixture) {
    const state = createDefaultState();
    act(state, 'seed-bracket', { ids: state.qualifier.players.map(player => player.id) });
    for (let round = 0; round < 13; round++) {
      const current = state.tournament.matches.find(value => value.id !== 'GF' && ['ready', 'live'].includes(value.status));
      act(state, 'select-match', { matchId: current.id }); act(state, 'draw-candidates');
      for (const playerIndex of [0, 1]) act(state, 'ban-song', { playerIndex, songId: null, confirmed: true });
      act(state, 'pick-songs');
      for (const playerIndex of [0, 1]) for (const songIndex of [0, 1]) act(state, 'set-match-score', { playerIndex, songIndex, score: playerIndex ? 980000 : 990000 });
      act(state, 'record-result', { verified: true });
    }
    act(state, 'select-match', { matchId: 'GF' }); fixture = state;
  }
  return structuredClone(fixture);
}
function firstTwo(state, scores = [[990000, 990000], [980000, 980000]]) {
  for (const playerIndex of [0, 1]) for (const songIndex of [0, 1]) act(state, 'set-match-score', { playerIndex, songIndex, score: scores[playerIndex][songIndex], judgements: { accuracy: playerIndex ? 98 : 99 } });
}
const configure = state => act(state, 'configure-final-finale', {
  song: { title: 'Synthetic final song', artist: 'Test artist', difficulty: 'AT', level: 17 },
  videoPath: 'assets/finale/reveal.mp4', videoDuration: 8.25
});
function sealed() {
  const state = ready(); configure(state); firstTwo(state);
  act(state, 'show-final-two-totals'); act(state, 'start-final-finale'); return state;
}

test('three-song final is optional for old saves, and the shared helper runs without DOM or timers', () => {
  const state = ready(); assert.equal(Sequence.isEnabled(match(state)), false); assert.equal(Sequence.songCount(match(state)), 2);
  configure(state); assert.equal(Sequence.songCount(match(state)), 3); assert.equal(Final.isFixed(match(state)), true);
  assert.deepEqual(Final.audioCue(match(state)), null);
  const sandbox = {}; vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/final-sequence'), 'utf8'), sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.BroadcastFinalSequence.phase(match(state), 1000))), Sequence.phase(match(state), 1000));
});

test('first two totals attach the confirmed AT17 finale without manual entry, and cannot declare a champion', () => {
  const state = ready(); firstTwo(state);
  act(state, 'show-final-two-totals'); assert.equal(state.scene, 'grand-final-totals');
  assert.equal(match(state).songs.length, 3); assert.equal(match(state).status, 'live');
  assert.deepEqual(match(state).finale.song, CompetitionConfig.FINALE_SONG);
  assert.deepEqual(match(state).scores, [[990000, 990000, null], [980000, 980000, null]]);
  assert.deepEqual(state.library.find(song => song.id === CompetitionConfig.FINALE_SONG.id), CompetitionConfig.FINALE_SONG);
  assert.notEqual(state.result.matchId, 'GF');
  assert.throws(() => act(state, 'record-result', { verified: true }), /all three/);
  act(state, 'start-final-finale'); assert.equal(match(state).finale.stage, 'sealed');
  assert.equal(state.scene, 'double-elimination-waiting');
  assert.ok(!JSON.stringify(publicState(state)).includes(CompetitionConfig.FINALE_SONG.title));
  assert.ok(!JSON.stringify(scorekeeperState(state)).includes(CompetitionConfig.FINALE_SONG.title));
  assert.throws(() => act(state, 'play-final-finale-video'), /local reveal video/);
  act(state, 'reveal-final-finale');
  assert.equal(match(publicState(state)).songs[2].title, 'What do you want more than a Happy ending?');
  assert.equal(match(publicState(state)).songs[2].difficulty, 'AT');
  assert.equal(match(publicState(state)).songs[2].level, 17);
  for (const playerIndex of [0, 1]) act(state, 'set-match-score', { playerIndex, songIndex: 2, score: playerIndex ? 999999 : 900000 });
  act(state, 'record-result', { verified: true });
  assert.equal(state.result.winnerId, match(state).players[1]);
  assert.deepEqual(state.result.totals, [2880000, 2959999]);
});

test('video-only configuration uses the confirmed finale and leaves the preset/random pools unchanged', () => {
  assert.equal(CompetitionConfig.FINALE_SONG.title, 'What do you want more than a Happy ending?');
  assert.equal(CompetitionConfig.FINALE_SONG.difficulty, 'AT'); assert.equal(CompetitionConfig.FINALE_SONG.level, 17);
  assert.equal(Object.isFrozen(CompetitionConfig.FINALE_SONG), true);
  assert.equal(CompetitionConfig.LIBRARY.length, 50); assert.equal(CompetitionConfig.DOUBLE_ELIMINATION_SONG_IDS.length, 42);
  assert.ok(!CompetitionConfig.LIBRARY.some(song => song.id === CompetitionConfig.FINALE_SONG.id));
  const state = ready();
  act(state, 'configure-final-finale', { videoPath: 'assets/finale/reveal.mp4', videoDuration: 9.5 });
  assert.deepEqual(match(state).finale.song, CompetitionConfig.FINALE_SONG);
  assert.equal(match(state).finale.videoPath, 'assets/finale/reveal.mp4');
  assert.equal(match(state).finale.videoDuration, 9.5);
  assert.equal(state.library.filter(song => song.eligible).length, 42);
  assert.equal(state.library.filter(song => song.id === CompetitionConfig.FINALE_SONG.id).length, 1);
  firstTwo(state); act(state, 'show-final-two-totals'); act(state, 'start-final-finale');
  act(state, 'play-final-finale-video'); act(state, 'finish-final-finale-video');
  assert.equal(match(state).finale.song.title, CompetitionConfig.FINALE_SONG.title);
});

test('confirmed finale setup preserves custom/scored songs, while completed two-song saves remain two-song saves', () => {
  const custom = sealed(), configured = structuredClone(match(custom).finale.song);
  assert.deepEqual(match(custom).songs[2], configured);
  act(custom, 'reveal-final-finale'); act(custom, 'set-match-score', { playerIndex: 0, songIndex: 2, score: 987654 });
  act(custom, 'set-final-finale-effect', { level: 1 });
  assert.deepEqual(match(custom).finale.song, configured); assert.equal(match(custom).scores[0][2], 987654);
  assert.ok(!custom.library.some(song => song.id === CompetitionConfig.FINALE_SONG.id));
  const old = ready(); firstTwo(old); act(old, 'record-result', { verified: true });
  const saved = JSON.stringify(old); validateState(JSON.parse(saved));
  assert.equal(match(old).songs.length, 2); assert.equal(match(old).finale, undefined);
  assert.equal(match(old).status, 'complete'); assert.deepEqual(old.result.totals, [1980000, 1960000]);
  assert.throws(() => act(old, 'show-final-two-totals'), /complete|completed/i);
  assert.equal(JSON.stringify(old), saved);
});

test('unconfigured in-progress sealed saves adopt the confirmed song only on an explicit continuation', () => {
  for (const stage of ['summary', 'sealed']) {
    const state = ready(); firstTwo(state);
    match(state).finale = { stage, song: null, videoPath: '', videoDuration: 0, effectLevel: 0, effectChangedAt: Date.now() };
    validateState(state); assert.equal(match(state).songs.length, 2);
    act(state, stage === 'summary' ? 'start-final-finale' : 'reveal-final-finale');
    assert.deepEqual(match(state).songs[2], CompetitionConfig.FINALE_SONG);
    assert.deepEqual(match(state).scores, [[990000, 990000, null], [980000, 980000, null]]);
  }
});

test('secret final metadata cannot leak through public or scorer projections, and both main and scorer reject concealed third scoring', () => {
  const state = sealed(), final = match(state), view = scorekeeperState(state);
  assert.equal(final.currentSong, 2); assert.equal(final.scores[0].length, 3);
  const publicJSON = JSON.stringify(publicState(state)), scorerJSON = JSON.stringify(view);
  assert.ok(!publicJSON.includes('Synthetic final song')); assert.ok(!publicJSON.includes('Test artist'));
  assert.ok(!scorerJSON.includes('Synthetic final song')); assert.ok(!scorerJSON.includes('gf-finale'));
  assert.equal(match(publicState(state)).songs[2].hidden, true);
  assert.throws(() => act(state, 'set-match-score', { playerIndex: 0, songIndex: 2, score: 999999 }), /Reveal/);
  assert.throws(() => scorekeeperAction(state, { contextKey: view.contextKey, action: { type: 'set-match-score', payload: { matchId: 'GF', playerIndex: 0, songIndex: 2, score: 999999 } } }), /not available/);
  assert.throws(() => act(state, 'set-broadcast-cue', { stage: 'double-elimination', scene: 'double-elimination-match', matchId: 'GF', songIndex: 2 }), /Reveal/);
});

test('server video cue synchronizes seeking and reveals automatically after its shared duration without a server timer', () => {
  const state = sealed(); act(state, 'play-final-finale-video');
  const final = match(state), cue = final.finale.videoCue;
  assert.equal(state.scene, 'grand-final-video'); assert.equal(cue.duration, 8.25);
  assert.equal(Sequence.phase(final, cue.startedAt + 3000).videoTime, 3);
  assert.equal(Sequence.phase(final, cue.startedAt + 8249).concealed, true);
  const end = Sequence.phase(final, cue.startedAt + 8250);
  assert.equal(end.stage, 'revealed'); assert.equal(end.videoEnded, true); assert.equal(end.videoActive, false);
  assert.equal(end.videoTime, 8.25); assert.equal(end.videoRemaining, 0);
  final.finale.videoCue.startedAt = Date.now() - 10000;
  assert.equal(match(publicState(state)).songs[2].title, 'Synthetic final song');
  assert.equal(scorekeeperState(state).match.songs[2].hidden, undefined);
  act(state, 'set-broadcast-cue', { stage: 'double-elimination', scene: 'double-elimination-match', matchId: 'GF', songIndex: 2 });
  assert.equal(final.currentSong, 2);
  assert.equal(match(state).finale.stage, 'revealed'); assert.equal(match(state).finale.videoCue, undefined);
  assert.equal(Sequence.phase(match(state), 0).stage, 'revealed', 'Persisted completion cannot conceal the song after a wall-clock correction');
});

test('manual video escape and no-video reveal preserve contamination; only the main can trigger staged purification', () => {
  for (const useVideo of [false, true]) {
    const state = sealed(); if (useVideo) act(state, 'play-final-finale-video');
    act(state, useVideo ? 'finish-final-finale-video' : 'reveal-final-finale');
    assert.equal(state.scene, 'double-elimination-waiting'); assert.equal(match(state).finale.effectLevel, 0);
    for (const level of [1, 2, 3, 4, 0]) {
      act(state, 'set-final-finale-effect', { level }); assert.equal(match(state).finale.effectLevel, level);
    }
    const view = scorekeeperState(state);
    for (const type of ['configure-final-finale', 'show-final-two-totals', 'start-final-finale', 'play-final-finale-video', 'finish-final-finale-video', 'reveal-final-finale', 'set-final-finale-effect']) {
      assert.throws(() => scorekeeperAction(state, { contextKey: view.contextKey, action: { type, payload: { matchId: 'GF', level: 3 } } }), error => error.code === 'FORBIDDEN');
    }
  }
});

test('champion uses the sum of all three songs and score corrections cannot change or reconceal a scored final song', () => {
  const state = sealed(); act(state, 'reveal-final-finale');
  act(state, 'set-match-score', { playerIndex: 0, songIndex: 2, score: 900000, judgements: { accuracy: 90 } });
  act(state, 'set-match-score', { playerIndex: 1, songIndex: 2, score: 999999, judgements: { accuracy: 100 } });
  assert.throws(() => configure(state), /locked/);
  act(state, 'record-result', { verified: true });
  assert.equal(state.result.winnerId, match(state).players[1]); assert.deepEqual(state.result.totals, [2880000, 2959999]);
  const impact = resultCorrectionImpact(state, 'GF');
  act(state, 'reopen-result', { matchId: 'GF', reason: 'Synthetic arbiter correction', affectedMatchIds: impact.affectedMatchIds });
  assert.equal(match(state).finale.stage, 'revealed'); assert.equal(match(state).finale.videoCue, undefined);
  act(state, 'record-result', { verified: true });
});

test('equal three-song totals use mean accuracy, and a tied mean retains the existing tiebreak workflow', () => {
  const state = ready(); configure(state); firstTwo(state, [[990000, 990000], [990000, 990000]]);
  act(state, 'show-final-two-totals'); act(state, 'start-final-finale'); act(state, 'reveal-final-finale');
  for (const playerIndex of [0, 1]) act(state, 'set-match-score', { playerIndex, songIndex: 2, score: 990000, judgements: { accuracy: 99 } });
  act(state, 'record-result', { verified: true }); assert.equal(match(state).decisionReason, 'accuracy');
  const tied = ready(); configure(tied); firstTwo(tied, [[990000, 990000], [990000, 990000]]);
  for (const songIndex of [0, 1]) act(tied, 'set-match-score', { playerIndex: 1, songIndex, score: 990000, judgements: { accuracy: 99 } });
  act(tied, 'show-final-two-totals'); act(tied, 'start-final-finale'); act(tied, 'reveal-final-finale');
  for (const playerIndex of [0, 1]) act(tied, 'set-match-score', { playerIndex, songIndex: 2, score: 990000, judgements: { accuracy: 99 } });
  assert.throws(() => act(tied, 'record-result', { verified: true }), /tiebreak/);
  act(tied, 'draw-match-tiebreak');
  for (const playerIndex of [0, 1]) act(tied, 'set-match-tiebreak-score', { index: 0, playerIndex, score: playerIndex ? 990000 : 980000 });
  act(tied, 'confirm-match-tiebreak', { index: 0, verified: true }); act(tied, 'record-result', { verified: true });
  assert.equal(match(tied).decisionReason, 'tiebreak'); assert.equal(tied.result.winnerId, match(tied).players[1]);
  assert.deepEqual(tied.result.totals, [2970000, 2970000], 'Tiebreaks do not replace the official three-song sum');
});

test('invalid paths, malformed persisted finale state, stale match IDs and unavailable setup are rejected transactionally', () => {
  const state = ready();
  for (const videoPath of ['https://example.com/reveal.mp4', 'assets/finale/../secret.mp4', '/assets/finale/reveal.mp4', 'assets/song-preview/reveal.mp4', 'assets/finale/reveal.mp4?token=x', 'assets/finale/a//clip.mp4', 'assets/finale/a/./clip.mp4']) {
    assert.throws(() => act(state, 'configure-final-finale', { videoPath }), /Video/);
  }
  assert.throws(() => act(state, 'configure-final-finale', { matchId: 'W1' }), error => error.code === 'MATCH_CHANGED');
  assert.throws(() => act(state, 'start-final-finale'), /scores/);
  configure(state);
  for (const patch of [{ stage: 'unknown' }, { effectLevel: -1 }, { effectLevel: 3 }, { videoDuration: Infinity }, { privateKey: 'unknown' }, { song: null }]) {
    const damaged = structuredClone(state); Object.assign(match(damaged).finale, patch); assert.throws(() => validateState(damaged), /Damaged state/);
  }
  act(state, 'reset-current-match'); assert.equal(match(state).finale.stage, 'base'); assert.equal(match(state).songs.length, 3);
  assert.deepEqual(match(state).scores, [[null, null, null], [null, null, null]]);
});

test('only a revealed third final song receives a countdown context and a shared rematch clears both third scores', () => {
  const state = sealed();
  state.scene = 'double-elimination-match';
  assert.equal(Countdown.context(state), null, 'A manually selected match scene cannot start a concealed song countdown');
  state.scene = 'double-elimination-waiting';
  const payload = { stage: 'double-elimination', matchId: 'GF', songIndex: 2, reason: 'game-error',
    videoChecked: false, unintentional: false, allAgree: false, note: 'Synthetic game restart requested by arbiter' };
  assert.throws(() => act(state, 'authorize-song-rematch', payload), /Reveal/);
  act(state, 'reveal-final-finale');
  act(state, 'set-broadcast-cue', { stage: 'double-elimination', scene: 'double-elimination-match', matchId: 'GF', songIndex: 2 });
  const context = Countdown.context(state);
  assert.equal(context.matchId, 'GF'); assert.equal(context.songIndex, 2); assert.equal(context.songId, 'gf-finale');
  assert.equal(Countdown.context(publicState(state)).key, context.key, 'Server and public-overlay countdown identities agree');
  for (const playerIndex of [0, 1]) act(state, 'set-match-score', { playerIndex, songIndex: 2, score: 990000, judgements: { accuracy: 99 } });
  const before = match(state).scores.map(row => row.slice(0, 2));
  act(state, 'authorize-song-rematch', payload);
  assert.deepEqual(match(state).scores.map(row => row.slice(0, 2)), before);
  assert.deepEqual(match(state).scores.map(row => row[2]), [null, null]);
  assert.deepEqual(match(state).judgements.map(row => row[2]), [null, null]);
  assert.equal(match(state).finale.stage, 'revealed'); assert.equal(match(state).rematches[0].songId, 'gf-finale');
  assert.throws(() => act(state, 'authorize-song-rematch', payload), /already been used/);
});

test('announced finale permits clearing or authorising a rematch for an earlier score without losing the reveal or recording an incomplete champion', () => {
  const state = sealed(); act(state, 'reveal-final-finale');
  act(state, 'set-match-score', { playerIndex: 0, songIndex: 1, score: null });
  assert.equal(match(state).finale.stage, 'revealed'); assert.equal(match(state).scores[0][1], null);
  act(state, 'set-match-score', { playerIndex: 0, songIndex: 1, score: 990000 });
  act(state, 'authorize-song-rematch', { stage: 'double-elimination', matchId: 'GF', songIndex: 0, reason: 'game-error',
    videoChecked: false, unintentional: false, allAgree: false, note: 'Synthetic review of an earlier final song' });
  assert.deepEqual(match(state).scores.map(row => row[0]), [null, null]);
  assert.equal(match(state).finale.stage, 'revealed'); assert.equal(match(publicState(state)).songs[2].title, 'Synthetic final song');
  assert.throws(() => act(state, 'record-result', { verified: true }), /every song score/);
  for (const songIndex of [0, 1]) {
    const summary = sealed(); act(summary, 'show-final-two-totals');
    act(summary, 'authorize-song-rematch', { stage: 'double-elimination', matchId: 'GF', songIndex, reason: 'game-error',
      videoChecked: false, unintentional: false, allAgree: false, note: 'Synthetic rematch from provisional first two song totals' });
    assert.equal(match(summary).finale.stage, 'summary'); assert.deepEqual(match(summary).scores.map(row => row[songIndex]), [null, null]);
    assert.throws(() => act(summary, 'start-final-finale'), /first two song scores/);
  }
});

test('third score entry and song progress make an elapsed reveal persistent rather than retaining an expired video clock', () => {
  for (const method of ['score', 'progress', 'waiting', 'statistics']) {
    const state = sealed(); act(state, 'play-final-finale-video'); match(state).finale.videoCue.startedAt = Date.now() - 10000;
    if (method === 'score') act(state, 'set-match-score', { playerIndex: 0, songIndex: 2, score: 999999 });
    else if (method === 'progress') act(state, 'set-song-progress', { index: 2 });
    else act(state, 'set-broadcast-cue', { stage: 'double-elimination', scene: method === 'waiting' ? 'double-elimination-waiting' : 'song-result', matchId: 'GF', songIndex: 2 });
    assert.equal(match(state).finale.stage, 'revealed', method); assert.equal(match(state).finale.videoCue, undefined, method);
    assert.equal(Sequence.phase(match(state), 0).concealed, false, method);
    assert.notEqual(state.scene, 'grand-final-video', method);
  }
});
