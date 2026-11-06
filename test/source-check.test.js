const test = require('node:test');
const assert = require('node:assert/strict');
const { createDefaultState } = require('./helpers/legacy-state');
const { applyBroadcastCheckAction, sourceStatus } = require('../lib/broadcast-check');

const sources = count => Array.from({ length: count }, (_, i) => ({ capture: `Capture ${i + 1}`, handcam: `Handcam ${i + 1}` }));
const apply = (state, type, payload) => applyBroadcastCheckAction(state, { type, payload });

test('the 4:3 webcam profile withdraws an old 16:9 source check without losing source names', () => {
  const state = createDefaultState();
  apply(state, 'set-broadcast-sources', { layout: 'qualifier', slots: sources(3).map(slot => ({ ...slot, handcam: '' })) });
  const current = sourceStatus(state), old = JSON.parse(current.signature);
  delete old.captureProfile;
  state.broadcast.sourceCheck = { signature: JSON.stringify(old), confirmedAt: new Date().toISOString() };
  assert.equal(sourceStatus(state).confirmed, false);
  assert.equal(sourceStatus(state).captureProfile, 'webcam-4:3-720p30');
  assert.deepEqual(sourceStatus(state).slots.map(slot => slot.capture), ['Capture 1', 'Capture 2', 'Capture 3']);
  apply(state, 'confirm-broadcast-sources', { signature: current.signature });
  assert.equal(sourceStatus(state).confirmed, true);
});

test('manual source check is invalidated by entrant, name, layout, mode and source changes', () => {
  const original = createDefaultState();
  apply(original, 'set-broadcast-sources', { layout: 'qualifier', slots: sources(3) });
  apply(original, 'confirm-broadcast-sources', { signature: sourceStatus(original).signature });
  assert.equal(sourceStatus(original).confirmed, true);
  for (const change of [s => s.qualifier.activePlayers.reverse(), s => s.qualifier.players[0].name = 'New name',
    s => s.qualifier.activeGroup = 'B', s => s.stage = 'double-elimination', s => s.broadcast.showHandcams = true,
    s => s.broadcast.sourceSlots.qualifier[0].capture = 'Another capture']) {
    const state = structuredClone(original); change(state);
    assert.equal(sourceStatus(state).confirmed, false);
    assert.equal(sourceStatus(state).confirmedAt, null);
  }
  original.qualifier.players[0].scores[0] = 999999;
  assert.equal(sourceStatus(original).confirmed, true, 'Scoring does not change the physical source assignment');
  apply(original, 'set-broadcast-sources', { layout: 'qualifier', slots: sources(3) });
  assert.equal(sourceStatus(original).confirmed, false);
});

test('confirmation checks current signature and complete sources for occupied slots only', () => {
  const state = createDefaultState();
  assert.throws(() => apply(state, 'confirm-broadcast-sources', { signature: sourceStatus(state).signature }), /Name the capture/);
  apply(state, 'set-broadcast-sources', { layout: 'qualifier', slots: sources(3) });
  const stale = sourceStatus(state).signature;
  state.qualifier.activePlayers = ['p2'];
  assert.throws(() => apply(state, 'confirm-broadcast-sources', { signature: stale }), /changed/);
  state.broadcast.sourceSlots.qualifier[0].handcam = '';
  apply(state, 'confirm-broadcast-sources', { signature: sourceStatus(state).signature });
  state.broadcast.showHandcams = true;
  assert.throws(() => apply(state, 'confirm-broadcast-sources', { signature: sourceStatus(state).signature }), /handcam/);
  state.qualifier.activePlayers = [];
  assert.throws(() => apply(state, 'confirm-broadcast-sources', { signature: sourceStatus(state).signature }), /Select on-stage/);
});

test('source settings reject malformed layouts and keep double-elimination matches separate', () => {
  const state = createDefaultState();
  for (const payload of [{ layout: '__proto__', slots: sources(3) }, { layout: 'double', slots: sources(3) },
    { layout: 'qualifier', slots: [{ capture: 'x'.repeat(81), handcam: '' }, ...sources(2)] }]) {
    assert.throws(() => apply(state, 'set-broadcast-sources', payload));
  }
  state.stage = 'double-elimination';
  state.tournament.matches = [{ id: 'W1', players: ['p1', 'p2'] }, { id: 'W2', players: ['p1', 'p2'] }];
  state.tournament.currentMatchId = 'W1';
  apply(state, 'set-broadcast-sources', { layout: 'double', slots: sources(2) });
  apply(state, 'confirm-broadcast-sources', { signature: sourceStatus(state).signature });
  assert.equal(sourceStatus(state).confirmed, true);
  state.tournament.currentMatchId = 'W2';
  assert.equal(sourceStatus(state).confirmed, false, 'A new match needs its own visual check even with the same entrants');
  assert.equal(apply(state, 'not-a-source-action'), false);
});
