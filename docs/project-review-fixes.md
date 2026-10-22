# Repairs following the project review

The review of `bfb49e0` identified four P2 issues and three P3 issues. These changes repair the normal command paths and retain existing event files and valid paired sessions.

| Issue | Result after repair | Regression coverage |
| --- | --- | --- |
| An empty main PIN file allowed login without a password | Startup rejects empty main PIN files and blank configured codes; credentials are written atomically and a damaged session key also stops startup | `test/audit-startup-roster.test.js`: failed writes, damaged files, valid tokens after restart |
| Scorers could erase qualifier tiebreaks by editing base scores | Scorers cannot edit base scores after any tiebreak begins; main-control correction requires a reason and reviewed confirmation, archiving the old field and all invalidated tiebreaks | `test/scorekeeper-tiebreak-lock.test.js`, `test/qualifier-rules.test.js`, browser correction and scorer checks |
| A roster crossing 20 players kept the old plan | Saving the unstarted roster recalculates Plan A/B from the current entrant count | `test/qualifier-rules.test.js`: 20→21 and 21→20, persistence and restart |
| A large backup listing blocked the server | Live HTTP listings scan and validate in a worker; cached summaries follow file changes and snapshot retention; restores revalidate the selected state | `test/backup-index.test.js`: 500 real snapshots, HTTP responsiveness, corruption, concurrent saves and shared refreshes |
| The next ordinary batch retained song three | The next ordinary batch resets to song one; pending tiebreak batches preserve their separate context | `test/qualifier-rules.test.js` |
| Legacy roster replacement retained removed readiness references | Removing an unscored entrant clears only their readiness checklist; an active wait explicitly blocks removal until cancelled, with evidence retained | `test/audit-startup-roster.test.js` |
| Backup summaries omitted extra-song scores | Lists, previews and final restore confirmation show base and tiebreak score counts and confirmed tiebreak counts for qualifiers and matches | `test/backup-index.test.js` and browser backup-summary checks |

No new dependency or state schema version is required. Existing scored events are not automatically regrouped during an upgrade. Preserve `data/`, restart the server and refresh staff pages and OBS Browser Sources to load the new scripts.

Optional Chromium checks use temporary event data and dummy pairing codes:

```sh
python3 test/scorekeeper-tiebreak-lock.py
python3 test/control-tiebreak-correction.py
```

The normal `npm test` suite includes the server and domain regressions. Tests do not use the real event's PINs, session key or saved tournament.

## Follow-up reliability repairs

The follow-up review adds these fixes without replacing the schema-1 event format or existing pairing sessions:

| Issue | Repair | Regression coverage |
| --- | --- | --- |
| A main-control command queued before disconnection could run after reconnection | Commands belong to their original connection and are discarded when that connection changes; a fresh synchronized state is required for a new command | `test/control-reconnect-browser.py` |
| Different replacement tiebreak songs shared an array index and incorrectly shared a replay allowance | Replay limits follow the song identity within the existing player/round or match scope; saved metadata and aliases retain same-song limits | `test/tiebreak-rematch-identity.test.js` |
| Two running servers could overwrite the same event file | The server acquires exclusive ownership of the canonical data directory before loading state or credentials, and releases it on shutdown or failed startup | `test/data-directory-lock.test.js` |
| Image verification overwrote output before reporting stale assets | `--check` compares all generated image bytes and the manifest without writing; regular builds stage outputs before publication and roll back publication failures | `test/display-assets-build.py` |
| Refreshing a staff page lost unsaved drafts | Both roles retain bounded, expiring drafts in tab storage, isolated by event identity; recovery requires normal conflict review and never submits automatically | `test/draft-storage.test.js`, `test/draft-recovery-browser.py`, `test/event-identity.test.js` |
| Browser checks lacked a reproducible shared entrypoint | Pinned Python dependencies, shared Python/browser runners and GitHub Actions exercise the core suite and the critical Chromium flows | `npm run test:python`, `npm run test:browser:smoke` |

New events have a random persistent identity. Older events adopt one without changing their scores, revision or audit history. Explicit backup restoration keeps the current event's identity; automatic recovery also retains a valid identity from the damaged current file. An unidentifiable legacy recovery receives an identity before staff pages reconnect.

The data-directory lock protects broadcast servers on the same computer's local filesystem. Standalone `StateStore` use remains available to offline tools; stop the server before using a separate tool to write its event data. Concurrent starts may both decline rather than risk two writers; retry after the other launch has stopped. A live or unverifiable process claim is never removed based on its age.

## Node.js security update — October 22, 2026

The runtime review found Node.js 24.19.0 while the [October 21 security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases) fixes the high-severity Brotli decoder issue CVE-2026-111497 and other runtime vulnerabilities in Node 24.22.1. A normal Brotli-compressed JSON request reached the native decoder before pairing was checked. This verified the exposed decoding path without using an exploit payload or attempting code execution.

The application now requires stable Node 24 releases from 24.22.1 onward, below version 25. The package metadata, lockfile, `.node-version`, install/start/test checks and server entrypoint share this requirement. CI tests the fixed baseline and the latest 24.x release, and runs a separate npm dependency audit. Runtime versions must still be reviewed against new Node.js advisories; an empty npm audit result does not establish runtime safety.

Request JSON parsing also disables inflation. Valid Brotli, gzip and deflate fixtures are rejected before any native request decoder is created, while ordinary JSON pairing, role checks, backup restoration and the 100 KiB limit retain their existing behavior. This reduces the application's decoding surface in addition to upgrading the runtime; it does not replace runtime security updates.

`test/node-version.test.js` covers the version boundary, unsupported releases, configuration consistency and CLI errors. `test/request-encoding.test.js` verifies the decoding boundary and unchanged ordinary JSON behavior using temporary event data. This update does not change dependency versions, pairing credentials, saved scores or the event schema. The project and inspected cloud environment contain no PHP runtime or application to update.
