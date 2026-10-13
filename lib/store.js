const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { createDefaultState } = require('./default-state');
const { applyAction } = require('./tournament');
const { validateState } = require('./state-validation');
const { sourceStatus } = require('./broadcast-check');
const { BACKUP_ID, compatibleState, backupSummary, fingerprint, summariesFromCache, scanBackups } = require('./backup-index');

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

class StateStore {
  constructor(dir, options = {}) {
    fs.mkdirSync(dir, { recursive: true }); this.file = path.join(dir, 'match-state.json');
    this.backupDir = path.join(dir, 'backups'); fs.mkdirSync(this.backupDir, { recursive: true });
    this._backupCache = new Map(); this._backupScanPromise = null;
    this._backupChanges = null; this._backupCacheReplaced = false;
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
    return backupSummary(id, state, fs.statSync(path.join(this.backupDir, id)));
  }
  listBackups() {
    // Startup recovery remains synchronous; live HTTP requests use the worker below.
    const result = scanBackups(this.backupDir, this._backupCache);
    this._backupCache = new Map(result.cache);
    if (this._backupChanges) this._backupCacheReplaced = true;
    return structuredClone(result.backups);
  }
  scanBackupsOffThread() {
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'backup-index-worker.js'), {
        workerData: { dir: this.backupDir, cache: [...this._backupCache] }
      });
      let received = false;
      worker.once('message', result => { received = true; resolve(result); });
      worker.once('error', reject);
      worker.once('exit', code => { if (!received) reject(new Error(`Backup scan stopped before completion (exit ${code}).`)); });
    });
  }
  listBackupsAsync() {
    if (!this._backupScanPromise) {
      this._backupChanges = new Set(); this._backupCacheReplaced = false;
      this._backupScanPromise = (async () => {
        const result = await this.scanBackupsOffThread();
        if (!this._backupCacheReplaced) {
          const cache = new Map(result.cache);
          // Merge only snapshots saved/pruned by commands during this scan. Retain the
          // worker's findings for all other files, including damaged or deleted entries.
          // Continuous score saves must never restart the whole directory scan.
          for (const id of this._backupChanges) {
            if (this._backupCache.has(id)) cache.set(id, this._backupCache.get(id));
            else cache.delete(id);
          }
          this._backupCache = cache;
        }
        // A synchronous full scan, if requested meanwhile, already has the newer view.
        return summariesFromCache(this._backupCache);
      })().finally(() => { this._backupScanPromise = null; this._backupChanges = null; this._backupCacheReplaced = false; });
    }
    // Concurrent refreshes share one scan; callers cannot mutate the retained index.
    return this._backupScanPromise.then(backups => structuredClone(backups));
  }
  previewBackup(id) {
    const state = this.readBackup(id), summary = this.backupSummary(id, state);
    return { ...summary, stage: state.stage, event: { title: state.event.title, date: state.event.date, venue: state.event.venue },
      matchResults: state.tournament.matches.filter(m => m.status === 'complete').map(m => ({ matchId: m.id, winnerId: m.winnerId, loserId: m.loserId, resultType: m.resultType })) };
  }
  saveBackup(state, options = {}) {
    if (options.legacy) compatibleState(state); else validateState(state);
    const id = `revision-${String(state.revision).padStart(12, '0')}-${Date.now()}-${randomBytes(4).toString('hex')}.json`;
    const file = path.join(this.backupDir, id);
    atomicWrite(file, state);
    const stat = fs.statSync(file);
    this._backupCache.set(id, { fingerprint: fingerprint(stat), summary: backupSummary(id, options.legacy ? compatibleState(state).state : state, stat) });
    this._backupChanges?.add(id);
    return id;
  }
  pruneBackups() {
    // Pruning follows a successful save and must not report an already-saved command as failed.
    const files = fs.readdirSync(this.backupDir).filter(id => BACKUP_ID.test(id)).sort((a, b) => b.localeCompare(a));
    for (const id of files.slice(this.backupLimit)) {
      fs.unlinkSync(path.join(this.backupDir, id));
      this._backupCache.delete(id); this._backupChanges?.add(id);
    }
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
