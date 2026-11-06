const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Standings = require('../public/js/final-standings');
const T = require('../lib/tournament');
const { validateState } = require('../lib/state-validation');
const { fixture, act } = require('./helpers/final-standings-state');
const group = (result, id) => result.groups.find(group => group.id === id);

for (const count of [16, 24, 64]) test(`${count}-player event derives the podium and unordered bands from confirmed results`, () => {
  const state = fixture(count), original = structuredClone(state), result = Standings.build(state);
  const final = state.tournament.matches.find(match => match.id === 'GF');
  const bronze = state.tournament.matches.find(match => match.id === 'L6');
  assert.equal(result.ready, true);
  assert.deepEqual(result.podium.map(slot => slot.player.id), [final.winnerId, final.loserId, bronze.loserId]);
  assert.equal(T.losses(state, final.loserId), 1, 'A winners-bracket finalist can finish runner-up with only one loss');
  assert.equal(group(result, 'top-eight').players.length, 5);
  assert.equal(group(result, 'remaining').players.length, count - 8);
  const awarded = new Set(result.podium.map(slot => slot.player.id));
  const seeded = new Set(state.tournament.seeds);
  for (const id of ['top-eight', 'remaining']) {
    const band = group(result, id);
    assert.equal(band.unordered, true);
    assert.deepEqual(band.players.map(player => player.id), state.qualifier.players
      .filter(player => id === 'top-eight' ? seeded.has(player.id) && !awarded.has(player.id) : !seeded.has(player.id)).map(player => player.id));
    assert.ok(band.players.every(player => Object.keys(player).sort().join(',') === 'id,name'));
  }
  const ids = [...result.podium.map(slot => slot.player.id), ...result.groups.flatMap(group => group.players.map(player => player.id))];
  assert.equal(new Set(ids).size, count); assert.equal(ids.length, count);
  const pages = Standings.pages(result);
  assert.deepEqual(pages.flatMap(page => page.players), group(result, 'remaining').players);
  assert.ok(pages.every(page => page.players.length <= 12));
  assert.deepEqual(Standings.build(T.publicState(state)), result);
  assert.deepEqual(state, original, 'Standings must not change scores, seeds, results or saved state');
});

test('final standings require every match confirmation, including a scored but unconfirmed final', () => {
  const state = fixture(16, false);
  assert.deepEqual(Standings.build(state), { ready: false, podium: [], groups: [] });
  for (const action of [{ type: 'set-scene', payload: { scene: 'final-standings' } },
    { type: 'set-broadcast-cue', payload: { stage: 'double-elimination', scene: 'final-standings' } }]) {
    const before = structuredClone(state);
    assert.throws(() => T.applyAction(state, action), /Confirm all match results/);
    assert.deepEqual(state, before);
  }
  act(state, 'record-result', { verified: true });
  for (const match of state.tournament.matches) {
    const copy = structuredClone(state); copy.tournament.matches.find(value => value.id === match.id).status = 'ready';
    assert.equal(Standings.build(copy).ready, false, match.id);
  }
  const copy = structuredClone(state); copy.tournament.matches.pop(); assert.equal(Standings.build(copy).ready, false);
});

test('both scene controls use the confirmed podium without changing the selected match or song', () => {
  const state = fixture(), final = state.tournament.matches.find(match => match.id === 'GF');
  const selected = [state.tournament.currentMatchId, final.currentSong];
  act(state, 'set-scene', { scene: 'final-standings' });
  assert.equal(state.stage, 'double-elimination'); assert.equal(state.scene, 'final-standings'); validateState(state);
  act(state, 'set-broadcast-cue', { stage: 'double-elimination', scene: 'final-standings' });
  assert.deepEqual([state.tournament.currentMatchId, final.currentSong], selected);
  assert.throws(() => act(state, 'set-broadcast-cue', { stage: 'double-elimination', scene: 'final-standings', songIndex: 1 }), /do not select/);
  assert.throws(() => act(state, 'set-broadcast-cue', { stage: 'qualifier', scene: 'final-standings' }), /qualifier broadcast/);
});

test('reopening a result immediately invalidates awards and recomputes them after reconfirmation', () => {
  const state = fixture(), before = Standings.build(state);
  act(state, 'set-scene', { scene: 'final-standings' });
  act(state, 'reopen-result', { matchId: 'GF', affectedMatchIds: [], reason: 'Fixture score correction.' });
  assert.equal(Standings.build(state).ready, false);
  for (const playerIndex of [0, 1]) for (const songIndex of [0, 1]) act(state, 'set-match-score', { playerIndex, songIndex, score: playerIndex ? 980000 : 990000 });
  act(state, 'record-result', { verified: true }); validateState(state);
  const after = Standings.build(state);
  assert.equal(after.podium[0].player.id, before.podium[1].player.id);
  assert.equal(after.podium[1].player.id, before.podium[0].player.id);
  assert.deepEqual(after.groups, before.groups);
});

test('vacant or disqualified podium slots stay vacant and disqualified entrants receive no rank', () => {
  const state = fixture(), final = state.tournament.matches.find(match => match.id === 'GF');
  const third = state.tournament.matches.find(match => match.id === 'L6').loserId;
  final.loserId = null;
  state.qualifier.players.find(player => player.id === third).disqualification = { reason: 'fixture' };
  const result = Standings.build(state);
  assert.equal(result.podium[1].player, null); assert.equal(result.podium[2].player, null);
  assert.equal(group(result, 'disqualified').players[0].id, third);
  assert.ok(!group(result, 'top-eight').players.some(player => player.id === third));
  assert.ok(!group(result, 'remaining').players.some(player => player.id === third));
});

test('the shared standings model works in an OBS browser without Node globals', () => {
  const state = fixture(), sandbox = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/final-standings'), 'utf8'), sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.BroadcastFinalStandings.build(state))), Standings.build(state));
});
