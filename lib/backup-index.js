const fs = require('node:fs');
const path = require('node:path');
const { validateState } = require('./state-validation');
const QualifierRules = require('../public/js/qualifier-rules');

const BACKUP_ID = /^revision-\d{12,16}-\d{13}-[a-f0-9]{8}\.json$/;

function compatibleState(value) {
  // Earlier final-candidate commands retained the song cursor after clearing songs.
  const final = Array.isArray(value?.tournament?.matches) && value.tournament.matches.find(match => match?.id === 'GF');
  const changed = Boolean(final && Array.isArray(final.songs) && final.songs.length === 0 && [1, 2].includes(final.currentSong));
  const state = changed ? structuredClone(value) : value;
  if (changed) state.tournament.matches.find(match => match.id === 'GF').currentSong = 0;
  return { state: validateState(state), changed };
}

function scored(values) { return values.filter(value => value !== null).length; }
function scoreCounts(state) {
  const rounds = state.qualifier.plan ? Object.values(state.qualifier.rounds) : [];
  const qualifierRows = state.qualifier.plan ? rounds.flatMap(round => Object.values(round.results)) : state.qualifier.players;
  const qualifierTies = rounds.flatMap(round => round.tiebreaks || []);
  const matchTies = state.tournament.matches.flatMap(match => match.tiebreaks || []);
  const qualifierBaseScoredSlots = qualifierRows.reduce((count, row) => count +
    (QualifierRules.isChallenge(state) ? Number(QualifierRules.complete(state, row)) : scored(row.scores)), 0);
  const qualifierTiebreakScoredSlots = qualifierTies.reduce((count, tie) => count + scored(Object.values(tie.scores)), 0);
  const qualifierConfirmedTiebreaks = qualifierTies.filter(tie => tie.confirmed).length;
  const matchBaseScoredSlots = state.tournament.matches.reduce((count, match) => count + scored(match.scores.flat()), 0);
  const matchTiebreakScoredSlots = matchTies.reduce((count, tie) => count + scored(tie.scores), 0);
  const matchConfirmedTiebreaks = matchTies.filter(tie => tie.confirmed).length;
  const qualifierScoredSlots = qualifierBaseScoredSlots + qualifierTiebreakScoredSlots;
  const matchScoredSlots = matchBaseScoredSlots + matchTiebreakScoredSlots;
  return { qualifierBaseScoredSlots, qualifierTiebreakScoredSlots, qualifierConfirmedTiebreaks,
    matchBaseScoredSlots, matchTiebreakScoredSlots, matchConfirmedTiebreaks,
    qualifierScoredSlots, matchScoredSlots, scoredSlots: qualifierScoredSlots + matchScoredSlots,
    confirmedTiebreaks: qualifierConfirmedTiebreaks + matchConfirmedTiebreaks };
}

function backupSummary(id, state, stat) {
  return { id, revision: state.revision, updatedAt: state.updatedAt, createdAt: stat.mtime.toISOString(),
    eventTitle: state.event.title, scene: state.scene, qualifierScoringMode: state.qualifier.scoringMode || 'legacy-score',
    completedMatches: state.tournament.matches.filter(match => match.status === 'complete').length,
    ...scoreCounts(state) };
}

function fingerprint(stat) {
  // ctime also detects replacement or same-sized edits that preserve the mtime.
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

function summariesFromCache(cache) {
  return [...cache.values()].flatMap(entry => entry.summary ? [entry.summary] : [])
    .sort((a, b) => b.revision - a.revision || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

function scanBackups(dir, previous = new Map()) {
  const cache = new Map();
  let validatedFiles = 0;
  for (const id of fs.readdirSync(dir).filter(name => BACKUP_ID.test(name))) {
    const file = path.join(dir, id);
    try {
      const stat = fs.statSync(file), signature = fingerprint(stat);
      if (!stat.isFile()) continue;
      const saved = previous.get(id);
      if (saved?.fingerprint === signature) { cache.set(id, saved); continue; }
      let summary = null;
      try {
        validatedFiles++;
        const state = compatibleState(JSON.parse(fs.readFileSync(file, 'utf8'))).state;
        summary = backupSummary(id, state, stat);
      } catch { /* Damaged snapshots are omitted, including on subsequent cached scans. */ }
      // An external writer changed the file while it was read. Never cache mixed bytes.
      if (fingerprint(fs.statSync(file)) === signature) cache.set(id, { fingerprint: signature, summary });
    } catch { /* Deleted or inaccessible snapshots are omitted. */ }
  }
  return { cache: [...cache], backups: summariesFromCache(cache), validatedFiles };
}

module.exports = { BACKUP_ID, compatibleState, scoreCounts, backupSummary, fingerprint, summariesFromCache, scanBackups };
