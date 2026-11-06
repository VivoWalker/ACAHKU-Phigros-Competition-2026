const { randomUUID } = require('node:crypto');
const Intermission = require('../public/js/intermission');
const Videos = require('../public/js/broadcast-videos');
const COMMANDS = new Set(['configure-intermission', 'set-intermission-video-duration', 'start-intermission', 'play-intermission-video', 'stop-intermission-video', 'end-intermission']);
function applyAction(state, action) {
  if (action.type === 'set-scene' && action.payload?.scene === 'intermission')
    return applyAction(state, { type: 'start-intermission' });
  if (action.type === 'set-scene' && action.payload?.scene === 'arcaea-trailer')
    return applyAction(state, { type: 'play-intermission-video' });
  if (!COMMANDS.has(action.type)) return false;
  const current = Videos.intermission(state.broadcast?.intermission || Intermission.defaults()), payload = action.payload || {};
  let next = { ...current };
  if (action.type === 'configure-intermission') {
    if (payload.loop !== undefined && typeof payload.loop !== 'boolean') throw new Error('Invalid intermission loop setting.');
    next = { ...next, videoPath: payload.videoPath, loop: false, resumeTime: payload.resumeTime === undefined ? current.resumeTime : payload.resumeTime };
    if (next.videoPath !== current.videoPath) delete next.videoDuration;
    if (next.videoPath !== current.videoPath || next.loop !== current.loop) {
      next.cue = null;
      if (state.scene === 'arcaea-trailer') state.scene = 'intermission';
    }
    Intermission.validate(next);
  } else if (action.type === 'set-intermission-video-duration') {
    if (payload.videoPath !== current.videoPath || (payload.cueId ?? null) !== (current.cue?.id ?? null))
      throw new Error('The intermission video changed.');
    if (!Number.isFinite(payload.duration) || payload.duration <= 0 || payload.duration > 3600)
      throw new Error('Invalid intermission video duration.');
    next.videoDuration = payload.duration;
    Intermission.validate(next);
  } else if (action.type === 'start-intermission') {
    state.scene = 'intermission'; next.cue = null;
  } else if (action.type === 'play-intermission-video') {
    if (!current.videoPath) throw new Error('Configure a video before playing the trailer.');
    state.scene = 'arcaea-trailer';
    next.cue = { id: randomUUID(), startedAt: Date.now() };
  } else if (action.type === 'end-intermission') {
    if (!['intermission', 'arcaea-trailer'].includes(state.scene)) throw new Error('The intermission is no longer on air.');
    next.cue = null; state.stage = 'double-elimination';
    state.scene = state.tournament.seeded ? 'bracket' : 'double-elimination-waiting';
  } else {
    next.cue = null;
    if (state.scene === 'arcaea-trailer') state.scene = 'intermission';
  }
  state.broadcast = { ...state.broadcast, intermission: next };
  return true;
}
module.exports = { COMMANDS, applyAction };
