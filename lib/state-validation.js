const { SCENES, DEFINITIONS, publicState } = require('./tournament');

function validateState(state) {
  const invalid = (field, message = 'invalid value') => { throw new Error(`Damaged state: ${field} (${message}).`); };
  const object = (v, field) => { if (!v || typeof v !== 'object' || Array.isArray(v)) invalid(field, 'expected an object'); };
  const string = (v, field, max = 240, required = false) => { if (typeof v !== 'string' || v.length > max || (required && !v.trim())) invalid(field, 'expected text'); };
  const integer = (v, field, min, max) => { if (!Number.isSafeInteger(v) || v < min || v > max) invalid(field, 'integer out of range'); };
  const bool = (v, field) => { if (typeof v !== 'boolean') invalid(field, 'expected a boolean'); };
  const list = (v, field, length, max = 1000) => { if (!Array.isArray(v) || v.length > max || (length !== undefined && v.length !== length)) invalid(field, 'invalid array length'); };
  const unique = (values, field) => { if (new Set(values).size !== values.length) invalid(field, 'duplicate identifiers'); };
  const date = (v, field) => { string(v, field, 80, true); if (!Number.isFinite(Date.parse(v))) invalid(field, 'invalid timestamp'); };
  const scores = (values, field, count) => { list(values, field, count); values.forEach((value, i) => { if (value !== null) integer(value, `${field}[${i}]`, 0, 1000000); }); };
  object(state, 'state');
  if (state.schemaVersion !== 1) invalid('schemaVersion', 'unsupported version');
  integer(state.revision, 'revision', 0, Number.MAX_SAFE_INTEGER - 1);
  date(state.updatedAt, 'updatedAt');
  object(state.event, 'event');
  for (const key of ['title', 'organiser', 'organiserZH', 'date', 'time', 'venue', 'message']) string(state.event[key], `event.${key}`, key === 'organiser' ? 180 : 120, ['title', 'venue'].includes(key));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(state.event.date)) invalid('event.date');
  if (!SCENES.includes(state.scene)) invalid('scene');
  if (!['qualifier', 'double-elimination'].includes(state.stage)) invalid('stage');
  // Earlier schema-1 files may predate the optional broadcast display settings.
  if (state.broadcast !== undefined) {
    object(state.broadcast, 'broadcast');
    if (state.broadcast.showHandcams !== undefined) bool(state.broadcast.showHandcams, 'broadcast.showHandcams');
    if (state.broadcast.sourceSlots !== undefined) {
      object(state.broadcast.sourceSlots, 'broadcast.sourceSlots');
      for (const [key, count] of [['qualifier', 3], ['double', 2]]) {
        if (state.broadcast.sourceSlots[key] === undefined) continue;
        list(state.broadcast.sourceSlots[key], `broadcast.sourceSlots.${key}`, count);
        state.broadcast.sourceSlots[key].forEach((slot, i) => {
          object(slot, `broadcast.sourceSlots.${key}[${i}]`);
          for (const name of ['capture', 'handcam']) string(slot[name], `broadcast.sourceSlots.${key}[${i}].${name}`, 80);
        });
      }
    }
    if (state.broadcast.sourceCheck !== undefined && state.broadcast.sourceCheck !== null) {
      object(state.broadcast.sourceCheck, 'broadcast.sourceCheck');
      string(state.broadcast.sourceCheck.signature, 'broadcast.sourceCheck.signature', 4000, true);
      date(state.broadcast.sourceCheck.confirmedAt, 'broadcast.sourceCheck.confirmedAt');
    }
  }
  const song = (value, field) => {
    object(value, field); string(value.id, `${field}.id`, 80, true); string(value.title, `${field}.title`, 100, true);
    string(value.artist, `${field}.artist`, 100); if (!['EZ', 'HD', 'IN', 'AT'].includes(value.difficulty)) invalid(`${field}.difficulty`);
    if (!Number.isFinite(value.level) || value.level < 1 || value.level > 20) invalid(`${field}.level`);
    string(value.art, `${field}.art`, 180, true);
    if (!/^assets\/[a-zA-Z0-9_./-]+\.(svg|png|jpg|jpeg|webp)$/i.test(value.art) || value.art.includes('..')) invalid(`${field}.art`);
    if (value.previewAudio !== undefined) {
      string(value.previewAudio, `${field}.previewAudio`, 180);
      if (value.previewAudio !== '' && (!/^assets\/song-preview\/[a-zA-Z0-9_./-]+\.(mp3|ogg|wav|m4a)$/i.test(value.previewAudio) || value.previewAudio.includes('..'))) invalid(`${field}.previewAudio`);
    }
    bool(value.eligible, `${field}.eligible`);
  };
  list(state.library, 'library', undefined, 500); state.library.forEach((s, i) => song(s, `library[${i}]`)); unique(state.library.map(s => s.id), 'library');
  const songIds = new Set(state.library.map(s => s.id));
  const songRef = (id, field) => { string(id, field, 80, true); if (!songIds.has(id)) invalid(field, 'unknown song'); };
  const q = state.qualifier; object(q, 'qualifier'); list(q.players, 'qualifier.players', undefined, 64);
  q.players.forEach((p, i) => {
    const field = `qualifier.players[${i}]`; object(p, field); string(p.id, `${field}.id`, 80, true); string(p.name, `${field}.name`, 48, true);
    if (!['A', 'B'].includes(p.group)) invalid(`${field}.group`); scores(p.scores, `${field}.scores`, 3);
    if (p.tiePriority !== null) integer(p.tiePriority, `${field}.tiePriority`, 1, 64);
  });
  unique(q.players.map(p => p.id), 'qualifier.players');
  const playerIds = new Set(q.players.map(p => p.id));
  const playerRef = (id, field, nullable = true) => { if (nullable && id === null) return; if (!playerIds.has(id)) invalid(field, 'unknown player'); };
  if (!['A', 'B'].includes(q.activeGroup)) invalid('qualifier.activeGroup'); integer(q.currentSong, 'qualifier.currentSong', 0, 2);
  list(q.activePlayers, 'qualifier.activePlayers', undefined, 3); unique(q.activePlayers, 'qualifier.activePlayers');
  q.activePlayers.forEach(id => { playerRef(id, 'qualifier.activePlayers', false); if (q.players.find(p => p.id === id).group !== q.activeGroup) invalid('qualifier.activePlayers', 'player from another group'); });
  object(q.groups, 'qualifier.groups');
  for (const group of ['A', 'B']) {
    object(q.groups[group], `qualifier.groups.${group}`); list(q.groups[group].songs, `qualifier.groups.${group}.songs`, 3);
    unique(q.groups[group].songs, `qualifier.groups.${group}.songs`); q.groups[group].songs.forEach(id => songRef(id, `qualifier.groups.${group}.songs`));
    if (q.players.filter(p => p.group === group).length > 32) invalid(`qualifier.players.${group}`, 'too many players');
  }
  if (q.groups.A.songs.some(id => q.groups.B.songs.includes(id))) invalid('qualifier.groups', 'groups share songs');
  const t = state.tournament; object(t, 'tournament'); bool(t.seeded, 'tournament.seeded');
  list(t.seeds, 'tournament.seeds', t.seeded ? 8 : 0); t.seeds.forEach(id => playerRef(id, 'tournament.seeds')); unique(t.seeds.filter(Boolean), 'tournament.seeds');
  if (t.seeded && t.seeds.filter(Boolean).length < 2) invalid('tournament.seeds', 'at least two entrants are required');
  list(t.matches, 'tournament.matches', t.seeded ? DEFINITIONS.length : 0); unique(t.matches.map(m => m?.id), 'tournament.matches');
  const matchIds = new Set(t.matches.map(m => m?.id));
  if (t.currentMatchId !== null && !matchIds.has(t.currentMatchId)) invalid('tournament.currentMatchId', 'unknown match');
  if (t.seeded && !matchIds.has(t.currentMatchId)) invalid('tournament.currentMatchId');
  t.matches.forEach((m, i) => {
    const field = `tournament.matches[${i}]`; object(m, field); const definition = DEFINITIONS.find(d => d[0] === m.id);
    if (!definition) invalid(`${field}.id`, 'unknown match');
    if (m.round !== definition[1] || m.bracket !== definition[2]) invalid(field, 'incorrect round or bracket'); string(m.label, `${field}.label`, 120, true);
    list(m.sources, `${field}.sources`, 2);
    m.sources.forEach((source, index) => { object(source, `${field}.sources[${index}]`); const expected = definition[index + 4]; if (source.type !== expected.type || source.value !== expected.value) invalid(`${field}.sources[${index}]`, 'incorrect bracket dependency'); });
    list(m.players, `${field}.players`, 2); m.players.forEach(id => playerRef(id, `${field}.players`)); unique(m.players.filter(Boolean), `${field}.players`);
    if (!['pending', 'ready', 'live', 'complete'].includes(m.status)) invalid(`${field}.status`);
    const count = m.id === 'GF' ? 3 : 2; list(m.scores, `${field}.scores`, 2); m.scores.forEach((s, pi) => scores(s, `${field}.scores[${pi}]`, count));
    list(m.candidates, `${field}.candidates`, undefined, m.id === 'GF' ? 8 : 6); if (![0, m.id === 'GF' ? 8 : 6].includes(m.candidates.length)) invalid(`${field}.candidates`);
    m.candidates.forEach((s, si) => { song(s, `${field}.candidates[${si}]`); songRef(s.id, `${field}.candidates[${si}].id`); }); unique(m.candidates.map(s => s.id), `${field}.candidates`);
    list(m.songs, `${field}.songs`, undefined, count); if (![0, count].includes(m.songs.length)) invalid(`${field}.songs`);
    m.songs.forEach((s, si) => { song(s, `${field}.songs[${si}]`); if (!m.candidates.some(c => c.id === s.id)) invalid(`${field}.songs`, 'song outside candidates'); }); unique(m.songs.map(s => s.id), `${field}.songs`);
    list(m.bans, `${field}.bans`, 2); m.bans.forEach(id => { if (id !== null && !m.candidates.some(s => s.id === id)) invalid(`${field}.bans`, 'ban outside candidates'); }); unique(m.bans.filter(Boolean), `${field}.bans`);
    list(m.audiencePicks, `${field}.audiencePicks`, undefined, 2); unique(m.audiencePicks, `${field}.audiencePicks`); m.audiencePicks.forEach(id => { if (!m.candidates.some(s => s.id === id)) invalid(`${field}.audiencePicks`); });
    if (m.hostPick !== null) { song(m.hostPick, `${field}.hostPick`); if (m.id !== 'GF' || !m.candidates.some(s => s.id === m.hostPick.id)) invalid(`${field}.hostPick`); }
    bool(m.hostRevealed, `${field}.hostRevealed`); integer(m.currentSong, `${field}.currentSong`, 0, Math.max(0, m.songs.length - 1));
    for (const key of ['winnerId', 'loserId']) { playerRef(m[key], `${field}.${key}`); if (m[key] !== null && !m.players.includes(m[key])) invalid(`${field}.${key}`, 'result player not in match'); }
    if (![null, 'score', 'bye', 'draw'].includes(m.resultType)) invalid(`${field}.resultType`); string(m.note, `${field}.note`, 240);
    if (m.status === 'complete' && m.resultType === null) invalid(`${field}.resultType`, 'completed result missing');
    if (m.overridePlayers !== null) { list(m.overridePlayers, `${field}.overridePlayers`, 2); m.overridePlayers.forEach(id => playerRef(id, `${field}.overridePlayers`)); unique(m.overridePlayers.filter(Boolean), `${field}.overridePlayers`); }
    if (m.id === 'GF' && m.songs.length && (!m.hostPick || m.songs[2].id !== m.hostPick.id)) invalid(`${field}.hostPick`, 'private final selection missing');
    const resolved = m.sources.map(source => source.type === 'seed' ? { ready: true, id: t.seeds[source.value - 1] } : (() => {
      const prior = t.matches.find(match => match.id === source.value);
      return { ready: prior?.status === 'complete', id: source.type === 'winner' ? prior?.winnerId : prior?.loserId };
    })());
    const expectedPlayers = m.overridePlayers || resolved.map(source => source.id ?? null);
    if (m.players.some((id, index) => id !== expectedPlayers[index])) invalid(`${field}.players`, 'players differ from bracket dependencies');
    const ready = resolved.every(source => source.ready);
    if (m.status !== 'complete') {
      const expectedStatus = ready ? (m.id === t.currentMatchId ? 'live' : 'ready') : 'pending';
      if (m.status !== expectedStatus || m.resultType !== null || m.winnerId !== null || m.loserId !== null) invalid(`${field}.status`, 'inconsistent match state');
    } else {
      if (!ready) invalid(`${field}.status`, 'result before preceding matches finished');
      const present = m.players.filter(Boolean), totals = m.scores.map(row => row.reduce((sum, value) => sum + (value ?? 0), 0));
      if (m.resultType === 'score') {
        if (present.length !== 2 || m.songs.length !== count || m.scores.flat().some(value => value === null) || (m.id === 'GF' && !m.hostRevealed)) invalid(`${field}.resultType`, 'incomplete scored result');
        const tied = totals[0] === totals[1];
        if (!present.includes(m.winnerId) || (!tied && m.winnerId !== m.players[totals[0] > totals[1] ? 0 : 1]) || (tied && !m.note.trim())) invalid(`${field}.winnerId`, 'winner differs from scores or tie adjudication');
        if (m.loserId !== present.find(id => id !== m.winnerId)) invalid(`${field}.loserId`, 'incorrect loser');
      } else if (m.resultType === 'bye' || m.resultType === 'draw') {
        if (present.length > 1 || m.winnerId !== (present[0] ?? null) || m.loserId !== null || m.scores.flat().some(value => value !== null)) invalid(`${field}.resultType`, 'invalid vacant-field result');
        if (m.resultType === 'draw' && (!m.overridePlayers || present.length !== 1)) invalid(`${field}.resultType`, 'invalid lottery result');
      }
    }
  });
  list(t.drawLog, 'tournament.drawLog', undefined, 10000);
  t.drawLog.forEach((entry, i) => { const field = `tournament.drawLog[${i}]`; object(entry, field); if (!matchIds.has(entry.matchId) || !matchIds.has(entry.target)) invalid(field, 'unknown match'); list(entry.eligible, `${field}.eligible`, undefined, 8); entry.eligible.forEach(id => playerRef(id, `${field}.eligible`, false)); playerRef(entry.winnerId, `${field}.winnerId`, false); string(entry.note, `${field}.note`, 240); date(entry.timestamp, `${field}.timestamp`); });
  if (state.result !== null) {
    const r = state.result; object(r, 'result'); if (!matchIds.has(r.matchId)) invalid('result.matchId'); string(r.label, 'result.label', 120); if (!['WB', 'LB', 'GF'].includes(r.bracket)) invalid('result.bracket'); integer(r.round, 'result.round', 1, 6);
    for (const key of ['winnerId', 'loserId']) playerRef(r[key], `result.${key}`); if (!['score', 'bye', 'draw'].includes(r.type)) invalid('result.type'); string(r.note, 'result.note', 240);
    list(r.players, 'result.players', 2); r.players.forEach(id => playerRef(id, 'result.players')); list(r.totals, 'result.totals', 2); r.totals.forEach(value => integer(value, 'result.totals', 0, 3000000));
    object(r.placements, 'result.placements'); for (const [id, placement] of Object.entries(r.placements)) { playerRef(id, 'result.placements', false); string(placement, 'result.placements', 80); }
    const match = t.matches.find(m => m.id === r.matchId);
    if (match.status !== 'complete' || r.winnerId !== match.winnerId || r.loserId !== match.loserId || r.type !== match.resultType || r.label !== match.label || r.bracket !== match.bracket || r.round !== match.round || r.note !== match.note || r.players.some((id, index) => id !== match.players[index]) || r.totals.some((value, index) => value !== match.scores[index].reduce((sum, score) => sum + (score ?? 0), 0))) invalid('result', 'displayed result differs from completed match');
    const placements = {};
    if (match.id === 'L6' && match.loserId) placements[match.loserId] = 'Third place';
    if (match.id === 'GF') { if (match.winnerId) placements[match.winnerId] = 'Champion'; if (match.loserId) placements[match.loserId] = 'First Runner-up'; }
    if (Object.keys(r.placements).length !== Object.keys(placements).length || Object.entries(placements).some(([id, place]) => r.placements[id] !== place)) invalid('result.placements', 'placements differ from the result');
  }
  if (state.auditLog !== undefined) {
    list(state.auditLog, 'auditLog', undefined, 500); state.auditLog.forEach((entry, i) => { object(entry, `auditLog[${i}]`); integer(entry.revision, `auditLog[${i}].revision`, 0, state.revision); string(entry.type, `auditLog[${i}].type`, 80, true); date(entry.at, `auditLog[${i}].at`); if (entry.reason !== undefined) string(entry.reason, `auditLog[${i}].reason`, 1000); });
  }
  if (state.correctionLog !== undefined) list(state.correctionLog, 'correctionLog', undefined, 10000);
  if (state.recovery !== undefined && state.recovery !== null) { object(state.recovery, 'recovery'); date(state.recovery.recoveredAt, 'recovery.recoveredAt'); string(state.recovery.backupId, 'recovery.backupId', 180, true); string(state.recovery.preservedFile, 'recovery.preservedFile', 180, true); string(state.recovery.message, 'recovery.message', 500, true); }
  // Validate the exact derived state path used by HTTP and Socket.IO before accepting a save.
  try { publicState(state); } catch { invalid('publicState', 'cannot publish this state'); }
  return state;
}

module.exports = { validateState };
