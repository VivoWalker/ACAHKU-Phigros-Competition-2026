const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { createDefaultState } = require('./default-state');
const { applyAction } = require('./tournament');
const { validateState } = require('./state-validation');
const { sourceStatus } = require('./broadcast-check');

const BACKUP_ID = /^revision-\d{12,16}-\d{13}-[a-f0-9]{8}\.json$/;
const AUDIT_LIMIT = 500;
function error(message, code = 'INVALID') { const failure = new Error(message); failure.code = code; return failure; }
function atomicWrite(file, value) {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function audit(next, type, reason) {
  const entry = { revision: next.revision, type, at: next.updatedAt };
  if (typeof reason === 'string' && reason.trim()) entry.reason = reason.trim().slice(0, 1000);
  next.auditLog = [...(next.auditLog || []), entry].slice(-AUDIT_LIMIT);
}
function requireReason(reason) {
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 1000) throw error('Enter a recovery reason (1–1,000 characters).');
  return reason.trim();
}
function compatibleState(value) {
  // Older final-candidate commands cleared songs without clearing the previous song index.
  const final = Array.isArray(value?.tournament?.matches) && value.tournament.matches.find(m => m?.id === 'GF');
  const changed = Boolean(final && Array.isArray(final.songs) && final.songs.length === 0 && [1, 2].includes(final.currentSong));
  const state = changed ? structuredClone(value) : value;
  if (changed) state.tournament.matches.find(m => m.id === 'GF').currentSong = 0;
  return { state: validateState(state), changed };
}

