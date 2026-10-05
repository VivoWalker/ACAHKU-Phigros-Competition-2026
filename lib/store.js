const fs = require('node:fs');
const path = require('node:path');
const { createDefaultState } = require('./default-state');
const { applyAction } = require('./tournament');
class StateStore {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true }); this.file = path.join(dir, 'match-state.json');
    if (fs.existsSync(this.file)) {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (this.state.schemaVersion !== 1 || !Array.isArray(this.state.tournament?.matches)) throw new Error('Unsupported or damaged state file. Preserve it and restore a valid backup.');
    } else { this.state = createDefaultState(); this.write(this.state); }
  }
  write(state) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  commit(action, expectedRevision) {
    if (expectedRevision !== this.state.revision) { const error = new Error('Another operator updated the state. Latest data loaded; please try again.'); error.code = 'STALE'; throw error; }
    const next = applyAction(structuredClone(this.state), action);
    next.revision++; next.updatedAt = new Date().toISOString();
    this.write(next); this.state = next; return next;
  }
}
module.exports = { StateStore };
