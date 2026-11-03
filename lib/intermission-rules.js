const { randomUUID } = require('node:crypto');
const Intermission = require('../public/js/intermission');
const COMMANDS = new Set(['configure-intermission', 'start-intermission', 'play-intermission-video', 'stop-intermission-video', 'end-intermission']);
function applyAction(state, action) {
  if (action.type === 'set-scene' && action.payload?.scene === 'intermission')
    return applyAction(state, { type: 'start-intermission' });
  if (!COMMANDS.has(action.type)) return false;
  const current = state.broadcast?.intermission || Intermission.defaults(), payload = action.payload || {};
  let next = { ...current };
  if (action.type === 'configure-intermission') {
    next = { ...next, videoPath: payload.videoPath, loop: payload.loop, resumeTime: payload.resumeTime };
    if (next.videoPath !== current.videoPath || next.loop !== current.loop) next.cue = null;
    Intermission.validate(next);
  } else if (action.type === 'start-intermission' || action.type === 'play-intermission-video') {
    if (action.type === 'play-intermission-video' && (state.scene !== 'intermission' || !current.videoPath))
      throw new Error('Start the intermission and configure a video before playing the trailer.');
    state.scene = 'intermission';
    next.cue = current.videoPath ? { id: randomUUID(), startedAt: Date.now() } : null;
  } else if (action.type === 'end-intermission') {
    if (state.scene !== 'intermission') throw new Error('The intermission is no longer on air.');
    next.cue = null; state.stage = 'double-elimination';
    state.scene = state.tournament.seeded ? 'bracket' : 'double-elimination-waiting';
  } else next.cue = null;
  state.broadcast = { ...state.broadcast, intermission: next };
  return true;
}
module.exports = { COMMANDS, applyAction };
