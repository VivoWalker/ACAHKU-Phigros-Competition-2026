(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BroadcastFinaleEffects = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const WIDTH = 1920, HEIGHT = 1080, FRAME_MS = 50, PIXELS = 220, SEGMENTS = 160;
  const PURIFICATION_MS = 2300, INVASION_MS = 1800, HOLE_TILE = 48, HOLE_PIXEL = 8;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const random = index => { const value = Math.sin(index * 127.1 + 311.7) * 43758.5453; return value - Math.floor(value); };
  const ease = value => value * value * (3 - 2 * value);
  const mix = (a, b, value) => a + (b - a) * value;
  // Clock-sampled noise keeps independent OBS sources in sync. No random
  // timers, geometry accumulation or full-screen turbulence filters are used.
  function noise(x, time, seed) {
    const cell = Math.floor(x), tick = Math.floor(time), px = ease(x - cell), pt = ease(time - tick);
    const sample = (a, b) => random(a * 17.17 + b * 93.31 + seed);
    return mix(mix(sample(cell, tick), sample(cell + 1, tick), px),
      mix(sample(cell, tick + 1), sample(cell + 1, tick + 1), px), pt) * 2 - 1;
  }

  // Unequal steps, broad advancing lobes and short local tears keep the front
  // organic. Each depth moves independently; the capture mask stays stationary.
  function contour(coverage, seconds = 0, depth = 0, seed = 0, maximum = 2 / 3) {
    const base = HEIGHT * (1 - clamp(coverage, 0, maximum));
    const top = [], step = WIDTH / SEGMENTS, layerSeed = seed + depth * 151;
    for (let i = 0; i <= SEGMENTS; i++) {
      const x = i === 0 || i === SEGMENTS ? i * step : i * step + Math.round((random(i * 11 + seed) - .5) * 4) * 2;
      const tick = Math.floor(seconds * 7 + random(i + 71));
      const tear = random(Math.floor(i / 3) * 43 + tick * 13 + layerSeed) > .84
        ? (random(i * 19 + tick * 31 + layerSeed) - .5) * 38 : 0;
      const wave = noise(i * .075, seconds * .47, seed + 31) * 56
        + noise(i * .32, seconds * 1.25, layerSeed + 113) * 27
        + noise(i * 1.71, seconds * 4.3, layerSeed + 281) * 13 + tear;
      top.push([x, Math.round(clamp(base + depth * 28 + wave, maximum > 2 / 3 ? 12 : 180, HEIGHT + 96) / 2) * 2]);
    }
    let edge = `M0 ${top[0][1]}`;
    for (const [x, y] of top.slice(1)) edge += `H${x}V${y}`;
    return { edge, area: `${edge}V${HEIGHT + 96}H0Z`, baseline: base, points: top };
  }
  function pixelPath(seconds = 0, depth = 1, seed = 0, count = PIXELS) {
    let result = '';
    for (let i = 0; i < count; i++) {
      const drift = noise(i * 1.7, seconds * .7, seed + 78) * (8 + depth * 10);
      const x = Math.round((random(i + 1 + seed) * WIDTH + drift) / 2) * 2;
      const speed = (12 + random(i + 501) * 25) * depth;
      const y = Math.round(((random(i + 221) * (HEIGHT + 80) - seconds * speed) % (HEIGHT + 80) + HEIGHT + 80) % (HEIGHT + 80) / 4) * 4;
      const size = Math.max(1, Math.round((random(i + 901) > .9 ? 7 : random(i + 101) > .55 ? 4 : 2) * depth));
      result += `M${x} ${y}h${size}v${size}h-${size}Z`;
    }
    return result;
  }
  function fragmentPath(points, seconds = 0, seed = 0) {
    let result = '';
    for (let i = 0; i < 14; i++) {
      const cycle = seconds * (.32 + random(i + 71) * .28) + random(i + seed);
      const age = cycle - Math.floor(cycle), tick = Math.floor(cycle), salt = seed + i * 57 + tick * 131;
      const index = 3 + Math.floor(random(salt + 1) * (points.length - 7));
      const x = Math.round((points[index][0] + noise(i * 7, seconds * 2, salt) * 14) / 2) * 2;
      const y = Math.round((points[index][1] - 12 - age * 86) / 2) * 2;
      const notch = 2 + Math.round(random(salt + 33) * 3) * 2;
      const w = Math.max(notch * 2 + 4, 12 + Math.round(random(salt + 7) * 25) * 2), h = 6 + Math.round(random(salt + 13) * 9) * 2;
      result += `M${x} ${y}h${notch}v-4h${w - notch * 2}v4h${notch}v${h - 4}h-${notch}v4h-${w - notch * 2}v-4h-${notch}Z`;
    }
    return result;
  }
  function tearPath(seconds = 0, seed = 0) {
    let result = '';
    for (let i = 0; i < 18; i++) {
      const tick = Math.floor(seconds * 5 + random(i + 91)), salt = i * 51 + tick * 73 + seed;
      const x = Math.round(random(salt) * WIDTH / 4) * 4, y = Math.round(random(salt + 13) * HEIGHT / 4) * 4;
      const width = 24 + Math.round(random(salt + 31) * 35) * 4, height = 2 + Math.round(random(salt + 71) * 4) * 2;
      result += `M${x} ${y}h${width}v${height}h-${width}Z`;
    }
    return result;
  }

  let cachedHoleSeed, cachedHoleLayout, pendingHoleSeed, pendingHoleLayout;
  const holeHash = (x, y, seed) => {
    let value = Math.imul(x ^ seed, 374761393) ^ Math.imul(y, 668265263);
    value = Math.imul(value ^ value >>> 13, 1274126177);
    return ((value ^ value >>> 16) >>> 0) / 4294967296;
  };
  function holeNoise(x, y, seed) {
    const ix = Math.floor(x), iy = Math.floor(y), px = ease(x - ix), py = ease(y - iy);
    return mix(mix(holeHash(ix, iy, seed), holeHash(ix + 1, iy, seed), px),
      mix(holeHash(ix, iy + 1, seed), holeHash(ix + 1, iy + 1, seed), px), py);
  }
  function holeCell(x, y, seed) {
    const ix = Math.floor(x), iy = Math.floor(y);
    let nearest = 4;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx, cy = iy + dy;
      const sx = cx + .12 + holeHash(cx, cy, seed) * .76 - x;
      const sy = cy + .12 + holeHash(cx, cy, seed + 97) * .76 - y;
      nearest = Math.min(nearest, sx * sx + sy * sy);
    }
    return Math.min(1, Math.sqrt(nearest));
  }
  function* buildHoleLayout(seed) {
    const columns = WIDTH / HOLE_PIXEL, rows = HEIGHT / HOLE_PIXEL, salt = seed | 0;
    const thresholds = new Float32Array(columns * rows), order = Array.from(thresholds, (_, index) => index);
    // A warped field has no rectangular parent tiles. Broad openings, narrow
    // necks and small detached pixels share the same progressive threshold.
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        const wx = x + (holeNoise(x / 29, y / 23, salt + 41) - .5) * 25
          + (holeNoise(x / 9, y / 11, salt + 83) - .5) * 7;
        const wy = y + (holeNoise(x / 27, y / 21, salt + 137) - .5) * 22
          + (holeNoise(x / 12, y / 8, salt + 191) - .5) * 6;
        thresholds[y * columns + x] = holeNoise(wx / 19, wy / 17, salt + 229) * .37
          + holeNoise(wx / 7.3, wy / 8.7, salt + 311) * .25
          + holeNoise(wx / 2.7, wy / 3.1, salt + 431) * .16
          + holeCell(wx / 11.7, wy / 10.3, salt + 569) * .12
          + holeHash(x, y, salt + 683) * .1;
      }
      yield;
    }
    // Sparse ragged data tears break the rounded noise contours without
    // creating a repeated row grid or one giant clean horizontal aperture.
    for (let tear = 0; tear < 27; tear++) {
      const x0 = Math.floor(holeHash(tear, 0, salt + 719) * columns);
      const y0 = Math.floor(holeHash(tear, 1, salt + 719) * rows);
      const width = 7 + Math.floor(holeHash(tear, 2, salt + 719) * 22);
      for (let dx = 0; dx < width && x0 + dx < columns; dx++) {
        const y = y0 + (holeHash(dx, tear, salt + 761) > .76 ? 1 : 0);
        if (y < rows && holeHash(dx, tear, salt + 809) > .18)
          thresholds[y * columns + x0 + dx] -= .09 + holeHash(dx, tear, salt + 857) * .12;
      }
    }
    // Rank normalization preserves useful stage coverage for every seed while
    // retaining the field's irregular topology. A fixed clock remains nested.
    yield;
    order.sort((a, b) => thresholds[a] - thresholds[b] || a - b);
    order.forEach((index, rank) => { thresholds[index] = .001 + .998 * rank / (order.length - 1); });
    return { thresholds };
  }
  function prepareHoleLayout(seed, steps = 2) {
    if (cachedHoleLayout && cachedHoleSeed === seed) return cachedHoleLayout;
    if (!pendingHoleLayout || pendingHoleSeed !== seed) {
      pendingHoleSeed = seed; pendingHoleLayout = buildHoleLayout(seed);
    }
    for (let step = 0; step < steps; step++) {
      const next = pendingHoleLayout.next();
      if (!next.done) continue;
      // At most one completed field and one in-progress field are retained.
      cachedHoleSeed = seed; cachedHoleLayout = next.value;
      pendingHoleSeed = undefined; pendingHoleLayout = undefined;
      return cachedHoleLayout;
    }
  }
  function holeLayout(seed) {
    let layout;
    // An immediate stage change can finish the already-prepared rows without
    // restarting work. Normal reveals have ample time to prepare every row.
    while (!(layout = prepareHoleLayout(seed, 1))) { /* drain the bounded field */ }
    return layout;
  }
  function pixelHoles(amount, seed = 0, seconds = 0, motion = 1) {
    const value = clamp(amount, 0, 1);
    const columns = WIDTH / HOLE_PIXEL, rows = HEIGHT / HOLE_PIXEL;
    const total = Math.ceil(WIDTH / HOLE_TILE) * Math.ceil(HEIGHT / HOLE_TILE);
    if (value === 0) return { mask: '', edge: '', rects: [], cleared: 0,
      total, clearance: 0 };
    if (value === 1) return { mask: `M0 0h${WIDTH}v${HEIGHT}h-${WIDTH}Z`,
      edge: `M0 0H${WIDTH}V${HEIGHT}H0Z`, rects: [[0, 0, WIDTH, HEIGHT]], cleared: total, total, clearance: 1 };
    const { thresholds } = holeLayout(seed), pixels = new Uint8Array(thresholds.length);
    const counts = new Uint8Array(total), tileColumns = Math.ceil(WIDTH / HOLE_TILE);
    const jitter = clamp(motion, 0, 1) * .068, tick = Math.floor(seconds * 9), salt = seed | 0;
    let area = 0;
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
      const index = y * columns + x, threshold = thresholds[index];
      // Local bursts move a few neighboring pixels together; independent
      // fragments chatter around them. Only the active frontier changes, so
      // healed interiors do not flash wholesale back into corruption.
      const offset = jitter && Math.abs(value - threshold) <= jitter
        ? ((holeHash(Math.floor(x / 3), Math.floor(y / 2), salt + tick * 157 + 911) * 2 - 1) * .65
          + (holeHash(x, y, salt + tick * 263 + 1013) * 2 - 1) * .35) * jitter : 0;
      if (value <= threshold + offset) continue;
      pixels[index] = 1; area++;
      counts[Math.floor(y / 6) * tileColumns + Math.floor(x / 6)]++;
    }
    // Merge row runs and matching runs above into a bounded SVG path, rather
    // than adding thousands of DOM nodes or stroking internal grid lines.
    const rects = [];
    let previous = new Map();
    for (let y = 0; y < rows; y++) {
      const current = new Map();
      for (let x = 0; x < columns;) {
        if (!pixels[y * columns + x]) { x++; continue; }
        const start = x;
        while (x < columns && pixels[y * columns + x]) x++;
        const key = start * columns + x, above = previous.get(key);
        const rectangle = above || [start * HOLE_PIXEL, y * HOLE_PIXEL, (x - start) * HOLE_PIXEL, 0];
        rectangle[3] += HOLE_PIXEL;
        if (!above) rects.push(rectangle);
        current.set(key, rectangle);
      }
      previous = current;
    }
    let mask = '', edge = '', cleared = 0;
    for (const [x, y, width, height] of rects) mask += `M${x} ${y}h${width}v${height}h-${width}Z`;
    // Keep a matching exposed-edge path for diagnostics. The rendered mask
    // itself adds no glow, luminous borders or internal grid lines.
    for (let y = 0; y <= rows; y++) for (let x = 0; x < columns;) {
      const exposed = at => !!(y > 0 && pixels[(y - 1) * columns + at]) !== !!(y < rows && pixels[y * columns + at]);
      if (!exposed(x)) { x++; continue; }
      const start = x;
      while (x < columns && exposed(x)) x++;
      edge += `M${start * HOLE_PIXEL} ${y * HOLE_PIXEL}h${(x - start) * HOLE_PIXEL}`;
    }
    for (let x = 0; x <= columns; x++) for (let y = 0; y < rows;) {
      const exposed = at => !!(x > 0 && pixels[at * columns + x - 1]) !== !!(x < columns && pixels[at * columns + x]);
      if (!exposed(y)) { y++; continue; }
      const start = y;
      while (y < rows && exposed(y)) y++;
      edge += `M${x * HOLE_PIXEL} ${start * HOLE_PIXEL}v${(y - start) * HOLE_PIXEL}`;
    }
    for (let index = 0; index < total; index++) {
      const height = Math.min(6, rows - Math.floor(index / tileColumns) * 6);
      if (counts[index] === 6 * height) cleared++;
    }
    return { mask, edge, rects, cleared, total, clearance: area / pixels.length };
  }
  function sequencePhase(match, time, api) {
    const raw = api?.phase?.(match, time) || match?.finale;
    const stage = raw?.stage || raw?.effectiveStage || 'base';
    const involved = match?.id === 'GF' && ['sealed', 'video', 'revealed'].includes(stage);
    const effectLevel = clamp(Number.isInteger(match?.finale?.effectLevel) ? match.finale.effectLevel : 0, 0, 4);
    return { stage, involved, effectLevel, changedAt: match?.finale?.effectChangedAt || 0 };
  }
  function purification(level, changedAt, time) {
    const amounts = [0, .28, .65, 1, 0];
    if (level === 0 || level === 4) return { amount: 0, progress: 1 };
    const progress = ease(clamp((time - changedAt) / PURIFICATION_MS, 0, 1));
    return { amount: mix(amounts[level - 1], amounts[level], progress), progress };
  }
  function garbledTitle(time, seed = 0) {
    const symbols = '01░▒▓█/\\≠∅∆◇※#@$%?';
    const tick = Math.floor(time / 120);
    return Array.from({ length: 16 }, (_, index) => symbols[Math.floor(random(tick * 71 + index * 17 + seed) * symbols.length)]).join('');
  }

  function createController({ canvas, now = () => Date.now(), onPhaseChange = () => {} } = {}) {
    const document = canvas.ownerDocument, window = document.defaultView;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const svgNS = 'http://www.w3.org/2000/svg';
    let match, scene = '', active = false, disposed = false, frame = 0, timer = 0, lastFrame = 0;
    let group, shape, outline, glow, particles, shade, rearShape, rearEdge, rearParticles,
      frontShade, frontEdge, fragments, fragmentShadow, tears, texture;
    let phaseKey = '', target = 0, value = 0, cueId, bridge, effectSeed = 0;
    let sequenceKey = '', sequence = {}, redLayer, hopeMask;
    const originalLabels = new WeakMap();
    const phase = () => window.BroadcastFinalAnnouncement.phase(match, now());
    const finalSequence = () => sequencePhase(match, now(), window.BroadcastFinalSequence);
    const eligible = () => (sequence.involved || window.BroadcastFinalAnnouncement.isFixed(match))
      && scene !== 'start' && !scene.startsWith('qualifier-');
    const key = state => `${state.started ? 1 : 0}:${state.pending ? 1 : 0}:${state.index}`;
    const node = (name, attributes) => {
      const element = document.createElementNS(svgNS, name);
      for (const [name, value] of Object.entries(attributes || {})) element.setAttribute(name, value);
      return element;
    };
    function attach() {
      if (group?.isConnected) return true;
      const parent = canvas.querySelector('.broadcast-backdrop > g[mask]');
      if (!parent) return false;
      group = node('g', { 'data-finale-effects': '', 'pointer-events': 'none', opacity: '0' });
      const definitions = node('defs'), clip = node('clipPath', { id: 'finale-invasion-clip', clipPathUnits: 'userSpaceOnUse' });
      shape = node('path'); clip.append(shape); definitions.append(clip);
      const rearClip = node('clipPath', { id: 'finale-invasion-rear-clip', clipPathUnits: 'userSpaceOnUse' });
      rearShape = node('path'); rearClip.append(rearShape); definitions.append(rearClip);
      const gradient = node('linearGradient', { id: 'finale-invasion-red', x1: '0', y1: '0', x2: '0', y2: '1' });
      gradient.append(node('stop', { 'stop-color': '#b8172b' }), node('stop', { offset: '.22', 'stop-color': '#850b1c' }),
        node('stop', { offset: '.65', 'stop-color': '#480510' }), node('stop', { offset: '1', 'stop-color': '#24010a' }));
      definitions.append(gradient);
      const clearing = node('mask', { id: 'finale-hope-clearing', maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: WIDTH, height: HEIGHT });
      clearing.append(node('rect', { width: WIDTH, height: HEIGHT, fill: 'white' }));
      hopeMask = node('path', { fill: 'black' }); clearing.append(hopeMask); definitions.append(clearing);
      group.append(definitions);
      redLayer = node('g', { 'data-finale-corruption': '' }); group.append(redLayer);
      const rear = node('g', { 'data-finale-depth': 'rear' });
      const rearFill = node('g', { 'clip-path': 'url(#finale-invasion-rear-clip)' });
      rearFill.append(node('rect', { width: WIDTH, height: HEIGHT, fill: '#510814', opacity: '.7' }));
      rearParticles = node('path', { fill: '#d53146', opacity: '.48' }); rearFill.append(rearParticles);
      rearEdge = node('path', { fill: 'none', stroke: '#a31d32', 'stroke-width': '2', opacity: '.65' });
      rear.append(rearFill, rearEdge); redLayer.append(rear);
      const body = node('g', { 'data-finale-depth': 'body' });
      const fill = node('g', { 'clip-path': 'url(#finale-invasion-clip)' });
      fill.append(node('rect', { width: WIDTH, height: HEIGHT, fill: 'url(#finale-invasion-red)' }));
      // The bundled reference texture supplies the fine grain. Its original
      // top edge is outside our viewport: the live procedural edge owns shape.
      texture = node('image', { 'data-finale-texture': '', href: '/assets/finale/error-texture.png',
        x: '-48', y: '-408', width: '2016', height: '1536', opacity: '.5', preserveAspectRatio: 'xMidYMid slice' });
      fill.append(texture);
      tears = node('path', { 'data-finale-tears': '', fill: '#1c000b', opacity: '.32' });
      particles = node('path', { fill: '#ff667a', opacity: '.72' }); fill.append(tears, particles); body.append(fill);
      glow = node('path', { fill: 'none', stroke: '#ff183d', 'stroke-width': '9', opacity: '.34' });
      outline = node('path', { fill: 'none', stroke: '#ffb3bb', 'stroke-width': '1.5', opacity: '.8' });
      body.append(glow, outline); redLayer.append(body);
      const front = node('g', { 'data-finale-depth': 'front' });
      const frontFill = node('g', { 'clip-path': 'url(#finale-invasion-clip)' });
      frontShade = node('path', { fill: '#27010d', opacity: '.34' });
      frontEdge = node('path', { fill: 'none', stroke: '#ed334e', 'stroke-width': '1', opacity: '.24' });
      frontFill.append(frontShade, frontEdge); front.append(frontFill);
      fragmentShadow = node('path', { fill: '#26010b', opacity: '.7', transform: 'translate(5 8)' });
      fragments = node('path', { 'data-finale-fragments': '', fill: '#bc142e', stroke: '#ff6579', 'stroke-width': '1', opacity: '.66' });
      front.append(fragmentShadow, fragments); redLayer.append(front);
      // Dimming is local to the infected pixels, never a full-canvas filter.
      shade = node('rect', { 'data-finale-shade': '', width: WIDTH, height: HEIGHT, fill: '#10070d', opacity: '0', 'clip-path': 'url(#finale-invasion-clip)' });
      redLayer.append(shade);
      parent.append(group); return true;
    }
    function stopFrame() { if (frame) window.cancelAnimationFrame(frame); frame = 0; lastFrame = 0; }
    function stopTimer() { if (timer) window.clearTimeout(timer); timer = 0; }
    function updateGarble() {
      const sealed = sequence.involved && ['sealed', 'video'].includes(sequence.stage);
      for (const element of canvas.querySelectorAll?.('[data-finale-garbled]') || []) {
        if (!originalLabels.has(element)) originalLabels.set(element, element.textContent);
        if (!sealed) { element.textContent = originalLabels.get(element); continue; }
        const text = reduce.matches || sequence.effectLevel >= 3 ? '▓▒░ UNRECOGNIZED ░▒▓' : garbledTitle(now(), effectSeed);
        if (element.textContent !== text) element.textContent = text;
      }
    }
    function draw(timestamp) {
      // The shared clock is the sole authority for the rising front. Sampling
      // it here also restores a refreshed browser midway through either rise.
      const extensive = sequence.involved;
      const level = extensive ? sequence.effectLevel : 0;
      value = extensive ? 2 / 3 + (.965 - 2 / 3) * (reduce.matches || level > 0 ? 1 : ease(clamp((now() - sequence.changedAt) / INVASION_MS, 0, 1)))
        : reduce.matches ? target : phase().coverage;
      if (bridge && !reduce.matches) {
        const progress = clamp((now() - bridge.startedAt) / 650, 0, 1);
        const eased = progress * progress * (3 - 2 * progress);
        value = bridge.from + (value - bridge.from) * eased;
        if (progress === 1) bridge = null;
      }
      const seconds = reduce.matches || extensive && level >= 3 ? 0 : now() / 1000;
      const limit = extensive ? .965 : 2 / 3;
      const path = contour(value, seconds, 0, effectSeed, limit);
      const rear = contour(value, seconds * .78, -1, effectSeed, limit), front = contour(value, seconds * 1.13, 1, effectSeed, limit);
      shape.setAttribute('d', path.area); outline.setAttribute('d', path.edge); glow.setAttribute('d', path.edge);
      rearShape.setAttribute('d', rear.area); rearEdge.setAttribute('d', rear.edge);
      frontShade.setAttribute('d', front.area); frontEdge.setAttribute('d', front.edge);
      rearParticles.setAttribute('d', pixelPath(seconds, .58, effectSeed + 71, 100));
      particles.setAttribute('d', pixelPath(seconds, 1.2, effectSeed, 120));
      const debris = fragmentPath(path.points, seconds, effectSeed);
      fragments.setAttribute('d', debris); fragmentShadow.setAttribute('d', debris);
      tears.setAttribute('d', tearPath(seconds, effectSeed));
      const driftX = noise(31, seconds * .55, effectSeed) * 18, driftY = noise(71, seconds * .43, effectSeed) * 22;
      texture.setAttribute('transform', `translate(${driftX.toFixed(1)} ${driftY.toFixed(1)})`);
      fragments.setAttribute('opacity', (.57 + (noise(13, seconds * 2.2, effectSeed) + 1) * .08).toFixed(2));
      const cleared = purification(level, sequence.changedAt, reduce.matches ? Infinity : now());
      const hope = extensive && level > 0 && level < 4;
      // Leave the established two-song reveal on its original single-mask
      // rendering path. An extra full-canvas mask is needed only while clearing.
      if (hope) redLayer.setAttribute('mask', 'url(#finale-hope-clearing)');
      else redLayer.removeAttribute('mask');
      // Reuse the existing 20fps draw loop to prepare a few rows before the
      // first purification cue. No extra timer or animation handle is needed.
      if (!hope) prepareHoleLayout(effectSeed);
      const motion = reduce.matches || level >= 3 ? 0 : level === 2 ? .65 : 1;
      const openings = pixelHoles(hope ? cleared.amount : 0, effectSeed, seconds, motion);
      // Pixel holes reveal the original backdrop without painting luminous
      // outlines or fills. Recovery light belongs to text glyphs only.
      hopeMask.setAttribute('d', openings.mask);
      group.dataset.purification = extensive ? String(level) : 'off';
      group.dataset.hopeAmount = (hope ? cleared.amount : 0).toFixed(4);
      group.dataset.clearedTiles = String(openings.cleared);
      group.dataset.clearance = openings.clearance.toFixed(4);
      updateGarble();
      group.dataset.coverage = value.toFixed(4); group.dataset.edgeBaseline = path.baseline.toFixed(1);
      canvas.dataset.finaleCoverage = value.toFixed(4);
      if (timestamp !== undefined) lastFrame = timestamp;
    }
    function animate(timestamp) {
      frame = 0;
      if (disposed || !active || document.hidden || reduce.matches || !eligible() || target <= 0 || !group?.isConnected) return;
      if (!lastFrame || timestamp - lastFrame >= FRAME_MS) draw(timestamp);
      if (sequence.involved && sequence.effectLevel >= 3 && purification(sequence.effectLevel, sequence.changedAt, now()).progress === 1) return;
      frame = window.requestAnimationFrame(animate);
    }
    function schedule() {
      stopTimer();
      if (disposed || !active || document.hidden || !eligible()) return;
      const state = phase(), currentSequence = finalSequence();
      if (currentSequence.involved ? currentSequence.stage !== 'video' : !state.started || state.complete) return;
      // Only the short reveal timeline needs polling. Artwork advances from
      // the synchronized clock even when autoplay is blocked or audio muted.
      timer = window.setTimeout(() => {
        timer = 0;
        if (disposed || !active || document.hidden) return;
        const next = phase(), nextKey = key(next), nextSequence = finalSequence();
        if (nextKey !== phaseKey || nextSequence.stage !== sequenceKey) {
          phaseKey = nextKey; sequenceKey = nextSequence.stage; sequence = nextSequence; onPhaseChange();
        }
        schedule();
      }, 100);
    }
    function update(next = {}) {
      if (disposed) return;
      const previousCueId = cueId;
      match = next.match; scene = next.scene || ''; active = next.active === true;
      cueId = match?.finalAnnouncement?.id;
      sequence = finalSequence(); sequenceKey = sequence.stage;
      const state = phase(), sequenceVisible = sequence.involved && eligible();
      const infected = eligible() && (sequenceVisible ? sequence.effectLevel !== 4 : state.started && !state.pending);
      phaseKey = key(state);
      canvas.classList.toggle('finale-infected', infected);
      canvas.classList.toggle('finale-sequence-corrupt', sequenceVisible);
      canvas.classList.toggle('finale-effects-running', infected && active && !document.hidden && !reduce.matches && (!sequenceVisible || sequence.effectLevel < 3));
      canvas.dataset.finalePurification = sequenceVisible ? String(sequence.effectLevel) : 'off';
      canvas.dataset.finaleStage = infected ? String(state.revealedCount) : '0';
      canvas.dataset.finaleActive = infected && active && !document.hidden ? 'true' : 'false';
      if (!infected) {
        stopFrame(); stopTimer(); target = value = 0; bridge = null;
        updateGarble();
        canvas.dataset.finaleCoverage = '0';
        // Keep the last geometry for the CSS fade-out. Hiding visibility here
        // would cut that transition short during a scene or stage change.
        if (group) {
          group.setAttribute('opacity', '0');
          group.dataset.hopeAmount = '0.0000'; group.dataset.clearedTiles = '0'; group.dataset.clearance = '0.0000';
          group.dataset.purification = sequenceVisible ? String(sequence.effectLevel) : 'off';
        }
        schedule(); return;
      }
      // Replays replace the cue ID. Seed from the participants so an existing
      // source and one refreshed after a replay still draw the same noise.
      if (target === 0) effectSeed = [...`${match.id}:${(match.players || []).join(':')}`]
        .reduce((seed, letter) => (seed * 31 + letter.charCodeAt(0)) % 10007, 0);
      // An operator may advance to song two before the first rise finishes.
      // Bridge that clock seek locally instead of jumping the front upward.
      if (group?.isConnected && active && previousCueId && previousCueId !== cueId
        && state.index === 1 && state.coverage - value > .04) bridge = { from: value, startedAt: now() };
      target = sequenceVisible ? .965 : (state.index + 1) / 3;
      if (attach()) {
        const announcement = scene === 'grand-final-announcement' || scene === 'song-selection';
        const gameplay = scene === 'double-elimination-match';
        group.setAttribute('opacity', sequenceVisible ? gameplay ? '.46' : '.81' : announcement ? '.84' : gameplay ? '.24' : '.37');
        shade.setAttribute('opacity', announcement ? '.08' : '.3');
        draw();
      }
      if (active && !document.hidden && !reduce.matches && !frame) frame = window.requestAnimationFrame(animate);
      else if (!active || document.hidden || reduce.matches) stopFrame();
      schedule();
    }
    function refresh() { update({ match, scene, active }); }
    reduce.addEventListener('change', refresh);
    document.addEventListener('visibilitychange', refresh);
    return {
      update,
      dispose() {
        if (disposed) return; disposed = true; stopFrame(); stopTimer();
        reduce.removeEventListener('change', refresh); document.removeEventListener('visibilitychange', refresh);
        group?.remove(); group = shape = outline = glow = particles = shade = match = bridge = null;
        rearShape = rearEdge = rearParticles = frontShade = frontEdge = fragments = fragmentShadow = tears = texture = null;
        redLayer = hopeMask = null;
        canvas.classList.remove('finale-infected', 'finale-effects-running', 'finale-sequence-corrupt');
        canvas.dataset.finalePurification = 'off';
        canvas.dataset.finaleActive = 'false'; canvas.dataset.finaleCoverage = '0'; canvas.dataset.finaleStage = '0';
      }
    };
  }
  return { WIDTH, HEIGHT, FRAME_MS, PIXELS, PURIFICATION_MS, contour, pixelPath, fragmentPath, tearPath,
    pixelHoles, sequencePhase, purification, garbledTitle, createController };
});
