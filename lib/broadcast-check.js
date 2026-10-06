// Records a crew member's visual check. This does not connect to OBS or verify video.
const SLOT_COUNTS = { qualifier: 3, double: 2 };

function sourceStatus(state) {
  const layout = state.stage === 'qualifier' ? 'qualifier' : 'double';
  const match = state.tournament.matches.find(m => m.id === state.tournament.currentMatchId);
  const players = layout === 'qualifier' ? state.qualifier.activePlayers : match?.players || [];
  const sources = state.broadcast?.sourceSlots?.[layout] || [];
  const slots = Array.from({ length: SLOT_COUNTS[layout] }, (_, index) => {
    const playerId = players[index] || null;
    return { index, playerId, playerName: state.qualifier.players.find(p => p.id === playerId)?.name || '',
      capture: sources[index]?.capture || '', handcam: sources[index]?.handcam || '' };
  });
  const showHandcams = state.broadcast?.showHandcams === true;
  const signature = JSON.stringify({ layout, context: layout === 'qualifier' ? state.qualifier.activeGroup : match?.id || null,
    showHandcams, slots });
  const confirmed = state.broadcast?.sourceCheck?.signature === signature;
  return { layout, signature, showHandcams, slots, confirmed,
    confirmedAt: confirmed ? state.broadcast.sourceCheck.confirmedAt : null };
}

function applyBroadcastCheckAction(state, action) {
  if (!['set-broadcast-sources', 'confirm-broadcast-sources'].includes(action.type)) return false;
  const payload = action.payload || {};
  const check = (valid, message) => { if (!valid) throw new Error(message); };
  state.broadcast ||= { showHandcams: false };
  if (action.type === 'set-broadcast-sources') {
    check(Object.hasOwn(SLOT_COUNTS, payload.layout), 'Choose the qualifier or double-elimination source layout.');
    check(Array.isArray(payload.slots) && payload.slots.length === SLOT_COUNTS[payload.layout], 'Provide every source slot for this layout.');
    const slots = payload.slots.map(slot => {
      check(slot && typeof slot === 'object', 'Provide capture-card and handcam source names.');
      for (const key of ['capture', 'handcam']) check(typeof slot[key] === 'string' && slot[key].length <= 80, 'Source names must be text of at most 80 characters.');
      return { capture: slot.capture.trim(), handcam: slot.handcam.trim() };
    });
    state.broadcast.sourceSlots = { ...state.broadcast.sourceSlots, [payload.layout]: slots };
    // Saving even identical labels calls for a fresh visual check of the real feeds.
    state.broadcast.sourceCheck = null;
  } else {
    const status = sourceStatus(state), occupied = status.slots.filter(slot => slot.playerId);
    check(typeof payload.signature === 'string' && payload.signature === status.signature,
      'The entrants, match or sources changed. Check the current OBS feeds again.');
    check(occupied.length > 0, 'Select on-stage players before checking OBS sources.');
    check(occupied.every(slot => slot.capture && (!status.showHandcams || slot.handcam)),
      'Name the capture source for each player, and the handcam source when dual view is enabled.');
    state.broadcast.sourceCheck = { signature: status.signature, confirmedAt: new Date().toISOString() };
  }
  return true;
}

module.exports = { sourceStatus, applyBroadcastCheckAction };
