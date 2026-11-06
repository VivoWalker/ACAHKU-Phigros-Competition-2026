(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BroadcastSelectionRoulette = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const LEAD_MS = 500, DEFAULT_DURATION = 12;
  const STEPS = [70, 70, 80, 80, 90, 100, 110, 120, 135, 150, 170, 195, 220, 250, 280, 320];
  const ROLL_MS = STEPS.reduce((sum, ms) => sum + ms, 0);
  function valid(cue) {
    return cue?.kind === 'picks' && typeof cue.id === 'string' && Number.isFinite(cue.startedAt)
      && Array.isArray(cue.songIds) && cue.songIds.length === 2 && new Set(cue.songIds).size === 2
      && Array.isArray(cue.roulette?.poolIds) && cue.roulette.poolIds.length >= 2 && cue.roulette.poolIds.length <= 6
      && new Set(cue.roulette.poolIds).size === cue.roulette.poolIds.length
      && Array.from(cue.roulette.poolIds).every(id => typeof id === 'string' && id.length > 0)
      && Array.from(cue.songIds).every(id => typeof id === 'string' && cue.roulette.poolIds.includes(id))
      && Array.isArray(cue.durations) && cue.durations.length === 2 && Array.from(cue.durations).every(seconds => Number.isFinite(seconds) && seconds > 0 && seconds <= 600);
  }
  function phase(cue, now) {
    if (!valid(cue)) return null;
    let start = cue.startedAt + LEAD_MS;
    if (now < start) return { stage: 'pending', index: 0, revealedCount: 0, focusId: null, highlightId: null, nextAt: start };
    for (let index = 0; index < 2; index++) {
      const pool = cue.roulette.poolIds.filter(id => index === 0 || id !== cue.songIds[0]);
      if (now < start + ROLL_MS) {
        let step = 0, until = start + STEPS[0];
        while (now >= until && step < STEPS.length - 1) until += STEPS[++step];
        const target = pool.indexOf(cue.songIds[index]);
        const position = ((target - (STEPS.length - 1) + step) % pool.length + pool.length) % pool.length;
        return { stage: 'rolling', index, step, revealedCount: index,
          focusId: index ? cue.songIds[0] : null, highlightId: pool[position], stepStartedAt: until - STEPS[step], nextAt: until };
      }
      start += ROLL_MS;
      const end = start + cue.durations[index] * 1000;
      if (now < end) return { stage: 'preview', index, revealedCount: index + 1, focusId: cue.songIds[index],
        highlightId: cue.songIds[index], offset: Math.max(0, (now - start) / 1000), duration: cue.durations[index], nextAt: end };
      start = end;
    }
    return { stage: 'complete', index: 1, revealedCount: 2, focusId: cue.songIds[1], highlightId: cue.songIds[1], nextAt: null };
  }
  function context(state, now) {
    if (state?.stage !== 'double-elimination' || state.scene !== 'song-selection') return null;
    const match = state.tournament.matches.find(match => match.id === state.tournament.currentMatchId);
    if (!match || match.id === 'GF' || match.status === 'complete' || match.tiebreaks?.length) return null;
    return phase(match.selectionPreviewCue, now);
  }
  function label(current) {
    return !current ? '選曲' : current.stage === 'complete' ? '選曲完成' : current.stage === 'preview'
      ? `SONG 0${current.index + 1}` : `抽選中 · SONG 0${current.index + 1}`;
  }
  function createClock({ now, onChange, setTimer = setTimeout, clearTimer = clearTimeout }) {
    let cue = null, timer = null, signature = '', disposed = false;
    function tick() {
      if (disposed) return;
      if (timer !== null) clearTimer(timer); timer = null;
      const current = phase(cue, now()), key = JSON.stringify([cue?.id, current?.stage, current?.index, current?.step]);
      if (key !== signature) { signature = key; onChange(current); }
      if (current?.nextAt !== null && current?.nextAt !== undefined) timer = setTimer(tick, Math.max(10, Math.min(250, current.nextAt - now())));
    }
    return {
      update(next) { if (!disposed) { cue = next; tick(); } },
      dispose() { disposed = true; cue = null; if (timer !== null) clearTimer(timer); timer = null; }
    };
  }
  function paint(root, current, reduced = false) {
    for (const stage of root.querySelectorAll('.selection-stage,.song-grid')) stage.dataset.rouletteStage = current?.stage || '';
    for (const row of root.querySelectorAll('[data-selection-song]')) {
      const rolling = current?.stage === 'rolling' && !reduced;
      row.classList.toggle('roulette-highlight', !!rolling && row.dataset.selectionSong === current.highlightId);
      if (current) row.classList.toggle('focused', !rolling && current.stage !== 'rolling' && row.dataset.selectionSong === current.focusId);
    }
  }
  return { LEAD_MS, ROLL_MS, STEPS, DEFAULT_DURATION, valid, phase, context, label, createClock, paint };
});
