const test = require('node:test');
const assert = require('node:assert/strict');
const Effects = require('../public/js/finale-effects');

function fixture() {
  const frames = new Map(), timers = new Map(), documentListeners = new Map(), mediaListeners = new Map();
  let counter = 0, clock = 2000;
  const state = { started: true, pending: false, index: 0, revealedCount: 1,
    complete: false, stageStartedAt: 1000, coverage: .1 };
  const reduce = { matches: false,
    addEventListener: (name, listener) => mediaListeners.set(name, listener),
    removeEventListener: name => mediaListeners.delete(name) };
  const window = {
    matchMedia: () => reduce,
    requestAnimationFrame: callback => { frames.set(++counter, callback); return counter; },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout: callback => { timers.set(++counter, callback); return counter; },
    clearTimeout: id => timers.delete(id),
    BroadcastFinalAnnouncement: { phase: () => state, isFixed: match => match?.id === 'GF' }
  };
  class Element {
    constructor(name) { this.name = name; this.children = []; this.dataset = {}; this.attributes = new Map(); this.parent = null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
    get isConnected() { return this.name === 'masked-root' || !!this.parent?.isConnected; }
  }
  const document = {
    defaultView: window, hidden: false,
    createElementNS: (_namespace, name) => new Element(name),
    addEventListener: (name, listener) => documentListeners.set(name, listener),
    removeEventListener: name => documentListeners.delete(name)
  };
  const parent = new Element('masked-root'), classes = new Set();
  const label = new Element('span'); label.textContent = 'UNKNOWN SONG';
  const canvas = { ownerDocument: document, dataset: {},
    querySelector: selector => selector === '.broadcast-backdrop > g[mask]' ? parent : null,
    querySelectorAll: selector => selector === '[data-finale-garbled]' ? [label] : [],
    classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      remove(...names) { for (const name of names) classes.delete(name); } } };
  let phaseChanges = 0;
  const controller = Effects.createController({ canvas, now: () => clock, onPhaseChange: () => phaseChanges++ });
  const tick = () => {
    const tasks = [...frames.entries()]; frames.clear(); clock += 60;
    for (const [, callback] of tasks) callback(clock);
  };
  const poll = () => { const tasks = [...timers.values()]; timers.clear(); for (const callback of tasks) callback(); };
  return { controller, canvas, parent, classes, state, frames, timers, document, documentListeners,
    mediaListeners, reduce, tick, poll, label, setTime: time => { clock = time; }, phaseChanges: () => phaseChanges };
}

function descendants(element) {
  return [element, ...element.children.flatMap(descendants)];
}

function geometry(element) {
  return descendants(element).map(node => [node.name, [...node.attributes.entries()]]);
}

function depthLayers(group) {
  return descendants(group).filter(node => node.attributes.has('data-finale-depth'));
}

test('finale front has bounded irregular geometry and a two-thirds terminal extent', () => {
  assert.ok(Math.abs(Effects.contour(1 / 3, 0).baseline - 720) < 1e-9);
  assert.ok(Math.abs(Effects.contour(2 / 3, 0).baseline - 360) < 1e-9);
  assert.equal(Effects.contour(100, 0).baseline, Effects.contour(2 / 3, 0).baseline);
  for (const coverage of [0, 1 / 3, 2 / 3, 100]) {
    for (const seconds of [0, .05, 1, 120, 86400]) {
      for (const depth of [-1, 0, 1]) {
        const path = Effects.contour(coverage, seconds, depth, 42);
        assert.ok(path.area.length < 12000);
        assert.doesNotMatch(path.area, /NaN|Infinity/);
        assert.ok(path.points.length >= 100 && path.points.length <= 240);
        assert.equal(path.points[0][0], 0);
        assert.equal(path.points.at(-1)[0], Effects.WIDTH);
        const widths = new Set();
        for (let i = 0; i < path.points.length; i++) {
          const [x, y] = path.points[i];
          assert.ok(Number.isFinite(x) && Number.isFinite(y));
          assert.ok(x >= 0 && x <= Effects.WIDTH);
          assert.ok(Math.abs(y - path.baseline) <= 180);
          if (i) {
            const width = x - path.points[i - 1][0];
            assert.ok(width > 0 && width <= 64);
            widths.add(width);
          }
        }
        assert.ok(widths.size >= 3, 'the front must not repeat a fixed staircase width');
      }
    }
  }
});