class StateStore {
  constructor(dir, options = {}) {
    fs.mkdirSync(dir, { recursive: true }); this.file = path.join(dir, 'match-state.json');
    this.backupDir = path.join(dir, 'backups'); fs.mkdirSync(this.backupDir, { recursive: true });
    this.backupLimit = options.backupLimit ?? 500;
    if (!Number.isInteger(this.backupLimit) || this.backupLimit < 1 || this.backupLimit > 1000) throw new Error('Backup limit must be 1–1,000.');
    if (fs.existsSync(this.file)) {
      let candidate, compatibilityAdjusted = false;
      try { candidate = JSON.parse(fs.readFileSync(this.file, 'utf8')); const loaded = compatibleState(candidate); this.state = loaded.state; compatibilityAdjusted = loaded.changed; }
      catch (failure) {
        const backup = this.listBackups()[0];
        if (!backup) throw new Error(`Cannot load the saved tournament: ${failure.message} No valid automatic backup was found. Preserve ${this.file} and restore a valid complete backup.`);
        const recovered = this.readBackup(backup.id);
        // Keep the exact damaged bytes before replacing anything so staff can inspect them.
        const preservedFile = `match-state-damaged-${Date.now()}-${randomBytes(4).toString('hex')}.json`;
        fs.copyFileSync(this.file, path.join(dir, preservedFile), fs.constants.COPYFILE_EXCL);
        const at = new Date().toISOString();
        const lastKnownRevision = Number.isSafeInteger(candidate?.revision) && candidate.revision >= 0 && candidate.revision < Number.MAX_SAFE_INTEGER - 2 ? candidate.revision : 0;
        recovered.revision = Math.max(lastKnownRevision, recovered.revision + 1, ...this.listBackups().map(b => b.revision + 1)) + 1;
        recovered.updatedAt = at;
        if (recovered.broadcast?.sourceCheck) recovered.broadcast.sourceCheck = null;
        recovered.recovery = { recoveredAt: at, backupId: backup.id, preservedFile,
          message: 'Saved tournament was damaged. Restored the latest valid automatic backup. Check the recovered match and scores before continuing.' };
        audit(recovered, 'startup-recovery', 'Invalid saved tournament; recovered the latest valid automatic backup.');
        this.write(recovered); this.state = recovered;
      }
      if (compatibilityAdjusted) {
        this.saveBackup(candidate, { legacy: true });
        const migrated = structuredClone(this.state); migrated.revision++; migrated.updatedAt = new Date().toISOString();
        audit(migrated, 'legacy-final-cursor-normalized', 'Reset an empty Grand Finals song list to song index zero; original state retained in automatic backups.');
        this.write(migrated); this.state = migrated;
        try { this.pruneBackups(); } catch { /* Retry backup pruning on the next save. */ }
      }
    } else { this.state = createDefaultState(); this.write(this.state); }
  }
  write(state) { validateState(state); atomicWrite(this.file, state); }
  readBackup(id) {
    if (typeof id !== 'string' || !BACKUP_ID.test(id)) throw error('Unknown automatic backup.');
    const file = path.join(this.backupDir, id);
    if (!fs.existsSync(file)) throw error('Automatic backup no longer exists. Refresh the list.');
    try { return compatibleState(JSON.parse(fs.readFileSync(file, 'utf8'))).state; }
    catch (failure) { throw error(`This backup is damaged: ${failure.message}`); }
  }
  backupSummary(id, state) {
    const qualifierScoredSlots = state.qualifier.players.reduce((count, p) => count + p.scores.filter(s => s !== null).length, 0);
    const matchScoredSlots = state.tournament.matches.reduce((count, m) => count + m.scores.flat().filter(s => s !== null).length, 0);
    return { id, revision: state.revision, updatedAt: state.updatedAt, createdAt: fs.statSync(path.join(this.backupDir, id)).mtime.toISOString(),
      eventTitle: state.event.title, scene: state.scene, completedMatches: state.tournament.matches.filter(m => m.status === 'complete').length,
      scoredSlots: qualifierScoredSlots + matchScoredSlots };
  }
  listBackups() {
    return fs.readdirSync(this.backupDir).filter(id => BACKUP_ID.test(id)).flatMap(id => {
      try { return [this.backupSummary(id, this.readBackup(id))]; } catch { return []; }
    }).sort((a, b) => b.revision - a.revision || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }
  previewBackup(id) {
    const state = this.readBackup(id), summary = this.backupSummary(id, state);
    return { ...summary, stage: state.stage, event: { title: state.event.title, date: state.event.date, venue: state.event.venue },
      qualifierScoredSlots: state.qualifier.players.reduce((count, p) => count + p.scores.filter(s => s !== null).length, 0),
      matchScoredSlots: state.tournament.matches.reduce((count, m) => count + m.scores.flat().filter(s => s !== null).length, 0),
      matchResults: state.tournament.matches.filter(m => m.status === 'complete').map(m => ({ matchId: m.id, winnerId: m.winnerId, loserId: m.loserId, resultType: m.resultType })) };
  }
  saveBackup(state, options = {}) {
    if (options.legacy) compatibleState(state); else validateState(state);
    const id = `revision-${String(state.revision).padStart(12, '0')}-${Date.now()}-${randomBytes(4).toString('hex')}.json`;
    atomicWrite(path.join(this.backupDir, id), state); return id;
  }
  pruneBackups() {
    // Pruning follows a successful save and must not report an already-saved command as failed.
    const files = fs.readdirSync(this.backupDir).filter(id => BACKUP_ID.test(id)).sort((a, b) => b.localeCompare(a));
    for (const id of files.slice(this.backupLimit)) fs.unlinkSync(path.join(this.backupDir, id));
  }
  assertRevision(expectedRevision) {
    if (expectedRevision !== this.state.revision) throw error('Another operator updated the state. Latest data loaded; review the change before trying again.', 'STALE');
  }
  persist(next) {
    validateState(next);
    this.saveBackup(this.state); // A failed snapshot stops the command before the official save.
    this.write(next); this.state = next;
    try { this.pruneBackups(); } catch { /* Retry backup pruning on the next save. */ }
    return next;
  }
  commit(action, expectedRevision) {
    this.assertRevision(expectedRevision);
    const next = applyAction(structuredClone(this.state), action);
    if (next.broadcast?.sourceCheck && sourceStatus(this.state).signature !== sourceStatus(next).signature) next.broadcast.sourceCheck = null;
    next.revision++; next.updatedAt = new Date().toISOString();
    audit(next, action.type, action.payload?.reason);
    return this.persist(next);
  }
  restore(backupId, expectedRevision, reason) {
    this.assertRevision(expectedRevision); reason = requireReason(reason);
    const next = this.readBackup(backupId);
    next.revision = this.state.revision + 1; next.updatedAt = new Date().toISOString();
    // Retain the current audit trail, including the reason for returning to an older tournament.
    next.auditLog = this.state.auditLog || [];
    next.recovery = null;
    if (next.broadcast?.sourceCheck) next.broadcast.sourceCheck = null;
    audit(next, 'restore-backup', reason);
    return this.persist(next);
  }
}
module.exports = { StateStore, validateState };
