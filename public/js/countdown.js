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
    layer.innerHTML = '<div class="countdown-stage" aria-hidden="true"><div class="countdown-lane is-left"><i class="countdown-note is-tap"></i><i class="countdown-note is-hold"></i><i class="countdown-note is-flick"></i></div><div class="countdown-lane is-right"><i class="countdown-note is-tap"></i><i class="countdown-note is-hold"></i><i class="countdown-note is-flick"></i></div><div class="countdown-judgment"><i></i><b></b></div><div class="countdown-hit is-left"></div><div class="countdown-hit is-right"></div></div><div class="countdown-frame"><p class="countdown-eyebrow">PHIGROS</p><div class="countdown-number"></div><p class="countdown-caption">GET READY</p><div class="countdown-progress" aria-hidden="true"><i></i></div></div>';
    canvas.append(layer);
    const number = layer.querySelector('.countdown-number'), caption = layer.querySelector('.countdown-caption'), progress = layer.querySelector('.countdown-progress i');
    const line = layer.querySelector('.countdown-judgment'), notes = [...layer.querySelectorAll('.countdown-note')], hits = [...layer.querySelectorAll('.countdown-hit')];
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    let client, eligible, cueId, shown = -1, frame = null, fadeAnimation = null, disposed = false;
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
      if (layer.hidden && shown === -1 && !beatAnimations.length && !fadeAnimation) return;
      layer.hidden = true; layer.style.opacity = ''; layer.removeAttribute('data-countdown-id'); delete layer.dataset.countdownPhase;
      cancelBeat(); fadeAnimation?.cancel(); fadeAnimation = null;
      layer.classList.remove('is-start'); delete layer.dataset.countdownBeat;
      cueId = null; shown = -1;
    }
    function paint() {
      if (disposed) return false;
      const cue = client?.cue, current = phase(cue, client?.now() || 0);
      if (!client?.connected || document.hidden || !eligible || !cue || cue.context.key !== eligible.key || !current) { hide(); return false; }
      layer.hidden = false; layer.dataset.countdownId = cue.id; layer.dataset.countdownPhase = current.label;
      if (cueId !== cue.id || shown !== current.index) {
        cancelBeat(); if (cueId !== cue.id) { fadeAnimation?.cancel(); fadeAnimation = null; }
        cueId = cue.id; shown = current.index; number.textContent = current.label;
        layer.classList.toggle('is-start', current.index === 3); layer.dataset.countdownBeat = ['tap', 'hold', 'flick', 'start'][current.index];
        caption.textContent = current.index === 3 ? '開始比賽' : 'GET READY';
        if (!reduce.matches) {
          const elapsed = client.now() - current.startsAt;
          // Each beat comes from the same server clock. Late sources seek into
          // the current motion rather than replaying its entrance.
          const frames = [{ opacity: 0, transform: 'translate(42px, 18px) scale(.9)', offset: 0, easing: EASE }, { opacity: 1, transform: 'translate(0, 0) scale(1)', offset: .2 }];
          if (current.index < 3) frames.push({ opacity: 1, transform: 'translate(0, 0) scale(1)', offset: .85, easing: EASE }, { opacity: 0, transform: 'translate(-32px, -10px) scale(1.025)', offset: 1 });
          else frames.push({ opacity: 1, transform: 'translate(0, 0) scale(1)' });
          animateBeat(number, frames, current.index === 3 ? 700 : 1000, elapsed);
          if (current.index < 3) {
            const type = ['is-tap', 'is-hold', 'is-flick'][current.index];
            const skew = current.index === 2 ? ' skewX(-15deg)' : '';
            for (const note of notes) if (note.classList.contains(type)) animateBeat(note, [
              { opacity: 0, transform: `translateY(-580px)${skew}`, offset: 0, easing: 'cubic-bezier(.45, 0, .55, 1)' },
              { opacity: 1, transform: `translateY(-540px)${skew}`, offset: .08, easing: 'cubic-bezier(.45, 0, .55, 1)' },
              { opacity: 1, transform: `translateY(0)${skew}`, offset: .76 },
              { opacity: 0, transform: `translateY(10px)${skew}`, offset: .83 },
              { opacity: 0, transform: `translateY(10px)${skew}`, offset: 1 }
            ], 1000, elapsed);
            for (const hit of hits) animateBeat(hit, [
              { opacity: 0, transform: 'scale(.3)', offset: 0 },
              { opacity: 0, transform: 'scale(.3)', offset: .74, easing: EASE },
              { opacity: .65, transform: 'scale(1)', offset: .79, easing: EASE },
              { opacity: 0, transform: 'scale(1.65)', offset: 1 }
            ], 1000, elapsed);
            animateBeat(line, [
              { opacity: .65, offset: 0 }, { opacity: .65, offset: .74, easing: EASE },
              { opacity: 1, offset: .79, easing: EASE }, { opacity: .65, offset: 1 }
            ], 1000, elapsed);
          } else animateBeat(line, [
            { transform: 'scaleX(.3)', opacity: .65, easing: EASE },
            { transform: 'scaleX(1)', opacity: 1 }
          ], 650, elapsed);
        }
      }
      progress.style.transform = `scaleX(${current.progress})`;
      if (current.fading && !fadeAnimation && !reduce.matches) {
        fadeAnimation = layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, easing: EASE, fill: 'both' });
        fadeAnimation.startTime = (document.timeline.currentTime ?? performance.now()) - (client.now() - (cue.endsAt - 250));
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
    function preferenceChanged() { if (disposed) return; cancelBeat(); fadeAnimation?.cancel(); fadeAnimation = null; shown = -1; restart(); }
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

  return { context, phase, createClient, createLayer, DURATION };
});