test('short-time jitter and depth layers are seeded, independently changing geometry', () => {
  const at = (seconds, depth = 0, seed = 42) => Effects.contour(2 / 3, seconds, depth, seed).edge;
  assert.equal(at(20), at(20), 'a stable clock and seed must produce stable geometry');
  assert.notEqual(at(20), at(20.15), 'the edge should visibly evolve within a fraction of a second');
  assert.notEqual(at(20, -1), at(20, 0));
  assert.notEqual(at(20, 0), at(20, 1));
  assert.notEqual(at(20, 0, 42), at(20, 0, 43));
  const depthChanges = [-1, 0, 1].map(depth => {
    const before = Effects.contour(2 / 3, 20, depth, 42).points;
    const after = Effects.contour(2 / 3, 20.15, depth, 42).points;
    return after.map((point, index) => point[1] - before[index][1]);
  });
  assert.notDeepEqual(depthChanges[0], depthChanges[1], 'depth layers must not move as a rigid stack');
  assert.notDeepEqual(depthChanges[1], depthChanges[2]);
});

test('particles, detached fragments and horizontal tears stay bounded and evolve without unbounded objects', () => {
  for (const seconds of [0, .15, 120, 86400]) {
    const points = Effects.contour(2 / 3, seconds, 0, 42).points;
    const paths = [Effects.pixelPath(seconds), Effects.pixelPath(seconds, -1, 42, 80),
      Effects.fragmentPath(points, seconds, 42), Effects.tearPath(seconds, 42)];
    assert.equal((paths[0].match(/M/g) || []).length, Effects.PIXELS);
    assert.equal((paths[1].match(/M/g) || []).length, 80);
    for (const path of paths) {
      assert.equal(typeof path, 'string');
      assert.ok(path.length > 0 && path.length < 24000);
      assert.doesNotMatch(path, /NaN|Infinity|--/);
    }
  }
  const points = Effects.contour(2 / 3, 20, 0, 42).points;
  assert.equal(Effects.fragmentPath(points, 20, 42), Effects.fragmentPath(points, 20, 42));
  assert.notEqual(Effects.fragmentPath(points, 20, 42), Effects.fragmentPath(points, 20.15, 42));
  assert.notEqual(Effects.tearPath(20, 42), Effects.tearPath(20.15, 42));
  assert.notEqual(Effects.pixelPath(20, -1, 42), Effects.pixelPath(20, 1, 42));
});

test('random narrow fragments retain valid SVG path numbers across seeds and cycle boundaries', () => {
  const points = Effects.contour(2 / 3, 0).points;
  for (let seed = 0; seed < 64; seed++) {
    for (const seconds of [0, .15, 1, 1.99, 2.01, 12, 120, 86400]) {
      const path = Effects.fragmentPath(points, seconds, seed);
      const fragments = (path.match(/M/g) || []).length;
      assert.ok(fragments > 0 && fragments <= 32);
      assert.doesNotMatch(path, /NaN|Infinity|--/,
        `invalid fragment coordinates for seed ${seed} at ${seconds}s`);
    }
  }
});

