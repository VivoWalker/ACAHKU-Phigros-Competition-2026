const { randomInt, randomUUID } = require('node:crypto');
const SCENES = ['start', 'qualifier-waiting', 'double-elimination-waiting', 'qualifier-match', 'double-elimination-match', 'result', 'bracket', 'song-selection'];
const seed = n => ({ type: 'seed', value: n });
const win = id => ({ type: 'winner', value: id });
const lose = id => ({ type: 'loser', value: id });
const DEFINITIONS = [
  ['W1', 1, 'WB', 'Winners’ Bracket Round 1', seed(1), seed(8)],
  ['W2', 1, 'WB', 'Winners’ Bracket Round 1', seed(4), seed(5)],
  ['W3', 1, 'WB', 'Winners’ Bracket Round 1', seed(2), seed(7)],
  ['W4', 1, 'WB', 'Winners’ Bracket Round 1', seed(3), seed(6)],
  ['W5', 2, 'WB', 'Winners’ Bracket Round 2', win('W1'), win('W2')],
  ['W6', 2, 'WB', 'Winners’ Bracket Round 2', win('W3'), win('W4')],
  ['L1', 2, 'LB', 'Losers’ Bracket Entry', lose('W1'), lose('W2')],
  ['L2', 2, 'LB', 'Losers’ Bracket Entry', lose('W3'), lose('W4')],
  ['W7', 3, 'WB', 'Winners’ Bracket Final', win('W5'), win('W6')],
  ['L3', 3, 'LB', 'Losers’ Bracket Round 2', win('L1'), lose('W6')],
  ['L4', 3, 'LB', 'Losers’ Bracket Round 2', win('L2'), lose('W5')],
  ['L5', 4, 'LB', 'Losers’ Bracket Round 3', win('L3'), win('L4')],
  ['L6', 5, 'LB', 'Losers’ Bracket Final', win('L5'), lose('W7')],
  ['GF', 6, 'GF', 'Grand Finals', win('W7'), win('L6')]
];
function assert(value, message) { if (!value) throw new Error(message); }
function text(value, max = 120) {
  assert(typeof value === 'string', 'Expected text.');
  return value.trim().slice(0, max);
}
function score(value) {
  if (value === '' || value === null) return null;
  assert(Number.isInteger(value) && value >= 0 && value <= 1000000, 'Scores must be integers from 0 to 1,000,000.');
  return value;
}
function shuffled(values, rand = randomInt) {
  const a = [...values];
  for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function total(scores) { return scores.reduce((s, n) => s + (n ?? 0), 0); }
function rankings(state, group) {
  const players = state.qualifier.players.filter(p => p.group === group)
    .map(p => ({ ...p, total: total(p.scores), complete: p.scores.every(n => n !== null) }))
    .sort((a, b) => b.total - a.total || (a.tiePriority ?? 999) - (b.tiePriority ?? 999) || a.id.localeCompare(b.id));
  return players.map((p, i) => ({ ...p, rank: i + 1,
    tied: players.some(other => other.id !== p.id && other.total === p.total &&
      (other.tiePriority === null || p.tiePriority === null || other.tiePriority === p.tiePriority))
  }));
}
function createBracket(ids) {
  assert(ids.length === 8, 'Exactly eight seed slots are required. Use null for a vacancy.');
  const used = ids.filter(Boolean);
  assert(new Set(used).size === used.length, 'A player cannot occupy two seed slots.');
  assert(used.length >= 2, 'At least two players are required.');
  return { seeded: true, seeds: ids, currentMatchId: 'W1', drawLog: [],
    matches: DEFINITIONS.map(([id, round, bracket, label, a, b]) => ({
      id, round, bracket, label, sources: [a, b], players: [null, null],
      status: 'pending', candidates: [], bans: [null, null], songs: [],
      audiencePicks: [], hostPick: null, hostRevealed: false,
      currentSong: 0, scores: [Array(id === 'GF' ? 3 : 2).fill(null), Array(id === 'GF' ? 3 : 2).fill(null)],
      winnerId: null, loserId: null, resultType: null, note: '', overridePlayers: null
    }))
  };
}
function resolveBracket(state) {
  const t = state.tournament;
  for (const m of t.matches) {
    const resolved = m.sources.map(source => {
      if (source.type === 'seed') return { ready: true, id: t.seeds[source.value - 1] ?? null };
      const prior = t.matches.find(x => x.id === source.value);
      return { ready: prior?.status === 'complete', id: source.type === 'winner' ? prior?.winnerId : prior?.loserId };
    });
    if (m.status !== 'complete') {
      m.players = m.overridePlayers ?? resolved.map(s => s.id ?? null);
      const ready = resolved.every(s => s.ready);
      m.status = ready ? (m.id === t.currentMatchId ? 'live' : 'ready') : 'pending';
    }
  }
}
function losses(state, playerId) {
  if (!playerId) return 0;
  return state.tournament.matches.filter(m => m.status === 'complete' && m.loserId === playerId).length;
}
function getMatch(state, id = state.tournament.currentMatchId) {
  const m = state.tournament.matches.find(x => x.id === id);
  assert(m, 'Seed the bracket and select a match first.');
  return m;
}
function editable(m) { assert(m.status !== 'complete', 'This result is locked. Completed matches cannot be reset or overwritten.'); }
function playable(m) { editable(m); assert(m.status !== 'pending', 'Previous matches must finish before this match is available.'); }
function findSong(state, id) { const s = state.library.find(x => x.id === id); assert(s, 'Unknown song.'); return { ...s }; }
function participant(state, id) { return state.qualifier.players.find(p => p.id === id); }
function makeResult(state, m) {
  const placements = {};
  if (m.id === 'L6' && m.loserId) placements[m.loserId] = 'Third place';
  if (m.id === 'GF') { if (m.winnerId) placements[m.winnerId] = 'Champion'; if (m.loserId) placements[m.loserId] = 'First Runner-up'; }
  state.result = { matchId: m.id, label: m.label, bracket: m.bracket, round: m.round,
    winnerId: m.winnerId, loserId: m.loserId, type: m.resultType, note: m.note,
    players: [...m.players], totals: m.scores.map(total), placements };
}
function finish(state, m, winnerId, kind, note = '') {
  m.winnerId = winnerId;
  m.loserId = m.players.find(id => id && id !== winnerId) ?? null;
  m.resultType = kind; m.note = note; m.status = 'complete';
  resolveBracket(state); makeResult(state, m);
}
function applyAction(state, action) {
  assert(action && typeof action.type === 'string', 'Invalid command.');
  const p = action.payload ?? {};
  switch (action.type) {
    case 'set-event': {
      for (const key of ['title', 'organiser', 'organiserZH', 'date', 'time', 'venue', 'message']) {
        if (key in p) state.event[key] = text(p[key], key === 'organiser' ? 180 : 120);
      }
      assert(state.event.title && state.event.venue, 'Event name and venue are required.');
      assert(/^\d{4}-\d{2}-\d{2}$/.test(state.event.date), 'Use a YYYY-MM-DD date.');
      break;
    }
    case 'set-scene':
      assert(SCENES.includes(p.scene), 'Unknown scene.'); state.scene = p.scene;
      if (p.scene.startsWith('qualifier-')) state.stage = 'qualifier';
      else if (p.scene.startsWith('double-elimination-') || ['bracket', 'song-selection'].includes(p.scene)) state.stage = 'double-elimination';
      break;
    case 'set-stage': assert(['qualifier', 'double-elimination'].includes(p.stage), 'Unknown stage.'); state.stage = p.stage; break;
    case 'set-roster': {
      assert(!state.tournament.seeded, 'The seeded player roster is locked.');
      assert(['A', 'B'].includes(p.group) && Array.isArray(p.names), 'Choose Group A or B.');
      assert(p.names.length <= 32, 'Maximum 32 players per group.');
      const names = p.names.map(n => text(n, 48)).filter(Boolean);
      assert(new Set(names).size === names.length, 'Names within a group must be unique.');
      const old = state.qualifier.players.filter(x => x.group === p.group);
      state.qualifier.players = state.qualifier.players.filter(x => x.group !== p.group).concat(names.map(name =>
        old.find(x => x.name === name) ?? { id: randomUUID(), name, group: p.group, scores: [null, null, null], tiePriority: null }));
      state.qualifier.activePlayers = state.qualifier.activePlayers.filter(id => participant(state, id));
      break;
    }
    case 'randomise-groups': {
      assert(!state.tournament.seeded && state.qualifier.players.every(p => p.scores.every(n => n === null)), 'Randomise groups before scoring or seeding.');
      shuffled(state.qualifier.players).forEach((p, i) => { p.group = i % 2 ? 'B' : 'A'; });
      state.qualifier.activePlayers = []; break;
    }
    case 'set-qualifier-display': {
      if (p.group !== undefined) { assert(['A', 'B'].includes(p.group), 'Invalid group.'); state.qualifier.activeGroup = p.group; state.qualifier.activePlayers = []; }
      if (p.players !== undefined) {
        assert(Array.isArray(p.players) && p.players.length <= 3 && new Set(p.players).size === p.players.length, 'Choose up to three different players.');
        assert(p.players.every(id => participant(state, id)?.group === state.qualifier.activeGroup), 'Displayed players must be in the active group.');
        state.qualifier.activePlayers = p.players;
      }
      if (p.currentSong !== undefined) { assert(Number.isInteger(p.currentSong) && p.currentSong >= 0 && p.currentSong < 3, 'Invalid song number.'); state.qualifier.currentSong = p.currentSong; }
      break;
    }
    case 'set-qualifier-songs': {
      assert(['A', 'B'].includes(p.group) && Array.isArray(p.ids) && p.ids.length === 3 && new Set(p.ids).size === 3, 'Choose three different songs.');
      assert(!state.qualifier.players.some(x => x.group === p.group && x.scores.some(n => n !== null)), 'Group songs are locked after scoring starts.');
      const other = state.qualifier.groups[p.group === 'A' ? 'B' : 'A'].songs;
      assert(!p.ids.some(id => other.includes(id)), 'Groups A and B must use different songs.');
      p.ids.forEach(id => findSong(state, id)); state.qualifier.groups[p.group].songs = p.ids; break;
    }
    case 'set-qualifier-score': {
      assert(!state.tournament.seeded, 'Qualifier scores are locked after seeding.');
      const player = participant(state, p.playerId); assert(player, 'Unknown player.');
      assert(Number.isInteger(p.songIndex) && p.songIndex >= 0 && p.songIndex < 3, 'Invalid song number.');
      player.scores[p.songIndex] = score(p.score); break;
    }
    case 'set-tie-priority': {
      assert(!state.tournament.seeded, 'Qualifier rankings are locked after seeding.');
      const player = participant(state, p.playerId); assert(player, 'Unknown player.');
      assert(p.priority === null || (Number.isInteger(p.priority) && p.priority >= 1 && p.priority <= 64), 'Tie priority must be 1–64.');
      player.tiePriority = p.priority; break;
    }
    case 'qualify': {
      assert(!state.tournament.seeded, 'Bracket already seeded.');
      const groups = ['A', 'B'].map(group => rankings(state, group));
      groups.forEach(group => {
        assert(group.length >= 4 && group.every(p => p.complete), 'All group scores must be entered, with at least four players in each group.');
        assert(!group.slice(0, 4).some(p => p.tied), 'Resolve tied qualifier rankings using unique tie priorities.');
      });
      const ids = Array.from({ length: 4 }, (_, i) => [groups[0][i].id, groups[1][i].id]).flat();
      state.tournament = createBracket(ids); state.stage = 'double-elimination'; resolveBracket(state); break;
    }
    case 'seed-bracket': {
      assert(!state.tournament.matches.some(m => m.status === 'complete' || m.scores.flat().some(n => n !== null)), 'Seeding is locked once scoring or results begin.');
      assert(Array.isArray(p.ids), 'Provide eight seed slots.');
      p.ids.filter(Boolean).forEach(id => assert(participant(state, id), 'Unknown seeded player.'));
      state.tournament = createBracket(p.ids); state.result = null; state.stage = 'double-elimination'; resolveBracket(state); break;
    }
    case 'select-match': {
      const m = getMatch(state, p.matchId); assert(m.status !== 'pending' && m.status !== 'complete', 'Select a ready match.');
      state.tournament.currentMatchId = m.id; state.stage = 'double-elimination'; resolveBracket(state); break;
    }
    case 'draw-candidates': {
      const m = getMatch(state); playable(m); assert(m.id !== 'GF', 'Set eight Grand Finals candidates separately.');
      assert(m.players.every(Boolean), 'This match has a vacancy; record a bye or draw.');
      assert(m.scores.flat().every(n => n === null), 'Reset this match before redrawing songs.');
      const pool = state.library.filter(s => s.eligible);
      assert(pool.length >= 6, 'At least six eligible library songs are required.');
      m.candidates = shuffled(pool).slice(0, 6).map(s => ({ ...s })); m.bans = [null, null]; m.songs = []; m.currentSong = 0; break;
    }
    case 'ban-song': {
      const m = getMatch(state); playable(m); assert(m.id !== 'GF' && m.candidates.length === 6, 'Draw six candidates first.');
      assert([0, 1].includes(p.playerIndex), 'Invalid player.');
      assert(m.songs.length === 0, 'Bans are locked after the final draw.');
      assert(p.songId === null || m.candidates.some(s => s.id === p.songId), 'Song is not in this draw.');
      assert(!p.songId || m.bans[1 - p.playerIndex] !== p.songId, 'The other player has already banned that song.');
      m.bans[p.playerIndex] = p.songId; break;
    }
    case 'pick-songs': {
      const m = getMatch(state); playable(m); assert(m.id !== 'GF', 'Use the Grand Finals selection flow.');
      assert(m.songs.length === 0 && m.candidates.length === 6 && m.bans.every(Boolean), 'Both players must ban one song before the draw.');
      const remaining = m.candidates.filter(s => !m.bans.includes(s.id)); assert(remaining.length === 4, 'Four songs must remain.');
      m.songs = shuffled(remaining).slice(0, 2); m.currentSong = 0; break;
    }
    case 'set-final-candidates': {
      const m = getMatch(state); playable(m); assert(m.id === 'GF', 'Select Grand Finals first.');
      assert(m.scores.flat().every(n => n === null), 'Reset the final before changing candidates.');
      assert(Array.isArray(p.ids) && p.ids.length === 8 && new Set(p.ids).size === 8, 'Choose eight distinct candidates.');
      m.candidates = p.ids.map(id => findSong(state, id)); m.audiencePicks = []; m.hostPick = null; m.hostRevealed = false; m.songs = []; break;
    }
    case 'set-final-picks': {
      const m = getMatch(state); playable(m); assert(m.id === 'GF' && m.candidates.length === 8, 'Set eight final candidates first.');
      assert(m.scores.flat().every(n => n === null), 'Picks are locked after scoring begins.');
      assert(Array.isArray(p.audienceIds) && p.audienceIds.length === 2 && new Set(p.audienceIds).size === 2, 'Record two different audience picks.');
      assert(!p.audienceIds.includes(p.hostId), 'MC pick must differ from the audience picks.');
      const lookup = id => { const s = m.candidates.find(x => x.id === id); assert(s, 'Pick from the eight candidates.'); return { ...s }; };
      m.audiencePicks = p.audienceIds; m.hostPick = lookup(p.hostId); m.songs = [...p.audienceIds.map(lookup), m.hostPick]; m.hostRevealed = false; m.currentSong = 0; break;
    }
    case 'reveal-host-song': {
      const m = getMatch(state); playable(m); assert(m.id === 'GF' && m.hostPick, 'Set an MC pick first.'); m.hostRevealed = true; break;
    }
    case 'set-song-progress': {
      const m = getMatch(state); playable(m);
      assert(Number.isInteger(p.index) && p.index >= 0 && p.index < m.songs.length, 'Choose a selected song.');
      assert(m.id !== 'GF' || p.index !== 2 || m.hostRevealed, 'Reveal the MC pick before going to song three.');
      m.currentSong = p.index; break;
    }
    case 'set-match-score': {
      const m = getMatch(state); playable(m); assert(m.players.every(Boolean), 'A vacant match cannot be scored.');
      assert([0, 1].includes(p.playerIndex) && Number.isInteger(p.songIndex) && p.songIndex >= 0 && p.songIndex < m.scores[0].length, 'Invalid score slot.');
      assert(m.songs.length === m.scores[0].length, 'Select the match songs first.');
      assert(m.id !== 'GF' || p.songIndex !== 2 || m.hostRevealed, 'Reveal the MC song before scoring it.');
      m.scores[p.playerIndex][p.songIndex] = score(p.score); break;
    }
    case 'record-result': {
      const m = getMatch(state); playable(m);
      assert(m.players.every(Boolean) && m.scores.flat().every(n => n !== null), 'Enter every song score for both players.');
      const sums = m.scores.map(total); let winnerId;
      if (sums[0] === sums[1]) {
        assert(m.players.includes(p.tieWinnerId) && text(p.note ?? '').length > 0, 'A tied total needs a referee-selected winner and an adjudication note.'); winnerId = p.tieWinnerId;
      } else winnerId = m.players[sums[0] > sums[1] ? 0 : 1];
      finish(state, m, winnerId, 'score', text(p.note ?? '', 240)); state.scene = 'result'; break;
    }
    case 'record-bye': {
      const m = getMatch(state); playable(m); const present = m.players.filter(Boolean);
      assert(present.length <= 1, 'Byes are only valid for vacant matches.');
      finish(state, m, present[0] ?? null, 'bye', text(p.note ?? 'Vacant slot', 240)); break;
    }
    case 'lottery-bye': {
      const m = getMatch(state); playable(m);
      const pairIds = m.round === 1 ? (['W1', 'W2'].includes(m.id) ? ['W1', 'W2'] : ['W3', 'W4']) : m.round === 2 && m.bracket === 'LB' ? ['L1', 'L2'] : [];
      assert(pairIds.includes(m.id), 'A four-player entry field is required for a lottery.');
      const pair = pairIds.map(id => getMatch(state, id));
      assert(pair.every(x => ['ready', 'live'].includes(x.status) && x.scores.flat().every(n => n === null)), 'Both entry matches must be ready and unscored.');
      const all = pair.flatMap(x => x.players).filter(Boolean); assert(all.length === 3 && new Set(all).size === 3, 'Lottery requires exactly three players and one vacancy in this field.');
      const winner = p.playerId || shuffled(all)[0]; assert(all.includes(winner), 'Draw winner must belong to this four-player field.');
      const others = all.filter(id => id !== winner); const other = pair.find(x => x.id !== m.id);
      m.overridePlayers = [winner, null]; m.players = [...m.overridePlayers];
      other.overridePlayers = others; other.players = [...others];
      const note = text(p.note || 'Four-player vacancy lottery', 240);
      state.tournament.drawLog.push({ matchId: m.id, eligible: all, winnerId: winner, target: m.id, note, timestamp: new Date().toISOString() });
      finish(state, m, winner, 'draw', note); break;
    }
    case 'reset-current-match': {
      const m = getMatch(state); playable(m); const count = m.id === 'GF' ? 3 : 2;
      m.candidates = []; m.bans = [null, null]; m.songs = []; m.audiencePicks = []; m.hostPick = null; m.hostRevealed = false; m.currentSong = 0;
      m.scores = [Array(count).fill(null), Array(count).fill(null)]; break;
    }
    case 'upsert-song': {
      assert(p.song && typeof p.song === 'object', 'Provide song details.');
      const s = p.song;
      const song = { id: s.id ? text(s.id, 80) : randomUUID(), title: text(s.title, 100), artist: text(s.artist ?? '', 100),
        difficulty: text(s.difficulty, 2), level: Number(s.level), art: text(s.art || 'assets/song/cover-1.svg', 180), eligible: Boolean(s.eligible) };
      assert(song.title && ['EZ', 'HD', 'IN', 'AT'].includes(song.difficulty) && Number.isFinite(song.level) && song.level >= 1 && song.level <= 20, 'Provide title, difficulty and a level from 1 to 20.');
      assert(/^assets\/[a-zA-Z0-9_./-]+\.(svg|png|jpg|jpeg|webp)$/i.test(song.art) && !song.art.includes('..'), 'Artwork must be a local assets path.');
      const index = state.library.findIndex(x => x.id === song.id);
      if (index < 0) { assert(state.library.length < 500, 'Library limit is 500 songs.'); state.library.push(song); }
      else state.library[index] = song;
      break;
    }
    default: throw new Error('Unknown command.');
  }
  resolveBracket(state);
  return state;
}
function publicState(state) {
  const copy = structuredClone(state);
  for (const m of copy.tournament.matches) {
    delete m.hostPick;
    if (m.id === 'GF' && !m.hostRevealed && m.songs.length >= 3) {
      m.songs[2] = { id: 'sealed', title: 'MC PICK — SEALED', artist: 'To be revealed', difficulty: '', level: null, art: 'assets/song/sealed.svg', hidden: true };
    }
  }
  copy.qualifier.rankings = { A: rankings(copy, 'A'), B: rankings(copy, 'B') };
  copy.tournament.standings = copy.tournament.seeds.map((id, i) => ({
    playerId: id, seed: i + 1, losses: losses(copy, id), eliminated: Boolean(id) && losses(copy, id) >= 2,
    placement: copy.tournament.matches.find(m => m.id === 'GF' && m.status === 'complete')?.winnerId === id && id ? 'Champion' :
      copy.tournament.matches.find(m => m.id === 'GF' && m.status === 'complete')?.loserId === id && id ? 'First Runner-up' :
      copy.tournament.matches.find(m => m.id === 'L6' && m.status === 'complete')?.loserId === id && id ? 'Third place' : null
  }));
  return copy;
}
module.exports = { SCENES, DEFINITIONS, createBracket, resolveBracket, rankings, total, losses, applyAction, publicState };
