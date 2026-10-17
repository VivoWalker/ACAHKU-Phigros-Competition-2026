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
  const canvas = { ownerDocument: document, dataset: {},
    querySelector: selector => selector === '.broadcast-backdrop > g[mask]' ? parent : null,
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
    mediaListeners, reduce, tick, poll, phaseChanges: () => phaseChanges };
}

test('finale front morphs with bounded pixel geometry and a two-thirds terminal extent', () => {
  assert.ok(Math.abs(Effects.contour(1 / 3, 0).baseline - 720) < 1e-9);
  assert.ok(Math.abs(Effects.contour(2 / 3, 0).baseline - 360) < 1e-9);
  assert.equal(Effects.contour(100, 0).baseline, Effects.contour(2 / 3, 0).baseline);
  assert.notEqual(Effects.contour(2 / 3, 0).edge, Effects.contour(2 / 3, 3).edge);
  for (const seconds of [0, 1, 120, 86400]) {
    const path = Effects.contour(2 / 3, seconds);
    assert.ok(path.area.length < 1600);
    assert.equal((path.edge.match(/H/g) || []).length, 80);
    assert.doesNotMatch(path.area, /NaN|Infinity/);
    assert.equal((Effects.pixelPath(seconds).match(/M/g) || []).length, Effects.PIXELS);
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