test('finale uses the live synchronized coverage and preserves a single masked group through scene changes', () => {
  const f = fixture();
  f.controller.update({ match: { id: 'GF' }, scene: 'grand-final-announcement', active: true });
  const group = f.parent.children[0], initialNodes = group.children.length;
  assert.equal(f.parent.children.length, 1);
  assert.equal(group.dataset.coverage, '0.1000');
  assert.equal(f.frames.size, 1); assert.equal(f.timers.size, 1);
  f.state.coverage = .3; f.tick();
  assert.equal(group.dataset.coverage, '0.3000');
  f.state.index = 1; f.state.revealedCount = 2; f.state.coverage = .5; f.poll();
  assert.equal(f.phaseChanges(), 1);
  f.controller.update({ match: { id: 'GF' }, scene: 'double-elimination-waiting', active: true });
  assert.equal(f.parent.children[0], group); assert.equal(group.children.length, initialNodes);
  assert.equal(group.attributes.get('opacity'), '.37');
  f.state.complete = true; f.state.coverage = 2 / 3;
  f.controller.update({ match: { id: 'GF' }, scene: 'double-elimination-match', active: true });
  assert.equal(f.parent.children[0], group); assert.equal(group.attributes.get('opacity'), '.24');
  assert.equal(f.timers.size, 0); assert.equal(f.frames.size, 1);
  f.controller.dispose();
});

test('finale timers, animation frames and listeners are bounded and released off air and on disposal', () => {
  const f = fixture();
  for (let i = 0; i < 30; i++) f.controller.update({ match: { id: 'GF' }, scene: 'grand-final-announcement', active: true });
  assert.equal(f.parent.children.length, 1); assert.equal(f.frames.size, 1); assert.equal(f.timers.size, 1);
  f.document.hidden = true; f.documentListeners.get('visibilitychange')();
  assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
  f.document.hidden = false; f.documentListeners.get('visibilitychange')();
  assert.equal(f.frames.size, 1); assert.equal(f.timers.size, 1);
  f.reduce.matches = true; f.mediaListeners.get('change')();
  assert.equal(f.frames.size, 0); assert.equal(f.canvas.dataset.finaleCoverage, '0.3333');
  assert.ok(!f.classes.has('finale-effects-running'));
  f.controller.update({ match: { id: 'GF' }, scene: 'grand-final-announcement', active: false });
  assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
  f.controller.update({ match: null, scene: 'qualifier-match', active: true });
  assert.ok(!f.classes.has('finale-infected')); assert.equal(f.canvas.dataset.finaleCoverage, '0');
  f.controller.dispose(); f.controller.dispose();
  assert.equal(f.parent.children.length, 0); assert.equal(f.documentListeners.size, 0); assert.equal(f.mediaListeners.size, 0);
  assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0); assert.equal(f.canvas.dataset.finaleActive, 'false');
});

test('layered jitter retains one masked group and a fixed node pool across a hundred frames', () => {
  const f = fixture();
  f.controller.update({ match: { id: 'GF' }, scene: 'grand-final-announcement', active: true });
  const group = f.parent.children[0], layers = depthLayers(group);
  assert.deepEqual(layers.map(layer => layer.attributes.get('data-finale-depth')).sort(), ['body', 'front', 'rear']);
  const count = descendants(group).length;
  assert.ok(count < 96);
  const initial = layers.map(geometry);
  for (let i = 0; i < 100; i++) {
    f.tick();
    assert.equal(f.parent.children.length, 1);
    assert.equal(f.parent.children[0], group);
    assert.equal(descendants(group).length, count);
    assert.equal(f.frames.size, 1);
    assert.equal(f.timers.size, 1);
  }
  layers.forEach((layer, index) => assert.notDeepEqual(geometry(layer), initial[index]));
  f.controller.dispose();
  assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
});

test('reduced motion freezes all depth layers, particles and shards and resumes a single animation loop', () => {
  const f = fixture();
  f.controller.update({ match: { id: 'GF' }, scene: 'grand-final-announcement', active: true });
  f.tick();
  f.reduce.matches = true; f.mediaListeners.get('change')();
  const group = f.parent.children[0], still = geometry(group);
  for (let i = 0; i < 20; i++) {
    f.tick();
    f.controller.update({ match: { id: 'GF' }, scene: 'grand-final-announcement', active: true });
    assert.deepEqual(geometry(group), still);
    assert.equal(f.frames.size, 0);
  }
  f.reduce.matches = false; f.mediaListeners.get('change')();
  assert.equal(f.frames.size, 1);
  f.tick(); assert.notDeepEqual(geometry(group), still);
  f.controller.dispose();
});

