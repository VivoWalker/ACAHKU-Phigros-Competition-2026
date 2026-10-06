(function () {
  'use strict';
  const KEY = '[data-motion-key]', BLOCK = '[data-motion-block]', STATIC = '[data-motion-static]';
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let ghostId = 0;
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
  function topTargets(nodes) {
    const selected = new Set(nodes);
    return nodes.filter(node => {
      for (let parent = node.parentElement; parent; parent = parent.parentElement) if (selected.has(parent)) return false;
      return true;
    });
  }
  function scaleFor(mount, canvas) {
    const anchor = canvas || mount;
    const rect = anchor.getBoundingClientRect();
    return { x: rect.width / (anchor.offsetWidth || rect.width || 1) || 1, y: rect.height / (anchor.offsetHeight || rect.height || 1) || 1 };
  }
  function measure(node) {
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
    return { rect, fontSize: style.fontSize, lineHeight: style.lineHeight, transform: style.transform === 'none' ? '' : style.transform,
      width: style.width, height: style.height, visibility: style.visibility, opacity: style.opacity };
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
  function blocks(root) {
    return topTargets([...root.querySelectorAll(BLOCK)].filter(node => !node.matches(KEY) && !isStatic(node) && !node.querySelector(STATIC) && !node.closest('[data-motion-ghost]')));
  }
  function ghost(node, mount, scale, hiddenKeys, phase) {
    const sourceNodes = [node, ...node.querySelectorAll('*')];
    const copy = node.cloneNode(true), copiedNodes = [copy, ...copy.querySelectorAll('*')];
    const ids = new Map(), suffix = `motion-${++ghostId}-`;
    for (let i = 0; i < sourceNodes.length; i++) {
      const original = sourceNodes[i], target = copiedNodes[i], style = getComputedStyle(original);
      for (const property of style) target.style.setProperty(property, style.getPropertyValue(property));
      if (target.id) { ids.set(target.id, suffix + target.id); target.id = suffix + target.id; }
      const sharedAncestor = original.closest(KEY);
      if (original.matches(STATIC) || original.closest(STATIC) || hiddenKeys.has(original.dataset.motionKey) ||
        sharedAncestor && hiddenKeys.has(sharedAncestor.dataset.motionKey)) target.style.visibility = 'hidden';
      target.removeAttribute('data-motion-key'); target.removeAttribute('data-motion-block'); target.removeAttribute('data-motion-static');
      target.removeAttribute('autofocus'); target.setAttribute('tabindex', '-1');
    }
    // Local SVG references get unique IDs too; the live scene keeps its one mask.
    for (const target of copiedNodes) for (const attribute of [...target.attributes]) {
      let value = attribute.value;
      for (const [before, after] of ids) {
        value = value.replaceAll(`url(#${before})`, `url(#${after})`).replaceAll(`url("#${before}")`, `url("#${after}")`);
        if ((attribute.name === 'href' || attribute.name === 'xlink:href') && value === '#' + before) value = '#' + after;
      }
      if (value !== attribute.value) target.setAttributeNS(attribute.namespaceURI, attribute.name, value);
    }
    const rect = node.getBoundingClientRect(), parent = mount.getBoundingClientRect();
    const wrapper = document.createElement('div');
    wrapper.dataset.motionGhost = phase; wrapper.setAttribute('aria-hidden', 'true'); wrapper.inert = true;
    Object.assign(wrapper.style, { position: 'absolute', left: `${(rect.left - parent.left) / scale.x}px`, top: `${(rect.top - parent.top) / scale.y}px`,
      width: `${rect.width / scale.x}px`, height: `${rect.height / scale.y}px`, pointerEvents: 'none', zIndex: '40' });
    Object.assign(copy.style, { position: 'relative', left: '0px', top: '0px', right: 'auto', bottom: 'auto', margin: '0px',
      width: `${rect.width / scale.x}px`, height: `${rect.height / scale.y}px`, transform: 'none' });
    if (getComputedStyle(node).display === 'inline') copy.style.display = 'block';
    wrapper.append(copy);
    return wrapper;
  }
  function createScene(mount, { canvas } = {}) {
    let markup, scene, pending = null, current = null, running = false, epoch = 0, forced = false;
    const animations = new Set(), cleanups = new Set(), idleWaiters = [];
    mount.dataset.motionPhase = 'idle';
    function cleanup(callback) {
      let done = false;
      const once = () => { if (!done) { done = true; cleanups.delete(once); callback(); } };
      cleanups.add(once); return once;
    }
    function keepStyle(node, property, value) {
      const before = node.style.getPropertyValue(property), priority = node.style.getPropertyPriority(property);
      node.style.setProperty(property, value);
      return cleanup(() => before ? node.style.setProperty(property, before, priority) : node.style.removeProperty(property));
    }
    function hide(node, shared) {
      const restore = [keepStyle(node, 'visibility', 'hidden')];
      for (const child of [node, ...node.querySelectorAll(KEY)]) if (shared.has(child.dataset.motionKey)) restore.push(keepStyle(child, 'visibility', 'visible'));
      return cleanup(() => restore.forEach(callback => callback()));
    }
    function clearTransient() { for (const callback of [...cleanups]) callback(); }
    function phase(value) { mount.dataset.motionPhase = value; }
    function settleIdle() { phase('idle'); for (const resolve of idleWaiters.splice(0)) resolve(); }
    function animate(node, frames, duration) {
      if (forced || reduce.matches || !node.isConnected) return Promise.resolve();
      const animation = node.animate(frames, { duration, easing: 'linear', fill: 'both' });
      animations.add(animation);
      return animation.finished.catch(() => {}).then(() => { animations.delete(animation); animation.cancel(); });
    }
    function commitContext(record) {
      const cover = mount.querySelector('[data-motion-cover-window], .selection-art, .cover-window');
      return { previousScene: scene, scene: record.scene, initial: markup === undefined,
        oldCoverSrc: cover?.querySelector('img:not([data-motion-cover-old])')?.getAttribute('src') || null };
    }
    function commit(record, template, oldKeys) {
      const context = commitContext(record);
      mount.replaceChildren(...reconcile(template.content, oldKeys));
      markup = record.html; scene = record.scene; mount.dataset.motionScene = String(scene || '');
      if (record.onCommit) record.onCommit(context);
    }
    async function perform(record, token) {
      if (record.html === markup) {
        const context = commitContext(record); scene = record.scene; mount.dataset.motionScene = String(scene || '');
        if (record.onCommit) record.onCommit(context); return;
      }
      const template = document.createElement('template'); template.innerHTML = record.html;
      const oldKeys = keyed(mount), targetKeys = keyed(template.content);
      const shared = new Set([...targetKeys].filter(([key, node]) => compatible(oldKeys.get(key), node)).map(([key]) => key));
      const before = new Map([...oldKeys].map(([key, node]) => [key, measure(node)]));
      const scale = scaleFor(mount, canvas), initial = markup === undefined;
      const changedScene = !initial && scene !== record.scene;
      if (changedScene && !forced) {
        phase('exit');
        const exits = blocks(mount);
        const missing = topTargets([...oldKeys].filter(([key, node]) => !shared.has(key) && !isStatic(node)).map(([, node]) => node))
          .filter(node => !exits.some(block => block.contains(node)));
        const restores = [], ghosts = [];
        for (const node of [...exits, ...missing]) {
          const copy = ghost(node, mount, scale, shared, 'exit'); mount.append(copy); ghosts.push(copy);
          restores.push(hide(node, shared));
          cleanup(() => copy.remove());
        }
        await Promise.all(ghosts.map(node => animate(node, [{ opacity: 1, transform: 'translateY(0px)' }, { opacity: 0, transform: 'translateY(-16px)' }], 100)));
        if (token !== epoch) return;
        restores.forEach(restore => restore()); ghosts.forEach(node => node.remove());
      }
      if (token !== epoch) return;
      commit(record, template, oldKeys);
      if (initial || forced || reduce.matches) { clearTransient(); return; }
      const afterKeys = keyed(mount), after = new Map([...afterKeys].map(([key, node]) => [key, measure(node)]));
      const entryBlocks = changedScene ? blocks(mount) : [];
      const entering = topTargets([...afterKeys].filter(([key, node]) => !shared.has(key) && !isStatic(node)).map(([, node]) => node))
        .filter(node => !entryBlocks.some(block => block.contains(node)));
      const entryGhosts = [], entryRestores = [];
      for (const node of [...entryBlocks, ...entering]) {
        entryGhosts.push(ghost(node, mount, scale, shared, 'enter'));
        entryRestores.push(hide(node, shared));
      }
      const moves = [], floated = [];
      let imageLayer;
      function floatImage(node, a, b, text = false) {
        const style = getComputedStyle(node), originalStyle = node.getAttribute('style');
        const placeholder = document.createElement('span'); placeholder.dataset.motionPlaceholder = '';
        for (const property of ['position', 'display', 'float', 'clear', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
          'flex-grow', 'flex-shrink', 'flex-basis', 'order', 'align-self', 'justify-self', 'grid-area', 'vertical-align', 'left', 'top', 'right', 'bottom']) {
          placeholder.style.setProperty(property, style.getPropertyValue(property));
        }
        if (style.display === 'inline') placeholder.style.display = 'inline-block';
        Object.assign(placeholder.style, { width: `${b.rect.width / scale.x}px`, height: `${b.rect.height / scale.y}px`, visibility: 'hidden', pointerEvents: 'none', boxSizing: 'border-box' });
        for (const property of style) node.style.setProperty(property, style.getPropertyValue(property));
        if (!imageLayer) {
          imageLayer = document.createElement('div'); imageLayer.dataset.motionLive = '';
          Object.assign(imageLayer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '50' }); mount.append(imageLayer);
          cleanup(() => imageLayer.remove());
        }
        node.replaceWith(placeholder); imageLayer.append(node);
        const origin = mount.getBoundingClientRect();
        const from = { left: `${(a.rect.left - origin.left) / scale.x}px`, top: `${(a.rect.top - origin.top) / scale.y}px`,
          width: `${a.rect.width / scale.x}px`, height: `${a.rect.height / scale.y}px`, opacity: a.opacity };
        const to = { left: `${(b.rect.left - origin.left) / scale.x}px`, top: `${(b.rect.top - origin.top) / scale.y}px`,
          width: `${b.rect.width / scale.x}px`, height: `${b.rect.height / scale.y}px`, opacity: b.opacity };
        if (text) {
          from.fontSize = a.fontSize; to.fontSize = b.fontSize;
          if (a.lineHeight !== 'normal' && b.lineHeight !== 'normal') { from.lineHeight = a.lineHeight; to.lineHeight = b.lineHeight; }
        }
        Object.assign(node.style, { position: 'absolute', left: to.left, top: to.top, right: 'auto', bottom: 'auto', width: to.width, height: to.height,
          margin: '0px', boxSizing: 'border-box', flex: 'none' });
        if (text) node.style.display = 'block';
        floated.push(cleanup(() => {
          if (placeholder.isConnected) placeholder.replaceWith(node);
          if (originalStyle === null) node.removeAttribute('style'); else node.setAttribute('style', originalStyle);
        }));
        return { node, from, to };
      }
      for (const [key, node] of afterKeys) {
        if (!shared.has(key) || isStatic(node)) continue;
        const a = before.get(key), b = after.get(key);
        if (['img', 'svg', 'picture', 'figure'].includes(node.localName)) {
          if (Math.abs(a.rect.left - b.rect.left) > .25 || Math.abs(a.rect.top - b.rect.top) > .25 ||
            Math.abs(a.rect.width - b.rect.width) > .25 || Math.abs(a.rect.height - b.rect.height) > .25 || a.opacity !== b.opacity) moves.push(floatImage(node, a, b));
          continue;
        }
        if (node.localName === 'span' && (Math.abs(a.rect.left - b.rect.left) > .25 || Math.abs(a.rect.top - b.rect.top) > .25 || a.fontSize !== b.fontSize)) {
          moves.push(floatImage(node, a, b, true)); continue;
        }
        let dx = (a.rect.left - b.rect.left) / scale.x, dy = (a.rect.top - b.rect.top) / scale.y;
        const parent = node.parentElement?.closest(KEY);
        if (parent && shared.has(parent.dataset.motionKey) && !isStatic(parent)) {
          const pa = before.get(parent.dataset.motionKey), pb = after.get(parent.dataset.motionKey);
          dx -= (pa.rect.left - pb.rect.left) / scale.x; dy -= (pa.rect.top - pb.rect.top) / scale.y;
        }
        const from = { transform: `translate(${dx}px, ${dy}px) ${b.transform}` }, to = { transform: b.transform || 'none' };
        if (a.fontSize !== b.fontSize && node.localName !== 'img') { from.fontSize = a.fontSize; to.fontSize = b.fontSize; }
        if (a.opacity !== b.opacity) { from.opacity = a.opacity; to.opacity = b.opacity; }
        if (Math.abs(dx) > .25 || Math.abs(dy) > .25 || Object.keys(from).length > 1) moves.push({ node, from, to });
      }
      if (moves.length) { phase('move'); await Promise.all(moves.map(({ node, from, to }) => animate(node, [from, to], 240))); }
      if (token !== epoch) return;
      floated.forEach(restore => restore()); imageLayer?.remove();
      if (entryGhosts.length) {
        phase('enter');
        for (const copy of entryGhosts) { mount.append(copy); cleanup(() => copy.remove()); }
        await Promise.all(entryGhosts.map(node => animate(node,
          [{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'translateY(0px)' }], 160)));
        if (token !== epoch) return;
      }
      entryRestores.forEach(restore => restore()); clearTransient();
    }
    async function drain(record, token) {
      running = true;
      try {
        while (record && token === epoch) {
          current = record; await perform(record, token);
          if (token !== epoch) return;
          record.resolve({ superseded: false }); current = null;
          record = pending; pending = null;
        }
      } catch (error) {
        current?.reject(error); pending?.reject(error); current = null; pending = null;
      } finally {
        if (token === epoch) { running = false; forced = false; clearTransient(); settleIdle(); }
      }
    }
    function immediate(record) {
      epoch++; for (const animation of animations) animation.cancel(); animations.clear(); clearTransient();
      if (current !== record) current?.resolve({ superseded: true });
      if (pending !== record) pending?.resolve({ superseded: true });
      current = pending = null;
      running = false; forced = false;
      const template = document.createElement('template'); template.innerHTML = record.html;
      commit(record, template, keyed(mount)); record.resolve({ superseded: false }); settleIdle();
    }
    function update(html, { scene: nextScene = scene, onCommit } = {}) {
      const record = { html, scene: nextScene, onCommit };
      const promise = new Promise((resolve, reject) => { record.resolve = resolve; record.reject = reject; });
      if (reduce.matches) immediate(record);
      else if (running) { pending?.resolve({ superseded: true }); pending = record; }
      else drain(record, epoch);
      return promise;
    }
    function idle() { return running || pending ? new Promise(resolve => idleWaiters.push(resolve)) : Promise.resolve(); }
    function finish() {
      forced = true;
      for (const animation of [...animations]) { try { animation.finish(); } catch (_) { animation.cancel(); } }
      if (!running) { forced = false; settleIdle(); }
      return idle();
    }
    function reduced() {
      if (!reduce.matches) return;
      const latest = pending || current;
      if (latest) immediate(latest); else { clearTransient(); settleIdle(); }
    }
    const controller = { update, finish, idle, reduced };
    sceneControllers.add(controller);
    return controller;
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
    const options = { duration: 240, easing: 'linear', fill: 'both' };
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
    if (!reduce.matches && windowEl.isConnected && controller.pending?.src === requestedSrc) {
      controller.pending.attrs = attrs; mountCover(controller); return controller.pending.promise;
    }
    if (!reduce.matches && windowEl.isConnected && controller.active?.record.src === requestedSrc) {
      controller.active.record.attrs = attrs; controller.pending?.resolve(); controller.pending = null;
      if (controller.active.started) applyCover(controller, controller.active.record);
      mountCover(controller); return controller.active.record.promise;
    }
    const loader = new Image(); loader.src = requestedSrc;
    const record = { src: requestedSrc, attrs, direction: direction < 0 ? -1 : 1, loader, ready: decoded(loader) };
    const promise = new Promise(resolve => { record.resolve = resolve; }); record.promise = promise;
    if (reduce.matches || !windowEl.isConnected || !oldSrc || requestedSrc === controller.renderedSrc && !controller.active) {
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
