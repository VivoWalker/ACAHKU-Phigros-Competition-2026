(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BroadcastFinalSequence = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const STAGES = Object.freeze(['base', 'summary', 'sealed', 'video', 'revealed']);
  const isEnabled = match => match?.id === 'GF' && match.finalMode === 'fixed-two' &&
    !!match.finale && typeof match.finale === 'object' && !Array.isArray(match.finale);
  const songCount = match => match?.id === 'GF' && (match.finalMode !== 'fixed-two' ||
    isEnabled(match) && match.songs?.length === 3) ? 3 : 2;
  const validVideoPath = value => typeof value === 'string' && value.length <= 180 &&
    /^assets\/finale\/[a-zA-Z0-9_./-]+\.(mp4|webm)$/i.test(value) && !value.includes('..') &&
    value.split('/').every(part => part && part !== '.');
  const validVideoCue = cue => !!cue && typeof cue === 'object' && !Array.isArray(cue) &&
    typeof cue.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cue.id) &&
    Number.isSafeInteger(cue.startedAt) && cue.startedAt >= 0 && cue.startedAt <= 8640000000000000 &&
    Number.isFinite(cue.duration) && cue.duration > 0 && cue.duration <= 3600;
  function phase(match, now = Date.now()) {
    const enabled = isEnabled(match), finale = enabled ? match.finale : null;
    const cue = finale?.stage === 'video' && validVideoCue(finale.videoCue) ? finale.videoCue : null;
    const elapsed = cue && Number.isFinite(now) ? Math.max(0, (now - cue.startedAt) / 1000) : 0;
    const videoEnded = !!cue && elapsed >= cue.duration;
    const stage = !enabled ? 'base' : videoEnded ? 'revealed' : finale.stage;
    return { enabled, stage, concealed: enabled && stage !== 'revealed',
      videoActive: !!cue && !videoEnded, videoEnded,
      videoTime: cue ? Math.min(cue.duration, elapsed) : 0,
      videoRemaining: cue ? Math.max(0, cue.duration - elapsed) : 0,
      effectLevel: enabled ? finale.effectLevel : 4 };
  }
  return Object.freeze({ STAGES, isEnabled, songCount, validVideoPath, validVideoCue, phase });
});
