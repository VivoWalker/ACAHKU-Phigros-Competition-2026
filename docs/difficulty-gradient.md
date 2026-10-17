# Double Elimination difficulty gradient

Official 2026 events use a biased six-candidate draw that becomes harder by bracket round. Every match in the same round uses the same policy, including the WB and LB matches in R2/R3. Grand Final keeps its two fixed songs and bypasses this algorithm. Unmarked historical events retain their previous uniform draw.

The organiser's original decimal chart constants remain separate from the integer `level` shown on air. The 42-chart official pool contains 16 low charts (16.1–16.5), 13 middle charts (16.6–16.8), and 13 high charts (16.9–17.5).

| Round | Preferred low / middle / high candidates | Required limits | Target candidate mean |
| --- | --- | --- | --- |
| R1 | 4 / 1 / 1 | At least 3 low; at most 1 high | 16.45 |
| R2 | 2 / 3 / 1 | At least 1 low; at most 2 high | 16.65 |
| R3 | 1 / 3 / 2 | At most 1 low | 16.85 |
| R4 | 0 / 3 / 3 | No low; at least 3 high | 17.05 |
| R5 | 0 / 0 / 6 | All six constants at least 16.9 | 17.20 |

The preferred quota and mean guide the draw. They may change with available stock; the required limits always apply. These are candidate-draw preferences, not a promise that every individual match's candidate mean strictly exceeds all earlier matches. The two songs selected after bans remain random.

## Selection and stock protection

1. Resolve the actual eligible pool with the existing identity-based song reservations. Banned/unselected candidates remain reusable. Formally selected songs, tiebreaks, reset selections and restored history stay owned by their match.
2. Build a schedule of remaining non-GF matches without formal selections. Use each match's real bracket round, rather than the number of previous draws. Matches with selections or completed byes do not consume an invented additional pair. Pending matches remain included even when their entrants are not known yet.
3. Enumerate six-song low/middle/high quotas that meet the current round's required limits. For each quota, examine every possible two-song consumption. Accept a quota only if every outcome leaves a feasible sequence of draws for all remaining matches. This protects R5 against early high-chart consumption regardless of bans or the random pair.
4. Choose a safe quota closest to the preferred one. Within each tier, weight songs toward the round's target mean using a Gaussian weight with sigma 0.35. Generate 96 proposals and randomly choose among proposals within 0.025 of the closest mean, then shuffle the six display positions. Production randomness uses Node's cryptographic random source.
5. Keep the existing two ban/pass decisions and random two-song selection. Before assigning that pair, recheck candidate chart metadata, required limits and future stock. Stale candidate sets require a redraw; artwork/audio-only edits do not invalidate their chart identity.

The feasibility planner uses a per-request memo table, limited to 75,000 inventory states, at most 13 regular matches and 500 library entries. It keeps no growing global cache. A reviewed redraw prefers its match's own reserved songs within a tier; these do not consume shared stock again. Future matches' owned songs are accounted for separately as well.

Additional tiebreaks draw randomly from songs whose reservation preserves a feasible remaining schedule. Filtering happens before the random choice, so an unsafe song cannot cause an intermittent failure when safe songs remain. R5 tiebreaks also require a constant of at least 16.9. If no safe song remains, or changed eligibility, a replacement draw or restored history makes the schedule infeasible, the command fails without saving that action. Staff must review the pool and add suitable announced songs as needed. The system does not lower R5's threshold or reuse another match's songs to make a draw succeed.

## Chart constants and existing events

The main-control song library has an optional **Original chart constant** input (`constant`). Use a number with at most one decimal that truncates to the chart's displayed level. An eligible custom chart needs its constant before an official gradient draw; integer levels alone do not provide enough information.

Older official libraries without this field resolve their decimal constant from the bundled configuration only when ID, title, artist, chart difficulty and integer level all match the official chart. This does not rewrite an existing library, score, selection or result. An unknown or changed chart requires its own constant. Older controls that omit the field preserve an existing stored value; clearing it removes that explicit value.

Already selected match songs keep their original metadata. Existing candidate sets are checked when the operator requests the formal pair; a set drawn before this update may need to be redrawn. Restart the server and refresh the main-control page after installing the update. Staff-only gradient details are not added to OBS layouts, and broadcast levels remain integers.

## Validation

`test/difficulty-draw.test.js` covers full-schedule stock planning, round limits, adversarial high/low consumption, out-of-order ready matches, owned history, aliases, metadata changes and impossible pools. `test/difficulty-draw-integration.test.js` exercises the real tournament actions and temporary persistence, including old official libraries, legacy draws, failed stale selections, tiebreak reservations and the fixed GF. `test/chart-constants.test.js` checks the original 42 constants and their editing/restore validation. `test/difficulty-draw-browser.py` checks the staff workflow and integer overlay levels using temporary events and dummy pairing codes.
