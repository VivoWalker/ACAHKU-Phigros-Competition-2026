const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the registry's ownership without a layout engine. Full animation
// and clipping remain covered by the real-browser motion/layout regression.
function fixture() {
  let notify;
  const media = { matches: false, addEventListener(event, listener) { this.changed = listener; } };
  function element() {
    return {
      dataset: {}, style: {}, children: [], isConnected: true,
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { this.children = nodes; },
      remove() { this.removed = true; this.isConnected = false; },
      contains() { return false; }, querySelectorAll() { return []; }
    };
  }
  const context = { window: {}, document: { createElement: element, documentElement: {} },
    matchMedia: () => media, MutationObserver: class { constructor(callback) { notify = callback; } observe() {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/motion.js'), 'utf8'), context);
  return { api: context.window.BroadcastMotion, element, media, notify: () => notify() };
}

test('scene disposal unregisters controllers, clears owned DOM and settles idle requests', async () => {
  const f = fixture(); let callbacks = 0;
  for (let index = 0; index < 100; index++) {
    const mount = f.element(), controller = f.api.createScene(mount);
    controller.reduced = () => callbacks++;
    assert.equal(mount.children.length, 2);
    controller.dispose(); controller.dispose();
    assert.ok(mount.children.every(node => node.removed && node.children.length === 0));
    assert.equal((await controller.update('<p>Do not remount</p>')).superseded, true);
    await controller.idle();
  }
  f.media.matches = true; f.media.changed();
  assert.equal(callbacks, 0);
});

test('detaching an established scene automatically unregisters it without interrupting connected peers', () => {
  const f = fixture(), removed = f.element(), retained = f.element(); let removedCalls = 0, retainedCalls = 0;
  const outgoing = f.api.createScene(removed), live = f.api.createScene(retained);
  outgoing.reduced = () => removedCalls++; live.reduced = () => retainedCalls++;
  removed.isConnected = false; f.notify();
  assert.ok(removed.children.every(node => node.removed));
  assert.ok(retained.children.every(node => !node.removed));
  f.media.matches = true; f.media.changed();
  assert.equal(removedCalls, 0); assert.equal(retainedCalls, 1);
  live.dispose();
});
