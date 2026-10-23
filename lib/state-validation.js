const { SCENES, DEFINITIONS, RESEED_FIELDS, initialSources, publicState } = require('./tournament');
const ScoreRules = require('../public/js/score-rules');
const QualifierRules = require('../public/js/qualifier-rules');
const MatchRules = require('./match-rules');
const SongPool = require('../public/js/song-pool');
const CompetitionConfig = require('../public/js/competition-config');
const FinalAnnouncement = require('../public/js/final-announcement');
const FinalSequence = require('../public/js/final-sequence');
const { WAIT_MS, WAIT_REASONS, DISQUALIFICATION_REASONS, READINESS_KEYS } = require('./adjudication');

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
  const judgements = (values, field, count) => {
    list(values, field, count);
    values.forEach((value, i) => { try { ScoreRules.normaliseJudgements(value); } catch (error) { invalid(`${field}[${i}]`, error.message); } });
  };
  object(state, 'state');
  if (state.schemaVersion !== 1) invalid('schemaVersion', 'unsupported version');
  if (state.eventId !== undefined && (typeof state.eventId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(state.eventId))) invalid('eventId', 'expected a UUID');
  integer(state.revision, 'revision', 0, Number.MAX_SAFE_INTEGER - 1);
  date(state.updatedAt, 'updatedAt');
  object(state.event, 'event');
  if (state.event.competitionVersion !== undefined && state.event.competitionVersion !== CompetitionConfig.VERSION) invalid('event.competitionVersion', 'unsupported competition configuration');
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
    if (value.constant !== undefined && !CompetitionConfig.validConstant(value.constant, value.level)) invalid(`${field}.constant`, 'expected a chart constant with at most one decimal matching the integer level');
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
  if (state.event.competitionVersion === CompetitionConfig.VERSION) {
    for (const id of CompetitionConfig.FINAL_SONG_IDS) {
      const actual = state.library.find(value => value.id === id), expected = CompetitionConfig.library().find(value => value.id === id);
      if (!actual || actual.eligible || !['title', 'difficulty', 'level'].every(key => actual[key] === expected[key])) invalid('library', 'fixed Grand Final configuration missing or changed');
    }
  } else if (state.scene === 'grand-final-announcement') invalid('scene', 'fixed Grand Final configuration required');
  const q = state.qualifier; object(q, 'qualifier'); list(q.players, 'qualifier.players', undefined, 64);
  if (q.scoringMode !== undefined && ![QualifierRules.CHALLENGE_MODE, 'legacy-score'].includes(q.scoringMode)) invalid('qualifier.scoringMode');
  if (q.scoringStarted !== undefined) bool(q.scoringStarted, 'qualifier.scoringStarted');
  const challenge = QualifierRules.isChallenge(state);
  const qualifierScores = (row, field) => {
    scores(row.scores, `${field}.scores`, 3);
    if (row.songStatsRecorded !== undefined) bool(row.songStatsRecorded, `${field}.songStatsRecorded`);
    if (row.songStats !== undefined) {
      list(row.songStats, `${field}.songStats`, 3);
      row.songStats.forEach((value, index) => {
        try { QualifierRules.normaliseSongStats(value); } catch (error) { invalid(`${field}.songStats[${index}]`, error.message); }
      });
    }
    if (challenge) {
      if (row.challengeTotal !== null) integer(row.challengeTotal, `${field}.challengeTotal`, 0, QualifierRules.MAX_CHALLENGE_TOTAL);
      if (row.scores.some(value => value !== null) || row.judgements?.some(Boolean)) invalid(field, 'Challenge Mode records one total, without individual song scores or accuracy');
    } else if (row.challengeTotal !== undefined && row.challengeTotal !== null) invalid(`${field}.challengeTotal`, 'Challenge Mode scoring required');
  };
  q.players.forEach((p, i) => {
    const field = `qualifier.players[${i}]`; object(p, field); string(p.id, `${field}.id`, 80, true); string(p.name, `${field}.name`, 48, true);
    if (!['A', 'B'].includes(p.group)) invalid(`${field}.group`); qualifierScores(p, field);
    if (challenge && p.tiePriority !== null) invalid(`${field}.tiePriority`, 'Challenge Mode ties require recorded tiebreak songs');
    if (p.tiePriority !== null) integer(p.tiePriority, `${field}.tiePriority`, 1, 64);
    if (p.number !== undefined) integer(p.number, `${field}.number`, 1, 64);
    if (p.judgements !== undefined) judgements(p.judgements, `${field}.judgements`, 3);
    if (p.disqualification !== undefined) {
      object(p.disqualification, `${field}.disqualification`);
      if (!DISQUALIFICATION_REASONS.includes(p.disqualification.reason)) invalid(`${field}.disqualification.reason`);
      date(p.disqualification.at, `${field}.disqualification.at`); string(p.disqualification.note, `${field}.disqualification.note`, 500);
    }
  });
  if (challenge && !q.plan && (q.scoringStarted || q.players.some(player => player.challengeTotal !== null))) invalid('qualifier.challengeTotal', 'configure a qualifier plan before recording Challenge totals');
  unique(q.players.map(p => p.id), 'qualifier.players');
  unique(q.players.filter(p => p.number !== undefined).map(p => p.number), 'qualifier.playerNumbers');
  const playerIds = new Set(q.players.map(p => p.id));
  const playerRef = (id, field, nullable = true) => { if (nullable && id === null) return; if (!playerIds.has(id)) invalid(field, 'unknown player'); };
  if (!['A', 'B'].includes(q.activeGroup)) invalid('qualifier.activeGroup'); integer(q.currentSong, 'qualifier.currentSong', 0, 2);
  list(q.activePlayers, 'qualifier.activePlayers', undefined, 3); unique(q.activePlayers, 'qualifier.activePlayers');
  q.activePlayers.forEach(id => { playerRef(id, 'qualifier.activePlayers', false); if (!QualifierRules.entries(state, q.activeGroup).some(player => player.id === id)) invalid('qualifier.activePlayers', 'player outside current round'); });
  object(q.groups, 'qualifier.groups');
  for (const group of ['A', 'B']) {
    object(q.groups[group], `qualifier.groups.${group}`); list(q.groups[group].songs, `qualifier.groups.${group}.songs`, 3);
    unique(q.groups[group].songs, `qualifier.groups.${group}.songs`); q.groups[group].songs.forEach(id => songRef(id, `qualifier.groups.${group}.songs`));
    if (q.players.filter(p => p.group === group).length > 32) invalid(`qualifier.players.${group}`, 'too many players');
  }
  if (q.plan !== undefined) {
    if (!['A', 'B'].includes(q.plan)) invalid('qualifier.plan');
    if (q.players.some(player => player.number === undefined)) invalid('qualifier.playerNumbers', 'proposal entrants need check-in numbers');
    object(q.rounds, 'qualifier.rounds');
    for (const group of ['A', 'B']) {
      const round = q.rounds[group], field = `qualifier.rounds.${group}`;
      if (round?.scoringStarted !== undefined) bool(round.scoringStarted, `${field}.scoringStarted`);
      object(round, field); list(round.playerIds, `${field}.playerIds`, undefined, 64); unique(round.playerIds, `${field}.playerIds`);
      round.playerIds.forEach(id => playerRef(id, `${field}.playerIds`, false));
      object(round.results, `${field}.results`);
      if (Object.keys(round.results).length !== round.playerIds.length) invalid(`${field}.results`, 'results differ from round entrants');
      for (const id of round.playerIds) {
        const row = round.results[id]; object(row, `${field}.results.${id}`);
        qualifierScores(row, `${field}.results.${id}`); judgements(row.judgements, `${field}.results.${id}.judgements`, 3);
      }
      bool(round.locked, `${field}.locked`); list(round.qualifiedIds, `${field}.qualifiedIds`, undefined, 4); unique(round.qualifiedIds, `${field}.qualifiedIds`);
      if (round.qualifiedIds.some(id => !round.playerIds.includes(id)) || round.qualifiedIds.length !== (round.locked ? 4 : 0)) invalid(`${field}.qualifiedIds`);
      if (round.locked && round.qualifiedIds.some(id => !QualifierRules.complete(state, round.results[id]))) invalid(`${field}.qualifiedIds`, 'qualified entrant has missing results');
      list(round.tiebreaks, `${field}.tiebreaks`, undefined, 1000);
      round.tiebreaks.forEach((tie, index) => {
        const path = `${field}.tiebreaks[${index}]`; object(tie, path); song(tie.song, `${path}.song`); songRef(tie.song.id, `${path}.song.id`);
        list(tie.playerIds, `${path}.playerIds`, undefined, 64); unique(tie.playerIds, `${path}.playerIds`);
        if (tie.playerIds.length < 2 || tie.playerIds.some(id => !round.playerIds.includes(id))) invalid(`${path}.playerIds`);
        object(tie.scores, `${path}.scores`); object(tie.judgements, `${path}.judgements`);
        if (Object.keys(tie.scores).length !== tie.playerIds.length || Object.keys(tie.judgements).length !== tie.playerIds.length) invalid(path, 'score entries differ from tiebreak entrants');
        for (const id of tie.playerIds) { scores([tie.scores[id]], `${path}.scores.${id}`, 1); judgements([tie.judgements[id]], `${path}.judgements.${id}`, 1); }
        bool(tie.confirmed, `${path}.confirmed`);
        if (tie.confirmed) {
          if (tie.playerIds.some(id => tie.scores[id] === null)) invalid(path, 'confirmed tiebreak has missing scores');
          for (const a of tie.playerIds) for (const b of tie.playerIds) if (!challenge && a !== b &&
            ScoreRules.compare([tie.scores[a]], [tie.scores[b]], [tie.judgements[a]], [tie.judgements[b]]).reason === 'missing-accuracy') invalid(path, 'equal scores require accuracy');
        } else if (index !== round.tiebreaks.length - 1) invalid(path, 'unconfirmed tiebreak before a later round');
      });
    }
    if (q.plan === 'A') {
      if (q.rounds.A.playerIds.length !== q.players.length || q.players.some(player => !q.rounds.A.playerIds.includes(player.id))) invalid('qualifier.rounds.A.playerIds');
      const revival = q.rounds.A.locked ? q.rounds.A.playerIds.filter(id => !q.rounds.A.qualifiedIds.includes(id)) : [];
      if (revival.length !== q.rounds.B.playerIds.length || revival.some(id => !q.rounds.B.playerIds.includes(id))) invalid('qualifier.rounds.B.playerIds', 'revival must exclude first-round qualifiers');
      if (!q.rounds.A.locked && q.activeGroup === 'B') invalid('qualifier.activeGroup', 'revival before first round qualification');
    } else for (const group of ['A', 'B']) {
      const expected = q.players.filter(player => (player.number % 2 ? 'A' : 'B') === group).map(player => player.id);
      if (expected.length !== q.rounds[group].playerIds.length || expected.some(id => !q.rounds[group].playerIds.includes(id))) invalid(`qualifier.rounds.${group}.playerIds`, 'group differs from check-in number parity');
    }
  }
  if (q.waits !== undefined) {
    object(q.waits, 'qualifier.waits');
    for (const [id, wait] of Object.entries(q.waits)) {
      playerRef(id, 'qualifier.waits', false); object(wait, 'qualifier.waits');
      if (!WAIT_REASONS.includes(wait.reason)) invalid('qualifier.waits.reason');
      date(wait.startsAt, 'qualifier.waits.startsAt'); date(wait.deadline, 'qualifier.waits.deadline');
      if (Date.parse(wait.deadline) - Date.parse(wait.startsAt) !== WAIT_MS) invalid('qualifier.waits.deadline', 'wait must be ten minutes');
      if (wait.songId !== undefined) songRef(wait.songId, 'qualifier.waits.songId');
    }
  }
  if (q.readiness !== undefined) {
    object(q.readiness, 'qualifier.readiness');
    for (const [id, record] of Object.entries(q.readiness)) {
      playerRef(id, 'qualifier.readiness', false); object(record, 'qualifier.readiness');
      READINESS_KEYS.forEach(key => bool(record[key], `qualifier.readiness.${key}`)); date(record.at, 'qualifier.readiness.at');
    }
  }
  const incident = (entry, field, count) => {
    object(entry, field); integer(entry.songIndex, `${field}.songIndex`, 0, count - 1); songRef(entry.songId, `${field}.songId`);
    if (entry.song !== undefined) {
      song(entry.song, `${field}.song`);
      if (entry.song.id !== entry.songId) invalid(`${field}.song`, 'snapshot differs from incident song');
    }
    if (!['game-error', 'score-page-left'].includes(entry.reason)) invalid(`${field}.reason`);
    for (const key of ['videoChecked', 'unintentional', 'allAgree']) bool(entry[key], `${field}.${key}`);
    if (entry.reason === 'score-page-left' && !(entry.videoChecked && entry.unintentional && entry.allAgree)) invalid(field, 'missing rematch evidence');
    string(entry.note, `${field}.note`, 500, true); date(entry.at, `${field}.at`);
    if (entry.tiebreakIndex !== undefined) integer(entry.tiebreakIndex, `${field}.tiebreakIndex`, 0, 999);
  };
  if (q.incidents !== undefined) {
    list(q.incidents, 'qualifier.incidents', undefined, 10000);
    q.incidents.forEach((entry, i) => { const field = `qualifier.incidents[${i}]`; incident(entry, field, 3); playerRef(entry.playerId, `${field}.playerId`, false); if (!['A', 'B'].includes(entry.group)) invalid(`${field}.group`); });
    unique(q.incidents.map(entry => JSON.stringify([entry.group, entry.playerId, entry.tiebreakIndex === undefined ? ['base', entry.songId] : ['tie', entry.songId, entry.tiebreakIndex]])), 'qualifier.incidents');
    unique(q.incidents.map(entry => JSON.stringify([entry.group, entry.playerId, entry.tiebreakIndex === undefined ? ['base', entry.songIndex] : ['tie', entry.songId, entry.tiebreakIndex]])), 'qualifier.incidents');
  }
  if (q.adjudications !== undefined) {
    list(q.adjudications, 'qualifier.adjudications', undefined, 10000);
    q.adjudications.forEach((entry, i) => {
      const field = `qualifier.adjudications[${i}]`; object(entry, field); string(entry.type, `${field}.type`, 80, true); date(entry.at, `${field}.at`);
      if (entry.note !== undefined) string(entry.note, `${field}.note`, 500);
      if (entry.scoringMode !== undefined && ![QualifierRules.CHALLENGE_MODE, 'legacy-score'].includes(entry.scoringMode)) invalid(`${field}.scoringMode`);
      if (entry.previousResult !== undefined) object(entry.previousResult, `${field}.previousResult`);
      for (const [value, key] of [[entry.previousChallengeTotal, 'previousChallengeTotal'], [entry.previousResult?.challengeTotal, 'previousResult.challengeTotal']]) {
        if (value !== undefined && value !== null) integer(value, `${field}.${key}`, 0, QualifierRules.MAX_CHALLENGE_TOTAL);
      }
      if (entry.scoringMode === QualifierRules.CHALLENGE_MODE && entry.invalidatedTiebreaks !== undefined) {
        list(entry.invalidatedTiebreaks, `${field}.invalidatedTiebreaks`, undefined, 1000);
        entry.invalidatedTiebreaks.forEach((tie, index) => {
          const saved = `${field}.invalidatedTiebreaks[${index}]`; object(tie, saved); song(tie.song, `${saved}.song`);
          list(tie.playerIds, `${saved}.playerIds`, undefined, 64); unique(tie.playerIds, `${saved}.playerIds`);
          if (tie.playerIds.length < 2) invalid(`${saved}.playerIds`);
          tie.playerIds.forEach(id => playerRef(id, `${saved}.playerIds`, false));
          object(tie.scores, `${saved}.scores`); object(tie.judgements, `${saved}.judgements`);
          if (Object.keys(tie.scores).length !== tie.playerIds.length || Object.keys(tie.judgements).length !== tie.playerIds.length) invalid(saved, 'archived scores differ from tiebreak entrants');
          bool(tie.confirmed, `${saved}.confirmed`);
          for (const id of tie.playerIds) {
            scores([tie.scores[id]], `${saved}.scores.${id}`, 1); judgements([tie.judgements[id]], `${saved}.judgements.${id}`, 1);
            if (tie.confirmed && tie.scores[id] === null) invalid(saved, 'confirmed archived tiebreak has missing scores');
          }
        });
      }
    });
  }
  if (q.groups.A.songs.some(id => q.groups.B.songs.includes(id))) invalid('qualifier.groups', 'groups share songs');
  const t = state.tournament; object(t, 'tournament'); bool(t.seeded, 'tournament.seeded');
  if (t.seedingPlan !== undefined && (t.seedingPlan !== 'B' || !t.seeded || q.plan !== 'B')) invalid('tournament.seedingPlan');
  if (t.ruleset !== undefined && (t.ruleset !== 'proposal-2026' || !t.seeded)) invalid('tournament.ruleset');
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
    const reseed = t.ruleset === 'proposal-2026' && RESEED_FIELDS.find(reseed => reseed.matches.includes(m.id));
    if (m.reseeded !== undefined) bool(m.reseeded, `${field}.reseeded`);
    let expectedSources = initialSources(m.id, t.seedingPlan);
    if (reseed && m.reseeded) {
      const entries = reseed.sources.map(source => {
        const previous = t.matches.find(m => m.id === source.value);
        if (previous?.status !== 'complete') invalid(`${field}.reseeded`, 'reseed before all field entrants are known');
        return { source, id: source.type === 'winner' ? previous.winnerId : previous.loserId };
      }).sort((a, b) => (a.id ? t.seeds.indexOf(a.id) : Number.MAX_SAFE_INTEGER) - (b.id ? t.seeds.indexOf(b.id) : Number.MAX_SAFE_INTEGER) || a.source.value.localeCompare(b.source.value));
      expectedSources = reseed.matches.indexOf(m.id) === 0 ? [entries[0].source, entries[3].source] : [entries[1].source, entries[2].source];
    }
    m.sources.forEach((source, index) => { object(source, `${field}.sources[${index}]`); const expected = expectedSources[index]; if (source.type !== expected.type || source.value !== expected.value) invalid(`${field}.sources[${index}]`, 'incorrect bracket dependency'); });
    list(m.players, `${field}.players`, 2); m.players.forEach(id => playerRef(id, `${field}.players`)); unique(m.players.filter(Boolean), `${field}.players`);
    if (!['pending', 'ready', 'live', 'complete'].includes(m.status)) invalid(`${field}.status`);
    const fixed = m.finalMode === 'fixed-two';
    if (m.finalMode !== undefined && (!fixed || m.id !== 'GF' || state.event.competitionVersion !== CompetitionConfig.VERSION)) invalid(`${field}.finalMode`);
    if (m.id === 'GF' && state.event.competitionVersion === CompetitionConfig.VERSION && !fixed) invalid(`${field}.finalMode`, 'official configuration uses two fixed songs');
    const finale = m.finale;
    if (finale !== undefined) {
      const path = `${field}.finale`; object(finale, path);
      if (!fixed || m.id !== 'GF') invalid(path, 'fixed Grand Final only');
      if (Object.keys(finale).some(key => !['stage', 'song', 'videoPath', 'videoDuration', 'videoCue', 'effectLevel', 'effectChangedAt'].includes(key))) invalid(path, 'unknown finale field');
      if (!FinalSequence.STAGES.includes(finale.stage)) invalid(`${path}.stage`);
      if (finale.song !== null) { song(finale.song, `${path}.song`); songRef(finale.song.id, `${path}.song.id`); }
      string(finale.videoPath, `${path}.videoPath`, 180);
      if (finale.videoPath !== '' && !FinalSequence.validVideoPath(finale.videoPath)) invalid(`${path}.videoPath`);
      if (!Number.isFinite(finale.videoDuration) || finale.videoDuration < 0 || finale.videoDuration > 3600) invalid(`${path}.videoDuration`);
      integer(finale.effectLevel, `${path}.effectLevel`, 0, 4);
      integer(finale.effectChangedAt, `${path}.effectChangedAt`, 0, 8640000000000000);
      if (finale.videoCue !== undefined) {
        object(finale.videoCue, `${path}.videoCue`);
        if (finale.stage !== 'video' || !FinalSequence.validVideoCue(finale.videoCue) || Object.keys(finale.videoCue).some(key => !['id', 'startedAt', 'duration'].includes(key))) invalid(`${path}.videoCue`);
        if (finale.videoCue.duration !== finale.videoDuration) invalid(`${path}.videoCue`, 'duration differs from configured video');
      }
      if (finale.stage === 'video' && (!finale.videoCue || !FinalSequence.validVideoPath(finale.videoPath))) invalid(path, 'video source and clock required');
      if (['video', 'revealed'].includes(finale.stage) && !finale.song) invalid(path, 'actual final song required');
      if (!['revealed', 'video'].includes(finale.stage) && finale.effectLevel !== 0) invalid(`${path}.effectLevel`, 'purification starts after the final song is revealed');
    }
    const count = m.id === 'GF' && (!fixed || finale?.song) ? 3 : 2; list(m.scores, `${field}.scores`, 2); m.scores.forEach((s, pi) => scores(s, `${field}.scores[${pi}]`, count));
    if (m.judgements !== undefined) { list(m.judgements, `${field}.judgements`, 2); m.judgements.forEach((row, pi) => judgements(row, `${field}.judgements[${pi}]`, count)); }
    if (m.finalCandidateCount !== undefined && (fixed || m.id !== 'GF' || m.finalCandidateCount !== 6)) invalid(`${field}.finalCandidateCount`);
    if (t.ruleset === 'proposal-2026' && m.id === 'GF' && !fixed && m.finalCandidateCount !== 6) invalid(`${field}.finalCandidateCount`, 'proposal final has six candidates');
    const candidateCount = fixed ? 0 : m.id === 'GF' ? m.finalCandidateCount || 8 : 6;
    list(m.candidates, `${field}.candidates`, undefined, candidateCount); if (![0, candidateCount].includes(m.candidates.length)) invalid(`${field}.candidates`);
    m.candidates.forEach((s, si) => { song(s, `${field}.candidates[${si}]`); songRef(s.id, `${field}.candidates[${si}].id`); }); unique(m.candidates.map(s => s.id), `${field}.candidates`);
    list(m.songs, `${field}.songs`, undefined, count); if (!(fixed ? [count] : [0, count]).includes(m.songs.length)) invalid(`${field}.songs`);
    m.songs.forEach((s, si) => {
      song(s, `${field}.songs[${si}]`);
      if (fixed && si < 2) {
        const expected = CompetitionConfig.library().find(value => value.id === CompetitionConfig.FINAL_SONG_IDS[si]);
        songRef(s.id, `${field}.songs[${si}].id`);
        if (!['id', 'title', 'difficulty', 'level'].every(key => s[key] === expected[key]) || s.eligible) invalid(`${field}.songs`, 'incorrect fixed Grand Final song');
      } else if (fixed) {
        if (!finale?.song || JSON.stringify(s) !== JSON.stringify(finale.song)) invalid(`${field}.songs`, 'final song differs from configured finale');
        songRef(s.id, `${field}.songs[${si}].id`);
      } else if (!m.candidates.some(c => c.id === s.id)) invalid(`${field}.songs`, 'song outside candidates');
    }); unique(m.songs.map(s => s.id), `${field}.songs`);
    if (finale) {
      if (!['video', 'revealed'].includes(finale.stage) && m.scores.some(row => row[2] !== undefined && row[2] !== null)) invalid(`${field}.finale`, 'sealed final song has scores');
    }
    list(m.bans, `${field}.bans`, 2); m.bans.forEach(id => { if (id !== null && !m.candidates.some(s => s.id === id)) invalid(`${field}.bans`, 'ban outside candidates'); }); unique(m.bans.filter(Boolean), `${field}.bans`);
    if (m.bansConfirmed !== undefined) { list(m.bansConfirmed, `${field}.bansConfirmed`, 2); m.bansConfirmed.forEach(value => bool(value, `${field}.bansConfirmed`)); }
    if (m.finalAnnouncement !== undefined) {
      const cue = m.finalAnnouncement, cueField = `${field}.finalAnnouncement`;
      object(cue, cueField);
      if (!FinalAnnouncement.isFixed(m) || state.event.competitionVersion !== CompetitionConfig.VERSION) invalid(cueField, 'fixed Grand Final only');
      if (Object.keys(cue).some(key => !['id', 'startedAt'].includes(key)) || !FinalAnnouncement.validCue(cue)) invalid(cueField, 'invalid final announcement timeline');
    }
    if (m.selectionPreviewCue !== undefined) {
      const cue = m.selectionPreviewCue, cueField = `${field}.selectionPreviewCue`;
      object(cue, cueField);
      if (m.id === 'GF' || m.status === 'complete' || m.tiebreaks?.length) invalid(cueField, 'regular selection only');
      if (Object.keys(cue).some(key => !['id', 'kind', 'songIds', 'startedAt'].includes(key))) invalid(cueField, 'unknown cue field');
      string(cue.id, `${cueField}.id`, 36, true);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cue.id)) invalid(`${cueField}.id`);
      if (!['ban', 'picks'].includes(cue.kind)) invalid(`${cueField}.kind`);
      integer(cue.startedAt, `${cueField}.startedAt`, 0, 8640000000000000);
      list(cue.songIds, `${cueField}.songIds`, cue.kind === 'ban' ? 1 : 2); unique(cue.songIds, `${cueField}.songIds`);
      if (cue.kind === 'ban') {
        if (m.songs.length || !m.bans.includes(cue.songIds[0])) invalid(cueField, 'ban preview does not match an active ban');
      } else if (m.songs.length !== 2 || cue.songIds.some((id, index) => id !== m.songs[index].id)) {
        invalid(cueField, 'picked preview order differs from match songs');
      }
    }
    if (m.tiebreaks !== undefined) {
      list(m.tiebreaks, `${field}.tiebreaks`, undefined, 1000);
      m.tiebreaks.forEach((tie, index) => {
        const path = `${field}.tiebreaks[${index}]`; object(tie, path); song(tie.song, `${path}.song`); songRef(tie.song.id, `${path}.song.id`);
        scores(tie.scores, `${path}.scores`, 2); judgements(tie.judgements, `${path}.judgements`, 2); bool(tie.confirmed, `${path}.confirmed`);
        if (tie.confirmed) {
          date(tie.confirmedAt, `${path}.confirmedAt`);
          if (tie.scores.includes(null) || ScoreRules.compare([tie.scores[0]], [tie.scores[1]], [tie.judgements[0]], [tie.judgements[1]]).reason === 'missing-accuracy') invalid(path, 'incomplete confirmed tiebreak');
        } else if (index !== m.tiebreaks.length - 1) invalid(path, 'unconfirmed earlier tiebreak');
      });
    }
    if (m.usedSongs !== undefined) {
      list(m.usedSongs, `${field}.usedSongs`, undefined, 2000);
      m.usedSongs.forEach((value, index) => song(value, `${field}.usedSongs[${index}]`));
      unique(m.usedSongs.map(value => JSON.stringify([value.id, SongPool.identity(value)])), `${field}.usedSongs`);
      for (const selected of [...m.songs, ...(m.tiebreaks || []).map(tie => tie.song)]) {
        if (!m.usedSongs.some(value => value.id === selected.id && SongPool.identity(value) === SongPool.identity(selected)))
          invalid(`${field}.usedSongs`, 'selected song missing from persistent usage history');
      }
    }
    if (m.rematches !== undefined) {
      list(m.rematches, `${field}.rematches`, undefined, 1000 + count);
      m.rematches.forEach((entry, i) => { incident(entry, `${field}.rematches[${i}]`, count); if (entry.matchId !== m.id) invalid(`${field}.rematches`, 'rematch belongs to another match'); });
      unique(m.rematches.map(entry => JSON.stringify(entry.tiebreakIndex === undefined ? ['base', entry.songId] : ['tie', entry.songId, entry.tiebreakIndex])), `${field}.rematches`);
      unique(m.rematches.map(entry => JSON.stringify(entry.tiebreakIndex === undefined ? ['base', entry.songIndex] : ['tie', entry.songId, entry.tiebreakIndex])), `${field}.rematches`);
    }
    if (m.verifiedAt !== undefined) date(m.verifiedAt, `${field}.verifiedAt`);
    if (m.decisionReason !== undefined && !['score', 'accuracy', 'tiebreak', 'arbiter'].includes(m.decisionReason)) invalid(`${field}.decisionReason`);
    list(m.audiencePicks, `${field}.audiencePicks`, undefined, 2); unique(m.audiencePicks, `${field}.audiencePicks`); m.audiencePicks.forEach(id => { if (!m.candidates.some(s => s.id === id)) invalid(`${field}.audiencePicks`); });
    if (m.hostPick !== null) { song(m.hostPick, `${field}.hostPick`); if (m.id !== 'GF' || !m.candidates.some(s => s.id === m.hostPick.id)) invalid(`${field}.hostPick`); }
    bool(m.hostRevealed, `${field}.hostRevealed`); integer(m.currentSong, `${field}.currentSong`, 0, Math.max(0, m.songs.length - 1));
    if (fixed && (m.bans.some(Boolean) || m.bansConfirmed?.some(Boolean) || m.audiencePicks.length || m.hostPick !== null || m.hostRevealed)) invalid(`${field}.finalMode`, 'fixed final has no selection or reveal stage');
    for (const key of ['winnerId', 'loserId']) { playerRef(m[key], `${field}.${key}`); if (m[key] !== null && !m.players.includes(m[key])) invalid(`${field}.${key}`, 'result player not in match'); }
    if (![null, 'score', 'bye', 'draw', 'forfeit'].includes(m.resultType)) invalid(`${field}.resultType`); string(m.note, `${field}.note`, 240);
    if (m.status === 'complete' && m.resultType === null) invalid(`${field}.resultType`, 'completed result missing');
    if (m.overridePlayers !== null) { list(m.overridePlayers, `${field}.overridePlayers`, 2); m.overridePlayers.forEach(id => playerRef(id, `${field}.overridePlayers`)); unique(m.overridePlayers.filter(Boolean), `${field}.overridePlayers`); }
    if (m.id === 'GF' && !fixed && m.songs.length && (!m.hostPick || m.songs[2].id !== m.hostPick.id)) invalid(`${field}.hostPick`, 'private final selection missing');
    const resolved = m.sources.map(source => source.type === 'seed' ? { ready: true, id: t.seeds[source.value - 1] } : (() => {
      const prior = t.matches.find(match => match.id === source.value);
      return { ready: prior?.status === 'complete', id: source.type === 'winner' ? prior?.winnerId : prior?.loserId };
    })());
    const rawPlayers = m.overridePlayers || resolved.map(source => source.id ?? null);
    const expectedPlayers = reseed && !m.reseeded ? [null, null] : rawPlayers.map((id, index) => {
      const vacancy = m.status !== 'complete' || ['bye', 'draw'].includes(m.resultType) && m.players[index] === null;
      return vacancy && q.players.find(player => player.id === id)?.disqualification ? null : id;
    });
    if (m.players.some((id, index) => id !== expectedPlayers[index])) invalid(`${field}.players`, 'players differ from bracket dependencies');
    const ready = resolved.every(source => source.ready) && (!reseed || m.reseeded === true);
    if (m.status !== 'complete') {
      const expectedStatus = ready ? (m.id === t.currentMatchId ? 'live' : 'ready') : 'pending';
      if (m.status !== expectedStatus || m.resultType !== null || m.winnerId !== null || m.loserId !== null) invalid(`${field}.status`, 'inconsistent match state');
    } else {
      if (!ready) invalid(`${field}.status`, 'result before preceding matches finished');
      const present = m.players.filter(Boolean), totals = m.scores.map(row => row.reduce((sum, value) => sum + (value ?? 0), 0));
      if (m.resultType === 'score') {
        if (present.length !== 2 || m.songs.length !== count || m.scores.flat().some(value => value === null) || (m.id === 'GF' && !fixed && !m.hostRevealed) || finale && (!finale.song || count !== 3 || !['video', 'revealed'].includes(finale.stage))) invalid(`${field}.resultType`, 'incomplete scored result');
        const tied = totals[0] === totals[1];
        if (t.ruleset === 'proposal-2026' || m.tiebreaks?.length) {
          const decision = MatchRules.resultDecision(m);
          if (decision.winnerIndex === null || m.winnerId !== m.players[decision.winnerIndex] || m.tiebreaks?.some(tie => !tie.confirmed)) invalid(`${field}.winnerId`, 'winner differs from score, accuracy or confirmed tiebreak');
          if (t.ruleset === 'proposal-2026') date(m.verifiedAt, `${field}.verifiedAt`);
        } else if (!present.includes(m.winnerId) || (!tied && m.winnerId !== m.players[totals[0] > totals[1] ? 0 : 1]) || (tied && !m.note.trim())) invalid(`${field}.winnerId`, 'winner differs from scores or tie adjudication');
        if (m.loserId !== present.find(id => id !== m.winnerId)) invalid(`${field}.loserId`, 'incorrect loser');
      } else if (m.resultType === 'bye' || m.resultType === 'draw') {
        if (present.length > 1 || m.winnerId !== (present[0] ?? null) || m.loserId !== null || m.scores.flat().some(value => value !== null)) invalid(`${field}.resultType`, 'invalid vacant-field result');
        if (m.resultType === 'draw' && (!m.overridePlayers || present.length !== 1)) invalid(`${field}.resultType`, 'invalid lottery result');
      } else if (m.resultType === 'forfeit') {
        if (m.winnerId !== null && !present.includes(m.winnerId) || !present.some(id => q.players.find(player => player.id === id)?.disqualification) ||
          m.loserId !== (present.find(id => id !== m.winnerId) ?? null)) invalid(`${field}.resultType`, 'invalid disqualification result');
      }
    }
  });
  if (t.songHistory !== undefined) {
    object(t.songHistory, 'tournament.songHistory');
    for (const [id, songs] of Object.entries(t.songHistory)) {
      if (!DEFINITIONS.some(definition => definition[0] === id)) invalid('tournament.songHistory', 'unknown match');
      list(songs, `tournament.songHistory.${id}`, undefined, 2000);
      songs.forEach((value, index) => song(value, `tournament.songHistory.${id}[${index}]`));
      unique(songs.map(value => JSON.stringify([value.id, SongPool.identity(value)])), `tournament.songHistory.${id}`);
    }
  }
  list(t.drawLog, 'tournament.drawLog', undefined, 10000);
  t.drawLog.forEach((entry, i) => { const field = `tournament.drawLog[${i}]`; object(entry, field); if (!matchIds.has(entry.matchId) || !matchIds.has(entry.target)) invalid(field, 'unknown match'); list(entry.eligible, `${field}.eligible`, undefined, 8); entry.eligible.forEach(id => playerRef(id, `${field}.eligible`, false)); playerRef(entry.winnerId, `${field}.winnerId`, false); string(entry.note, `${field}.note`, 240); date(entry.timestamp, `${field}.timestamp`); });
  if (state.result !== null) {
    const r = state.result; object(r, 'result'); if (!matchIds.has(r.matchId)) invalid('result.matchId'); string(r.label, 'result.label', 120); if (!['WB', 'LB', 'GF'].includes(r.bracket)) invalid('result.bracket'); integer(r.round, 'result.round', 1, 6);
    for (const key of ['winnerId', 'loserId']) playerRef(r[key], `result.${key}`); if (!['score', 'bye', 'draw', 'forfeit'].includes(r.type)) invalid('result.type'); string(r.note, 'result.note', 240);
    list(r.players, 'result.players', 2); r.players.forEach(id => playerRef(id, 'result.players')); list(r.totals, 'result.totals', 2); r.totals.forEach(value => integer(value, 'result.totals', 0, 3000000));
    object(r.placements, 'result.placements'); for (const [id, placement] of Object.entries(r.placements)) { playerRef(id, 'result.placements', false); string(placement, 'result.placements', 80); }
    const match = t.matches.find(m => m.id === r.matchId);
    if (match.status !== 'complete' || r.winnerId !== match.winnerId || r.loserId !== match.loserId || r.type !== match.resultType || r.label !== match.label || r.bracket !== match.bracket || r.round !== match.round || r.note !== match.note || r.players.some((id, index) => id !== match.players[index]) || r.totals.some((value, index) => value !== match.scores[index].reduce((sum, score) => sum + (score ?? 0), 0))) invalid('result', 'displayed result differs from completed match');
    const placements = {};
    const awardEligible = id => Boolean(id) && (match.resultType !== 'forfeit' || !q.players.find(player => player.id === id)?.disqualification);
    if (match.id === 'L6' && awardEligible(match.loserId)) placements[match.loserId] = 'Third place';
    if (match.id === 'GF') { if (awardEligible(match.winnerId)) placements[match.winnerId] = 'Champion'; if (awardEligible(match.loserId)) placements[match.loserId] = 'First Runner-up'; }
    if (Object.keys(r.placements).length !== Object.keys(placements).length || Object.entries(placements).some(([id, place]) => r.placements[id] !== place)) invalid('result.placements', 'placements differ from the result');
  }
  if (state.auditLog !== undefined) {
    list(state.auditLog, 'auditLog', undefined, 500); state.auditLog.forEach((entry, i) => { object(entry, `auditLog[${i}]`); integer(entry.revision, `auditLog[${i}].revision`, 0, state.revision); string(entry.type, `auditLog[${i}].type`, 80, true); date(entry.at, `auditLog[${i}].at`); if (entry.reason !== undefined) string(entry.reason, `auditLog[${i}].reason`, 1000); });
  }
  if (state.correctionLog !== undefined) list(state.correctionLog, 'correctionLog', undefined, 10000);
  if (state.recovery !== undefined && state.recovery !== null) { object(state.recovery, 'recovery'); date(state.recovery.recoveredAt, 'recovery.recoveredAt'); string(state.recovery.backupId, 'recovery.backupId', 180, true); if (state.recovery.preservedFile !== undefined) string(state.recovery.preservedFile, 'recovery.preservedFile', 180, true); string(state.recovery.message, 'recovery.message', 500, true); }
  // Validate the exact derived state path used by HTTP and Socket.IO before accepting a save.
  try { publicState(state); } catch { invalid('publicState', 'cannot publish this state'); }
  return state;
}

module.exports = { validateState };
