(function (root, factory) {
  const config = typeof module === 'object' && module.exports ? require('./competition-config') : root.CompetitionConfig;
  const api = factory(config);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BroadcastFinalAnnouncement = api;
})(typeof globalThis === 'object' ? globalThis : this, function (config) {
  'use strict';
  const PREVIEW_DURATION = 12.042449, LEAD_MS = 500, RISE_MS = 4000;
  const DURATIONS = Object.freeze([PREVIEW_DURATION, PREVIEW_DURATION]);
  const clamp = value => Math.max(0, Math.min(1, value));
  const ease = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
  const isFixed = match => match?.id === 'GF' && match.finalMode === 'fixed-two' &&
    match.songs?.length === 2 && config.FINAL_SONG_IDS.every((id, index) => match.songs[index]?.id === id);
  const validCue = cue => cue && typeof cue.id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cue.id) &&
    Number.isSafeInteger(cue.startedAt) && cue.startedAt >= 0 && cue.startedAt <= 8640000000000000;
  function phase(match, now = Date.now()) {
    const cue = isFixed(match) && match.finalAnnouncement;
    if (!validCue(cue) || !Number.isFinite(now)) return {
      started: false, index: 0, revealedCount: 0, complete: false, pending: false, stageStartedAt: null, coverage: 0
    };
    const elapsed = now - cue.startedAt - LEAD_MS;
    const index = elapsed < DURATIONS[0] * 1000 ? 0 : 1;
    const stageStartedAt = index === 0 ? cue.startedAt : cue.startedAt + LEAD_MS + DURATIONS[0] * 1000;
    return { started: true, index, revealedCount: index + 1,
      complete: elapsed >= (DURATIONS[0] + DURATIONS[1]) * 1000,
      pending: elapsed < 0, stageStartedAt,
      coverage: (index + ease((now - stageStartedAt) / RISE_MS)) / 3 };
  }
  function audioCue(match) {
    if (!isFixed(match) || !validCue(match.finalAnnouncement)) return null;
    return { ...match.finalAnnouncement, kind: 'picks', songIds: [...config.FINAL_SONG_IDS], durations: [...DURATIONS] };
  }
  return Object.freeze({ PREVIEW_DURATION, DURATIONS, LEAD_MS, RISE_MS, isFixed, validCue, phase, audioCue });
});
