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
