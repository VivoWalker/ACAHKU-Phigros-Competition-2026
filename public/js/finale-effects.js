(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BroadcastFinaleEffects = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const WIDTH = 1920, HEIGHT = 1080, FRAME_MS = 50, PIXELS = 220;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const random = index => { const value = Math.sin(index * 127.1 + 311.7) * 43758.5453; return value - Math.floor(value); };

  // A fixed number of staircase segments changes shape continuously. Neither
  // the source SVG nor its calibrated capture mask is rebuilt on each frame.
  function contour(coverage, seconds = 0) {
    const base = HEIGHT * (1 - clamp(coverage, 0, 2 / 3));
    const top = [], step = 24;
    for (let x = 0; x <= WIDTH; x += step) {
      const wave = Math.sin(x * .009 + seconds * .72) * 28
        + Math.sin(x * .027 - seconds * .48) * 17
        + Math.sin(x * .063 + seconds * .31) * 9;
      top.push([x, Math.round(clamp(base + wave, 20, HEIGHT + 64) / 4) * 4]);
    }
    let edge = `M0 ${top[0][1]}`;
    for (const [x, y] of top.slice(1)) edge += `H${x}V${y}`;
    return { edge, area: `${edge}V${HEIGHT + 64}H0Z`, baseline: base };
  }
  function pixelPath(seconds = 0) {
    let result = '';
    for (let i = 0; i < PIXELS; i++) {
      const x = Math.round(random(i + 1) * WIDTH / 4) * 4;
      const speed = 12 + random(i + 501) * 25;
      const y = Math.round(((random(i + 221) * (HEIGHT + 80) - seconds * speed) % (HEIGHT + 80) + HEIGHT + 80) % (HEIGHT + 80) / 4) * 4;
      const size = random(i + 901) > .9 ? 7 : random(i + 101) > .55 ? 4 : 2;
      result += `M${x} ${y}h${size}v${size}h-${size}Z`;
    }
    return result;
  }

  function createController({ canvas, now = () => Date.now(), onPhaseChange = () => {} } = {}) {
    const document = canvas.ownerDocument, window = document.defaultView;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const svgNS = 'http://www.w3.org/2000/svg';
    let match, scene = '', active = false, disposed = false, frame = 0, timer = 0, lastFrame = 0;
    let group, shape, outline, glow, particles, shade, phaseKey = '', target = 0, value = 0, cueId, bridge;
    const phase = () => window.BroadcastFinalAnnouncement.phase(match, now());
    const eligible = () => window.BroadcastFinalAnnouncement.isFixed(match)
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
      group = node('g', { 'data-finale-effects': '', 'pointer-events': 'none' });
      const definitions = node('defs'), clip = node('clipPath', { id: 'finale-invasion-clip', clipPathUnits: 'userSpaceOnUse' });
      shape = node('path'); clip.append(shape); definitions.append(clip);
      const gradient = node('linearGradient', { id: 'finale-invasion-red', x1: '0', y1: '0', x2: '0', y2: '1' });
      gradient.append(node('stop', { 'stop-color': '#85030b' }), node('stop', { offset: '1', 'stop-color': '#430006' }));
      definitions.append(gradient); group.append(definitions);
      const fill = node('g', { 'clip-path': 'url(#finale-invasion-clip)' });
      fill.append(node('rect', { width: WIDTH, height: HEIGHT, fill: 'url(#finale-invasion-red)' }));
      // The bundled reference texture supplies the fine grain. Its original
      // top edge is outside our viewport: the live procedural edge owns shape.
      fill.append(node('image', { 'data-finale-texture': '', href: '/assets/finale/error-texture.png',
        x: '0', y: '-360', width: WIDTH, height: '1440', opacity: '.54', preserveAspectRatio: 'xMidYMid slice' }));
      particles = node('path', { fill: '#ff5261', opacity: '.65' }); fill.append(particles); group.append(fill);
      glow = node('path', { fill: 'none', stroke: '#ff0824', 'stroke-width': '8', opacity: '.46' });
      outline = node('path', { fill: 'none', stroke: '#ffe3df', 'stroke-width': '1.7', opacity: '.85' });
      group.append(glow, outline);
      // Dimming is local to the infected pixels, never a full-canvas filter.
      shade = node('rect', { width: WIDTH, height: HEIGHT, fill: '#10070d', opacity: '0', 'clip-path': 'url(#finale-invasion-clip)' });
      group.append(shade); parent.append(group); return true;
    }
    function stopFrame() { if (frame) window.cancelAnimationFrame(frame); frame = 0; lastFrame = 0; }
    function stopTimer() { if (timer) window.clearTimeout(timer); timer = 0; }
    function draw(timestamp) {
      // The shared clock is the sole authority for the rising front. Sampling
      // it here also restores a refreshed browser midway through either rise.
      value = reduce.matches ? target : phase().coverage;
      if (bridge && !reduce.matches) {
        const progress = clamp((now() - bridge.startedAt) / 650, 0, 1);
        const eased = progress * progress * (3 - 2 * progress);
        value = bridge.from + (value - bridge.from) * eased;
        if (progress === 1) bridge = null;
      }
      const seconds = reduce.matches ? 0 : now() / 1000;
      const path = contour(value, seconds);
      shape.setAttribute('d', path.area); outline.setAttribute('d', path.edge); glow.setAttribute('d', path.edge);
      particles.setAttribute('d', pixelPath(seconds));
      group.dataset.coverage = value.toFixed(4); group.dataset.edgeBaseline = path.baseline.toFixed(1);
      canvas.dataset.finaleCoverage = value.toFixed(4);
      if (timestamp !== undefined) lastFrame = timestamp;
    }
    function animate(timestamp) {
      frame = 0;
      if (disposed || !active || document.hidden || reduce.matches || !eligible() || target <= 0 || !group?.isConnected) return;
      if (!lastFrame || timestamp - lastFrame >= FRAME_MS) draw(timestamp);
      frame = window.requestAnimationFrame(animate);
    }
    function schedule() {
      stopTimer();
      if (disposed || !active || document.hidden || !eligible()) return;
      const state = phase();
      if (!state.started || state.complete) return;
      // Only the short reveal timeline needs polling. Artwork advances from
      // the synchronized clock even when autoplay is blocked or audio muted.
      timer = window.setTimeout(() => {
        timer = 0;
        if (disposed || !active || document.hidden) return;
        const next = phase(), nextKey = key(next);
        if (nextKey !== phaseKey) { phaseKey = nextKey; onPhaseChange(); }
        schedule();
      }, 100);
    }
    function update(next = {}) {
      if (disposed) return;
      const previousCueId = cueId;
      match = next.match; scene = next.scene || ''; active = next.active === true;
      cueId = match?.finalAnnouncement?.id;
      const state = phase(), infected = eligible() && state.started && !state.pending;
      phaseKey = key(state);
      canvas.classList.toggle('finale-infected', infected);
      canvas.classList.toggle('finale-effects-running', infected && active && !document.hidden && !reduce.matches);
      canvas.dataset.finaleStage = infected ? String(state.revealedCount) : '0';
      canvas.dataset.finaleActive = infected && active && !document.hidden ? 'true' : 'false';
      if (!infected) {
        stopFrame(); stopTimer(); target = value = 0; bridge = null;
        canvas.dataset.finaleCoverage = '0';
        if (group) group.setAttribute('visibility', 'hidden');
        schedule(); return;
      }
      // An operator may advance to song two before the first rise finishes.
      // Bridge that clock seek locally instead of jumping the front upward.
      if (group?.isConnected && active && previousCueId && previousCueId !== cueId
        && state.index === 1 && state.coverage - value > .04) bridge = { from: value, startedAt: now() };
      target = (state.index + 1) / 3;
      if (attach()) {
        group.removeAttribute('visibility');
        const announcement = scene === 'grand-final-announcement' || scene === 'song-selection';
        const gameplay = scene === 'double-elimination-match';
        group.setAttribute('opacity', announcement ? '.84' : gameplay ? '.24' : '.37');
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
        canvas.classList.remove('finale-infected', 'finale-effects-running');
        canvas.dataset.finaleActive = 'false'; canvas.dataset.finaleCoverage = '0'; canvas.dataset.finaleStage = '0';
      }
    };
  }
  return { WIDTH, HEIGHT, FRAME_MS, PIXELS, contour, pixelPath, createController };
});
