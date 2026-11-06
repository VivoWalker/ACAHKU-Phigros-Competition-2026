'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { validateState } = require('../lib/state-validation');
const Waiting = require('../public/js/waiting-preview');

const DIRECTORY = path.join(__dirname, '../test/manual-saves');

function listManualSaves(directory = DIRECTORY) {
  const catalog = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (catalog.format !== 'acahku-manual-saves' || catalog.version !== 1 ||
      !Array.isArray(catalog.scenarios) || catalog.scenarioCount !== catalog.scenarios.length)
    throw new Error('Invalid manual-save catalog.');
  const ids = new Set();
  for (const entry of catalog.scenarios) {
    if (!/^[QBDFO]\d{2}$/.test(entry.id) || ids.has(entry.id) ||
        typeof entry.file !== 'string' || !entry.file.startsWith(entry.id + '-') ||
        !/^[A-Z]\d{2}-[a-z0-9-]+\.json$/.test(entry.file) ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) || typeof entry.title !== 'string' ||
        !Array.isArray(entry.steps) || !entry.steps.length || !Array.isArray(entry.expected) || !entry.expected.length)
      throw new Error('Invalid manual-save entry.');
    ids.add(entry.id);
  }
  return catalog.scenarios;
}

function loadManualSave(id, { directory = DIRECTORY, now = Date.now() } = {}) {
  const entries = listManualSaves(directory), key = String(id).trim().toUpperCase();
  const entry = /^\d+$/.test(key) ? entries[Number(key) - 1] : entries.find(item => item.id === key);
  if (!entry) throw new Error('Unknown test case: ' + key + '. Use --list to see the available saves.');
  const bytes = fs.readFileSync(path.join(directory, entry.file));
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
    throw new Error('Manual-save checksum differs: ' + entry.file);
  const state = validateState(JSON.parse(bytes.toString('utf8')));
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid test clock.');
  // Each run is a separate event, so browser drafts from an earlier rehearsal
  // cannot be offered as edits to this one.
  state.eventId = randomUUID(); state.updatedAt = new Date(now).toISOString();
  if (state.broadcast?.sourceCheck) state.broadcast.sourceCheck = null;
  const target = Waiting.context(state, now);
  for (const match of state.tournament.matches) {
    if (match.waitingPreviewCue && target?.matchId === match.id) {
      match.waitingPreviewCue = { ...match.waitingPreviewCue, id: randomUUID(), startedAt: now, contextKey: target.key };
    }
    if (state.scene === 'song-selection' && state.tournament.currentMatchId === match.id && match.selectionPreviewCue?.kind === 'ban') {
      match.selectionPreviewCue = { ...match.selectionPreviewCue, id: randomUUID(), startedAt: now };
    }
  }
  if (entry.waitRemainingMs !== undefined) {
    for (const wait of Object.values(state.qualifier.waits || {})) {
      const duration = Date.parse(wait.deadline) - Date.parse(wait.startsAt);
      wait.deadline = new Date(now + entry.waitRemainingMs).toISOString();
      wait.startsAt = new Date(now + entry.waitRemainingMs - duration).toISOString();
    }
  }
  validateState(state);
  return { entry, state };
}

module.exports = { DIRECTORY, listManualSaves, loadManualSave };
