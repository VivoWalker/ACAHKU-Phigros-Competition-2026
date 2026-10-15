const test = require('node:test');
const assert = require('node:assert/strict');
const { PairingAttempts } = require('../lib/pairing-attempts');

test('failed-device records expire in the background without another request', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 0;
  const attempts = new PairingAttempts({ now: () => now });
  t.after(() => attempts.close());
  for (let device = 0; device < 2000; device++) attempts.fail(`control:${device}`);
  assert.equal(attempts.entries.size, 2000);
  now = 60000; t.mock.timers.tick(30000);
  assert.equal(attempts.entries.size, 0);
});

test('capacity remains bounded and new devices cannot evict an active lockout', t => {
  let now = 0;
  const attempts = new PairingAttempts({ maxEntries: 16, now: () => now });
  t.after(() => attempts.close());
  for (let count = 0; count < 10; count++) attempts.fail('control:locked');
  for (let device = 0; device < 20000; device++) attempts.fail(`control:${device}`);
  assert.equal(attempts.entries.size, 16);
  assert.equal(attempts.blocked('control:locked'), true);
  assert.equal(attempts.blocked('control:new-device'), true);
  now = 60000;
  assert.equal(attempts.blocked('control:new-device'), false);
  attempts.fail('control:new-device');
  assert.equal(attempts.entries.size, 1);
});

test('rolling limits preserve separate panel roles and successful pairing clears only that device', t => {
  let now = 0;
  const attempts = new PairingAttempts({ now: () => now });
  t.after(() => attempts.close());
  for (let count = 0; count < 9; count++) attempts.fail('control:same-device');
  now = 1000; attempts.fail('control:same-device');
  assert.equal(attempts.blocked('control:same-device'), true);
  assert.equal(attempts.blocked('scorekeeper:same-device'), false);
  now = 60000;
  assert.equal(attempts.blocked('control:same-device'), false);
  assert.equal(attempts.entries.get('control:same-device').length, 1);
  attempts.fail('scorekeeper:same-device');
  attempts.clear('control:same-device');
  assert.equal(attempts.entries.has('control:same-device'), false);
  assert.equal(attempts.entries.has('scorekeeper:same-device'), true);
});

test('closing releases the sweeper and retained devices and is safe to repeat', () => {
  const attempts = new PairingAttempts();
  assert.equal(attempts.timer.hasRef(), false, 'Sweeper does not keep the process alive');
  attempts.fail('control:fixture'); attempts.close(); attempts.close();
  assert.equal(attempts.timer, null);
  assert.equal(attempts.entries.size, 0);
});
