const test = require('node:test');
const assert = require('node:assert/strict');
const Sound = require('../public/js/selection-switch-sound');
const Roulette = require('../public/js/selection-roulette');
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function fixture(enabled = true) {
  let time = 1000, resolveLoad, creations = 0;
  const sources = [], gains = [], statuses = [];
  const context = { state: 'running', currentTime: 0, destination: {},
    createGain() { const node = { gain: { value: 1, setTargetAtTime(value) { this.value = value; } }, connect() {}, disconnect() {} }; gains.push(node); return node; },
    createBufferSource() { const source = { starts: 0, stops: [], connect() {}, disconnect() {}, start() { this.starts++; }, stop(at) { this.stops.push(at); } }; sources.push(source); return source; },
    decodeAudioData: async () => ({ duration: .457483 }),
    async resume() { this.state = 'running'; }, async close() { this.state = 'closed'; }
  };
  const player = Sound.createPlayer({ enabled, now: () => time, createContext: () => { creations++; return context; },
    load: () => new Promise(resolve => { resolveLoad = resolve; }), onStatus: status => statuses.push(status) });
  const update = (step, volume = .25, active = true) => player.update({ active, volume, cue: { id: 'draw' }, phase: { stage: 'rolling', index: 0, step, stepStartedAt: time } });
  return { player, context, sources, gains, statuses, update, created: () => creations,
    advance: ms => { time += ms; }, load: () => resolveLoad(new ArrayBuffer(4)) };
}
test('silent staff previews create no audio context, media decoder or sound requests', () => {
  const f = fixture(false); f.update(0); f.update(1); assert.equal(f.created(), 0); f.player.dispose();
});
test('mute drops pending clicks, unmute waits for a new step, and scene exit stops every current voice', async () => {
  const f = fixture(); f.update(0); f.update(0, 0); f.load(); await flush(); assert.equal(f.sources.length, 0);
  f.update(0, .4); assert.equal(f.sources.length, 0, 'unmute must not replay the muted step');
  f.advance(80); f.update(1, .4); assert.equal(f.sources.length, 1); assert.equal(f.gains[0].gain.value, .4);
  f.update(1, .6); assert.equal(f.sources.length, 1); assert.equal(f.gains[0].gain.value, .6);
  f.update(1, .6, false); assert.equal(f.gains[0].gain.value, 0); assert.equal(f.sources[0].stops.length, 1);
  f.player.dispose(); assert.equal(f.context.state, 'closed');
});
test('slow loading discards stale ticks and the voice pool stays bounded during rapid selection', async () => {
  const f = fixture(); f.update(0); f.advance(500); f.load(); await flush(); assert.equal(f.sources.length, 0);
  for (let step = 1; step < 20; step++) { f.advance(70); f.update(step); assert.ok(f.sources.filter(source => !source.stops.length).length <= 2); }
  assert.equal(f.created(), 1); assert.equal(f.sources.length, 19);
  f.player.dispose(); f.update(20); assert.equal(f.sources.length, 19);
});
test('blocked browser audio resumes for new ticks and disposal cancels a late decode', async () => {
  const f = fixture(); f.context.state = 'suspended'; f.update(0); f.load(); await flush(); assert.ok(f.statuses.includes('blocked'));
  f.player.retry(); await flush(); f.advance(80); f.update(1); assert.equal(f.sources.length, 1); f.player.dispose();
  const late = fixture(); late.update(0); late.player.dispose(); late.load(); await flush(); assert.equal(late.sources.length, 0);
});
test('draw clocks keep the absolute next deadline on revisions and ignore callbacks after disposal', () => {
  let time = 0, next = 0;
  const timers = new Map(), changes = [];
  const cue = { id: 'draw', kind: 'picks', startedAt: 0, songIds: ['a', 'b'], roulette: { poolIds: ['a', 'b', 'c', 'd'] }, durations: [12, 12] };
  const clock = Roulette.createClock({ now: () => time, onChange: phase => changes.push(phase),
    setTimer(fn, delay) { const id = ++next; timers.set(id, { fn, at: time + delay }); return id; }, clearTimer: id => timers.delete(id) });
  clock.update(cue); const at = timers.values().next().value.at;
  clock.update(structuredClone(cue)); assert.equal(changes.length, 1); assert.equal(timers.values().next().value.at, at);
  time = Roulette.LEAD_MS + 150; clock.update(cue); assert.equal(changes.at(-1).stage, 'rolling');
  const stale = timers.values().next().value.fn, count = changes.length;
  clock.dispose(); stale(); assert.equal(changes.length, count); assert.equal(timers.size, 0);
});
