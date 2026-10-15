const test = require('node:test');
const assert = require('node:assert/strict');
const { createController, imagePath } = require('../public/js/media-warmup');

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const asset = name => `/assets/song/${name}.webp`;

function fixture(t, options = {}) {
  let clock = 0, serial = 0;
  const timers = new Map(), images = [], statuses = [];
  const setTimer = (callback, delay) => {
    const id = ++serial; timers.set(id, { callback, at: clock + delay }); return id;
  };
  const clearTimer = id => timers.delete(id);
  class Picture {
    constructor() {
      this.decoding = ''; this.decodeCalls = 0; this.sourceChanges = [];
      this.promise = new Promise((resolve, reject) => {
        this.complete = () => { this.onload?.(); resolve(); };
        this.fail = error => { this.onerror?.(); if (this.decodeCalls) reject(error); };
      });
    }
    set src(value) { this.source = value; this.sourceChanges.push(value); }
    get src() { return this.source; }
    decode() { this.decodeCalls++; return this.promise; }
    removeAttribute(name) { if (name === 'src') this.source = ''; }
  }
  const controller = createController({
    origin: 'http://broadcast.test',
    createImage: () => { const image = new Picture(); images.push(image); return image; },
    setTimer, clearTimer,
    requestIdle: callback => setTimer(callback, 32), cancelIdle: clearTimer,
    onStatus: status => statuses.push(status),
    ...options
  });
  t.after(() => controller.dispose());
  function advance(milliseconds) {
    const until = clock + milliseconds;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); clock = next[1].at; next[1].callback();
    }
    clock = until;
  }
  return { controller, images, timers, statuses, advance };
}

test('image warming accepts local asset images and rejects remote or escaped asset paths', () => {
  const origin = 'http://broadcast.test';
  assert.equal(imagePath('assets/song/title.webp', origin), '/assets/song/title.webp');
  assert.equal(imagePath('http://broadcast.test/assets/song/title.webp', origin), '/assets/song/title.webp');
  assert.equal(imagePath('/assets/club/Soc%20Logo.png', origin), '/assets/club/Soc%20Logo.png');
  for (const value of ['https://other.test/assets/a.png', '//other.test/assets/a.png', 'data:image/png;base64,AA', 'javascript:alert(1)', '/assets/../secret.png', '/assets/%2e%2e/secret.png', '/assets/a%5cb.png', '/assets/a.png\n', '/data/a.png', '/assets/song/a.mp3']) {
    assert.equal(imagePath(value, origin), '', value);
  }
});

test('background targets wait for idle time and decode with a concurrency limit of two', async t => {
  const f = fixture(t);
  f.controller.setImages(['a', 'b', 'c', 'd'].map(asset));
  assert.equal(f.images.length, 0);
  f.advance(32); assert.equal(f.images.length, 2);
  assert.equal(f.controller.status().loading, 2);
  assert.equal(f.controller.status().pending, 2);
  f.images[0].complete(); await flush(); f.advance(32);
  assert.equal(f.images.length, 3); assert.equal(f.controller.status().loading, 2);
  f.images[1].complete(); f.images[2].complete(); await flush(); f.advance(32);
  assert.equal(f.images.length, 4);
  f.images[3].complete(); await flush();
  assert.equal(f.controller.status().ready, 4); assert.equal(f.controller.status().targetPending, 0);
  assert.ok(f.statuses.every(status => status.loading <= 2));
});

test('repeated state updates and simultaneous cover requests share the same decode', async t => {
  const f = fixture(t);
  f.controller.setImages([asset('a'), asset('a')]);
  for (let i = 0; i < 40; i++) f.controller.setImages([asset('a')]);
  const first = f.controller.decodeImage(asset('a'));
  const second = f.controller.decodeImage('assets/song/a.webp');
  assert.equal(first, second); assert.equal(f.images.length, 1);
  f.images[0].complete(); const decoded = await first;
  assert.equal(decoded.image, f.images[0]); assert.equal(decoded.ok, true);
  assert.equal(f.controller.getDecoded(asset('a')), f.images[0]);
  await f.controller.decodeImage(asset('a'));
  assert.equal(f.images.length, 1); assert.equal(f.images[0].decodeCalls, 1);
});

