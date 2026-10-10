const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const Countdown = require('../public/js/countdown');
const { createDefaultState } = require('../lib/default-state');

function controlOperation() {
  // Exercise the shipped async handler: the queue/socket stubs expose a real timing race.
  const source = fs.readFileSync(path.join(__dirname, '../public/control/control.js'), 'utf8');
  const begin = source.indexOf('  async function sendCountdown('), end = source.indexOf('  setInterval(refreshCountdownControls', begin);
  assert.ok(begin >= 0 && end > begin, 'The shipped countdown handler must exist');
  const state = createDefaultState(); state.scene = 'qualifier-match';
  let release;
  const sent = [], messages = [];
  const socket = { connected: true, id: 'first-session', timeout() { return {
    emit(name, request, callback) { sent.push({ name, request, connected: socket.connected, socketId: socket.id }); callback(null, { ok: true }); }
  }; } };
  const sandbox = { state, socket, countdownPending: false, countdownClient: { cue: { id: 'original-cue' } },
    BroadcastCountdown: Countdown, queue: new Promise(resolve => { release = resolve; }),
    refreshCountdownControls() {}, toast(message, error) { messages.push({ message, error }); }
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(begin, end) + '\nthis.sendCountdownUnderTest = sendCountdown;', sandbox);
  return { sandbox, sent, messages, release, send: action => sandbox.sendCountdownUnderTest(action) };
}

for (const [name, change] of [
  ['disconnect', sandbox => { sandbox.socket.connected = false; }],
  ['disconnect and reconnect', sandbox => { sandbox.socket.id = 'second-session'; }],
  ['replacement paired socket', sandbox => { sandbox.socket = { ...sandbox.socket, id: 'second-session' }; }]
]) {
  test(`waiting crew countdown cannot be buffered or sent after ${name}`, async () => {
    for (const action of ['start', 'cancel']) {
      const f = controlOperation(), pending = f.send(action);
      assert.equal(f.sandbox.countdownPending, true);
      change(f.sandbox); f.release(); await pending;
      assert.equal(f.sent.length, 0, 'Old actions must never be sent on a disconnected or changed connection');
      assert.equal(f.messages.length, 1); assert.equal(f.messages[0].error, true);
      assert.equal(f.sandbox.countdownPending, false);
    }
  });
}

test('a queued countdown still works on the original connection and uses the newest saved revision', async () => {
  for (const action of ['start', 'cancel']) {
    const f = controlOperation(), pending = f.send(action);
    f.sandbox.state.revision++; f.release(); await pending;
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0].name, 'countdown-command');
    assert.equal(f.sent[0].connected, true); assert.equal(f.sent[0].socketId, 'first-session');
    assert.equal(f.sent[0].request.action, action); assert.equal(f.sent[0].request.expectedRevision, 1);
    assert.equal(f.sent[0].request.contextKey, Countdown.context(f.sandbox.state).key);
    assert.equal(f.sent[0].request.cueId, 'original-cue');
    assert.equal(f.messages.length, 0); assert.equal(f.sandbox.countdownPending, false);
  }
});

test('a queued countdown is rejected when the selected players or song change', async () => {
  const f = controlOperation(), pending = f.send('start');
  f.sandbox.state.qualifier.currentSong = 1; f.release(); await pending;
  assert.equal(f.sent.length, 0); assert.equal(f.messages.length, 1);
  assert.equal(f.sandbox.countdownPending, false);
});

class ClockSocket extends EventEmitter {
  constructor() { super(); this.connected = true; this.requests = []; }
  timeout() { return { emit: (name, callback) => { assert.equal(name, 'countdown-sync'); this.requests.push(callback); } }; }
}
const packet = (sequence, cue) => ({ sequence, cue, serverNow: Date.now() });
const cue = id => ({ id, startsAt: Date.now() + 350, endsAt: Date.now() + 4300, context: { key: 'fixture' } });

test('a delayed clock response cannot revive a cue after a newer cancellation', t => {
  const socket = new ClockSocket(), client = Countdown.createClient(socket); t.after(() => client.dispose());
  const first = cue('first'); socket.emit('countdown', packet(1, first));
  assert.equal(client.cue.id, 'first');
  socket.emit('countdown', packet(2, null)); assert.equal(client.cue, null);
  socket.requests[0](null, packet(1, first)); assert.equal(client.cue, null);
  const second = cue('second'); socket.emit('countdown', packet(3, second));
  socket.emit('countdown', packet(2, null)); assert.equal(client.cue.id, 'second');
});

test('disconnect clears the cue, ignores pending old clock replies and accepts a restarted server sequence', t => {
  const socket = new ClockSocket(), client = Countdown.createClient(socket); t.after(() => client.dispose());
  const oldReply = socket.requests[0], first = cue('first');
  socket.emit('countdown', packet(9, first)); assert.equal(client.cue.id, 'first');
  socket.connected = false; socket.emit('disconnect'); assert.equal(client.cue, null);
  oldReply(null, packet(9, first)); assert.equal(client.cue, null);
  socket.connected = true; socket.emit('connect');
  socket.emit('countdown', packet(0, null)); assert.equal(client.cue, null);
  oldReply(null, packet(9, first)); assert.equal(client.cue, null, 'An old connection must not revive its cue after reconnect');
  const second = cue('after-restart'); socket.emit('countdown', packet(1, second)); assert.equal(client.cue.id, 'after-restart');
});
