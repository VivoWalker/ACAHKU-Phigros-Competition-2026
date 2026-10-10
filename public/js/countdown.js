(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BroadcastCountdown = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const DURATION = 3950, EASE = 'cubic-bezier(.22, 1, .36, 1)';
  function context(state) {
    if (!state) return null;
    let current;
    if (state.stage === 'qualifier' && state.scene === 'qualifier-match') {
      const q = state.qualifier, songId = q.groups[q.activeGroup]?.songs[q.currentSong];
      if (!q.activePlayers.length || !state.library.some(song => song.id === songId)) return null;
      current = { scene: state.scene, stage: state.stage, group: q.activeGroup, songIndex: q.currentSong, songId, players: [...q.activePlayers] };
    } else if (state.stage === 'double-elimination' && state.scene === 'double-elimination-match') {
      const m = state.tournament.matches.find(match => match.id === state.tournament.currentMatchId), song = m?.songs[m.currentSong];
      if (!m || m.status === 'complete' || m.players.filter(Boolean).length !== 2 || m.songs.length !== (m.id === 'GF' ? 3 : 2) || !song || song.hidden || m.id === 'GF' && m.currentSong === 2 && !m.hostRevealed) return null;
      current = { scene: state.scene, stage: state.stage, matchId: m.id, songIndex: m.currentSong, songId: song.id, players: [...m.players] };
    } else return null;
    current.showHandcams = state.broadcast?.showHandcams === true;
    // Only public fields: private OBS source assignments never enter this key.
    current.key = JSON.stringify([current.scene, current.stage, current.group || current.matchId, current.songIndex, current.songId, current.players, current.showHandcams]);
    return current;
  }
  function phase(cue, now) {
    if (!cue || now >= cue.endsAt) return null;
    const elapsed = Math.max(0, now - cue.startsAt), index = Math.min(3, Math.floor(elapsed / 1000));
    return { index, label: ['3', '2', '1', 'START'][index], startsAt: cue.startsAt + index * 1000,
      pending: now < cue.startsAt, fading: now >= cue.endsAt - 250, progress: Math.min(1, elapsed / 3700) };
  }
  function createClient(socket, onChange) {
    let cue = null, sequence = -1, anchor = null, epoch = 0, disposed = false, timer;
    const now = () => anchor ? anchor.serverNow + performance.now() - anchor.localNow : 0;
    function apply(packet) {
      if (!packet || !Number.isFinite(packet.serverNow) || !Number.isSafeInteger(packet.sequence)) return;
      if (!anchor) anchor = { serverNow: packet.serverNow, localNow: performance.now() };
      if (packet.sequence < sequence) return;
      sequence = packet.sequence; cue = packet.cue; onChange?.();
    }
    function sampleClock() {
      const token = epoch; let best = Infinity, samples = 0;
      const sample = () => {
        if (disposed || token !== epoch || !socket.connected) return;
        const began = performance.now();
        socket.timeout(1500).emit('countdown-sync', (error, packet) => {
          if (disposed || token !== epoch || !socket.connected) return;
          const received = performance.now(), roundTrip = received - began;
          if (!error && Number.isFinite(packet?.serverNow)) {
            if (roundTrip < best) { best = roundTrip; anchor = { serverNow: packet.serverNow + roundTrip / 2, localNow: received }; }
            apply(packet);
          }
          if (++samples < 3) timer = setTimeout(sample, 40);
          else timer = setTimeout(sampleClock, 30000);
        });
      }; sample();
    }
    function connected() { epoch++; clearTimeout(timer); sequence = -1; cue = anchor = null; sampleClock(); onChange?.(); }
    function disconnected() { epoch++; clearTimeout(timer); cue = null; onChange?.(); }
    socket.on('countdown', apply); socket.on('connect', connected); socket.on('disconnect', disconnected);
    if (socket.connected) connected();
    return { now, get cue() { return cue; }, get connected() { return socket.connected; },
      dispose() { disposed = true; disconnected(); socket.off('countdown', apply); socket.off('connect', connected); socket.off('disconnect', disconnected); }
    };
  }
  function createLayer(canvas) {
    const layer = document.createElement('section'); layer.className = 'match-countdown'; layer.hidden = true;
    layer.setAttribute('role', 'status'); layer.setAttribute('aria-live', 'assertive'); layer.setAttribute('aria-atomic', 'true');
    layer.innerHTML = '<div class="countdown-frame"><p class="countdown-eyebrow">ACAHKU · PHIGROS</p><div class="countdown-number"></div><p class="countdown-caption">GET READY</p><div class="countdown-progress" aria-hidden="true"><i></i></div></div>';
    canvas.append(layer);
    const number = layer.querySelector('.countdown-number'), caption = layer.querySelector('.countdown-caption'), progress = layer.querySelector('.countdown-progress i');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    let client, eligible, cueId, shown = -1, frame, numberAnimation, fadeAnimation;
    function hide() {
      layer.hidden = true; layer.style.opacity = ''; layer.removeAttribute('data-countdown-id'); delete layer.dataset.countdownPhase;
      numberAnimation?.cancel(); fadeAnimation?.cancel(); numberAnimation = fadeAnimation = null;
      number.style.opacity = ''; number.style.transform = ''; cueId = null; shown = -1;
    }
    function paint() {
      const cue = client?.cue, current = phase(cue, client?.now() || 0);
      if (!client?.connected || document.hidden || !eligible || !cue || cue.context.key !== eligible.key || !current) { hide(); return false; }
      layer.hidden = false; layer.dataset.countdownId = cue.id; layer.dataset.countdownPhase = current.label;
      if (cueId !== cue.id || shown !== current.index) {
        numberAnimation?.cancel(); if (cueId !== cue.id) { fadeAnimation?.cancel(); fadeAnimation = null; }
        cueId = cue.id; shown = current.index; number.textContent = current.label;
        layer.classList.toggle('is-start', current.index === 3); caption.textContent = current.index === 3 ? '開始比賽' : 'GET READY';
        if (!reduce.matches) {
          // Ease the short entrance/exit separately so each digit stays readable
          // for the middle of its second instead of fading early with global easing.
          const frames = [{ opacity: 0, transform: 'translateX(96px) scale(.82)', offset: 0, easing: EASE }, { opacity: 1, transform: 'translateX(0) scale(1)', offset: .2 }];
          if (current.index < 3) frames.push({ opacity: 1, transform: 'translateX(0) scale(1)', offset: .85, easing: EASE }, { opacity: 0, transform: 'translateX(-60px) scale(1.04)', offset: 1 });
          else frames.push({ opacity: 1, transform: 'translateX(0) scale(1)' });
          numberAnimation = number.animate(frames, { duration: current.index === 3 ? 700 : 1000, easing: 'linear', fill: 'both' });
          numberAnimation.startTime = (document.timeline.currentTime ?? performance.now()) - (client.now() - current.startsAt);
        }
      }
      progress.style.transform = `scaleX(${current.progress})`;
      if (current.fading && !fadeAnimation && !reduce.matches) {
        fadeAnimation = layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, easing: EASE, fill: 'both' });
        fadeAnimation.startTime = (document.timeline.currentTime ?? performance.now()) - (client.now() - (cue.endsAt - 250));
      }
      return true;
    }
    function run() { frame = null; if (paint()) frame = requestAnimationFrame(run); }
    function update(nextClient, state, scene) {
      client = nextClient; eligible = scene === state?.scene ? context(state) : null;
      if (frame) cancelAnimationFrame(frame); run();
    }
    reduce.addEventListener('change', () => { numberAnimation?.cancel(); fadeAnimation?.cancel(); fadeAnimation = null; shown = -1; if (frame) cancelAnimationFrame(frame); run(); });
    document.addEventListener('visibilitychange', () => { if (frame) cancelAnimationFrame(frame); run(); });
    return { update };
  }
  return { context, phase, createClient, createLayer, DURATION };
});