test('current targets have priority and newer candidate draws cancel queued stale songs', async t => {
  const f = fixture(t);
  f.controller.setImages(['old-a', 'old-b', 'old-c', 'old-d'].map(asset));
  f.advance(32);
  f.controller.setImages(['new-a', 'new-b', 'new-c'].map(asset), { priority: [asset('new-c')] });
  assert.equal(f.controller.status().pending, 3);
  f.images[0].complete(); await flush(); f.advance(32);
  assert.equal(f.images[2].src, asset('new-c'));
  assert.ok(!f.images.some(image => image.src === asset('old-c') || image.src === asset('old-d')));
  f.images[1].complete(); f.images[2].complete(); await flush(); f.advance(32);
  assert.deepEqual(f.images.slice(3).map(image => image.src), [asset('new-a'), asset('new-b')]);
});

test('new scenes settle preparation promises for cancelled queued assets without waiting for downloads', async t => {
  const f = fixture(t);
  f.controller.setImages(['loading-a', 'loading-b'].map(asset)); f.advance(32);
  const stale = f.controller.prepare(['old-a', 'old-b'].map(asset));
  assert.equal(f.controller.status().pending, 2);
  f.controller.setImages([asset('new')]);
  assert.deepEqual((await stale).map(result => result.ok), [false, false]);
  assert.equal(f.images.length, 2); assert.equal(f.controller.status().pending, 1);
});

test('the retained cache is bounded, uses LRU order, and prefers keeping pinned logos', async t => {
  const f = fixture(t, { maxDecoded: 3 });
  f.controller.setImages([asset('logo'), asset('a'), asset('b')], { pinned: [asset('logo')] });
  f.advance(32); f.images[0].complete(); f.images[1].complete(); await flush(); f.advance(32);
  f.images[2].complete(); await flush();
  assert.equal(f.controller.status().ready, 3);
  f.controller.getDecoded(asset('a'));
  const next = f.controller.decodeImage(asset('c'));
  assert.equal(f.controller.getDecoded(asset('b')), null);
  assert.ok(f.controller.getDecoded(asset('logo')));
  assert.equal(f.controller.status().ready + f.controller.status().loading, 3);
  f.images[3].complete(); await next;
  assert.equal(f.controller.status().targetPending, 0);
  for (let index = 0; index < 15; index++) {
    const done = f.controller.decodeImage(asset('extra-' + index));
    f.images.at(-1).complete(); await done;
    assert.equal(f.controller.status().ready, 3);
  }
  assert.ok(f.controller.getDecoded(asset('logo')));
  assert.ok(f.statuses.every(status => status.ready + status.loading <= 3));
});

test('a supplied whole-library list is capped instead of decoding every jacket', async t => {
  const f = fixture(t);
  f.controller.setImages(Array.from({ length: 49 }, (_, index) => asset(index)), { priority: [asset(48)] });
  assert.equal(f.controller.status().total, 12);
  for (let round = 0; round < 6; round++) {
    f.advance(32);
    f.images.filter(image => !image.done).forEach(image => { image.done = true; image.complete(); });
    await flush();
  }
  assert.equal(f.images.length, 12); assert.equal(f.images[0].src, asset(48));
  assert.equal(f.controller.status().ready, 12);
});

test('rapid explicit cover requests have a bounded queue while decoders stall and obsolete requests settle', async t => {
  const f = fixture(t, { maxDecoded: 4 });
  const requests = Array.from({ length: 80 }, (_, index) => f.controller.decodeImage(asset('burst-' + index)));
  assert.equal(f.images.length, 2);
  assert.equal(f.controller.status().loading, 2);
  assert.equal(f.controller.status().pending, 4);
  const cancelled = await Promise.all(requests.slice(2, -4));
  assert.ok(cancelled.every(result => !result.ok));
  for (let round = 0; round < 3; round++) {
    f.images.filter(image => !image.done).forEach(image => { image.done = true; image.complete(); });
    await flush(); f.advance(32);
  }
  const results = await Promise.all(requests);
  assert.deepEqual(results.filter(result => result.ok).map(result => result.src), [0, 1, 76, 77, 78, 79].map(index => asset('burst-' + index)));
  assert.equal(f.images.length, 6);
  assert.equal(f.controller.status().pending, 0);
  assert.ok(f.statuses.every(status => status.loading <= 2 && status.pending <= 4 && status.loading + status.ready <= 4));
});