test('refreshing after a manual reveal cue change preserves synchronized procedural geometry', () => {
  const existing = fixture(), refreshed = fixture();
  existing.state.coverage = 1 / 3;
  existing.controller.update({ match: { id: 'GF', finalAnnouncement: { id: 'first-cue' } },
    scene: 'grand-final-announcement', active: true });
  for (const f of [existing, refreshed]) {
    f.state.index = 1; f.state.revealedCount = 2; f.state.coverage = 1 / 3;
    f.controller.update({ match: { id: 'GF', finalAnnouncement: { id: 'second-cue' } },
      scene: 'grand-final-announcement', active: true });
  }
  assert.deepEqual(geometry(existing.parent.children[0]), geometry(refreshed.parent.children[0]),
    'cue history must not change geometry rendered for the same match and clock');
  existing.controller.dispose(); refreshed.controller.dispose();
});

test('manual early advance bridges the rising front without a one-frame upward jump', () => {
  const f = fixture();
  f.controller.update({ match: { id: 'GF', finalAnnouncement: { id: 'first' } }, scene: 'grand-final-announcement', active: true });
  const group = f.parent.children[0];
  assert.equal(group.dataset.coverage, '0.1000');
  f.state.index = 1; f.state.revealedCount = 2; f.state.coverage = .35;
  f.controller.update({ match: { id: 'GF', finalAnnouncement: { id: 'second' } }, scene: 'grand-final-announcement', active: true });
  assert.equal(group.dataset.coverage, '0.1000');
  f.tick(); assert.ok(Number(group.dataset.coverage) > .1 && Number(group.dataset.coverage) < .35);
  f.state.coverage = .4;
  for (let i = 0; i < 12; i++) f.tick();
  assert.equal(group.dataset.coverage, '0.4000'); assert.equal(f.frames.size, 1);
  f.controller.dispose();
});

test('final-song corruption supersedes the initial reveal and occupies nearly the whole masked backdrop', () => {
  const f = fixture();
  const match = { id: 'GF', finale: { stage: 'sealed', effectLevel: 0, effectChangedAt: 0 } };
  f.controller.update({ match, scene: 'double-elimination-waiting', active: true });
  const group = f.parent.children[0];
  assert.ok(f.classes.has('finale-sequence-corrupt'));
  assert.equal(f.canvas.dataset.finalePurification, '0');
  assert.equal(group.dataset.coverage, '0.9650');
  const labels = [f.label.textContent];
  f.setTime(2500); f.tick(); labels.push(f.label.textContent);
  assert.notEqual(labels[0], labels[1], 'sealed title changes without a scene rerender');
  assert.equal(f.phaseChanges(), 0);
  assert.ok(descendants(group).some(node => node.attributes.get('id') === 'finale-hope-clearing'));
  assert.ok(!descendants(group).some(node => node.attributes.get('mask') === 'url(#finale-hope-clearing)'),
    'the additional clearing mask should render only during purification');
  assert.equal(group.parent, f.parent, 'the outer stationary capture mask still owns every effect');
  assert.ok(Number(group.dataset.edgeBaseline) < 50);
  f.controller.dispose();
});

