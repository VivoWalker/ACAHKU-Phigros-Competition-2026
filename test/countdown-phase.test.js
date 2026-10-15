const test = require('node:test');
const assert = require('node:assert/strict');
const { phase, ENTRY_DURATION, COUNTDOWN_DURATION, EXIT_DURATION, DURATION } = require('../public/js/countdown');

test('the fullscreen sweep completes before the first count and leaves after START', () => {
  assert.equal(ENTRY_DURATION, 650);
  assert.equal(COUNTDOWN_DURATION, 3700);
  assert.equal(EXIT_DURATION, 650);
  assert.equal(DURATION, ENTRY_DURATION + COUNTDOWN_DURATION + EXIT_DURATION);
  const cue = { startsAt: 10000, endsAt: 10000 + DURATION };
  for (const elapsed of [-100, 0, ENTRY_DURATION - 1]) {
    const current = phase(cue, cue.startsAt + elapsed);
    assert.equal(current.stage, 'entering');
    assert.equal(current.label, '', 'A partly covered match must not show the numeric start signal');
    assert.equal(current.pending, elapsed < 0);
  }
  for (const [index, label] of ['3', '2', '1', 'START'].entries()) {
    const beatStart = cue.startsAt + ENTRY_DURATION + index * 1000;
    const current = phase(cue, beatStart);
    assert.equal(current.stage, 'counting');
    assert.equal(current.index, index);
    assert.equal(current.label, label);
    assert.equal(current.startsAt, beatStart);
    assert.equal(current.fading, false);
  }
  const exitStart = cue.startsAt + ENTRY_DURATION + COUNTDOWN_DURATION;
  assert.equal(phase(cue, exitStart - 1).stage, 'counting');
  for (const elapsed of [0, EXIT_DURATION / 2, EXIT_DURATION - 1]) {
    const current = phase(cue, exitStart + elapsed);
    assert.equal(current.stage, 'exiting');
    assert.equal(current.label, 'START');
    assert.equal(current.fading, true);
  }
  assert.equal(phase(cue, cue.endsAt), null);
  assert.equal(phase(cue, cue.endsAt + 1000), null);
  assert.equal(phase(null, cue.startsAt), null);
});
