(function () {
  'use strict';
  const KEY = '[data-motion-key]', STATIC = '[data-motion-static]';
  const DURATION = 2400, LOGO_DURATION = 760, ENTRY_DURATION = 560, STAGGER = 65, EASING = 'cubic-bezier(.45, 0, .55, 1)';
  const LOGOS = new Set(['phigros-logo', 'phigros-wordmark', 'club-soc', 'club-kirameki']);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const coverControllers = new WeakMap();
  const activeCovers = new Set();
  const sceneControllers = new Set();
  const compatible = (a, b) => a && a.localName === b.localName && a.namespaceURI === b.namespaceURI;
  const isStatic = node => !!node.closest(STATIC);
  const ownKeys = root => [...root.querySelectorAll(KEY)].filter(node => !node.closest('[data-motion-ghost]'));
  function keyed(root) {
    const result = new Map();
    for (const node of ownKeys(root)) {
      const key = node.dataset.motionKey;
      if (key && !result.has(key)) result.set(key, node);
    }
    return result;
  }
  function scaleFor(mount, canvas) {
    const anchor = canvas || mount;
    const rect = anchor.getBoundingClientRect();
    return { x: rect.width / (anchor.offsetWidth || rect.width || 1) || 1, y: rect.height / (anchor.offsetHeight || rect.height || 1) || 1 };
  }
  function measure(node, mount, scale) {
    const bounds = node.getBoundingClientRect(), origin = mount.getBoundingClientRect(), style = getComputedStyle(node);
    // Snapshot in canvas coordinates now: the viewport can change during exit.
    const logical = rect => ({ left: (rect.left - origin.left) / scale.x, top: (rect.top - origin.top) / scale.y,
      width: rect.width / scale.x, height: rect.height / scale.y });
    const result = { rect: logical(bounds), fontSize: style.fontSize, lineHeight: style.lineHeight,
      transform: style.transform === 'none' ? '' : style.transform, width: style.width, height: style.height,
      visibility: style.visibility, opacity: style.opacity };
    if (node.localName === 'span' && node.textContent) {
      const range = document.createRange(); range.selectNodeContents(node);
      const text = range.getBoundingClientRect(); result.textRect = logical(text);
      let left = bounds.left, right = bounds.right, top = bounds.top, bottom = bounds.bottom;
      result.textOverflow = style.textOverflow;
      for (let parent = node; parent && parent !== mount; parent = parent.parentElement) {
        const css = getComputedStyle(parent), rect = parent.getBoundingClientRect();
        if (['hidden', 'clip', 'scroll', 'auto'].includes(css.overflowX)) {
          left = Math.max(left, rect.left + parseFloat(css.borderLeftWidth) * scale.x);
          right = Math.min(right, rect.right - parseFloat(css.borderRightWidth) * scale.x);
          if (css.textOverflow === 'ellipsis') result.textOverflow = 'ellipsis';
        }
        if (['hidden', 'clip', 'scroll', 'auto'].includes(css.overflowY)) {
          top = Math.max(top, rect.top + parseFloat(css.borderTopWidth) * scale.y);
          bottom = Math.min(bottom, rect.bottom - parseFloat(css.borderBottomWidth) * scale.y);
        }
      }
      result.visibleRect = logical({ left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) });
    }
    return result;
  }
  function attributes(node, source) {
    for (const attribute of [...node.attributes]) if (!source.hasAttribute(attribute.name)) node.removeAttribute(attribute.name);
    for (const attribute of [...source.attributes]) node.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
  }
  // Each keyed node is moved into the new tree, never cloned or replaced.
  function reconcile(fragment, oldKeys) {
    function materialize(source) {
      if (source.nodeType !== Node.ELEMENT_NODE) return source;
      const existing = oldKeys.get(source.dataset.motionKey);
      const node = compatible(existing, source) ? existing : source;
      const children = [...source.childNodes].map(materialize);
      if (node !== source) attributes(node, source);
      node.replaceChildren(...children);
      return node;
    }
    return [...fragment.childNodes].map(materialize);
  }
  const ENTRY_SELECTOR = '.event-title, .topmeta, .event-copy h1, .event-line, .organiser, .key-visual, '
    + '.waiting-copy > .section-label, .waiting-copy > h1, .waiting-players > p, .waiting-song, '
    + '.player-name > h2, .player-total, .song-scores, .handcam-label, .song-band, .scene-head, '
    + '.ranking-tables > section, .footer, .winner-panel, .result-row, .bracket-column, .candidate, '
    + '.selection-art, .selection-detail > h2, .picks, .selection-state, .empty-copy';
  function entryNodes(root) {
    const nodes = [...root.querySelectorAll(ENTRY_SELECTOR)];
    const selected = new Set(nodes);
    return nodes.filter(node => {
      for (let parent = node.parentElement; parent && parent !== root; parent = parent.parentElement) if (selected.has(parent)) return false;
      return !LOGOS.has(node.dataset.motionKey);
    }).map((node, index) => {
      const identity = node.dataset.motionKey || [...node.querySelectorAll(KEY)].map(child => child.dataset.motionKey).join('/') ||
        `${node.localName}:${node.className}:${index}`;
      // Changed copy is new content; live numbers keep their existing slot.
      return { node, id: identity + (node.matches('.player-total,.song-scores') ? '' : ':' + node.textContent.trim()) };
    });
  }
  function createScene(mount, { canvas } = {}) {
    let markup, scene, epoch = 0, running = false, current, presentation, lastLayout = new Map();
    const animations = new Set(), cleanups = [], waiters = [], logoTracks = new Map();
    const clock = () => document.timeline.currentTime ?? performance.now();
    mount.dataset.motionPhase = 'idle';
    function restoreAll() { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); }
    function style(node, values) {
      const original = node.getAttribute('style'); Object.assign(node.style, values);
      cleanups.push(() => original === null ? node.removeAttribute('style') : node.setAttribute('style', original));
    }
    function animate(node, frames, duration, start) {
      const elapsed = clock() - start;
      if (reduce.matches || elapsed >= duration) return Promise.resolve();
      const animation = node.animate(frames, { duration, easing: EASING, fill: 'both' });
      // One document timeline keeps all logos on exactly the same progress,
      // including a busy frame or a state update midway through a transition.
      animation.startTime = start;
      animations.add(animation);
      return animation.finished.catch(() => {}).then(() => { animations.delete(animation); animation.cancel(); });
    }
    function context(record) {
      return { previousScene: scene, scene: record.scene, initial: markup === undefined,
        oldCoverSrc: mount.querySelector('.selection-art img:not([data-motion-cover-old])')?.getAttribute('src') || null };
    }
    function commit(record, template) {
      const info = context(record);
      mount.replaceChildren(...reconcile(template.content, keyed(mount)));
      markup = record.html; scene = record.scene; mount.dataset.motionScene = String(scene || '');
      record.onCommit?.(info);
    }
    function sameRect(a, b) {
      return a && b && ['left', 'top', 'width', 'height'].every(property => Math.abs(a[property] - b[property]) < .5);
    }
    function idle() { return running ? new Promise(resolve => waiters.push(resolve)) : Promise.resolve(); }
    function settled() {
      running = false; mount.dataset.motionPhase = 'idle'; presentation = null; logoTracks.clear();
      for (const resolve of waiters.splice(0)) resolve();
    }
    function cancel() {
      epoch++; for (const animation of animations) animation.cancel(); animations.clear();
      restoreAll(); current?.resolve({ superseded: true }); current = null;
    }
    function floatLogo(node, a, b, layer) {
      const css = getComputedStyle(node), original = node.getAttribute('style');
      const placeholder = document.createElement('span'); placeholder.dataset.motionPlaceholder = '';
      for (const property of ['position', 'display', 'float', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
        'flex-grow', 'flex-shrink', 'flex-basis', 'order', 'align-self', 'justify-self', 'grid-area', 'vertical-align', 'left', 'top', 'right', 'bottom'])
        placeholder.style.setProperty(property, css.getPropertyValue(property));
      Object.assign(placeholder.style, { width: `${b.rect.width}px`, height: `${b.rect.height}px`, visibility: 'hidden', boxSizing: 'border-box' });
      if (css.display === 'inline') placeholder.style.display = 'inline-block';
      for (const property of ['object-fit', 'object-position', 'font-family', 'font-weight', 'font-size', 'font-style', 'line-height', 'letter-spacing', 'filter', 'padding', 'border'])
        node.style.setProperty(property, css.getPropertyValue(property));
      node.replaceWith(placeholder); layer.append(node);
      Object.assign(node.style, { position: 'absolute', left: `${b.rect.left}px`, top: `${b.rect.top}px`, right: 'auto', bottom: 'auto',
        width: `${b.rect.width}px`, height: `${b.rect.height}px`, margin: '0px', flex: 'none', zIndex: '1000' });
      cleanups.push(() => {
        if (placeholder.isConnected) placeholder.replaceWith(node);
        if (original === null) node.removeAttribute('style'); else node.setAttribute('style', original);
      });
      const frame = value => ({ left: `${value.rect.left}px`, top: `${value.rect.top}px`, width: `${value.rect.width}px`,
        height: `${value.rect.height}px`, opacity: value.opacity, ...(node.localName === 'span' ? { fontSize: value.fontSize } : {}) });
      return [frame(a), frame(b)];
    }
    async function perform(record, before, previousTracks, previousPresentation, previousLayout, token) {
      const template = document.createElement('template'); template.innerHTML = record.html;
      const initial = markup === undefined, changedScene = scene !== record.scene;
      commit(record, template);
      const scale = scaleFor(mount, canvas), now = clock();
      const layout = entryNodes(mount).map(item => ({ ...item, rect: measure(item.node, mount, scale).rect }));
      lastLayout = new Map(layout.map(item => [item.id, item.rect]));
      if (reduce.matches) { settled(); record.resolve({ superseded: false }); return; }
      const jobs = [], tracks = [];
      for (const [key, node] of keyed(mount)) {
        if (!LOGOS.has(key)) continue;
        const target = measure(node, mount, scale), old = before.get(key), prior = previousTracks.get(key);
        if (prior && sameRect(prior.target.rect, target.rect) && prior.start + LOGO_DURATION > now) {
          tracks.push({ key, node, ...prior, target });
        } else if (old && (!sameRect(old.rect, target.rect) || old.fontSize !== target.fontSize)) {
          tracks.push({ key, node, before: old, target, start: now });
        } else if (!old && !initial) {
          tracks.push({ key, node, before: { ...target, opacity: '0' }, target, start: now });
        }
      }
      const logoEnd = Math.max(now, ...tracks.map(track => track.start + LOGO_DURATION));
      const continuing = !changedScene && previousPresentation && !tracks.some(track => track.start === now);
      presentation = { scene, entries: new Map(continuing?.entries || []) };
      const newItems = layout.filter(item => initial || changedScene || tracks.length && !continuing ||
        !previousLayout.has(item.id) || !item.node.matches('.player-total') && !sameRect(previousLayout.get(item.id), item.rect));
      newItems.sort((a, b) => a.rect.left - b.rect.left || a.rect.top - b.rect.top || a.id.localeCompare(b.id));
      let order = 0;
      for (const item of newItems) {
        if (continuing && presentation.entries.has(item.id)) continue;
        presentation.entries.set(item.id, { start: logoEnd + order++ * STAGGER, order: order - 1 });
      }
      if (tracks.length) {
        mount.dataset.motionPhase = 'move';
        const layer = document.createElement('div'); layer.dataset.motionLive = ''; layer.dataset.motionBranding = '';
        Object.assign(layer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '1000' });
        mount.append(layer); cleanups.push(() => layer.remove());
        for (const track of tracks) {
          logoTracks.set(track.key, track);
          jobs.push(animate(track.node, floatLogo(track.node, track.before, track.target, layer), LOGO_DURATION, track.start));
        }
        // Reserve the transition stage for branding. New video apertures and
        // labels appear only after the topmost logos have reached their slots.
        for (const node of mount.querySelectorAll('[data-capture], #capture-mask rect[fill="black"]'))
          jobs.push(animate(node, [{ opacity: 0 }, { opacity: 0 }], Math.max(0, logoEnd - now), now));
        jobs.push(new Promise(resolve => {
          const timer = setTimeout(() => { if (token === epoch) mount.dataset.motionPhase = 'enter'; resolve(); }, Math.max(0, logoEnd - now));
          cleanups.push(() => { clearTimeout(timer); resolve(); });
        }));
      }
      for (const { node, id, rect } of layout) {
        const plan = presentation.entries.get(id);
        if (!plan || now >= plan.start + ENTRY_DURATION) continue;
        if (!tracks.length) mount.dataset.motionPhase = 'enter';
        node.dataset.motionEntry = id; node.dataset.motionOrder = String(plan.order);
        node.dataset.motionEntryRect = JSON.stringify(rect);
        cleanups.push(() => { delete node.dataset.motionEntry; delete node.dataset.motionOrder; delete node.dataset.motionEntryRect; });
        const css = getComputedStyle(node), transform = css.transform === 'none' ? '' : css.transform, opacity = css.opacity;
        // The mask follows the translation: incoming ink stays within its
        // final slot, including clipped artwork and adjacent bracket columns.
        style(node, { maskImage: 'linear-gradient(#000,#000)', maskRepeat: 'no-repeat', maskPosition: '0 0' });
        jobs.push(animate(node, [
          { opacity: 0, transform: `translateX(36px) ${transform}`, maskSize: 'calc(100% - 36px) 100%' },
          { opacity, transform: transform || 'none', maskSize: '100% 100%' }
        ], ENTRY_DURATION, plan.start));
      }
      await Promise.all(jobs);
      if (token !== epoch) return;
      restoreAll(); settled(); current = null; record.resolve({ superseded: false });
    }
    function update(html, { scene: nextScene = scene, onCommit } = {}) {
      const record = { html, scene: nextScene, onCommit };
      const promise = new Promise((resolve, reject) => { record.resolve = resolve; record.reject = reject; });
      if (html === markup && nextScene === scene) {
        try { onCommit?.(context(record)); record.resolve({ superseded: false }); } catch (error) { record.reject(error); }
        return promise;
      }
      const scale = scaleFor(mount, canvas);
      const before = new Map([...keyed(mount)].filter(([key]) => LOGOS.has(key)).map(([key, node]) => [key, measure(node, mount, scale)]));
      const previousTracks = new Map(logoTracks), previousPresentation = presentation, previousLayout = lastLayout;
      cancel(); logoTracks.clear(); running = true; current = record;
      const token = epoch;
      perform(record, before, previousTracks, previousPresentation, previousLayout, token).catch(error => {
        if (token !== epoch) return;
        restoreAll(); settled(); current = null; record.reject(error);
      });
      return promise;
    }
    function finish() {
      for (const animation of [...animations]) { try { animation.finish(); } catch (_) { animation.cancel(); } }
      return idle();
    }
    function reduced() {
      if (!reduce.matches || !current) return;
      const record = current; cancel(); logoTracks.clear();
      const template = document.createElement('template'); template.innerHTML = record.html;
      commit(record, template); settled(); record.resolve({ superseded: false });
    }
    const controller = { update, finish, idle, reduced }; sceneControllers.add(controller); return controller;
  }
  function decoded(image) {
    if (image.complete && image.naturalWidth) return Promise.resolve();
    return image.decode ? image.decode().catch(() => {}) : new Promise(resolve => {
      image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true });
    });
  }
  function coverAttrs(image) {
    return [...image.attributes].filter(attribute => attribute.name !== 'src' && attribute.name !== 'data-motion-cover-old')
      .map(attribute => [attribute.name, attribute.value]);
  }
  function applyCover(controller, record) {
    const image = controller.image;
    for (const attribute of [...image.attributes]) if (attribute.name !== 'src') image.removeAttribute(attribute.name);
    for (const [name, value] of record.attrs) image.setAttribute(name, value);
    image.setAttribute('src', record.src);
    controller.renderedSrc = record.src;
  }
  function mountCover(controller) {
    const { windowEl, image, active } = controller;
    for (const extra of [...windowEl.querySelectorAll('img')]) if (extra !== image && extra !== active?.old) extra.remove();
    if (image.parentElement !== windowEl) windowEl.prepend(image);
    if (active?.old && active.started && active.old.parentElement !== windowEl) windowEl.append(active.old);
    // A reconciled src must not replace the bitmap of an unfinished movement.
    image.setAttribute('src', controller.renderedSrc);
  }
  function clearCover(controller) {
    for (const animation of controller.active?.animations || []) animation.cancel();
    controller.active?.old?.remove();
    for (const extra of controller.windowEl.querySelectorAll('[data-motion-cover-old]')) extra.remove();
    controller.windowEl.dataset.coverMotionPhase = 'idle';
  }
  function stopCover(controller, latest) {
    latest ||= controller.pending || controller.active?.record;
    controller.token++; clearCover(controller);
    if (latest) applyCover(controller, latest);
    if (controller.windowEl.isConnected) mountCover(controller);
    controller.active?.record.resolve(); controller.pending?.resolve(); latest?.resolve();
    controller.active = controller.pending = null;
    controller.visibleSrc = controller.renderedSrc; activeCovers.delete(controller);
  }
  async function runCover(controller, record) {
    const token = ++controller.token;
    controller.active = { record, old: null, animations: [], started: false };
    activeCovers.add(controller); mountCover(controller);
    controller.windowEl.dataset.coverMotionPhase = 'loading';
    await record.ready;
    if (token !== controller.token) return;
    if (!controller.windowEl.isConnected || reduce.matches) { stopCover(controller, controller.pending || record); return; }
    if (controller.pending) {
      const latest = controller.pending; controller.pending = null;
      record.resolve(); controller.active = null; runCover(controller, latest); return;
    }
    const previous = controller.visibleSrc;
    if (!previous || previous === record.src || !record.loader.naturalWidth) {
      applyCover(controller, record); controller.visibleSrc = record.src;
      clearCover(controller); record.resolve(); controller.active = null; activeCovers.delete(controller); return;
    }
    const old = controller.image.cloneNode(false);
    old.removeAttribute('id'); old.removeAttribute('data-motion-key'); old.removeAttribute('data-motion-block');
    old.setAttribute('aria-hidden', 'true'); old.dataset.motionCoverOld = ''; old.src = previous;
    Object.assign(old.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' });
    controller.active.old = old;
    await decoded(old);
    if (token !== controller.token) return;
    if (!controller.windowEl.isConnected || reduce.matches) { stopCover(controller, controller.pending || record); return; }
    if (controller.pending) {
      const latest = controller.pending; controller.pending = null;
      old.remove(); record.resolve(); controller.active = null; runCover(controller, latest); return;
    }
    applyCover(controller, record); controller.active.started = true; controller.windowEl.append(old);
    controller.windowEl.dataset.coverMotionPhase = 'move';
    const options = { duration: DURATION, easing: EASING, fill: 'both' };
    const incoming = controller.image.animate([{ transform: `translateY(${record.direction * 100}%)` }, { transform: 'translateY(0%)' }], options);
    const outgoing = old.animate([{ transform: 'translateY(0%)' }, { transform: `translateY(${-record.direction * 100}%)` }], options);
    controller.active.animations = [incoming, outgoing];
    await Promise.all([incoming.finished.catch(() => {}), outgoing.finished.catch(() => {})]);
    if (token !== controller.token) return;
    clearCover(controller); controller.visibleSrc = record.src; record.resolve(); controller.active = null;
    const latest = controller.pending; controller.pending = null;
    if (latest) runCover(controller, latest); else activeCovers.delete(controller);
  }
  function coverSlide(windowEl, oldSrc, direction = 1, requested) {
    if (!windowEl) return Promise.resolve();
    const target = windowEl.querySelector('img:not([data-motion-cover-old])');
    if (!target) return Promise.resolve();
    const requestedSrc = (typeof requested === 'string' ? requested : requested?.src) || target.getAttribute('src');
    const attrs = coverAttrs(target);
    if (requested && typeof requested === 'object' && requested.alt !== undefined) {
      const existing = attrs.find(attribute => attribute[0] === 'alt');
      if (existing) existing[1] = requested.alt; else attrs.push(['alt', requested.alt]);
    }
    let controller = coverControllers.get(windowEl);
    if (!controller) {
      controller = { windowEl, image: target, active: null, pending: null, visibleSrc: oldSrc || requestedSrc,
        renderedSrc: oldSrc || requestedSrc, token: 0 };
      controller.stop = () => stopCover(controller);
      coverControllers.set(windowEl, controller);
    }
    // The requested song is separate from the still-visible, decoded bitmap.
    // Repeated state messages only remount the two owned image nodes.
    if (!requested?.immediate && !reduce.matches && windowEl.isConnected && controller.pending?.src === requestedSrc) {
      controller.pending.attrs = attrs; mountCover(controller); return controller.pending.promise;
    }
    if (!requested?.immediate && !reduce.matches && windowEl.isConnected && controller.active?.record.src === requestedSrc) {
      controller.active.record.attrs = attrs; controller.pending?.resolve(); controller.pending = null;
      if (controller.active.started) applyCover(controller, controller.active.record);
      mountCover(controller); return controller.active.record.promise;
    }
    const loader = new Image(); loader.src = requestedSrc;
    const record = { src: requestedSrc, attrs, direction: direction < 0 ? -1 : 1, loader, ready: decoded(loader) };
    const promise = new Promise(resolve => { record.resolve = resolve; }); record.promise = promise;
    if (reduce.matches || !windowEl.isConnected || requested?.immediate || !oldSrc || requestedSrc === controller.renderedSrc && !controller.active) {
      stopCover(controller, record); return promise;
    }
    mountCover(controller);
    if (controller.active) { controller.pending?.resolve(); controller.pending = record; }
    else runCover(controller, record);
    return promise;
  }
  // Detached cover windows must release animations and their obsolete artwork.
  const observer = new MutationObserver(() => { for (const controller of activeCovers) if (!controller.windowEl.isConnected) controller.stop(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  reduce.addEventListener('change', () => {
    if (!reduce.matches) return;
    for (const controller of sceneControllers) controller.reduced();
    for (const controller of [...activeCovers]) controller.stop();
  });
  window.BroadcastMotion = { createScene, coverSlide };
})();