test('three purification stages clear outward from centre, stop jitter and retain a bounded node pool', () => {
  const f = fixture(), match = { id: 'GF', finale: { stage: 'revealed', effectLevel: 0, effectChangedAt: 0 } };
  f.controller.update({ match, scene: 'double-elimination-match', active: true });
  const group = f.parent.children[0], count = descendants(group).length, radii = [];
  for (const level of [1, 2, 3]) {
    match.finale.effectLevel = level; match.finale.effectChangedAt = 2000 + level * 5000;
    f.setTime(match.finale.effectChangedAt);
    f.controller.update({ match, scene: 'double-elimination-match', active: true });
    const beginning = Number(group.dataset.hopeRadius);
    assert.ok(descendants(group).some(node => node.attributes.get('mask') === 'url(#finale-hope-clearing)'));
    f.setTime(match.finale.effectChangedAt + Effects.PURIFICATION_MS + 100); f.tick();
    radii.push(Number(group.dataset.hopeRadius));
    assert.ok(radii.at(-1) > beginning);
    assert.equal(descendants(group).length, count);
    assert.equal(f.parent.children.length, 1);
    assert.equal(f.canvas.dataset.finalePurification, String(level));
    assert.equal(f.frames.size, level === 3 ? 0 : 1);
    assert.equal(f.classes.has('finale-effects-running'), level < 3);
  }
  assert.ok(radii[0] < radii[1] && radii[1] < radii[2]);
  assert.ok(radii[2] > Math.hypot(Effects.WIDTH / 2, Effects.HEIGHT / 2 / .79));
  f.controller.dispose();
  assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
});

test('normal toggle clears added effects, while reduced motion freezes heavy corruption and garble', () => {
  const f = fixture(), match = { id: 'GF', finale: { stage: 'sealed', effectLevel: 0, effectChangedAt: 0 } };
  f.reduce.matches = true;
  f.controller.update({ match, scene: 'double-elimination-waiting', active: true });
  const group = f.parent.children[0], before = geometry(group), label = f.label.textContent;
  for (let i = 0; i < 10; i++) {
    f.tick(); f.controller.update({ match, scene: 'double-elimination-waiting', active: true });
    assert.deepEqual(geometry(group), before); assert.equal(f.label.textContent, label);
  }
  assert.equal(f.frames.size, 0);
  match.finale.stage = 'revealed'; match.finale.effectLevel = 4;
  f.controller.update({ match, scene: 'double-elimination-match', active: true });
  assert.equal(f.canvas.dataset.finalePurification, '4');
  assert.equal(group.attributes.get('opacity'), '0');
  assert.ok(!f.classes.has('finale-infected')); assert.ok(!f.classes.has('finale-effects-running'));
  assert.equal(f.label.textContent, 'UNKNOWN SONG');
  assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
  f.controller.dispose();
});

test('center opening and garble are deterministic, finite and bounded over long runtimes', () => {
  for (const level of [0, 1, 2, 3, 4]) {
    const start = Effects.purification(level, 1000, 1000), end = Effects.purification(level, 1000, 1000000);
    assert.ok(Number.isFinite(start.radius) && Number.isFinite(end.radius));
    const path = Effects.hopeContour(end.radius, 86400, 42, level < 3 ? 1 : 0);
    assert.ok(path.length < 6000); assert.doesNotMatch(path, /NaN|Infinity|--/);
  }
  assert.equal(Effects.garbledTitle(2000, 42), Effects.garbledTitle(2000, 42));
  assert.notEqual(Effects.garbledTitle(2000, 42), Effects.garbledTitle(2200, 42));
  assert.equal(Effects.garbledTitle(100000000, 42).length, 16);
});

test('effect phase follows the shared video timeline into revealed without mutating match state', () => {
  const FinalSequence = require('../public/js/final-sequence');
  const match = { id: 'GF', finalMode: 'fixed-two', finale: { stage: 'video', effectLevel: 0, effectChangedAt: 1000,
    videoCue: { id: '22222222-2222-4222-8222-222222222222', startedAt: 1000, duration: 1 } } };
  const before = JSON.stringify(match);
  assert.equal(Effects.sequencePhase(match, 1500, FinalSequence).stage, 'video');
  assert.equal(Effects.sequencePhase(match, 2100, FinalSequence).stage, 'revealed');
  assert.equal(Effects.sequencePhase(match, 2100, FinalSequence).involved, true);
  assert.equal(JSON.stringify(match), before);
});
