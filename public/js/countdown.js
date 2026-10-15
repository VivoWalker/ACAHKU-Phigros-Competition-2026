(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BroadcastCountdown = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const ENTRY_DURATION = 650, COUNTDOWN_DURATION = 3700, EXIT_DURATION = 650;
  const DURATION = ENTRY_DURATION + COUNTDOWN_DURATION + EXIT_DURATION;
  const EASE = 'cubic-bezier(.22, 1, .36, 1)', SWEEP_EASE = 'cubic-bezier(.65, 0, .35, 1)';
  function context(state) {
    if (!state) return null;
    let current;
    if (state.stage === 'qualifier' && state.scene === 'qualifier-match') {
      const q = state.qualifier, rounds = q.rounds?.[q.activeGroup]?.tiebreaks, pending = rounds?.at(-1), tie = pending && !pending.confirmed ? pending : null;
      const songId = tie?.song.id || q.groups[q.activeGroup]?.songs[q.currentSong];
      if (!q.activePlayers.length || !state.library.some(song => song.id === songId)) return null;
      if (q.rounds?.[q.activeGroup]?.locked || q.activePlayers.some(id => state.qualifier.players.find(player => player.id === id)?.disqualification)) return null;
      current = { scene: state.scene, stage: state.stage, group: q.activeGroup, songIndex: tie ? 0 : q.currentSong, songId, players: [...q.activePlayers],
        ...(tie ? { tiebreakIndex: rounds.length - 1 } : {}) };
    } else if (state.stage === 'double-elimination' && state.scene === 'double-elimination-match') {
      const m = state.tournament.matches.find(match => match.id === state.tournament.currentMatchId), pending = m?.tiebreaks?.at(-1), tie = pending && !pending.confirmed ? pending : null;
      const song = tie?.song || m?.songs[m.currentSong];
      if (!m || m.status === 'complete' || m.players.filter(Boolean).length !== 2 || m.songs.length !== (m.id === 'GF' && m.finalMode !== 'fixed-two' ? 3 : 2) || !song || song.hidden || m.id === 'GF' && m.currentSong === 2 && !m.hostRevealed) return null;
      current = { scene: state.scene, stage: state.stage, matchId: m.id, songIndex: tie ? 0 : m.currentSong, songId: song.id, players: [...m.players],
        ...(tie ? { tiebreakIndex: m.tiebreaks.length - 1 } : {}) };
    } else return null;
    current.showHandcams = state.broadcast?.showHandcams === true;
    // Only public fields: private OBS source assignments never enter this key.
    current.key = JSON.stringify([current.scene, current.stage, current.group || current.matchId, current.songIndex, current.songId, current.players, current.showHandcams]);
    if (current.tiebreakIndex !== undefined) current.key += ':' + current.tiebreakIndex;
    return current;
  }
  function phase(cue, now) {
    if (!cue || now >= cue.endsAt) return null;
    const elapsed = Math.max(0, now - cue.startsAt), counting = Math.max(0, elapsed - ENTRY_DURATION);
    const index = Math.min(3, Math.floor(counting / 1000));
    const stage = elapsed < ENTRY_DURATION ? 'entering' : now >= cue.endsAt - EXIT_DURATION ? 'exiting' : 'counting';
    return { index, stage, label: stage === 'entering' ? '' : ['3', '2', '1', 'START'][index],
      startsAt: cue.startsAt + ENTRY_DURATION + index * 1000,
      pending: now < cue.startsAt, fading: stage === 'exiting', progress: Math.min(1, counting / COUNTDOWN_DURATION) };
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
    layer.innerHTML = '<div class="countdown-sheet"><div class="countdown-surface" aria-hidden="true"></div><div class="countdown-frame" hidden><p class="countdown-eyebrow">MATCH START</p><div class="countdown-number"></div><p class="countdown-caption">準備開始</p><div class="countdown-progress" aria-hidden="true"><i></i><i></i><i></i></div></div></div>';
    canvas.append(layer);
    const sheet = layer.querySelector('.countdown-sheet'), content = layer.querySelector('.countdown-frame');
    const number = layer.querySelector('.countdown-number'), caption = layer.querySelector('.countdown-caption');
    const steps = [...layer.querySelectorAll('.countdown-progress i')];
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    let client, eligible, cueId, shown = -1, frame = null, sheetAnimation = null, disposed = false;
    const beatAnimations = [];
    function cancelBeat() {
      for (const animation of beatAnimations) animation.cancel();
      beatAnimations.length = 0;
    }
    function animateBeat(element, frames, duration, offset = 0) {
      const animation = element.animate(frames, { duration, easing: 'linear', fill: 'both' });
      animation.startTime = (document.timeline.currentTime ?? performance.now()) - offset;
      beatAnimations.push(animation);
    }
    function hide() {
      if (layer.hidden && shown === -1 && !beatAnimations.length && !sheetAnimation) return;
      layer.hidden = true; content.hidden = true; layer.removeAttribute('data-countdown-id');
      delete layer.dataset.countdownPhase; delete layer.dataset.countdownStage;
      cancelBeat(); sheetAnimation?.cancel(); sheetAnimation = null;
      layer.classList.remove('is-start');
      cueId = null; shown = -1;
    }
    function paint() {
      if (disposed) return false;
      const cue = client?.cue, current = phase(cue, client?.now() || 0);
      if (!client?.connected || document.hidden || !eligible || !cue || cue.context.key !== eligible.key || !current) { hide(); return false; }
      layer.hidden = false; layer.dataset.countdownId = cue.id; layer.dataset.countdownPhase = current.label;
      layer.dataset.countdownStage = current.stage;
      content.hidden = current.stage === 'entering';
      if (cueId !== cue.id) {
        cancelBeat(); sheetAnimation?.cancel(); sheetAnimation = null;
        cueId = cue.id; shown = -1;
        layer.classList.remove('is-start');
        if (!reduce.matches) {
          const duration = cue.endsAt - cue.startsAt;
          sheetAnimation = sheet.animate([
            { transform: 'translateX(2480px)', opacity: 1, offset: 0, easing: SWEEP_EASE },
            { transform: 'translateX(0)', opacity: 1, offset: ENTRY_DURATION / duration },
            { transform: 'translateX(0)', opacity: 1, offset: (duration - EXIT_DURATION) / duration, easing: SWEEP_EASE },
            { transform: 'translateX(2480px)', opacity: 0, offset: 1 }
          ], { duration, easing: 'linear', fill: 'both' });
          sheetAnimation.startTime = (document.timeline.currentTime ?? performance.now()) - (client.now() - cue.startsAt);
        }
      }
      if (current.stage !== 'entering' && shown !== current.index) {
        cancelBeat(); shown = current.index; number.textContent = current.label;
        layer.classList.toggle('is-start', current.index === 3);
        caption.textContent = current.index === 3 ? '開始比賽' : '準備開始';
        steps.forEach((step, index) => {
          step.classList.toggle('is-current', current.index === index);
          step.classList.toggle('is-complete', current.index > index);
        });
        if (!reduce.matches) {
          const elapsed = client.now() - current.startsAt;
          // Each beat comes from the same server clock. Late sources seek into
          // the current motion rather than replaying its entrance.
          const frames = [{ opacity: 0, transform: 'translateX(40px)', offset: 0, easing: EASE }, { opacity: 1, transform: 'translateX(0)', offset: .2 }];
          if (current.index < 3) frames.push({ opacity: 1, transform: 'translateX(0)', offset: .85, easing: EASE }, { opacity: 0, transform: 'translateX(-32px)', offset: 1 });
          else frames.push({ opacity: 1, transform: 'translateX(0)' });
          animateBeat(number, frames, current.index === 3 ? 700 : 1000, elapsed);
        }
      }
      return true;
    }
    function run() { frame = null; if (!disposed && paint()) frame = requestAnimationFrame(run); }
    function restart() { if (frame !== null) cancelAnimationFrame(frame); frame = null; if (!disposed) run(); }
    function update(nextClient, state, scene) {
      if (disposed) return;
      client = nextClient; eligible = scene === state?.scene ? context(state) : null;
      restart();
    }
    function preferenceChanged() {
      if (disposed) return;
      cancelBeat(); sheetAnimation?.cancel(); sheetAnimation = null; cueId = null; shown = -1; restart();
    }
    function visibilityChanged() { restart(); }
    reduce.addEventListener('change', preferenceChanged);
    document.addEventListener('visibilitychange', visibilityChanged);
    return { update, dispose() {
      if (disposed) return;
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame); frame = null;
      reduce.removeEventListener('change', preferenceChanged);
      document.removeEventListener('visibilitychange', visibilityChanged);
      hide(); client = eligible = null; layer.remove();
    } };
  }

  return { context, phase, createClient, createLayer, DURATION, ENTRY_DURATION, COUNTDOWN_DURATION, EXIT_DURATION };
});