test('failed or stalled media never blocks preparation, and state updates do not retry failures', async t => {
  const f = fixture(t, { timeoutMs: 200 });
  f.controller.setImages([asset('broken'), asset('stalled')]);
  const ready = f.controller.prepare([asset('broken'), asset('stalled')]);
  f.images[0].fail(new Error('bad image')); await flush();
  f.advance(200);
  assert.deepEqual((await ready).map(result => result.ok), [false, false]);
  for (let i = 0; i < 20; i++) f.controller.setImages([asset('broken'), asset('stalled')]);
  f.advance(1000); assert.equal(f.images.length, 2);
  assert.equal(f.controller.status().failed, 2); assert.equal(f.controller.status().targetPending, 0);
  assert.equal(f.images[1].src, '');
  f.images[1].complete(); await flush(); assert.equal(f.controller.status().ready, 0);
});

test('old browsers without Image.decode use onload and still handle errors', async t => {
  const images = [];
  const f = fixture(t, { createImage: () => { const image = {}; images.push(image); return image; } });
  const ready = f.controller.prepare([asset('a'), asset('b')]);
  images[0].onload(); images[1].onerror();
  assert.deepEqual((await ready).map(result => result.ok), [true, false]);
});

test('font warmup loads the four actual Saira weights only once and waits for font readiness', async t => {
  const calls = [];
  let finishReady;
  const f = fixture(t, { fonts: { load: (font, text) => { calls.push([font, text]); return Promise.resolve([{}]); }, ready: new Promise(resolve => { finishReady = resolve; }) } });
  const first = f.controller.prepareFonts();
  assert.equal(first, f.controller.prepareFonts()); await flush();
  assert.deepEqual(calls.map(([font]) => font), [400, 500, 600, 700].map(weight => `${weight} 32px Saira`));
  assert.equal(f.controller.status().fonts, 'loading');
  finishReady(); assert.equal(await first, true); assert.equal(f.controller.status().fonts, 'ready');
  assert.equal(f.timers.size, 0);
});

test('font errors, hanging fonts.ready and missing font APIs do not leave startup pending', async t => {
  const failed = fixture(t, { timeoutMs: 100, fonts: { load: () => Promise.reject(new Error('font missing')), ready: Promise.resolve() } });
  assert.equal(await failed.controller.prepareFonts(), false);
  const stalled = fixture(t, { timeoutMs: 100, fonts: { load: () => Promise.resolve([]), ready: new Promise(() => {}) } });
  const done = stalled.controller.prepareFonts(); await flush(); stalled.advance(100);
  assert.equal(await done, false); assert.equal(stalled.controller.status().fonts, 'failed');
  const absent = fixture(t, { fonts: null }); assert.equal(await absent.controller.prepareFonts(), false);
});

test('font timeout can be shorter than image timeout to keep startup bounded', async t => {
  const f = fixture(t, { timeoutMs: 4500, fontTimeoutMs: 1800, fonts: { load: () => new Promise(() => {}), ready: new Promise(() => {}) } });
  const ready = f.controller.prepareFonts();
  f.advance(1799); assert.equal(f.controller.status().fonts, 'loading');
  f.advance(1); assert.equal(await ready, false); assert.equal(f.timers.size, 0);
});

test('disposal cancels queued loads, clears timers and settles in-flight image/font promises', async t => {
  const f = fixture(t, { fonts: { load: () => new Promise(() => {}), ready: new Promise(() => {}) } });
  f.controller.setImages(['a', 'b', 'c'].map(asset));
  const ready = f.controller.decodeImage(asset('a'));
  const fonts = f.controller.prepareFonts();
  assert.equal(f.images.length, 2);
  f.controller.dispose();
  assert.equal((await ready).ok, false); assert.equal(await fonts, false);
  assert.equal(f.timers.size, 0);
  f.advance(10000); assert.equal(f.images.length, 2); assert.equal(f.controller.status().ready, 0);
  assert.equal((await f.controller.decodeImage(asset('new'))).ok, false);
});

test('cancelling an in-flight image explicitly empties its source and removes event handlers', async t => {
  const f = fixture(t);
  const ready = f.controller.prepare([asset('cancel-a'), asset('cancel-b')]);
  assert.ok(f.images.every(image => image.decodeCalls === 1));
  f.controller.dispose();
  assert.ok((await ready).every(result => !result.ok));
  assert.ok(f.images.every(image => image.onload === null && image.onerror === null && image.sourceChanges.at(-1) === ''));
  f.images.forEach(image => image.complete()); await flush();
  assert.equal(f.controller.status().ready, 0);
});
