(function () {
  const B = Broadcast, e = B.escape, $ = id => document.getElementById(id);
  const displayMedia = BroadcastDisplayMedia.createClient();
  const mediaWarmup = BroadcastMediaWarmup.createController({ maxDecoded: 8, concurrency: 2, timeoutMs: 2200, fontTimeoutMs: 1800 });
  const displayArt = path => displayMedia.resolve(path);
  let state, socket, activeTab = 'broadcast', connections = { overlays: 0, controls: 0 }, focusSongId, editingSongId = null;
  let queue = Promise.resolve(), toastTimer, token = sessionStorage.getItem('broadcast-token');
  let countdownClient, countdownPending = false;
  let lastRenderedTab, tabAnimation;
  let backupList = [], backupsLoaded = false, selectedBackupId = '', backupPreview = null, backupEpoch = 0;
  let correctionMatchId = '', correctionPreview = null, correctionEpoch = 0;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) { tabAnimation?.cancel(); tabAnimation = null; }
  });
  const button = (label, attrs = '', primary = false) => {
    const extra = attrs.match(/class="([^"]*)"/)?.[1] || '';
    return `<button class="phi-surface phi-button ${primary ? 'is-primary' : ''} ${extra}" ${attrs.replace(/class="[^"]*"/g, '')}>${label.replace(/[↗→]/g, B.icon('next'))}</button>`;
  };
  const options = (items, selected, blank = true) => `${blank ? '<option value="">Choose…</option>' : ''}${items.map(([value, label]) => `<option value="${e(value)}" ${value === selected ? 'selected' : ''}>${e(label)}</option>`).join('')}`;
  const qualifierEntries = (s = state, group = s.qualifier.activeGroup) => globalThis.QualifierRules ? QualifierRules.entries(s, group) : s.qualifier.players.filter(p => p.group === group);
  const playerOptions = (selected, group, blank = true) => options((group ? qualifierEntries(state, group) : state.qualifier.players).filter(p => !p.disqualification).map(p => [p.id, `${p.number ? '#' + p.number + ' · ' : ''}${p.name}`]), selected, blank);
  const finalCount = m => m?.finalCandidateCount || 8;
  const fixedFinal = m => m?.id === 'GF' && m.finalMode === 'fixed-two';
  const matchSongCount = m => B.matchSongCount(m);
  const officialConfig = s => !!globalThis.CompetitionConfig && s.event.competitionVersion === CompetitionConfig.VERSION;
  const songPreviewPath = song => !song ? '' : Object.hasOwn(song, 'previewAudio') ? song.previewAudio : globalThis.CompetitionConfig?.LIBRARY.find(item => item.id === song.id)?.previewAudio || '';
  const announcementAvailable = s => officialConfig(s) || s.tournament.matches.some(fixedFinal);
  const controlScenes = () => B.scenes.filter(scene => scene[0] !== 'grand-final-announcement' || announcementAvailable(state));
  const challenge = (s = state) => QualifierRules.isChallenge(s);
  const proposal = () => state.qualifier.plan === 'A' || state.qualifier.plan === 'B';
  const qualifierLabel = group => state.qualifier.plan === 'A' ? `Round ${group === 'A' ? 1 : 2}` : state.qualifier.plan === 'B' ? `${group === 'A' ? 'Odd' : 'Even'} numbers` : `Group ${group}`;
  const songOptions = (selected, pool = state.library) => options(pool.map(s => [s.id, `${s.title} / ${s.difficulty} ${s.level}`]), selected);
  const matchSongPool = (s, matchId, eligibleOnly = true) => SongPool.available(s, matchId, { eligibleOnly });
  function songPoolNotice(m = null) {
    const pool = SongPool.status(state), drawPool = m ? matchSongPool(state, m.id, m.id !== 'GF') : null;
    const finalMatch = state.tournament.matches.find(match => match.id === 'GF');
    const fixed = fixedFinal(finalMatch) || officialConfig(state), gfCandidates = finalMatch ? finalCount(finalMatch) : 6;
    const shortage = pool.availableRegular < pool.minimumRegularNeeded;
    const drawShortage = m && !fixedFinal(m) && drawPool.length < (m.id === 'GF' ? finalCount(m) : 6);
    return `<section class="song-pool-status notice ${shortage || drawShortage ? 'warning' : ''}" aria-label="Double elimination song pool"><h3>DE song pool · 正式比賽曲目跨場不重複</h3><div class="song-pool-metrics"><div><span>常規曲庫 · 去重</span><strong>${pool.eligibleTotal}</strong></div><div><span>已正式選用</span><strong>${pool.reservedRegular}</strong></div><div><span>全場尚未選用</span><strong>${pool.availableRegular}</strong></div></div><p>13 場 × 2 首 = 26 首正式曲；最後一場仍需 6 首候選，因此常規曲庫至少 <b>30 首</b>，建議 <b>42 首</b>（另留 12 首加賽餘量）。${fixed ? 'GF 固定兩首專用曲目，直接宣布並進行比賽。' : `GF 另準備 ${gfCandidates} 首候選。`}候選、禁選和未被抽中曲目可在其他場次再次出現。</p>${pool.regularMatchesRemaining ? `<p>尚有 ${pool.regularMatchesRemaining} 場待選曲，至少需要 ${pool.minimumRegularNeeded} 首尚未選用曲目${shortage ? `；目前不足 ${pool.minimumRegularNeeded - pool.availableRegular} 首，請先補充曲庫。` : '。'}</p>` : ''}${m && !fixedFinal(m) ? `<p>本場可用 ${drawPool.length} 首${m.id === 'GF' ? '（包含 GF 專用曲目）' : ''}${drawShortage ? `；不足 ${m.id === 'GF' ? finalCount(m) : 6} 首候選，請新增未被其他場次正式選用的曲目。` : '。'}</p>` : ''}<p class="secondary">同一曲名與作者視為同一首，切換難度不會解除占用。重抽、重置、恢復備份或糾錯保留正式選曲歷史；如需新的加賽曲目，請補充尚未選用的曲庫。</p>${pool.conflicts?.length ? '<p>舊資料存在跨場正式曲目重複；歷史結果保留，新抽曲會排除其他場次已選用曲目。</p>' : ''}</section>`;
  }
  const heading = (tag, title, description, action = '') => `<div class="page-heading"><div><div class="eyebrow">${tag}</div><h1>${title}</h1><p>${description}</p></div>${action ? `<div class="heading-action">${action}</div>` : ''}</div>`;
  const matchActions = new Set(['draw-candidates', 'ban-song', 'pick-songs', 'set-final-candidates', 'set-final-picks', 'reveal-host-song', 'set-song-progress', 'set-match-score', 'record-result', 'record-bye', 'lottery-bye', 'reset-current-match', 'draw-match-tiebreak', 'set-match-tiebreak-score', 'confirm-match-tiebreak']);
  const drafts = new Map();
  const qualifierCorrectionReasons = new Map();
  const valueOf = el => el.type === 'checkbox' ? el.checked : el.value;
  const normal = (record, value) => typeof value === 'boolean' ? value : record.numeric && value !== '' ? String(Number(value)) : String(value ?? '').trim();
  const equal = (record, a, b) => normal(record, a) === normal(record, b);
  const draftKey = el => el.dataset.draftScope ? `${el.dataset.draftScope}|${el.id}` : null;
  const matchContext = (s, id) => { const m = s.tournament.matches.find(item => item.id === id); return JSON.stringify([s.tournament.ruleset, m?.players, m?.songs.map(song => song.id), m?.candidates.map(song => song.id), (m?.tiebreaks || []).map(t => [t.song.id, t.confirmed])]); };
  const qualifierContext = (s, id, group = s.qualifier.activeGroup) => JSON.stringify([s.qualifier.plan || 'legacy', s.qualifier.scoringMode || 'legacy-score', group, s.qualifier.groups[group]?.songs, s.qualifier.rounds?.[group]?.playerIds, s.qualifier.rounds?.[group]?.locked, B.player(s, id)?.disqualification, s.qualifier.rounds?.[group]?.tiebreaks?.map(t => [t.song.id, t.playerIds, t.confirmed])]);
  const seedContext = s => JSON.stringify([s.qualifier.plan || 'legacy', s.qualifier.players.map(p => [p.id, Boolean(p.disqualification)]), ['A', 'B'].map(g => [s.qualifier.rounds?.[g]?.playerIds, s.qualifier.rounds?.[g]?.qualifiedIds, s.qualifier.rounds?.[g]?.locked]), s.tournament.seeded, s.tournament.seeds]);
  const sourceContext = (s = state) => { const status = s.broadcast?.sourceStatus; return JSON.stringify([status?.layout, status?.layout === 'qualifier' ? s.qualifier.activeGroup : s.tournament.currentMatchId, status?.showHandcams, status?.slots.map(slot => [slot.playerId, slot.playerName])]); };
  const sourceScope = (s = state) => `sources:${s.broadcast?.sourceStatus?.layout}:${encodeURIComponent(sourceContext(s))}`;
  function formScope(form) {
    const group = state.qualifier.activeGroup, match = state.tournament.currentMatchId;
    const signature = encodeURIComponent(matchContext(state, match));
    if (form.dataset.scoreEditor) return scoreScope(form);
    if (form.dataset.numberPlayer) return `number:${form.dataset.numberPlayer}`;
    if (form.id === 'readiness-form') return 'readiness:' + form.dataset.playerId;
    if (form.id === 'wait-form' || form.id === 'dq-form' || form.id === 'rematch-form') return `${form.id}:${encodeURIComponent(incidentContext())}`;
    if (form.dataset.renamePlayer) return `rename:${form.dataset.renamePlayer}`;
    return ({ 'event-form': 'event', 'song-form': `song:${editingSongId || 'new'}`, 'group-songs-form': `group-songs:${group}:${encodeURIComponent(qualifierContext(state, null, group))}`, 'roster-form': `roster:${group}`, 'seed-form': `seeds:${encodeURIComponent(seedContext(state))}`, 'result-form': `result:${match}:${signature}`, 'final-candidates-form': `candidates:${match}:${signature}`, 'final-picks-form': `picks:${match}:${signature}`, 'source-form': sourceScope(), 'restore-form': `restore:${selectedBackupId}`, 'correction-form': `correction:${correctionMatchId}`, 'plan-form': 'plan', 'competition-roster-form': 'competition-roster' })[form.id];
  }
  function formValues(scope, s = state) {
    const [kind, entity] = scope.split(':');
    if (kind === 'score-entry') return scoreValues(scope, s);
    if (kind === 'plan') return { 'qualifier-plan': s.qualifier.plan || 'auto' };
    if (kind === 'competition-roster') return { 'competition-roster': s.qualifier.players.map(p => p.name).join('\n') };
    if (kind === 'number') return { [`number-${entity}`]: String(B.player(s, entity)?.number ?? '') };
    if (kind === 'readiness') return Object.fromEntries(['device', 'globalVersion', 'headphones', 'charts', 'streamConsent'].map(key => [`ready-${key}`, s.qualifier.readiness?.[entity]?.[key] === true]));
    if (['wait-form', 'dq-form', 'rematch-form'].includes(kind)) return incidentDefaults(kind, s);
    const m = s.tournament.matches.find(match => match.id === entity);
    if (kind === 'event') return Object.fromEntries(Object.entries(s.event).map(([key, value]) => [`event-${key.replace('ZH', '-zh')}`, value]));
    if (kind === 'song') {
      const song = s.library.find(item => item.id === entity);
      return { 'song-title': song?.title || '', 'song-artist': song?.artist || '', 'song-difficulty': song?.difficulty || 'IN', 'song-level': String(song?.level ?? 15), 'song-art': song?.art || 'assets/song/cover-1.svg', 'song-preview-audio': songPreviewPath(song), 'song-eligible': song?.eligible !== false };
    }
    if (kind === 'group-songs') return Object.fromEntries(s.qualifier.groups[entity].songs.map((id, i) => [`group-song-${i}`, id]));
    if (kind === 'roster') return { roster: s.qualifier.players.filter(p => p.group === entity).map(p => p.name).join('\n') };
    if (kind === 'seeds') {
      const seeds = s.tournament.seeded ? s.tournament.seeds : s.qualifier.plan ? QualifierRules.seeds(s) : Array.from({ length: 4 }, (_, i) => [B.rankings(s, 'A')[i]?.id || null, B.rankings(s, 'B')[i]?.id || null]).flat();
      return { ...Object.fromEntries(seeds.map((id, i) => [`seed-${i}`, id || ''])), 'seed-note': '' };
    }
    if (kind === 'result') return { 'referee-winner': '', 'result-note': '' };
    if (kind === 'special') return { 'draw-winner': '', 'bye-note': '' };
    if (kind === 'candidates') { const pool = matchSongPool(s, m?.id, false); return Object.fromEntries(Array.from({ length: finalCount(m) }, (_, i) => [`final-candidate-${i}`, pool.find(song => song.id === m?.candidates[i]?.id)?.id || pool[i]?.id || ''])); }
    if (kind === 'picks') { const pool = (m?.candidates || []).filter(song => SongPool.isAvailable(s, song, m.id)); return { 'audience-1': pool.find(song => song.id === m?.audiencePicks[0])?.id || pool[0]?.id || '', 'audience-2': pool.find(song => song.id === m?.audiencePicks[1])?.id || pool[1]?.id || '', 'host-pick': pool.find(song => song.id === m?.hostPick?.id)?.id || pool[2]?.id || '' }; }
    if (kind === 'sources') return Object.fromEntries((s.broadcast?.sourceStatus?.layout === entity ? s.broadcast.sourceStatus.slots : []).flatMap((slot, i) => [[`source-capture-${i}`, slot.capture || ''], [`source-handcam-${i}`, slot.handcam || '']]));
    if (kind === 'rename') return { [`rename-name-${entity}`]: B.player(s, entity)?.name || '' };
    if (kind === 'restore') return { 'restore-reason': '' };
    if (kind === 'correction') return { 'correction-reason': '', 'correction-confirm-clear': false };
    return {};
  }
  function prepareDrafts(root) {
    for (const form of root.querySelectorAll('form')) { const scope = formScope(form); if (scope) form.dataset.draftScope = scope; }
    for (const el of root.querySelectorAll('input[id],textarea[id],select[id]')) {
      let scope = el.form?.dataset.draftScope, read;
      if (el.form?.dataset.scoreEditor) { const formScope = scope; const id = el.id; read = s => formValues(formScope, s)[id];
      } else if (el.dataset.matchScore !== undefined) {
        const matchId = el.dataset.matchId, pi = Number(el.dataset.matchScore), si = Number(el.dataset.songIndex);
        scope = `match-score:${matchId}:${encodeURIComponent(matchContext(state, matchId))}`; read = s => String(s.tournament.matches.find(m => m.id === matchId)?.scores[pi][si] ?? '');
      } else if (el.dataset.qualifierScore) {
        const id = el.dataset.qualifierScore, si = Number(el.dataset.songIndex);
        scope = `qualifier-score:${id}:${encodeURIComponent(qualifierContext(state, id))}`; read = s => String(qualifierEntries(s).find(p => p.id === id)?.scores[si] ?? '');
      } else if (el.dataset.tiePlayer) {
        const id = el.dataset.tiePlayer; scope = `tie:${id}`; read = s => String(B.player(s, id)?.tiePriority ?? '');
      } else if (['draw-winner', 'bye-note'].includes(el.id)) {
        const matchId = state.tournament.currentMatchId, id = el.id;
        scope = `special:${matchId}:${encodeURIComponent(matchContext(state, matchId))}`; read = s => formValues(scope, s)[id];
      } else if (el.dataset.activeSlot !== undefined || el.hasAttribute('data-qualifier-progress')) {
        const group = state.qualifier.activeGroup;
        scope = `qualifier-display:${group}:${encodeURIComponent(qualifierContext(state, null, group))}`;
        read = el.dataset.activeSlot !== undefined ? s => s.qualifier.activePlayers[Number(el.dataset.activeSlot)] || '' : s => String(s.qualifier.currentSong);
      } else if (el.hasAttribute('data-stage')) { scope = 'stage'; read = s => s.stage;
      } else if (scope) { const id = el.id; read = s => formValues(scope, s)[id]; }
      if (!scope || !read) continue;
      el.dataset.draftScope = scope; el._draftRead = read;
      const record = drafts.get(draftKey(el));
      if (record) { if (el.type === 'checkbox') el.checked = record.value; else el.value = record.value; }
    }
  }
  function rememberDraft(el) {
    const key = draftKey(el); if (!key || !el._draftRead) return;
    let record = drafts.get(key);
    if (!record) record = { key, scope: el.dataset.draftScope, id: el.id, label: (el.labels?.[0]?.textContent || el.getAttribute('aria-label') || el.id).replace(/\s+/g, ' ').trim(), read: el._draftRead, numeric: el.type === 'number', base: el._draftRead(state), pending: new Set(), conflict: false };
    record.value = valueOf(el);
    if (equal(record, record.value, record.base) && !record.pending.size) drafts.delete(key); else drafts.set(key, record);
    refreshDraftNotice();
  }
  function reconcileDrafts() {
    for (const record of drafts.values()) {
      const current = record.read(state);
      const [kind, id, signature] = record.scope.split(':');
      if (['match-score', 'result', 'special', 'candidates', 'picks'].includes(kind) && encodeURIComponent(matchContext(state, id)) !== signature) { record.conflict = true; continue; }
      if (kind === 'score-entry' && !scoreContextValid(record.scope, state)) { record.conflict = true; continue; }
      if (['wait-form', 'dq-form', 'rematch-form'].includes(kind) && id !== encodeURIComponent(incidentContext())) { record.conflict = true; continue; }
      if (kind === 'qualifier-score' && encodeURIComponent(qualifierContext(state, id)) !== signature) { record.conflict = true; continue; }
      if (kind === 'qualifier-display' && (state.qualifier.activeGroup !== id || signature !== encodeURIComponent(qualifierContext(state, null, id)))) { record.conflict = true; continue; }
      if (kind === 'seeds' && id !== encodeURIComponent(seedContext(state))) { record.conflict = true; continue; }
      if (kind === 'group-songs' && signature !== encodeURIComponent(qualifierContext(state, null, id))) { record.conflict = true; continue; }
      if (kind === 'sources' && encodeURIComponent(sourceContext()) !== signature) { record.conflict = true; continue; }
      if (record.pending.has(normal(record, current))) { record.base = current; record.conflict = false; }
      else if (!equal(record, current, record.base)) record.conflict = true;
    }
  }
  function snapshotDrafts(scopeOrKeys) {
    const records = Array.isArray(scopeOrKeys) ? scopeOrKeys.map(key => drafts.get(key)).filter(Boolean) : [...drafts.values()].filter(record => record.scope === scopeOrKeys);
    return records.map(record => ({ key: record.key, value: record.value, record }));
  }
  function draftGuard(snapshot) {
    for (const item of snapshot) if (item.record.conflict || !equal(item.record, item.record.read(state), item.record.base)) {
      item.record.conflict = true; refreshDraftNotice(); const error = new Error('编辑冲突：此字段已被其他操作员更新，草稿已保留。请先核对服务器版本。'); error.code = 'CONFLICT'; throw error;
    }
  }
  function clearSubmitted(snapshot) {
    for (const item of snapshot) {
      const record = drafts.get(item.key); if (!record) continue;
      record.pending.delete(normal(record, item.value));
      if (equal(record, record.value, item.value)) drafts.delete(item.key); else { record.base = item.value; record.conflict = false; }
    }
    refreshDraftNotice();
  }
  function draftForm(scope, type, build, options = {}) {
    const snapshot = snapshotDrafts(scope);
    return send(type, () => build({ ...formValues(scope), ...Object.fromEntries(snapshot.map(item => [item.record.id, item.value])) }), { ...options, snapshot });
  }
  function refreshDraftNotice() {
    if (!$('content')) return;
    const confirmSources = $('content').querySelector('[data-confirm-sources]');
    if (confirmSources) confirmSources.disabled = [...drafts.values()].some(record => record.scope === sourceScope());
    let notice = $('content').querySelector('.draft-notice');
    if (!drafts.size) { notice?.remove(); return; }
    if (!notice) { notice = document.createElement('div'); notice.className = 'notice draft-notice'; notice.setAttribute('role', 'status'); $('content').prepend(notice); }
    const conflicts = [...drafts.values()].filter(record => record.conflict);
    const scopeLabel = record => { if (record.scope.startsWith('score-entry:')) { const d = JSON.parse(decodeURIComponent(record.scope.split(':')[1])); return `${d.kind.startsWith('q') ? qualifierLabel(d.group) + ' · ' + B.name(state, d.id) : d.id + ' · P' + (d.pi + 1)} · ${d.kind === 'qc' ? 'Challenge 总分' : d.kind.endsWith('t') ? '加赛 ' + (d.index + 1) : 'Song ' + (d.si + 1)}`; } return record.scope.split(':').slice(0, 2).join(' · ').slice(0, 120); };
    notice._conflictKeys = conflicts.map(record => record.key);
    const display = value => e(String(value ?? '空值').slice(0, 160));
    notice.innerHTML = `<strong>${conflicts.length ? '编辑冲突 · 草稿已保留' : '未提交草稿'}</strong><p>${drafts.size} 个字段尚未提交。${conflicts.length ? '其他操作员修改了其中 ' + conflicts.length + ' 个字段；请核对以下差异后再提交。' : '切换标签页或收到实时更新时会保留草稿。'}</p>${conflicts.length ? `<ul class="draft-conflicts">${conflicts.map(record => `<li><strong>${e(scopeLabel(record))} · ${e(record.label.slice(0, 100))}</strong><span>服务器：${display(record.read(state))}</span><span>保留草稿：${display(record.value)}</span></li>`).join('')}</ul><div class="form-actions">${button('采用以上服务器版本', 'data-draft-resolution="server"')}${button('保留以上草稿并重新确认', 'data-draft-resolution="review"')}</div>` : ''}`;
  }
  async function confirmResult(scope) {
    const id = scope.split(':')[1]; await queue;
    if (state.tournament.currentMatchId !== id || encodeURIComponent(matchContext(state, id)) !== scope.split(':')[2]) throw new Error('当前场次、选手或曲目已变化，请重新核对赛果。');
    const m = state.tournament.matches.find(match => match.id === id);
    assertScoresSaved('match', id);
    if (!m?.scores.flat().every(score => score !== null)) throw new Error('请先保存双方所有曲目的分数。');
    const revision = state.revision, values = { ...formValues(scope), ...Object.fromEntries(snapshotDrafts(scope).map(item => [item.record.id, item.value])) };
    const totals = m.scores.map(B.total), decision = state.tournament.ruleset === 'proposal-2026' ? ScoreRules.matchDecision(m) : null;
    const winner = decision ? m.players[decision.winnerIndex] : totals[0] === totals[1] ? values['referee-winner'] : m.players[totals[0] > totals[1] ? 0 : 1];
    if (!winner) throw new Error(decision?.reason === 'missing-accuracy' ? '同分时请补录每首歌曲的原始 ACC。' : decision ? '分数与平均 ACC 均相同，请完成额外加赛并确认加赛成绩。' : '平分时请先选择裁判判定的获胜者并填写理由。');
    if (!confirm(`确认场次 ${id} / R${m.round}\n${B.name(state, m.players[0])}：${B.score(totals[0])}\n${B.name(state, m.players[1])}：${B.score(totals[1])}\n获胜者：${B.name(state, winner)}${decision ? '\n判定依据：' + (decision.reason === 'accuracy' ? 'ACC' : '分数 / 已确认加赛') : ''}\n已核对成绩，确认后推进赛程。`)) return;
    return draftForm(scope, 'record-result', fields => ({ matchId: id, verified: true, tieWinnerId: decision ? null : fields['referee-winner'] || null, note: fields['result-note'] }), { expectedRevision: revision });
  }
  function assertScoresSaved(kind, entity) {
    const pending = [...drafts.values()].some(record => {
      if (!record.scope.startsWith('score-entry:')) return false;
      const d = JSON.parse(decodeURIComponent(record.scope.split(':')[1]));
      return kind === 'match' ? ['m', 'mt'].includes(d.kind) && d.id === entity :
        ['q', 'qc', 'qt'].includes(d.kind) && (entity === undefined || d.group === entity);
    });
    if (pending) throw new Error('请先保存或明确放弃相关分数、ACC 与判定草稿，再核对加赛或晋级。');
  }
  function scoreDescriptor(form) {
    return { kind: form.dataset.scoreEditor, group: form.dataset.group || state.qualifier.activeGroup, id: form.dataset.entity, pi: Number(form.dataset.playerIndex || 0), si: Number(form.dataset.songIndex || 0), index: Number(form.dataset.tieIndex || 0), prefix: form.dataset.prefix };
  }
  function scoreScope(form) {
    const d = scoreDescriptor(form), context = d.kind.startsWith('q') ? qualifierContext(state, d.id, d.group) : matchContext(state, d.id);
    return 'score-entry:' + encodeURIComponent(JSON.stringify({ ...d, context }));
  }
  function scoreContextValid(scope, s) {
    const d = JSON.parse(decodeURIComponent(scope.split(':')[1]));
    return d.context === (d.kind.startsWith('q') ? qualifierContext(s, d.id, d.group) : matchContext(s, d.id));
  }
  function scoreData(d, s) {
    if (d.kind === 'qc') { const p = qualifierEntries(s, d.group).find(p => p.id === d.id); return { score: p?.challengeTotal ?? null, judgements: null }; }
    if (d.kind === 'q') { const p = qualifierEntries(s, d.group).find(p => p.id === d.id); return { score: p?.scores[d.si], judgements: p?.judgements?.[d.si] }; }
    if (d.kind === 'qt') { const t = s.qualifier.rounds?.[d.group]?.tiebreaks?.[d.index]; return { score: t?.scores[d.id], judgements: t?.judgements?.[d.id] }; }
    const m = s.tournament.matches.find(m => m.id === d.id);
    if (d.kind === 'mt') return { score: m?.tiebreaks?.[d.index]?.scores[d.pi], judgements: m?.tiebreaks?.[d.index]?.judgements?.[d.pi] };
    return { score: m?.scores[d.pi]?.[d.si], judgements: m?.judgements?.[d.pi]?.[d.si] };
  }
  function scoreValues(scope, s) {
    const d = JSON.parse(decodeURIComponent(scope.split(':')[1])), data = scoreData(d, s);
    return Object.fromEntries(['score', 'accuracy', 'perfect', 'good', 'bad', 'miss'].map(key => [key === 'score' ? d.prefix : `${d.prefix}-${key}`, String((key === 'score' ? data.score : data.judgements?.[key]) ?? '')]));
  }
  function scoreEditor(kind, id, pi, si, data, disabled = '', index = 0, group = state.qualifier.activeGroup) {
    const prefix = kind === 'qc' ? `qtotal-${id}` : kind === 'q' ? `qs-${id}-${si}` : kind === 'm' ? `ms-${id}-${pi}-${si}` : `ts-${kind}-${id}-${pi}-${index}`;
    if (kind === 'qc' || kind === 'qt' && challenge()) {
      const total = kind === 'qc';
      return `<form class="score-editor ${total ? 'challenge-total-editor' : ''}" data-score-editor="${kind}" data-entity="${e(id)}" data-group="${group}" data-player-index="${pi}" data-song-index="${si}" data-tie-index="${index}" data-prefix="${e(prefix)}"><label class="score-input-label" for="${e(prefix)}">${total ? 'Challenge 总分' : '加赛分数'}<input id="${e(prefix)}" type="number" inputmode="numeric" min="0" max="${total ? 3000000 : 1000000}" step="1" value="${data.score ?? ''}" placeholder="尚未计分" ${disabled}></label>${total ? '<p class="secondary">照录游戏三首课题结算总分 · 0–3,000,000</p>' : ''}${button(total ? '保存 Challenge 总分' : '保存加赛分数', `type="submit" class="score-save" ${disabled}`)}</form>`;
    }
    const attrs = kind === 'q' ? `data-qualifier-score="${e(id)}"` : kind === 'm' ? `data-match-score="${pi}" data-match-id="${e(id)}"` : '';
    return `<form class="score-editor" data-score-editor="${kind}" data-entity="${e(id)}" data-group="${group}" data-player-index="${pi}" data-song-index="${si}" data-tie-index="${index}" data-prefix="${e(prefix)}"><label class="score-input-label" for="${e(prefix)}">Score<input id="${e(prefix)}" type="number" inputmode="numeric" min="0" max="1000000" step="1" value="${data.score ?? ''}" placeholder="—" ${attrs} data-song-index="${si}" ${disabled}></label><details id="judgements-${e(prefix)}" class="judgement-details"><summary>ACC & judgements</summary><label for="${e(prefix)}-accuracy">Screen ACC (%)<input id="${e(prefix)}-accuracy" type="number" inputmode="decimal" min="0" max="100" step="0.0001" value="${data.judgements?.accuracy ?? ''}" placeholder="Original result screen" ${disabled}></label><div class="judgement-grid">${['perfect', 'good', 'bad', 'miss'].map(key => `<label for="${e(prefix)}-${key}">${key.toUpperCase()}<input id="${e(prefix)}-${key}" type="number" inputmode="numeric" min="0" max="10000000" step="1" value="${data.judgements?.[key] ?? ''}" placeholder="—" ${disabled}></label>`).join('')}</div><p class="secondary">ACC 按原始成绩画面填写。判定数量请全填或全留空。</p></details>${button('Save score + ACC', `type="submit" class="score-save" ${disabled}`)}</form>`;
  }
  function judgementPayload(values, prefix) {
    const accuracy = values[`${prefix}-accuracy`], keys = ['perfect', 'good', 'bad', 'miss'];
    const present = keys.filter(key => values[`${prefix}-${key}`] !== '');
    if (present.length && present.length !== 4) throw new Error('PERFECT / GOOD / BAD / MISS 请全部填写，或全部留空。');
    if (accuracy === '') { if (present.length) throw new Error('填写判定数量时请同时填写原始 ACC。'); return null; }
    return { accuracy: Number(accuracy), ...Object.fromEntries(present.map(key => [key, Number(values[`${prefix}-${key}`])])) };
  }
  async function submitScore(form, scope) {
    const d = scoreDescriptor(form), type = ({ q: 'set-qualifier-score', qc: 'set-qualifier-total', m: 'set-match-score', qt: 'set-qualifier-tiebreak-score', mt: 'set-match-tiebreak-score' })[d.kind];
    const build = values => d.kind === 'qc' ? { group: d.group, playerId: d.id, total: values[d.prefix] === '' ? null : Number(values[d.prefix]) } : ({ ...(d.kind.startsWith('q') ? { group: d.group, playerId: d.id } : { matchId: d.id, playerIndex: d.pi }), ...(d.kind.endsWith('t') ? { index: d.index } : { songIndex: d.si }), score: values[d.prefix] === '' ? null : Number(values[d.prefix]), judgements: d.kind === 'qt' && challenge() ? null : judgementPayload(values, d.prefix) });
    const guard = () => { if (!scoreContextValid(scope, state) || d.kind.startsWith('q') && state.qualifier.activeGroup !== d.group) throw new Error('轮次、选手或曲目已变化，旧成绩草稿未提交。'); };
    if (!['q', 'qc'].includes(d.kind)) return draftForm(scope, type, build, { guard });
    const snapshot = snapshotDrafts(scope);
    await queue;
    draftGuard(snapshot); guard();
    const payload = build({ ...formValues(scope), ...Object.fromEntries(snapshot.map(item => [item.record.id, item.value])) });
    const previous = scoreData(d, state), rounds = state.qualifier.rounds?.[d.group]?.tiebreaks || [];
    const changed = (d.kind === 'qc' ? payload.total : payload.score) !== previous.score || JSON.stringify(ScoreRules.normaliseJudgements(payload.judgements)) !== JSON.stringify(ScoreRules.normaliseJudgements(previous.judgements));
    const revision = state.revision;
    if (!changed || !rounds.length) return send(type, payload, { snapshot, guard, expectedRevision: revision });
    const confirmed = rounds.filter(t => t.confirmed).length;
    const judgementSummary = raw => { const value = ScoreRules.normaliseJudgements(raw); return value ? `ACC ${value.accuracy}%${Object.hasOwn(value, 'perfect') ? ` · P/G/B/M ${value.perfect}/${value.good}/${value.bad}/${value.miss}` : ''}` : '未填写'; };
    const impact = `${qualifierLabel(d.group)} · ${B.name(state, d.id)} · ${d.kind === 'qc' ? 'Challenge 总分' : 'Song ' + (d.si + 1)}\n分数：${previous.score === null ? '尚未计分' : B.score(previous.score)} → ${(d.kind === 'qc' ? payload.total : payload.score) === null ? '尚未计分' : B.score(d.kind === 'qc' ? payload.total : payload.score)}${d.kind === 'qc' ? '' : '\n原判定：' + judgementSummary(previous.judgements) + '\n新判定：' + judgementSummary(payload.judgements)}\n本轮 ${rounds.length} 场加赛将全部失效（${confirmed} 场已确认，${rounds.length - confirmed} 场未确认）。\n加赛完整记录会归档到裁判修正记录，晋级排名须重新核对。`;
    const reasonInput = prompt(`${impact}\n请填写修正基础成绩的具体理由（8–500 字）：`, qualifierCorrectionReasons.get(scope) || '');
    if (reasonInput === null) return;
    const reason = reasonInput.trim(); qualifierCorrectionReasons.set(scope, reason);
    if (reason.length < 8 || reason.length > 500) throw new Error('修正理由须为 8–500 字；成绩草稿已保留。');
    if (!confirm(`${impact}\n理由：${reason}\n已核对基础成绩，并同意归档及清除以上加赛？`)) return;
    const result = await send(type, { ...payload, confirmClearTiebreaks: true, verified: true, reason }, {
      snapshot, expectedRevision: revision,
      guard() { guard(); if (state.revision !== revision) throw new Error('核对期间赛事版本已变化；成绩与理由草稿已保留，请重新核对加赛影响。'); }
    });
    qualifierCorrectionReasons.delete(scope); return result;
  }
  function qualifierTiebreakPanel(group, locked) {
    if (!proposal()) return '';
    const ties = QualifierRules.tiedSets(state, group), rounds = state.qualifier.rounds?.[group]?.tiebreaks || [];
    return `<details id="qualifier-tiebreak-details"><summary>同分处理 · ${challenge() ? 'Challenge 总分 / 加赛' : 'ACC / 加赛'}</summary><p class="secondary">${challenge() ? 'Challenge 总分相同即进行独立加赛；加赛只比较分数，不加入原总分。' : '总分相同先比较三首平均 ACC，仍相同才抽取独立加赛；加赛不计入原总分。'}</p>${ties.map((ids, i) => `<div class="notice">${ids.map(id => e(B.name(state, id))).join(' / ')}<div class="form-actions">${button('Draw tiebreak song', `data-draw-qualifier-tie="${i}" data-tie-ids="${e(JSON.stringify(ids))}" data-tie-group="${group}" ${locked || rounds.some(t => !t.confirmed) ? 'disabled' : ''}`)}</div></div>`).join('') || '<p class="secondary">目前没有影响前四的未决同分。</p>'}${rounds.map((t, index) => `<section class="tiebreak-round"><h3>加赛 ${index + 1} · ${e(t.song.title)} ${t.confirmed ? '· 已确认' : ''}</h3><div class="tiebreak-entry-grid">${t.playerIds.map(id => `<div><h4>${e(B.name(state, id))}</h4>${scoreEditor('qt', id, 0, 0, { score: t.scores[id], judgements: t.judgements?.[id] }, locked || t.confirmed || index !== rounds.length - 1 ? 'disabled' : '', index, group)}</div>`).join('')}</div>${!t.confirmed ? button('Verify & confirm tiebreak', `data-confirm-qualifier-tie="${index}" data-tie-group="${group}" ${locked ? 'disabled' : ''}`) : ''}</section>`).join('')}</details>`;
  }
  function matchTiebreakPanel(m, disabled) {
    if (state.tournament.ruleset !== 'proposal-2026') return '';
    const decision = ScoreRules.matchDecision(m), rounds = m.tiebreaks || [], complete = m.scores.flat().every(n => n !== null), pool = matchSongPool(state, m.id);
    return `<details id="match-tiebreak-details"><summary>同分处理 · ACC / 加赛</summary><p class="secondary">${!complete ? '先保存完整比赛成绩。' : decision.reason === 'missing-accuracy' ? '总分相同：补录每首 ACC 后再判定。' : decision.winnerIndex !== null ? '已可按总分、ACC 或已确认加赛判定胜者。' : '总分与平均 ACC 相同，请抽取额外加赛。'} 加赛不计入原总分。</p>${!pool.length ? '<p class="notice warning">没有可用加赛曲目。请在 Event & library 新增尚未正式选用的常规曲目后再抽曲。</p>' : ''}${button('Draw tiebreak song', `data-command="draw-match-tiebreak" ${disabled || !complete || decision.reason !== 'tie' || rounds.some(t => !t.confirmed) || !pool.length ? 'disabled' : ''}`)}${rounds.map((t, index) => `<section class="tiebreak-round"><h3>加赛 ${index + 1} · ${e(t.song.title)} ${t.confirmed ? '· 已确认' : ''}</h3><div class="tiebreak-entry-grid">${m.players.map((id, pi) => `<div><h4>${e(B.name(state, id))}</h4>${scoreEditor('mt', m.id, pi, 0, { score: t.scores[pi], judgements: t.judgements?.[pi] }, disabled || t.confirmed || index !== rounds.length - 1 ? 'disabled' : '', index)}</div>`).join('')}</div>${!t.confirmed ? button('Verify & confirm tiebreak', `data-confirm-match-tie="${index}" ${disabled}`) : ''}</section>`).join('')}</details>`;
  }
  function incidentContext(s = state) { return JSON.stringify([s.stage, s.qualifier.plan, s.qualifier.scoringMode || 'legacy-score', s.qualifier.activeGroup, s.qualifier.rounds?.[s.qualifier.activeGroup]?.playerIds, s.qualifier.rounds?.[s.qualifier.activeGroup]?.tiebreaks?.map(t => [t.song.id, t.confirmed, t.playerIds]), s.qualifier.groups[s.qualifier.activeGroup].songs, s.tournament.currentMatchId, matchContext(s, s.tournament.currentMatchId)]); }
  function incidentDefaults(kind, s) {
    if (kind === 'wait-form') return { 'wait-player': '', 'wait-reason': 'absence', 'wait-song': '' };
    if (kind === 'dq-form') return { 'dq-player': '', 'dq-reason': 'other', 'dq-note': '' };
    return { 'rematch-player': '', 'rematch-song': '0', 'rematch-reason': 'game-error', 'rematch-video': false, 'rematch-unintentional': false, 'rematch-agree': false, 'rematch-note': '' };
  }
  let readinessPlayerId = '';
  function refereePanel() {
    const q = state.qualifier, m = B.currentMatch(state), selected = q.players.find(p => p.id === readinessPlayerId && !p.disqualification) || q.players.find(p => !p.disqualification);
    if (!selected) return '';
    readinessPlayerId = selected.id;
    const pendingTie = state.stage === 'qualifier' ? B.qualifierTiebreak(state) : B.matchTiebreak(state);
    const ready = q.readiness?.[selected.id] || {}, songIds = pendingTie ? [pendingTie.song.id] : state.stage === 'qualifier' ? q.groups[q.activeGroup].songs : m?.songs.map(s => s.id) || [];
    return `<section class="panel referee-panel"><details id="referee-details"><summary>裁判工具 · 准备检查 / 等待 / 重赛 / DQ</summary><p class="secondary">裁判核对后执行；十分钟等待不会自动取消资格。超出规则的情况须记录 ACA 决定。</p><div class="referee-grid"><section><h3>选手准备检查</h3><label for="readiness-player">Player<select id="readiness-player">${playerOptions(selected.id)}</select></label><form id="readiness-form" data-player-id="${e(selected.id)}">${[['device', '自备设备可用'], ['globalVersion', 'Global 版本'], ['headphones', '使用耳机'], ['charts', '所需曲目已解锁'], ['streamConsent', '已确认直播安排']].map(([key, label]) => `<label class="checkbox-label"><input id="ready-${key}" type="checkbox" ${ready[key] ? 'checked' : ''}>${label}</label>`).join('')}<div class="form-actions">${button('保存准备检查', 'type="submit"')}</div></form></section><section><h3>等待 · 10 分钟</h3><form id="wait-form"><label for="wait-player">Player<select id="wait-player">${playerOptions('')}</select></label><label for="wait-reason">Reason<select id="wait-reason">${options([['absence', '缺席'], ['chart-unlock', '曲目未解锁']], 'absence', false)}</select></label><label for="wait-song">Chart (解锁等待时填写)<select id="wait-song">${songOptions('', state.library.filter(s => songIds.includes(s.id)))}</select></label><div class="form-actions">${button('开始十分钟等待', 'type="submit"')}</div></form>${Object.entries(q.waits || {}).map(([id, wait]) => `<div class="wait-record"><strong>${e(B.name(state, id))}</strong><span data-wait-deadline="${e(wait.deadline)}" data-wait-reason="${e(wait.reason)}">${wait.reason === 'absence' ? '缺席' : '曲目未解锁'} · 截止 ${e(new Date(wait.deadline).toLocaleTimeString('zh-HK'))}${Date.parse(wait.deadline) <= Date.now() ? ' · 已届满' : ''}</span>${button('取消等待', `data-cancel-wait="${e(id)}"`)}</div>`).join('')}</section><section><h3>取消比赛资格</h3><form id="dq-form"><label for="dq-player">Player<select id="dq-player">${playerOptions('')}</select></label><label for="dq-reason">Reason<select id="dq-reason">${options([['absence', '等待届满 · 缺席'], ['chart-unlock', '等待届满 · 未解锁'], ['headphones', '未使用耳机'], ['rule-violation', '违反规则'], ['score-unavailable', '无法提供成绩'], ['other', '其他 ACA 决定']], 'other', false)}</select></label><label for="dq-note">裁判 / ACA 决定记录<textarea id="dq-note" class="report-note" maxlength="500" required></textarea></label><div class="form-actions">${button('核对并取消资格', 'type="submit" class="danger"')}</div></form>${q.players.filter(p => p.disqualification).map(p => `<p class="secondary">DQ · ${e(p.name)} · ${e(p.disqualification.reason)}</p>`).join('')}</section><section><h3>授权单曲重赛</h3><form id="rematch-form" ${pendingTie ? `data-tiebreak-index="${pendingTie.index}"` : ''}>${state.stage === 'qualifier' ? `<label for="rematch-player">Player<select id="rematch-player">${pendingTie ? options(pendingTie.playerIds.map(id => [id, B.name(state, id)])) : playerOptions('', q.activeGroup)}</select></label>` : ''}<label for="rematch-song">Song<select id="rematch-song">${options(songIds.map((id, i) => [String(i), `${pendingTie ? 'Tiebreak ' + (pendingTie.index + 1) : 'Song ' + (i + 1)} · ${B.song(state, id)?.title || id}`]), '0', false)}</select></label><label for="rematch-reason">Reason<select id="rematch-reason">${options([['game-error', '游戏错误'], ['score-page-left', '无意离开成绩画面']], 'game-error', false)}</select></label><label class="checkbox-label"><input id="rematch-video" type="checkbox">已检查比赛录像</label><label class="checkbox-label"><input id="rematch-unintentional" type="checkbox">确认并非故意</label><label class="checkbox-label"><input id="rematch-agree" type="checkbox">所有相关选手同意</label><label for="rematch-note">裁判记录<textarea id="rematch-note" class="report-note" maxlength="500" required></textarea></label><p class="secondary">${state.stage === 'qualifier' ? '每位选手每轮每首曲目仅一次重赛机会。' : '每场每首曲目双方共用一次重赛额度。'}${state.stage === 'qualifier' && challenge() && !pendingTie ? '重赛后清除该选手当前轮的 Challenge 总分，完成三首结算后重新录入。' : '只清除该曲成绩及判定资料。'}</p><div class="form-actions">${button('核对并授权重赛', `type="submit" ${!songIds.length ? 'disabled' : ''}`)}</div></form></section></div></details></section>`;
  }
  async function confirmQualifierRound(group) {
    await queue;
    assertScoresSaved('qualifier', group);
    if (state.qualifier.activeGroup !== group) throw new Error('当前轮次已变化，请重新核对。');
    const revision = state.revision, ids = B.rankings(state, group).slice(0, 4).map(p => p.id);
    if (!confirm(`核对 ${qualifierLabel(group)} 成绩及同分处理。晋级：\n${ids.map(id => B.name(state, id)).join('\n')}\n锁定第一轮，并为其余选手创建空白的第二轮成绩？`)) return;
    return send('finalize-qualifier-round', { group, verified: true }, { expectedRevision: revision });
  }
  async function confirmQualification() {
    await queue; const revision = state.revision;
    assertScoresSaved('qualifier');
    const ids = proposal() ? QualifierRules.seeds(state) : Array.from({ length: 4 }, (_, i) => [B.rankings(state, 'A')[i]?.id, B.rankings(state, 'B')[i]?.id]).flat();
    if (!confirm(`已核对预选成绩及同分处理。确认以下种子并锁定预选？\n${ids.map((id, i) => `${i + 1}. ${B.name(state, id)}`).join('\n')}`)) return;
    return send('qualify', { verified: true }, { expectedRevision: revision });
  }
  async function confirmTiebreak(kind, index, group = state.qualifier.activeGroup) {
    await queue; const revision = state.revision, m = B.currentMatch(state);
    assertScoresSaved(kind === 'q' ? 'qualifier' : 'match', kind === 'q' ? group : m?.id);
    const t = kind === 'q' ? state.qualifier.rounds?.[group]?.tiebreaks?.[index] : m?.tiebreaks?.[index];
    if (!t || t.confirmed || (kind === 'q' && state.qualifier.activeGroup !== group)) throw new Error('加赛轮次已变化，请重新核对。');
    const ids = kind === 'q' ? t.playerIds : m.players, scores = kind === 'q' ? ids.map(id => t.scores[id]) : t.scores;
    if (scores.some(n => n === null)) throw new Error('请先保存所有加赛成绩。');
    if (!confirm(`确认已核对加赛 ${index + 1} · ${t.song.title}\n${ids.map((id, i) => `${B.name(state, id)}：${B.score(scores[i])}`).join('\n')}\n如仍完全同分，请继续抽取新的加赛。`)) return;
    return send(kind === 'q' ? 'confirm-qualifier-tiebreak' : 'confirm-match-tiebreak', { ...(kind === 'q' ? { group } : { matchId: m.id }), index, verified: true }, { expectedRevision: revision });
  }
  async function submitIncident(form, scope) {
    const kind = form.id, snapshot = snapshotDrafts(scope), values = { ...formValues(scope), ...Object.fromEntries(snapshot.map(i => [i.record.id, i.value])) };
    if (kind === 'readiness-form') return draftForm(scope, 'set-player-readiness', fields => ({ playerId: form.dataset.playerId, ...Object.fromEntries(['device', 'globalVersion', 'headphones', 'charts', 'streamConsent'].map(key => [key, fields[`ready-${key}`] === true])) }));
    await queue;
    if (scope.split(':')[1] !== encodeURIComponent(incidentContext())) throw new Error('轮次、场次或曲目已变化，请重新核对裁判操作。');
    const revision = state.revision, m = B.currentMatch(state);
    let type, payload;
    if (kind === 'wait-form') { type = 'start-player-wait'; payload = { playerId: values['wait-player'], reason: values['wait-reason'], songId: values['wait-song'] || undefined }; }
    if (kind === 'dq-form') { type = 'disqualify-player'; payload = { playerId: values['dq-player'], reason: values['dq-reason'], note: values['dq-note'] }; if (!confirm(`取消 ${B.name(state, payload.playerId)} 本次比赛资格？\n${payload.note}\n资格取消后将影响后续对阵。`)) return; }
    if (kind === 'rematch-form') { type = 'authorize-song-rematch'; payload = { stage: state.stage, ...(state.stage === 'qualifier' ? { group: state.qualifier.activeGroup, playerId: values['rematch-player'] } : { matchId: m?.id }), songIndex: Number(values['rematch-song']), ...(form.dataset.tiebreakIndex !== undefined ? { tiebreakIndex: Number(form.dataset.tiebreakIndex) } : {}), reason: values['rematch-reason'], videoChecked: values['rematch-video'] === true, unintentional: values['rematch-unintentional'] === true, allAgree: values['rematch-agree'] === true, note: values['rematch-note'] }; if (!confirm(`授权 Song ${payload.songIndex + 1} 重赛，并${state.stage === 'qualifier' && challenge() && form.dataset.tiebreakIndex === undefined ? '清除该选手当前轮 Challenge 总分，之后重新录入游戏结算总分' : '清除该曲已记成绩及判定资料'}？\n${state.stage === 'qualifier' ? '每位选手每轮每首曲目仅一次重赛机会。' : '每场每首曲目双方共用一次重赛机会。'}`)) return; }
    return draftForm(scope, type, () => payload, { expectedRevision: revision, guard() { if (scope.split(':')[1] !== encodeURIComponent(incidentContext())) throw new Error('比赛内容已变化，请重新核对裁判操作。'); } });
  }
  async function requestJSON(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { Authorization: 'Bearer ' + token, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
    const result = await response.json(); if (!response.ok) { const error = new Error(result.error || '请求未完成'); error.code = result.code; throw error; } return result;
  }
  async function loadBackups() {
    const result = await requestJSON('/api/backups'); backupList = result.backups; backupsLoaded = true;
    if (!backupList.some(b => b.id === selectedBackupId)) selectedBackupId = backupList[0]?.id || '';
    render();
  }
  async function previewBackup() {
    const id = selectedBackupId, revision = state.revision, epoch = ++backupEpoch;
    const backup = await requestJSON('/api/backups/' + encodeURIComponent(id) + '/preview');
    if (epoch === backupEpoch && id === selectedBackupId) { backupPreview = { backup, revision }; render(); }
  }
  async function previewCorrection() {
    const id = correctionMatchId, epoch = ++correctionEpoch;
    const result = await requestJSON('/api/result-correction/' + encodeURIComponent(id));
    if (epoch === correctionEpoch && id === correctionMatchId) { correctionPreview = { matchId: id, ...result }; render(); }
  }
  async function restoreBackup(scope) {
    const preview = backupPreview; if (!preview || preview.backup.id !== scope.split(':')[1]) throw new Error('请先查看恢复摘要。');
    const snapshot = snapshotDrafts(scope), values = { ...formValues(scope), ...Object.fromEntries(snapshot.map(item => [item.record.id, item.value])) };
    const reason = values['restore-reason'].trim(); if (!reason) throw new Error('请填写恢复理由。');
    await queue; if (state.revision !== preview.revision) throw new Error('预览已过期，请重新查看摘要后确认；理由已保留。');
    if (!confirm(`恢复备份版本 ${preview.backup.revision}\n${preview.backup.event.title}\n已完成 ${preview.backup.completedMatches} 场\n${backupScoreSummary(preview.backup, 'qualifier')}\n${backupScoreSummary(preview.backup, 'match')}\n将替换当前赛事版本 ${preview.revision}，当前版本会自动备份。\n正式选曲历史会保留，不会重新开放给其他场次。\n理由：${reason}`)) return;
    const task = queue.then(async () => {
      if (state.revision !== preview.revision) throw new Error('预览已过期，请重新查看摘要后确认；理由已保留。');
      const result = await requestJSON('/api/restore', { method: 'POST', body: JSON.stringify({ backupId: preview.backup.id, expectedRevision: preview.revision, reason }) });
      clearSubmitted(snapshot); backupPreview = null; correctionPreview = null; await loadBackups(); toast('备份已恢复 · 版本 ' + result.revision); return result;
    });
    queue = task.catch(() => {}); return task;
  }
  async function reopenResult(scope) {
    const preview = correctionPreview, id = scope.split(':')[1];
    if (!preview || preview.matchId !== id || preview.impact.blockedReason) throw new Error('请先查看有效的纠错影响预览。');
    const values = { ...formValues(scope), ...Object.fromEntries(snapshotDrafts(scope).map(item => [item.record.id, item.value])) };
    const reason = values['correction-reason'].trim(); if (!reason) throw new Error('请填写纠错理由。');
    if (preview.impact.requiresConfirmation && !values['correction-confirm-clear']) throw new Error('请明确勾选清除下游场次的确认。');
    await queue; if (state.revision !== preview.revision) throw new Error('预览已过期，请重新查看影响后确认；理由已保留。');
    if (!confirm(`重新打开场次 ${id}\n本场曲目及分数保留。\n需要清除并重新进行：${preview.impact.affectedMatchIds.join(', ') || '无下游'}\n理由：${reason}`)) return;
    await draftForm(scope, 'reopen-result', () => ({ matchId: id, reason, affectedMatchIds: preview.impact.affectedMatchIds, confirmClear: values['correction-confirm-clear'] === true }), { expectedRevision: preview.revision });
    correctionPreview = null; render(); toast('场次已重新打开；请复核并重新确认赛果。');
  }
  function toast(message, error = false) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').className = 'visible' + (error ? ' error' : ''); toastTimer = setTimeout(() => { $('toast').className = ''; }, error ? 7000 : 2500); }
  function send(type, payload = {}, { snapshot = [], guard, expectedRevision } = {}) {
    const contextMatch = (typeof payload !== 'function' && payload.matchId) || $('content')?.dataset.matchId || state?.tournament.currentMatchId;
    const contextSignature = matchContext(state, contextMatch);
    const body = () => { const value = typeof payload === 'function' ? payload() : payload; return matchActions.has(type) ? { ...value, matchId: value.matchId || contextMatch } : value; };
    const task = queue.then(() => new Promise((resolve, reject) => {
      if (!socket?.connected || !state) return reject(new Error('Disconnected. Reconnect before updating the broadcast.'));
      let command;
      try { draftGuard(snapshot); guard?.(); command = body(); if (matchActions.has(type) && (command.matchId !== state.tournament.currentMatchId || contextSignature !== matchContext(state, command.matchId))) { const error = new Error('当前场次、选手或曲目已切换，旧操作未提交；草稿已保留。'); error.code = 'MATCH_CHANGED'; throw error; } } catch (error) { return reject(error); }
      for (const item of snapshot) item.record.pending.add(normal(item.record, item.value));
      $('sync-status').textContent = 'Saving…';
      socket.timeout(8000).emit('command', { expectedRevision: expectedRevision ?? state.revision, action: { type, payload: command } }, (err, result) => {
        if (err) return reject(new Error('No acknowledgement received. Reconnect and check the saved state before retrying.'));
        if (!result.ok) { const error = new Error(result.code === 'STALE' ? '编辑冲突：版本已变化，草稿已保留，请重新核对。' : result.error); error.code = result.code; return reject(error); }
        clearSubmitted(snapshot);
        $('sync-status').textContent = `Saved · revision ${result.revision}`; resolve(result);
      });
    }));
    queue = task.catch(() => {});
    task.catch(error => { for (const item of snapshot) item.record.pending.delete(normal(item.record, item.value)); reconcileDrafts(); refreshDraftNotice(); toast(error.message, true); $('sync-status').textContent = 'Update not saved · 草稿保留'; });
    return task;
  }
  function controlStatus(connected) {
    $('connection').className = 'connection' + (connected ? '' : ' offline');
    $('connection').innerHTML = `<span class="dot"></span>${connected ? 'Connected to laptop' : 'Reconnecting…'}`;
    if (!connected) $('sync-status').textContent = 'Offline · editing paused';
  }
  function connect() {
    countdownClient?.dispose();
    if (socket) socket.disconnect();
    socket = createBroadcastSocket('/control', { token });
    countdownClient = BroadcastCountdown.createClient(socket, refreshCountdownControls);
    socket.on('connect', () => { $('pairing').hidden = true; $('workspace').hidden = false; controlStatus(true); });
    socket.on('state', next => { state = next; render(); $('sync-status').textContent = `Saved · revision ${next.revision}`; });
    socket.on('connections', next => { connections = next; refreshConnections(); });
    socket.on('disconnect', () => controlStatus(false));
    socket.on('connect_error', error => {
      controlStatus(false);
      if (['PAIRING_REQUIRED', 'FORBIDDEN'].includes(error.message)) { socket.disconnect(); token = null; sessionStorage.removeItem('broadcast-token'); $('workspace').hidden = true; $('pairing').hidden = false; $('connection').innerHTML = '<span class="dot"></span>Pair this device'; if (error.message === 'FORBIDDEN') $('pair-error').textContent = '此頁面需要主控配對碼；計分員請使用計分員入口。'; }
    });
  }
  $('pair-form').addEventListener('submit', async event => {
    event.preventDefault(); $('pair-error').textContent = '';
    const submit = event.target.querySelector('button'); submit.disabled = true;
    try {
      const response = await fetch('../api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: $('pin').value }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      token = result.token; sessionStorage.setItem('broadcast-token', token); $('pin').value = ''; connect();
    } catch (error) { $('pair-error').textContent = error.message; } finally { submit.disabled = false; }
  });
  function refreshConnections() {
    if ($('overlay-count')) $('overlay-count').textContent = connections.overlays ? `${connections.overlays} source${connections.overlays === 1 ? '' : 's'} connected` : 'No overlay connected';
    if ($('crew-count')) $('crew-count').textContent = `${connections.controls} 主控 · ${connections.scorekeepers || 0} 計分員`;
  }
  function refreshCountdownControls() {
    const current = BroadcastCountdown.context(state), cue = countdownClient?.cue;
    const phase = BroadcastCountdown.phase(cue, countdownClient?.now() || 0), active = !!phase;
    const start = document.querySelector('[data-start-countdown]'), cancel = document.querySelector('[data-cancel-countdown]'), status = document.querySelector('[data-countdown-status]');
    if (start) start.disabled = countdownPending || !socket?.connected || !current || active;
    if (cancel) cancel.disabled = countdownPending || !socket?.connected || !active;
    const label = active ? `正在倒計時 · ${phase.label}` : current ? '選手準備完成後，按下開始倒計時。' : '請先切換至比賽畫面並完成選手、曲目設定。';
    if (status && status.textContent !== label) status.textContent = label;
  }
  function countdownPanel() {
    return `<section class="panel countdown-panel"><div class="section-heading"><div><h2>比賽開始倒計時</h2><p class="secondary">全屏 3 · 2 · 1 · START，結束後恢復比賽畫面。</p></div></div><p class="secondary" data-countdown-status role="status"></p><div class="countdown-actions">${button('開始倒計時 · 3 2 1 START', 'data-start-countdown', true)}${button('取消倒計時', 'data-cancel-countdown')}</div></section>`;
  }
  async function sendCountdown(action) {
    const current = BroadcastCountdown.context(state), cueId = countdownClient?.cue?.id;
    if (!current || !socket?.connected || countdownPending) return;
    const requestSocket = socket, connectionId = socket.id;
    countdownPending = true; refreshCountdownControls();
    try {
      await queue;
      if (!requestSocket.connected || requestSocket !== socket || requestSocket.id !== connectionId) throw new Error('連線已變更，請確認選手準備完成後重新按下倒計時。');
      if (BroadcastCountdown.context(state)?.key !== current.key) throw new Error('選手、場次或曲目已切換，請重新核對。');
      const result = await new Promise((resolve, reject) => requestSocket.timeout(8000).emit('countdown-command', { action, expectedRevision: state.revision, contextKey: current.key, cueId }, (error, value) => error ? reject(new Error('未收到倒計時確認，請檢查目前畫面。')) : resolve(value)));
      if (!result.ok) throw new Error(result.error);
    } catch (error) { toast(error.message, true); }
    finally { countdownPending = false; refreshCountdownControls(); }
  }
  function refreshWaitControls() {
    for (const el of document.querySelectorAll('[data-wait-deadline]')) {
      const remaining = Math.max(0, Math.ceil((Date.parse(el.dataset.waitDeadline) - Date.now()) / 1000));
      const text = `${el.dataset.waitReason === 'absence' ? '缺席' : '曲目未解锁'} · ${remaining ? '剩余 ' + String(Math.floor(remaining / 60)).padStart(2, '0') + ':' + String(remaining % 60).padStart(2, '0') : '十分钟已届满 · 等待裁判确认'}`;
      if (el.textContent !== text) el.textContent = text;
    }
  }
  setInterval(refreshCountdownControls, 100);
  setInterval(refreshWaitControls, 1000);
  function sourcePanel() {
    const status = state.broadcast?.sourceStatus;
    if (!status) return '<section class="panel broadcast-sources-panel"><h2>OBS 来源人工核对</h2><p class="secondary">等待来源状态。</p></section>';
    const dirty = [...drafts.values()].some(record => record.scope === sourceScope());
    return `<section class="panel broadcast-sources-panel"><div class="section-heading"><div><h2>OBS 来源人工核对</h2><p class="secondary">只记录工作人员的人工检查；不连接 OBS，也不验证实际视频。</p></div><strong class="source-check-status ${status.confirmed ? 'checked' : 'unchecked'}" data-confirmed="${status.confirmed}">${status.confirmed ? '已人工核对' : '尚未核对'}</strong></div><form id="source-form"><div class="source-slot-grid">${status.slots.map(slot => `<fieldset><legend>位置 ${slot.index + 1} · ${e(slot.playerName || '空位')}</legend><label for="source-capture-${slot.index}">擷取卡来源名称<input id="source-capture-${slot.index}" value="${e(slot.capture)}" maxlength="80" placeholder="OBS 内的来源名称"></label><label for="source-handcam-${slot.index}">手元来源名称${status.showHandcams ? '（必填）' : '（单画面可留空）'}<input id="source-handcam-${slot.index}" value="${e(slot.handcam)}" maxlength="80"></label></fieldset>`).join('')}</div><div class="form-actions">${button('保存来源名称', 'type="submit"')}${button('已查看实际 OBS 画面，人工核对并确认', `type="button" data-confirm-sources ${dirty ? 'disabled' : ''}`)}</div></form><p class="secondary">请先保存名称，再在实际 OBS 中逐一检查当前选手与来源。选手、场次、名字或显示模式变化后需要重新核对。${status.confirmedAt ? '上次人工核对：' + e(new Date(status.confirmedAt).toLocaleString('zh-HK')) : ''}</p></section>`;
  }
  function renamePlayers() {
    return `<section class="panel rename-panel"><details id="rename-details"><summary>修改显示名称 · 保留选手 ID 与成绩</summary><p class="secondary">改名不会重新创建选手，不改变分组、种子、已记分或赛果。</p><div class="rename-grid">${qualifierEntries().map(p => `<form id="rename-form-${e(p.id)}" data-rename-player="${e(p.id)}"><label for="rename-name-${e(p.id)}">${e(p.name)}<input id="rename-name-${e(p.id)}" value="${e(p.name)}" maxlength="48" required></label>${button('保存名称', 'type="submit"')}</form>`).join('')}</div></details></section>`;
  }
  const actionLabels = {
    'set-qualifier-plan': '设置预选方案', 'set-competition-roster': '更新完整参赛名单', 'draw-player-numbers': '抽签选手编号', 'set-player-number': '修改选手编号', 'next-qualifier-batch': '下一组编号选手', 'finalize-qualifier-round': '核对并锁定预选轮次', 'draw-qualifier-tiebreak': '抽取预选加赛', 'set-qualifier-tiebreak-score': '记录预选加赛成绩', 'confirm-qualifier-tiebreak': '核对预选加赛', 'draw-match-tiebreak': '抽取双淘汰加赛', 'set-match-tiebreak-score': '记录双淘汰加赛成绩', 'confirm-match-tiebreak': '核对双淘汰加赛', 'set-player-readiness': '保存准备检查', 'start-player-wait': '开始十分钟等待', 'cancel-player-wait': '取消等待', 'disqualify-player': '取消选手资格', 'authorize-song-rematch': '授权单曲重赛',
    'apply-competition-config': '套用正式歌单与决赛规则', 'set-event': '修改赛事资料', 'set-scene': '切换直播场景', 'set-stage': '切换赛事阶段',
    'set-roster': '更新参赛名单', 'rename-player': '修改选手名称', 'randomise-groups': '随机分组',
    'set-qualifier-display': '切换预选选手或曲目进度', 'set-qualifier-songs': '设置预选曲目',
    'set-qualifier-score': '记录预选分数', 'set-tie-priority': '设置同分排名', 'qualify': '确认晋级名单',
    'seed-bracket': '创建种子对阵', 'select-match': '选择双淘汰场次', 'draw-candidates': '抽取候选曲目',
    'ban-song': '禁选曲目', 'pick-songs': '抽取比赛曲目', 'set-final-candidates': '设置决赛候选曲目',
    'set-final-picks': '锁定决赛选曲', 'reveal-host-song': '公开主持人曲目', 'set-song-progress': '切换比赛曲目进度',
    'set-match-score': '记录双淘汰分数', 'record-result': '确认赛果', 'record-bye': '记录轮空',
    'lottery-bye': '抽签决定轮空', 'reset-current-match': '重置未完成场次', 'reopen-result': '重新打开赛果',
    'upsert-song': '更新本地曲库', 'restore-backup': '恢复备份',
    'set-broadcast-display': '切换直播显示', 'set-broadcast-sources': '保存来源名称', 'confirm-broadcast-sources': '人工核对来源',
    'startup-recovery': '启动时自动恢复损坏数据', 'legacy-final-cursor-normalized': '修正旧版决赛曲目进度'
  };
  function backupScoreSummary(backup, kind) {
    const tiebreak = backup[`${kind}TiebreakScoredSlots`] ?? 0;
    const base = backup[`${kind}BaseScoredSlots`] ?? Math.max(0, (backup[`${kind}ScoredSlots`] ?? 0) - tiebreak);
    const confirmed = backup[`${kind}ConfirmedTiebreaks`] ?? 0;
    return `${kind === 'qualifier' ? '预选赛' : '双淘汰'}：基础 ${base} 个分数，加赛 ${tiebreak} 个分数，${confirmed} 场加赛已确认。`;
  }
  function backupListLabel(backup) {
    const tiebreak = (backup.qualifierTiebreakScoredSlots ?? 0) + (backup.matchTiebreakScoredSlots ?? 0);
    const base = (backup.qualifierBaseScoredSlots ?? Math.max(0, (backup.qualifierScoredSlots ?? 0) - (backup.qualifierTiebreakScoredSlots ?? 0))) + (backup.matchBaseScoredSlots ?? Math.max(0, (backup.matchScoredSlots ?? 0) - (backup.matchTiebreakScoredSlots ?? 0)));
    const confirmed = backup.confirmedTiebreaks ?? (backup.qualifierConfirmedTiebreaks ?? 0) + (backup.matchConfirmedTiebreaks ?? 0);
    return `版本 ${backup.revision} · ${backup.completedMatches} 场完成 · 基础 ${base} / 加赛 ${tiebreak} 分数 · 已确认加赛 ${confirmed} · ${new Date(backup.createdAt).toLocaleString('zh-HK')}`;
  }
  function operationsPanel() {
    const completed = state.tournament.matches.filter(m => m.status === 'complete');
    const correction = correctionPreview?.matchId === correctionMatchId ? correctionPreview : null;
    const restoration = backupPreview?.backup.id === selectedBackupId ? backupPreview : null;
    const correctionStale = correction && correction.revision !== state.revision, restoreStale = restoration && restoration.revision !== state.revision;
    return `<section class="panel operations-panel"><div class="section-heading"><div><h2>赛果纠错与备份恢复</h2><p class="secondary">先查看具体影响，再填写理由并确认。期间有新操作时必须重新预览。</p></div>${button('刷新备份列表', 'data-load-backups')}</div><div class="operations-grid"><section><h3>已完成场次纠错</h3><label for="correction-match">需要重新打开的场次<select id="correction-match">${options(completed.map(m => [m.id, `${m.id} · ${m.label}`]), correctionMatchId)}</select></label><div class="form-actions">${button('查看纠错影响', `data-preview-correction ${correctionMatchId ? '' : 'disabled'}`)}</div>${correction ? `<div class="impact-summary"><p>预览版本 ${correction.revision} · 场次 ${e(correctionMatchId)}</p>${correctionStale ? '<strong data-preview-stale>预览已过期，请重新查看影响；理由草稿保留。</strong>' : ''}${correction.impact.blockedReason ? `<p class="error">${e(correction.impact.blockedReason)}</p>` : ''}<p>本场保留曲目及分数并重新开放。下游需要重新进行：</p><ul>${correction.impact.affectedMatches.map(m => `<li>${e(m.id)} · ${e(m.label)}${m.hasResult ? ' · 已有赛果' : m.hasScores ? ' · 已有记分' : m.hasStartedSelection || m.hasOverride ? ' · 已有选曲或抽签' : ' · 尚未开始'}</li>`).join('') || '<li>没有下游场次</li>'}</ul></div><form id="correction-form"><label for="correction-reason">纠错理由<textarea id="correction-reason" maxlength="240" required></textarea></label>${correction.impact.requiresConfirmation ? '<label class="checkbox-label"><input id="correction-confirm-clear" type="checkbox">我已核对并同意清除以上下游场次的选曲、记分、抽签及赛果</label>' : ''}<div class="form-actions">${button('按上述影响重新打开赛果', `type="submit" ${correctionStale || correction.impact.blockedReason ? 'disabled' : ''}`)}</div></form>` : '<p class="secondary">查看影响后才可操作。</p>'}</section><section><h3>恢复自动备份</h3><label for="backup-id">备份<select id="backup-id">${options(backupList.map(b => [b.id, backupListLabel(b)]), selectedBackupId)}</select></label><div class="form-actions">${button('查看恢复摘要', `data-preview-backup ${selectedBackupId ? '' : 'disabled'}`)}</div>${restoration ? `<div class="impact-summary"><p>${e(restoration.backup.event.title)} · ${e(restoration.backup.event.date)} · ${e(restoration.backup.event.venue)}</p><p>当前赛事版本 ${restoration.revision} → 备份版本 ${restoration.backup.revision}</p><p>已完成 ${restoration.backup.completedMatches} 场。</p><p data-backup-qualifier-counts>${e(backupScoreSummary(restoration.backup, 'qualifier'))}</p><p data-backup-match-counts>${e(backupScoreSummary(restoration.backup, 'match'))}</p><p>备份赛果：${e(restoration.backup.matchResults.map(m => m.matchId).join(', ') || '无')}</p>${restoreStale ? '<strong data-preview-stale>预览已过期，请重新查看摘要；理由草稿保留。</strong>' : ''}<p>恢复会替换赛事结果；已正式选用的曲目历史会保留。恢复前会自动保留当前版本。</p></div><form id="restore-form"><label for="restore-reason">恢复理由<textarea id="restore-reason" maxlength="500" required></textarea></label><div class="form-actions">${button('确认恢复此备份', `type="submit" ${restoreStale ? 'disabled' : ''}`)}</div></form>` : `<p class="secondary">${backupsLoaded ? '选取备份并查看摘要后才可恢复。' : '点击刷新备份列表。'}</p>`}</section></div><details id="audit-details"><summary>最近操作记录</summary><ol class="audit-list">${(state.auditLog || []).slice(-10).reverse().map(item => `<li><time>${e(new Date(item.at).toLocaleString('zh-HK'))}</time> · 版本 ${item.revision} · ${e(actionLabels[item.type] || item.type)}${item.reason ? `<p>${e(item.reason)}</p>` : ''}</li>`).join('') || '<li>尚无操作记录</li>'}</ol></details></section>`;
  }
  function broadcast() {
    const scenes = controlScenes(), selected = scenes.find(s => s[0] === state.scene) || scenes[0], m = B.currentMatch(state), q = state.qualifier;
    const showHandcams = state.broadcast?.showHandcams === true;
    return heading('CONTROL ROOM / 直播控制', 'Your next moment, on air.', 'Manage the show. Keep the rhythm moving.', `<span class="pill"><span>${state.stage === 'qualifier' ? 'QUALIFIERS' : 'DOUBLE ELIMINATION'}</span></span>`) +
      countdownPanel() +
      `<section class="panel broadcast-display-panel"><div class="section-heading"><div><h2>畫面顯示</h2><p class="secondary">每位選手的直播畫面</p></div></div><div class="display-mode-buttons" role="group" aria-label="選手畫面顯示模式">${button('<strong class="display-mode-title">單畫面</strong><span class="display-mode-description">擷取卡主畫面</span>', `data-broadcast-handcams="false" class="display-mode-button ${showHandcams ? '' : 'selected'}" aria-pressed="${!showHandcams}"`, !showHandcams)}${button('<strong class="display-mode-title">雙畫面</strong><span class="display-mode-description">擷取卡主畫面 + 手元小窗</span>', `data-broadcast-handcams="true" class="display-mode-button ${showHandcams ? 'selected' : ''}" aria-pressed="${showHandcams}"`, showHandcams)}</div><p class="secondary">先在 OBS 擺好擷取卡與手元來源，將網頁 Layout 放在最上層。切換後，網頁即時顯示或隱藏手元小窗。</p></section>` +
      `<div class="broadcast-grid"><section class="preview-panel"><div class="panel-header"><h2>Program preview</h2><span class="on-air"><i class="dot"></i>LIVE STATE</span></div><div class="preview-shell" id="preview-container"></div><div class="preview-caption"><span>1920 × 1080 · transparent overlay</span><a href="../overlay/live.html" target="_blank" rel="noopener">Open overlay ${B.icon('next')}</a></div><div class="status-strip"><div class="status-cell"><span class="micro">Current stage</span><strong>${state.stage === 'qualifier' ? 'Qualifiers' : 'Double elimination'}</strong><small>${state.stage === 'qualifier' ? B.qualifierLabel(state) : m ? `R${m.round} · ${m.bracket}` : 'Awaiting seeding'}</small></div><div class="status-cell"><span class="micro">Current match</span><strong>${state.stage === 'qualifier' ? `${q.activePlayers.length} players` : m?.id || '—'}</strong><small>${state.stage === 'qualifier' ? 'Three-player layout' : m?.label || 'Eight qualifying seeds'}</small></div><div class="status-cell"><span class="micro">Song progress</span><strong>${(state.stage === 'qualifier' ? B.qualifierTiebreak(state) : B.matchTiebreak(state)) ? 'TIEBREAK ' + ((state.stage === 'qualifier' ? B.qualifierTiebreak(state) : B.matchTiebreak(state)).index + 1) : state.stage === 'qualifier' ? q.currentSong + 1 + ' / 3' : m ? `${m.currentSong + 1} / ${matchSongCount(m)}` : '—'}</strong><small>${e((state.stage === 'qualifier' ? B.qualifierTiebreak(state) : B.matchTiebreak(state))?.song.title || (state.stage === 'qualifier' ? B.song(state, q.groups[q.activeGroup].songs[q.currentSong])?.title : m?.songs[m.currentSong]?.title) || 'Awaiting selection')}</small></div></div><div class="current-bar"><div><span class="micro">On air now</span><h3>${e(selected[1])}</h3><p>${e(state.event.title)} · ${e(state.event.venue)}</p></div><div>${button('Edit match ' + B.icon('next'), `data-tab="${state.stage === 'qualifier' ? 'qualifiers' : 'bracket'}"`)}</div></div></section><aside class="panel"><div class="panel-header"><h2>Scenes <span class="secondary">畫面</span></h2><span class="micro">${String(scenes.findIndex(s => s[0] === state.scene) + 1).padStart(2, '0')} / ${String(scenes.length).padStart(2, '0')}</span></div><div class="scene-list">${scenes.map(([id, title, zh], i) => `<button class="scene-button" data-scene="${id}" aria-pressed="${id === state.scene}"><span class="scene-number">${String(i + 1).padStart(2, '0')}</span><span><span class="scene-name">${title}</span><small>${zh}</small></span><span class="scene-arrow">${id === state.scene ? '●' : B.icon('next')}</span></button>`).join('')}</div><div class="scene-section-note"><div id="overlay-count">Overlay status</div><div id="crew-count" style="margin-top:5px">Control devices</div><div style="margin-top:10px">OBS WebSocket · not configured</div></div></aside></div>` + sourcePanel();
  }
  function qualifiers() {
    const q = state.qualifier, group = q.activeGroup, players = B.rankings(state, group), groupSongs = q.groups[group].songs.map(id => B.song(state, id));
    const isChallenge = challenge(), configured = proposal(), round = q.rounds?.[group], locked = state.tournament.seeded || round?.locked ? 'disabled' : '';
    const songSetLocked = locked || QualifierRules.roundStarted(state, group) ? 'disabled' : '';
    const started = state.tournament.seeded || QualifierRules.hasScores(state);
    const tie = configured ? QualifierRules.activeTiebreak(state, group) : null, prelocked = started ? 'disabled' : '', ordered = qualifierEntries(state, group).filter(p => !p.disqualification && (!tie || tie.playerIds.includes(p.id)));
    const onStageOptions = selected => options(ordered.map(p => [p.id, `#${p.number || '—'} · ${p.name}`]), selected);
    return heading('QUALIFIERS / 預選賽', `${qualifierLabel(group)}. Every point counts.`, configured ? q.plan === 'A' ? 'Round 1: top four advance. Round 2: remaining players compete for four places.' : 'Odd / even numbered groups. Top four in each group advance.' : 'Legacy groups. Configure the proposal plan before scoring.', `<div class="group-switch">${['A', 'B'].map(g => `<button class="phi-surface ${g === group ? 'selected' : ''}" data-group="${g}" ${q.plan === 'A' && g === 'B' && !q.rounds.A.locked ? 'disabled' : ''}>${qualifierLabel(g)}</button>`).join('')}</div>`) +
      `<section class="panel qualifier-scoring-panel"><div class="section-heading"><div><h2>Qualifier 计分方式</h2><p class="secondary">${isChallenge ? 'Challenge Mode · 直接录入游戏三首结算总分，按总分排名。' : '现有赛事使用旧版分曲分数及 ACC 规则。'}</p></div>${!isChallenge ? button('启用 Challenge 总分计分', `data-qualifier-challenge ${QualifierRules.canChangeScoringMode(state) ? '' : 'disabled'}`, true) : '<span class="pill">CHALLENGE TOTAL</span>'}</div><p class="secondary">${isChallenge ? '每位选手只填一个总分；0 有效，留空表示尚未计分。' : QualifierRules.canChangeScoringMode(state) ? '仅在未录入成绩及比赛记录时切换；将保留名单和曲目。' : '已有比赛记录，保留原规则。请另建新赛事使用 Challenge 总分计分。'}</p></section>` +
      `<section class="panel qualifier-plan-panel"><details id="plan-details" ${configured ? '' : 'open'}><summary>比赛方案与抽签编号 · 开赛前设置</summary><p class="secondary"><a class="rules-link" href="../rules/" target="_blank" rel="noopener">Competition rules · English ↗</a></p><form id="plan-form"><div class="field-grid"><label for="qualifier-plan">Proposal plan<select id="qualifier-plan" ${prelocked}>${options([['auto', 'Auto · ≤20 Plan A / >20 Plan B'], ['A', 'Plan A · 两轮预选'], ['B', 'Plan B · 奇偶编号分组']], q.plan || 'auto', false)}</select></label><div class="form-actions">${button('Apply proposal plan', `type="submit" ${prelocked}`, true)}</div></div></form><form id="competition-roster-form"><label for="competition-roster">完整参赛名单 · 每行一人<textarea id="competition-roster" ${prelocked}>${e(q.players.map(p => p.name).join('\n'))}</textarea></label><div class="form-actions">${button('保存完整名单', `type="submit" ${prelocked}`)}${button('随机抽签编号', `type="button" data-draw-numbers ${prelocked}`)}</div></form><div class="number-roster">${q.players.map(p => `<form data-number-player="${e(p.id)}"><label for="number-${e(p.id)}">${e(p.name)}<input id="number-${e(p.id)}" type="number" min="1" max="64" step="1" value="${p.number ?? ''}" ${prelocked}></label>${button('保存编号', `type="submit" ${prelocked}`)}</form>`).join('')}</div></details></section>` +
      `<div class="section-grid"><section class="panel"><div class="section-heading"><div><h2>On-stage players</h2><p class="secondary">${tie ? '当前加赛选手 · ' + e(tie.song.title) : '按抽签编号次序，最多三位同场'}</p></div>${button('Show match ↗', 'data-scene="qualifier-match"', true)}</div><div class="field-grid three">${Array.from({ length: 3 }, (_, i) => `<label for="active-${i}">Slot ${i + 1}<select id="active-${i}" data-active-slot="${i}">${onStageOptions(q.activePlayers[i])}</select></label>`).join('')}</div>${configured ? `<div class="form-actions">${button('Next ordered batch →', `data-next-batch`)}</div><p class="secondary batch-order">${ordered.map(p => `<span class="${q.activePlayers.includes(p.id) ? 'current' : ''}">#${p.number} ${e(p.name)}</span>`).join(' → ')}</p>` : ''}<label for="qualifier-progress" style="margin-top:20px">Current song<select id="qualifier-progress" data-qualifier-progress ${tie ? 'disabled' : ''}>${groupSongs.map((s, i) => `<option value="${i}" ${i === q.currentSong ? 'selected' : ''}>SONG ${i + 1} · ${e(s?.title)}</option>`).join('')}</select></label></section><section class="panel"><div class="section-heading"><div><h2>${qualifierLabel(group)} song set</h2><p class="secondary">${q.plan === 'A' ? '第二轮使用独立成绩，不携带第一轮分数' : '两组使用不同的三首曲目'}</p></div></div><form id="group-songs-form"><div class="field-grid three">${q.groups[group].songs.map((id, i) => `<label for="group-song-${i}">Song ${i + 1}<select id="group-song-${i}" ${songSetLocked}>${songOptions(id)}</select></label>`).join('')}</div><div class="form-actions">${button('Save song set', `type="submit" ${songSetLocked}`)}<span class="secondary">Locked after scoring begins.</span></div></form></section></div>` +
      `<section class="panel" style="margin-top:26px"><div class="section-heading"><div><h2>Scores & standings</h2><p class="secondary">${isChallenge ? "直接录入游戏课题模式三首结算总分" : "每首曲目保存分数与原始 ACC"}</p></div>${q.plan === 'A' && group === 'A' ? button('核对并结束 Round 1 →', `data-finalize-round="A" ${locked}`, true) : button('核对晋级并创建赛程 →', `data-command="qualify" ${state.tournament.seeded ? 'disabled' : ''}`, true)}</div>${locked ? '<div class="notice">本轮成绩已锁定。</div>' : ''}${isChallenge && !configured ? '<div class="notice">请先设置比赛方案与抽签编号，再录入课题总分。</div>' : ''}<div class="score-table-wrap"><table class="score-table"><thead><tr><th>RANK</th><th>PLAYER</th>${isChallenge ? '<th>CHALLENGE TOTAL</th>' : groupSongs.map((s, i) => `<th>SONG ${i + 1}<div class="song-caption" title="${e(s?.title)}">${e(s?.title)}</div></th>`).join('')}<th>${isChallenge ? 'SAVED TOTAL' : 'TOTAL / ACC'}</th>${!configured ? '<th>TIE ORDER</th>' : ''}</tr></thead><tbody>${players.map(p => `<tr><td class="rank ${p.rank <= 4 && (!isChallenge || p.complete) ? 'advances' : ''}">${isChallenge && !p.complete ? '—' : (p.tied ? '=' : '') + p.rank}</td><td class="player-name">${p.number ? '#' + p.number + ' · ' : ''}${e(p.name)}<div class="song-caption">${p.disqualification ? 'DQ' : QualifierRules.complete(state, p) ? p.rank <= 4 ? 'QUALIFYING POSITION' : 'COMPLETE' : 'SCORES INCOMPLETE'}</div></td>${isChallenge ? `<td>${scoreEditor('qc', p.id, 0, 0, { score: p.challengeTotal }, locked || p.disqualification || !configured ? 'disabled' : '', 0, group)}</td>` : p.scores.map((n, i) => `<td>${scoreEditor('q', p.id, 0, i, { score: n, judgements: p.judgements?.[i] }, locked || p.disqualification ? 'disabled' : '', 0, group)}</td>`).join('')}<td class="total">${p.total === null || p.total === undefined ? '—' : B.score(p.total)}${isChallenge ? '' : `<div class="song-caption">${p.accuracy === null || p.accuracy === undefined ? 'ACC —' : p.accuracy.toFixed(4) + '%'}</div>`}</td>${!configured ? `<td><input class="priority" id="tie-${e(p.id)}" type="number" min="1" max="64" value="${p.tiePriority ?? ''}" placeholder="—" aria-label="${e(p.name)} tie priority" data-tie-player="${e(p.id)}" ${locked}></td>` : ''}</tr>`).join('')}</tbody></table></div><p class="secondary" style="margin-top:16px">${isChallenge ? '按游戏输出的 Challenge 总分排序，不平均 ACC；相同总分进行独立加赛。' : configured ? '同分按平均 ACC 排序；仍同分则进行独立加赛，不能手动指定优先排名。' : 'Legacy: equal totals use unique tie priorities (1 goes first).'}</p>${qualifierTiebreakPanel(group, locked)}${!configured ? `<details id="roster-details"><summary>Legacy group roster</summary><form id="roster-form"><label for="roster">Group ${group} players<textarea id="roster" ${locked}>${e(q.players.filter(p => p.group === group).map(p => p.name).join('\n'))}</textarea></label><div class="form-actions">${button('Update roster', `type="submit" ${locked}`)}${button('Randomise A / B', `type="button" data-command="randomise-groups" ${locked}`)}</div></form></details>` : ''}</section>` + renamePlayers() + refereePanel();
  }
  function seedEditor() {
    const rankedA = B.rankings(state, 'A'), rankedB = B.rankings(state, 'B');
    const defaults = proposal() ? QualifierRules.seeds(state) : Array.from({ length: 4 }, (_, i) => [rankedA[i]?.id || null, rankedB[i]?.id || null]).flat();
    const seeds = state.tournament.seeded ? state.tournament.seeds : defaults;
    const locked = state.tournament.matches.some(m => m.status === 'complete' || m.scores.flat().some(n => n !== null));
    const pairings = state.tournament.seeded ? `First round: ${state.tournament.matches.filter(m => m.round === 1).map(m => m.sources.every(s => s.type === 'seed') ? m.sources.map(s => '#' + s.value).join('–') : m.players.map(id => B.name(state, id)).join(' vs ')).join(' · ')}.` : state.qualifier.plan === 'B' ? 'Group 1 #1 vs Group 2 #4 · Group 1 #2 vs Group 2 #3 · Group 2 #1 vs Group 1 #3 · Group 2 #2 vs Group 1 #4.' : 'First round: #1–#8, #2–#7, #3–#6, #4–#5.';
    return `<form id="seed-form"><div class="notice">${e(pairings)}<p>Manual seeding can bypass qualifier scoring. Leave a slot empty for a vacancy.</p></div><div class="field-grid eight">${Array.from({ length: 8 }, (_, i) => `<label for="seed-${i}">Seed #${i + 1}<select id="seed-${i}" ${locked ? 'disabled' : ''}>${playerOptions(seeds[i])}</select></label>`).join('')}</div><label for="seed-note" style="margin-top:20px">ACA manual seeding decision <span>未通过预选确认时请记录 ACA 手动种子安排的理由。</span><textarea id="seed-note" class="report-note" maxlength="240" ${locked ? 'disabled' : ''} ${proposal() && !(state.qualifier.rounds.A.locked && state.qualifier.rounds.B.locked) ? 'required' : ''}></textarea></label><div class="form-actions">${button(state.tournament.seeded ? 'Update seeds' : 'Create 14-match bracket', `type="submit" ${locked ? 'disabled' : ''}`, true)}</div></form>`;
  }
  function bracket() {
    const m = B.currentMatch(state), t = state.tournament;
    if (!m) return heading('DOUBLE ELIMINATION / 雙淘汰賽', 'Eight seeds. One champion.', 'Advance the qualifier winners, or enter seeds manually.') + `<section class="panel"><div class="section-heading"><h2>Set the starting field</h2></div>${seedEditor()}</section>`;
    const count = matchSongCount(m), complete = m.status === 'complete', disabled = complete || m.status === 'pending' ? 'disabled' : '';
    let round = 0;
    return heading('DOUBLE ELIMINATION / 雙淘汰賽', 'The bracket, in motion.', 'Record each result to open the next matches.', button('Show bracket ↗', 'data-scene="bracket"', true)) +
      `<div class="section-grid"><section class="section-stack"><div class="panel"><div class="section-heading"><h2>Match schedule</h2><span class="micro">${t.matches.filter(x => x.status === 'complete').length} / 14 COMPLETE</span></div><div class="bracket-list">${t.matches.map(match => { const divider = match.round !== round ? `<div class="round-break">ROUND ${match.round}</div>` : ''; round = match.round; const targets = t.matches.filter(x => x.sources.some(y => y.type === 'winner' && y.value === match.id)).map(x => x.id).join(', '), loserTargets = t.matches.filter(x => x.sources.some(y => y.type === 'loser' && y.value === match.id)).map(x => x.id).join(', '); return divider + `<div class="match-row ${match.status}"><span class="match-id">${match.id}</span><div><h3>${e(match.label)}</h3><div class="versus-text">${match.players.map(id => id ? e(B.name(state, id)) : match.status === 'pending' ? 'TBD' : 'Vacant').join(' vs. ')}</div><div class="bracket-paths">${targets ? 'Winner → ' + targets : 'Winner → Champion'} · ${loserTargets ? 'Loser → ' + loserTargets : match.id === 'GF' ? 'Runner-up' : 'Loser eliminated'}</div></div><div>${['ready', 'live'].includes(match.status) ? button(match.status === 'live' ? 'Active' : 'Select', `data-match="${match.id}" class="btn-small"`, match.status === 'live') : `<span class="state-text">${match.status === 'complete' ? `${e(B.name(state, match.winnerId))}<br>${match.resultType.toUpperCase()}` : 'Waiting'}</span>`}</div></div>`; }).join('')}</div></div><div class="panel"><details id="seed-details" style="margin-top:0;border-top:0;padding-top:0"><summary>Seeding & vacancies</summary>${seedEditor()}</details>${t.drawLog.length ? `<div class="notice">${t.drawLog.map(d => `DRAW · ${e(B.name(state, d.winnerId))} → ${e(d.target)} · ${e(d.note)}`).join('<br>')}</div>` : ''}</div></section><section class="section-stack"><div class="panel"><div class="match-header"><div><h2>R${m.round} — ${e(m.label)}</h2><p>${m.bracket} · ${m.status.toUpperCase()} · ${count} SONGS</p></div><span class="match-code">${m.id}</span></div><div class="score-entry">${m.players.map((id, pi) => `<div class="player-score"><h3>${e(B.name(state, id))}</h3><div class="player-meta">SEED #${id ? B.seed(state, id) : '—'} · ${B.losses(state, id)} LOSSES</div>${Array.from({ length: count }, (_, si) => `<div class="match-song-score"><div class="song-caption">Song ${si + 1} · ${e(m.songs[si]?.title || 'Awaiting song selection')}${m.id === 'GF' && !fixedFinal(m) && si === 2 && !m.hostRevealed ? ' · PRIVATE' : ''}</div>${scoreEditor('m', m.id, pi, si, { score: m.scores[pi][si], judgements: m.judgements?.[pi]?.[si] }, disabled || !id || m.songs.length !== count || m.id === 'GF' && !fixedFinal(m) && si === 2 && !m.hostRevealed ? 'disabled' : '')}</div>`).join('')}<div class="total-band"><span class="micro">Total</span><strong>${B.score(B.total(m.scores[pi]))}</strong></div></div>`).join('')}</div><div class="progress-buttons">${Array.from({ length: count }, (_, i) => button(`SONG ${i + 1} / ${count}`, `data-song-progress="${i}" ${disabled || !m.songs[i] || m.id === 'GF' && !fixedFinal(m) && i === 2 && !m.hostRevealed ? 'disabled' : ''}`, i === m.currentSong)).join('')}</div><div class="form-actions">${button('Select songs ' + B.icon('next'), 'data-tab="songs"')}${button('Show match ↗', 'data-scene="double-elimination-match"', true)}</div><details id="result-details"><summary>Record result <span class="secondary">確認賽果並推進賽程</span></summary><form id="result-form">${state.tournament.ruleset === 'proposal-2026' ? '<p class="secondary">按总分 → 平均 ACC → 已确认加赛判定胜者；裁判核对原始成绩后确认。</p>' : `<label for="referee-winner">Referee winner (only for tied totals)<select id="referee-winner" ${disabled}>${options(m.players.filter(Boolean).map(id => [id, B.name(state, id)]))}</select></label>`}<label for="result-note" style="margin-top:16px">Adjudication note <span>裁判核对记录</span><textarea id="result-note" class="report-note" ${disabled}></textarea></label><div class="form-actions">${button('Confirm result & advance', `type="submit" ${disabled}`, true)}</div></form></details>${matchTiebreakPanel(m, disabled)}<details id="special-details"><summary>Vacancy, bye & lottery <span class="secondary">輪空與抽籤</span></summary><label for="draw-winner">Lottery winner <span>Leave empty for a random draw among the three eligible players.</span><select id="draw-winner" ${disabled}>${options([...new Set((([['W1', 'W2'], ['W3', 'W4'], ['W5', 'W6'], ['L1', 'L2'], ['L3', 'L4']].find(ids => ids.includes(m.id)) || []).flatMap(matchId => t.matches.find(x => x.id === matchId)?.players || [])))].filter(id => id && !B.player(state, id)?.disqualification).map(id => [id, B.name(state, id)]))}</select></label><label for="bye-note" style="margin-top:16px">Record note<input id="bye-note" placeholder="Vacant slot / lottery record" ${disabled}></label><div class="form-actions">${button('Record vacant-match bye', `data-bye ${disabled}`)}${button('Draw four-player bye', `data-lottery ${disabled}`)}</div><p class="secondary">Lottery is available in a four-player entry field with three players and one vacancy, before either match is scored. Fields include R1 / R2 winners and R2 / R3 losers. The other two players remain paired.</p></details><div class="form-actions" style="border-top:1px solid #2e3d49;padding-top:20px">${button('Reset current match', `data-reset class="danger" ${disabled}`)}</div></div></section></div>` + refereePanel();
  }
  function songSelection() {
    const m = B.currentMatch(state);
    if (fixedFinal(m)) return fixedFinalSelection(m);
    if (!m) return heading('SONG SELECTION / 選曲', 'Build the field first.', 'Seed the bracket and select a match to begin.', button('Go to bracket →', 'data-tab="bracket"', true));
    const gf = m.id === 'GF', candidatesCount = finalCount(m), done = m.status === 'complete' || m.status === 'pending', disabled = done ? 'disabled' : '', drawPool = matchSongPool(state, m.id, !gf), pickPool = m.candidates.filter(song => !m.bans.includes(song.id) && SongPool.isAvailable(state, song, m.id)), finalPickValues = formValues(`picks:${m.id}`);
    const focus = m.candidates.find(s => s.id === focusSongId) || m.songs[m.currentSong] || m.candidates[0];
    return heading(`SONG SELECTION / ${m.id} · R${m.round}`, gf ? 'The final has its own rhythm.' : 'Draw. Ban. Let fate decide.', gf ? `${candidatesCount} candidates. Two audience choices. One MC selection.` : 'Six candidates. One ban per player. Two random match songs.', button('Show selection ↗', 'data-scene="song-selection"', true)) +
      songPoolNotice(m) + `${done ? '<div class="notice">This match is locked. Select a ready match in Bracket.</div>' : ''}<div class="song-grid"><section><div class="panel-header"><h2>${gf ? 'Grand Finals candidates' : 'Candidate pool'}</h2><span class="micro">${m.candidates.length} / ${gf ? candidatesCount : 6} SONGS</span></div>${!gf ? `<div class="form-actions" style="margin:0 0 18px">${button(m.candidates.length ? 'Redraw 6 candidates ' + B.icon('random') : 'Draw 6 candidates ' + B.icon('random'), `data-command="draw-candidates" ${disabled || m.scores.flat().some(n => n !== null) || drawPool.length < 6 ? 'disabled' : ''}`, true)}</div>` : ''}<div class="candidate-catalog">${m.candidates.map((song, i) => `<div class="candidate-row ${focus?.id === song.id ? 'focused' : ''} ${m.bans.includes(song.id) ? 'banned' : ''} ${m.songs.some(s => s.id === song.id) ? 'picked' : ''} ${!SongPool.isAvailable(state, song, m.id) ? 'unavailable' : ''}" data-focus-song="${e(song.id)}"><span class="index">${String(i + 1).padStart(2, '0')}</span><div style="min-width:0"><button class="song-preview-button" data-focus-song="${e(song.id)}" aria-label="Preview ${e(song.title)}">${e(song.title)}</button><div class="song-info">${e(song.artist)} · ${e(song.difficulty)} ${e(song.level)}</div>${!SongPool.isAvailable(state, song, m.id) ? '<span class="song-use-label">USED · 其他場已選</span>' : ''}</div>${!gf ? `<div class="ban-actions">${m.players.map((id, pi) => `<button class="ban-button ${m.bans[pi] === song.id ? 'active' : ''}" data-ban-song="${e(song.id)}" data-ban-player="${pi}" aria-label="${e(B.name(state, id))} ban ${e(song.title)}" ${disabled || m.songs.length || m.bans[1 - pi] === song.id || !SongPool.isAvailable(state, song, m.id) && m.bans[pi] !== song.id ? 'disabled' : ''}>P${pi + 1}<br>BAN</button>`).join('')}</div>` : '<span class="micro">CANDIDATE</span>'}</div>`).join('') || '<div class="panel"><p class="secondary">Candidates will appear here when the draw is ready.</p></div>'}</div>${gf ? `<details id="final-candidates" ${m.candidates.length ? '' : 'open'}><summary>Set ${candidatesCount} candidates <span class="secondary">可包含常規曲庫以外曲目</span></summary><form id="final-candidates-form"><div class="field-grid">${Array.from({ length: candidatesCount }, (_, i) => `<label for="final-candidate-${i}">Candidate ${i + 1}<select id="final-candidate-${i}" ${disabled}>${songOptions(drawPool.find(song => song.id === m.candidates[i]?.id)?.id || drawPool[i]?.id, drawPool)}</select></label>`).join('')}</div><div class="form-actions">${button(`Set ${candidatesCount} candidates`, `type="submit" ${disabled || drawPool.length < candidatesCount ? 'disabled' : ''}`)}</div></form></details>` : `<div class="notice">P1 · ${e(B.name(state, m.players[0]))}<br>P2 · ${e(B.name(state, m.players[1]))}</div>`}</section><section><div class="song-focus"><div class="cover-window"><img src="../${e(displayArt(focus?.art || 'assets/song/cover-1.svg'))}" alt="${e(focus?.title || 'Tournament artwork')}"></div><div class="song-focus-title"><div style="min-width:0;flex:1"><h2>${e(focus?.title || 'Awaiting the draw.')}</h2><p>${e(focus?.artist || 'The next two songs start here.')}</p></div>${focus ? `<div class="difficulty-block"><b>${e(focus.level)}</b><span>${e(focus.difficulty)}</span></div>` : ''}</div></div><div class="panel"><div class="section-heading"><div><h2>Match songs</h2><p class="secondary">選曲結果自動寫入比賽畫面</p></div></div>${m.songs.length ? m.songs.map((song, i) => `<div class="selected-track"><span class="order">0${i + 1}</span><div><h3>${e(song.title)}</h3><small>${e(song.difficulty)} ${e(song.level)} · ${e(song.artist)}</small></div>${gf && i === 2 && !m.hostRevealed ? '<span class="locked-label">PRIVATE</span>' : ''}</div>`).join('') : '<p class="secondary">The final songs have not been selected.</p>'}${!gf ? `${m.candidates.length && m.candidates.some(song => !SongPool.isAvailable(state, song, m.id)) ? `<p class="notice warning">部分候選已被其他場次正式選用，本場抽曲會排除這些曲目${m.songs.length ? '；本場已鎖定的正式曲目保留。' : pickPool.length < 2 ? `；禁選後不足 2 首，${drawPool.length < 6 ? '先補充曲庫再重抽候選。' : '請重抽候選。'}` : drawPool.length >= 6 ? '。可重抽以恢復 6 首可用候選。' : '。剩餘候選仍可抽正式曲目；補足 6 首才能重抽候選。'}</p>` : ''}<div class="selection-progress" style="margin-top:22px"><div>P1 BAN <span>${m.bans[0] ? 'LOCKED' : m.bansConfirmed?.[0] ? 'PASS' : 'PENDING'}</span></div><div>P2 BAN <span>${m.bans[1] ? 'LOCKED' : m.bansConfirmed?.[1] ? 'PASS' : 'PENDING'}</span></div></div><div class="form-actions">${m.bansConfirmed ? m.players.map((id, pi) => button(`P${pi + 1} · Pass ban`, `data-ban-pass="${pi}" ${disabled || m.songs.length || m.candidates.length !== 6 ? 'disabled' : ''}`)).join('') : ''}${button('Draw 2 match songs ' + B.icon('random'), `data-command="pick-songs" ${disabled || m.songs.length || pickPool.length < 2 || !(m.bansConfirmed || m.bans.map(Boolean)).every(Boolean) ? 'disabled' : ''}`, true)}</div>` : `<form id="final-picks-form" style="margin-top:20px"><div class="field-grid"><label for="audience-1">Audience pick 1<select id="audience-1" ${disabled}>${songOptions(finalPickValues['audience-1'], m.candidates.filter(song => SongPool.isAvailable(state, song, m.id)))}</select></label><label for="audience-2">Audience pick 2<select id="audience-2" ${disabled}>${songOptions(finalPickValues['audience-2'], m.candidates.filter(song => SongPool.isAvailable(state, song, m.id)))}</select></label></div><div class="private-block"><h3>Private MC selection <span class="secondary">僅工作人員可見</span></h3><label for="host-pick">MC pick<select id="host-pick" ${disabled}>${songOptions(finalPickValues['host-pick'], m.candidates.filter(song => SongPool.isAvailable(state, song, m.id)))}</select></label></div><div class="form-actions">${button('Lock audience & MC picks', `type="submit" ${disabled || m.candidates.length !== candidatesCount || m.candidates.filter(song => SongPool.isAvailable(state, song, m.id)).length < 3 ? 'disabled' : ''}`, true)}</div></form><div class="form-actions">${button(m.hostRevealed ? 'MC song revealed' : 'Reveal MC song to broadcast', `data-reveal-host ${disabled || !m.hostPick || m.hostRevealed ? 'disabled' : ''}`)}</div>`}<div class="form-actions">${button('Enter scores →', 'data-tab="bracket"')}</div></div></section></div>`;
  }
  function fixedFinalSelection(m) {
    const songs = B.fixedFinalSongs(state), disabled = ['complete', 'pending'].includes(m.status) ? 'disabled' : '';
    return heading('GRAND FINAL / R6', 'Two songs. One champion.', '固定两首决赛曲目，双方按次序比赛，以两首总分及平均 ACC 判定赛果。', button('宣布决赛曲目 ↗', 'data-scene="grand-final-announcement"', true)) +
      `<section class="panel fixed-final-panel"><div class="section-heading"><div><h2>Grand Final songs</h2><p class="secondary">决赛歌单已确定，直接进入比赛。</p></div><span class="micro">2 SONGS</span></div><div class="fixed-final-song-grid">${songs.map((song, i) => `<article class="fixed-final-song"><img src="../${e(displayArt(song.art))}" alt="${e(song.title)}"><div class="fixed-final-song-copy"><span class="micro">SONG ${i + 1}</span><h3>${e(song.title)}</h3><p>${e(song.difficulty)} ${e(Math.trunc(song.level))}${song.artist ? ` · ${e(song.artist)}` : ''}</p></div></article>`).join('')}</div><div class="progress-buttons">${songs.map((song, i) => button(`SONG ${i + 1} / 2`, `data-song-progress="${i}" ${disabled}`, i === m.currentSong)).join('')}</div><div class="form-actions">${button('Enter scores →', 'data-tab="bracket"')}${button('Show match ↗', 'data-scene="double-elimination-match"', true)}</div></section>`;
  }
  function songCategory(song) {
    const config = globalThis.CompetitionConfig;
    if (officialConfig(state) && config.FINAL_SONG_IDS.includes(song.id)) return 'GRAND FINAL';
    if (officialConfig(state) && Object.values(config.QUALIFIER_SONG_IDS).flat().includes(song.id)) return 'QUALIFIER';
    return song.eligible ? 'DOUBLE ELIMINATION' : 'OTHER CHARTS';
  }
  function canApplyCompetitionPreset() {
    const t = state.tournament;
    return !t.seeded && !QualifierRules.hasScores(state) && !state.result && !t.matches.length && !t.seeds.length && !t.drawLog.length &&
      !Object.keys(t.songHistory || {}).length && !state.correctionLog?.length && !state.qualifier.players.some(player => player.judgements?.some(Boolean)) &&
      !['A', 'B'].some(group => Object.values(state.qualifier.rounds?.[group]?.results || {}).some(row => row.judgements?.some(Boolean)));
  }
  function competitionPresetPanel() {
    const config = globalThis.CompetitionConfig;
    if (!config) return '';
    const library = config.library(), available = canApplyCompetitionPreset(), applied = officialConfig(state);
    const groups = [['Qualifier Group 1', config.QUALIFIER_SONG_IDS.A], ['Qualifier Group 2', config.QUALIFIER_SONG_IDS.B], ['Double Elimination · 42 charts', config.DOUBLE_ELIMINATION_SONG_IDS], ['Grand Final · 2 charts', config.FINAL_SONG_IDS]];
    return `<section class="panel competition-preset-panel"><div class="section-heading"><div><h2>正式比赛歌单</h2><p class="secondary">6 首预选谱面 + 42 首双淘汰谱面 + 2 首决赛谱面 · ${applied ? '已载入' : '待套用'}</p></div>${button(applied ? '重新套用正式歌单' : '套用正式歌单与决赛规则', `data-apply-competition-config ${available ? '' : 'disabled'}`, !applied)}</div><p class="secondary">曲名、指定谱面与对应曲绘一并载入。等级取整数，小数直接舍去。Qualifier：Challenge Mode 三首结算总分直接录入。Grand Final：Desultory Signals IN 17、Petrichor AT 17，固定两首。</p>${available ? '<p class="secondary">套用后替换当前曲库及两组预选曲目。请先核对下方歌单，再确认套用。</p>' : '<p class="secondary">已有比赛记录，当前赛事无法替换正式歌单与决赛规则。</p>'}<details id="competition-preset-details"><summary>查看完整正式歌单与曲绘</summary><div class="competition-preset-groups">${groups.map(([title, ids]) => `<section><h3>${e(title)}</h3><div class="preset-song-list">${ids.map(id => { const song = library.find(s => s.id === id); return `<div class="preset-song-row"><img src="../${e(displayArt(song.art))}" alt="" loading="lazy"><div><strong>${e(song.title)}</strong><span>${e(song.difficulty)} ${e(Math.trunc(song.level))}</span></div></div>`; }).join('')}</div></section>`).join('')}</div></details></section>`;
  }
  async function applyCompetitionPreset() {
    if (!globalThis.CompetitionConfig || !canApplyCompetitionPreset()) throw new Error('已有比赛记录，不能替换当前赛事歌单与决赛规则。');
    if (drafts.size) throw new Error('请先保存或处理尚未提交的草稿，再套用正式歌单。');
    const revision = state.revision;
    if (!confirm('套用已核对的正式比赛歌单？\n替换当前曲库为 50 个谱面：6 个预选、42 个双淘汰、2 个决赛。\n预选两组改为已公布的三首曲目；等级直接舍去小数。\nGrand Final 固定 Desultory Signals IN 17 与 Petrichor AT 17，直接宣布并比赛。')) return;
    await send('apply-competition-config', { confirmed: true }, { expectedRevision: revision, guard() { if (drafts.size || !canApplyCompetitionPreset()) throw new Error('草稿或比赛记录已变化，请重新核对正式歌单。'); } });
    editingSongId = null; focusSongId = null; render(); toast('正式歌单、曲绘及两首决赛规则已套用。');
  }
  function eventSettings() {
    const song = state.library.find(s => s.id === editingSongId);
    const chartLocked = song && ['A', 'B'].some(group => state.qualifier.groups[group].songs.includes(song.id) && QualifierRules.roundStarted(state, group)) ? 'disabled' : '';
    return heading('EVENT & LIBRARY / 活動與曲庫', 'Make it your competition.', 'Event details and local song metadata, in one place.', button('Export state backup ' + B.icon('folder'), 'data-export')) + competitionPresetPanel() + songPoolNotice() +
      `<div class="section-grid"><section class="panel"><div class="section-heading"><div><h2>Event information</h2><p class="secondary">活動資訊</p></div></div><form id="event-form"><div class="field-grid"><label class="wide" for="event-title">Event name<input id="event-title" name="title" value="${e(state.event.title)}" maxlength="120" required></label><label class="wide" for="event-organiser">Organiser<input id="event-organiser" name="organiser" value="${e(state.event.organiser)}" maxlength="180"></label><label class="wide" for="event-organiser-zh">Organiser / 繁體中文<input id="event-organiser-zh" name="organiserZH" value="${e(state.event.organiserZH)}"></label><label for="event-date">Date<input id="event-date" name="date" type="date" value="${e(state.event.date)}" required></label><label for="event-time">Time<input id="event-time" name="time" value="${e(state.event.time)}"></label><label for="event-venue">Venue<input id="event-venue" name="venue" value="${e(state.event.venue)}" required></label><label for="event-message">Broadcast tagline<input id="event-message" name="message" value="${e(state.event.message)}"></label></div><div class="form-actions">${button('Save event information', 'type="submit"', true)}</div></form><label for="event-stage" style="margin-top:26px">Current stage<select id="event-stage" data-stage><option value="qualifier" ${state.stage === 'qualifier' ? 'selected' : ''}>Qualifiers</option><option value="double-elimination" ${state.stage === 'double-elimination' ? 'selected' : ''}>Double elimination</option></select></label></section><section class="panel"><div class="section-heading"><div><h2>Song library</h2><p class="secondary">本地曲庫 · ${state.library.length} songs</p></div>${button('New song +', 'data-new-song')}</div><p class="secondary">${officialConfig(state) ? '正式歌单与曲绘已载入；赛前请核对曲名及谱面。' : '确认正式歌单、难度与曲绘后开赛。可在上方套用正式歌单。'}</p><form id="song-form" style="margin-top:22px"><div class="field-grid"><label class="wide" for="song-title">Title<input id="song-title" value="${e(song?.title || '')}" required maxlength="100" ${chartLocked}></label><label class="wide" for="song-artist">Artist<input id="song-artist" value="${e(song?.artist || '')}" maxlength="100" ${chartLocked}></label><label for="song-difficulty">Difficulty<select id="song-difficulty" ${chartLocked}>${options(['EZ', 'HD', 'IN', 'AT'].map(x => [x, x]), song?.difficulty || 'IN', false)}</select></label><label for="song-level">Level<input id="song-level" type="number" min="1" max="20" step="1" value="${Math.trunc(song?.level ?? 15)}" required ${chartLocked}></label><label class="wide" for="song-art">Local artwork path <span>Place artwork in public/assets/song/</span><input id="song-art" value="${e(song?.art || 'assets/song/cover-1.svg')}" maxlength="180" required></label><label class="wide" for="song-preview-audio">Music preview path · optional <span>10–15 秒預覽 · public/assets/song-preview/ · 禁曲及抽曲後自動播放</span><input id="song-preview-audio" value="${e(songPreviewPath(song))}" maxlength="180" placeholder="assets/song-preview/song-01.mp3"></label><label class="checkbox-label wide"><input id="song-eligible" type="checkbox" ${song?.eligible !== false ? 'checked' : ''}> Include in regular 6-song draws</label></div><div class="form-actions">${button(song ? 'Save song' : 'Add song', 'type="submit"', true)}${song ? `<span class="secondary">${chartLocked ? '本谱面已用于预选赛，曲名、作者、难度和等级已锁定；仍可更新曲绘及预览素材。' : 'Existing match selections keep their original metadata.'}</span>` : ''}</div></form><div class="library-list">${state.library.map(s => `<div class="library-row"><img class="library-art" src="../${e(displayArt(s.art))}" alt="" loading="lazy"><div>${e(s.title)}<div class="secondary">${e(s.difficulty)} ${e(Math.trunc(s.level))} · ${e(songCategory(s))}</div></div><button data-edit-song="${e(s.id)}" aria-label="Edit ${e(s.title)}">Edit ↗</button></div>`).join('')}</div></section></div>` + operationsPanel();
  }
  const pages = { broadcast, qualifiers, bracket, songs: songSelection, event: eventSettings };
  displayMedia.ready.then(() => render());
  mediaWarmup.prepareFonts();
  addEventListener('pagehide', () => { mediaWarmup.dispose(); displayMedia.dispose(); }, { once: true });
  function render() {
    if (!state) return;
    const currentMatch = B.currentMatch(state);
    const visibleSongs = activeTab === 'songs' ? (fixedFinal(currentMatch) ? currentMatch.songs : currentMatch?.candidates) || [] : [];
    mediaWarmup.setImages(visibleSongs.filter(song => !song.hidden).map(song => '../' + displayArt(song.art)));
    const active = document.activeElement;
    const focusAttributes = ['data-scene', 'data-focus-song', 'data-ban-song', 'data-ban-player', 'data-command', 'data-song-progress', 'data-broadcast-handcams'];
    const keyboardSelector = active?.tagName === 'BUTTON' ? focusAttributes.filter(key => active.hasAttribute(key)).map(key => `[${key}="${CSS.escape(active.getAttribute(key))}"]`).join('') : '';
    const focused = active && active.id && $('content').contains(active) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) ? { id: active.id, scope: active.dataset.draftScope, start: active.selectionStart, end: active.selectionEnd } : null;
    const openDetails = [...$('content').querySelectorAll('details[open][id]')].map(el => el.id);
    const previousArtWindow = $('content').querySelector('.cover-window');
    const previousSrc = previousArtWindow?.querySelector('img:not([data-motion-cover-old])')?.getAttribute('src');
    const nextHTML = pages[activeTab]();
    const template = document.createElement('template'); template.innerHTML = nextHTML;
    reconcileDrafts(); prepareDrafts(template.content);
    const nextArtWindow = template.content.querySelector('.cover-window'), desiredCover = nextArtWindow?.querySelector('img');
    const requestedCover = desiredCover ? { src: desiredCover.getAttribute('src'), alt: desiredCover.getAttribute('alt') || '', decodeImage: mediaWarmup.decodeImage } : null;
    // Preserve the decoded bitmaps and active movement until the newest logical cover is ready.
    if (previousArtWindow && nextArtWindow) nextArtWindow.replaceWith(previousArtWindow);
    if (activeTab === 'broadcast' && $('program-preview')) {
      // Keep the iframe attached: replacing or moving it would reload its source.
      for (const selector of ['.page-heading', '.broadcast-display-panel', '.broadcast-sources-panel', '.status-strip', '.current-bar', 'aside.panel']) {
        $('content').querySelector(selector).replaceWith(template.content.querySelector(selector));
      }
    } else {
      $('content').replaceChildren(...template.content.childNodes);
      if ($('preview-container')) {
        const iframe = document.createElement('iframe'); iframe.id = 'program-preview'; iframe.title = 'Live broadcast program preview';
        iframe.src = '../overlay/live.html?preview=1'; $('preview-container').append(iframe);
      }
    }
    for (const id of openDetails) if ($(id)) $(id).open = true;
    const artWindow = $('content').querySelector('.cover-window');
    if (artWindow && requestedCover) {
      BroadcastMotion.coverSlide(artWindow, previousSrc, requestedCover);
    }
    if (focused && $(focused.id)?.dataset.draftScope === focused.scope) { const next = $(focused.id); next.focus({ preventScroll: true }); try { if (focused.start !== null) next.setSelectionRange(focused.start, focused.end); } catch (_) {} }
    else if (keyboardSelector) $('content').querySelector(`button${keyboardSelector}`)?.focus({ preventScroll: true });
    document.querySelectorAll('.tabs [data-tab]').forEach(el => el.setAttribute('aria-selected', el.dataset.tab === activeTab));
    const changedTab = lastRenderedTab !== undefined && lastRenderedTab !== activeTab;
    lastRenderedTab = activeTab;
    if (changedTab) {
      tabAnimation?.cancel(); tabAnimation = null;
      if (!reducedMotion.matches) {
        const animation = $('content').animate([{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'translateY(0px)' }], { duration: 160, easing: 'linear', fill: 'both' });
        tabAnimation = animation;
        animation.finished.catch(() => {}).then(() => {
          if (tabAnimation === animation) { animation.cancel(); tabAnimation = null; }
        });
      }
    }
    $('content').dataset.matchId = state.tournament.currentMatchId || '';
    if (state.recovery?.message) { const notice = document.createElement('div'); notice.className = 'notice recovery-alert'; notice.setAttribute('role', 'alert'); notice.innerHTML = `<strong>赛事数据已自动恢复</strong><p>${e(state.recovery.message)}</p><p>请核对当前名单、分数及赛果。原文件已保留：${e(state.recovery.preservedFile || '')}</p>`; $('content').prepend(notice); }
    refreshDraftNotice(); refreshConnections(); refreshCountdownControls(); refreshWaitControls();
  }
  document.addEventListener('click', event => {
    const target = event.target.closest('button,[data-focus-song]'); if (!target || target.disabled || !state) return;
    if (target.hasAttribute('data-start-countdown')) { sendCountdown('start'); return; }
    if (target.hasAttribute('data-cancel-countdown')) { sendCountdown('cancel'); return; }
    if (target.hasAttribute('data-apply-competition-config')) { applyCompetitionPreset().catch(error => toast(error.message, true)); return; }
    if (target.dataset.draftResolution) {
      for (const key of target.closest('.draft-notice')?._conflictKeys || []) { const record = drafts.get(key); if (!record?.conflict) continue;
        if (target.dataset.draftResolution === 'server') drafts.delete(key);
        else { record.base = record.read(state); record.conflict = false; }
      }
      render(); if (target.dataset.draftResolution === 'review') toast('草稿已保留，请再次提交对应表单；比分请修改后保存。'); return;
    }
    if (target.hasAttribute('data-load-backups')) { loadBackups().catch(error => toast(error.message, true)); return; }
    if (target.hasAttribute('data-preview-backup')) { previewBackup().catch(error => toast(error.message, true)); return; }
    if (target.hasAttribute('data-preview-correction')) { previewCorrection().catch(error => toast(error.message, true)); return; }
    if (target.hasAttribute('data-confirm-sources')) {
      const status = state.broadcast?.sourceStatus, signature = status?.signature;
      if (!signature) return;
      if ([...drafts.values()].some(record => record.scope === sourceScope())) { toast('请先保存来源名称，再检查实际 OBS 画面并确认。', true); return; }
      send('confirm-broadcast-sources', { signature }, { guard() { if (state.broadcast?.sourceStatus?.signature !== signature) throw new Error('选手或来源已变化，请重新检查实际 OBS 画面。'); } }).catch(() => {}); return;
    }
    if (target.dataset.tab) { activeTab = target.dataset.tab; render(); window.scrollTo({ top: 0, behavior: 'instant' }); return; }
    if (target.dataset.broadcastHandcams !== undefined) { send('set-broadcast-display', { showHandcams: target.dataset.broadcastHandcams === 'true' }).catch(() => {}); return; }
    if (target.dataset.scene) { send('set-scene', { scene: target.dataset.scene }).catch(() => {}); return; }
    if (target.hasAttribute('data-qualifier-challenge')) {
      if ([...drafts.values()].some(record => record.scope.startsWith('score-entry:'))) { toast('请先保存或明确放弃分数草稿，再切换计分方式。', true); return; }
      if (confirm('启用 Challenge Mode 总分计分？每位选手将直接录入游戏三首结算总分；保留名单和曲目。')) send('set-qualifier-scoring-mode', { mode: 'challenge-total' }).catch(() => {}); return;
    }
    if (target.hasAttribute('data-draw-numbers')) { if (confirm('重新随机抽签所有选手编号，并按编号安排顺序？')) send('draw-player-numbers').catch(() => {}); return; }
    if (target.hasAttribute('data-next-batch')) { send('next-qualifier-batch').catch(() => {}); return; }
    if (target.dataset.finalizeRound) { confirmQualifierRound(target.dataset.finalizeRound).catch(error => toast(error.message, true)); return; }
    if (target.dataset.drawQualifierTie !== undefined) { const group = target.dataset.tieGroup; send('draw-qualifier-tiebreak', { group, playerIds: JSON.parse(target.dataset.tieIds) }, { guard() { assertScoresSaved('qualifier', group); if (state.qualifier.activeGroup !== group) throw new Error('预选轮次已变化，请重新选择加赛。'); } }).catch(() => {}); return; }
    if (target.dataset.confirmQualifierTie !== undefined) { confirmTiebreak('q', Number(target.dataset.confirmQualifierTie), target.dataset.tieGroup).catch(error => toast(error.message, true)); return; }
    if (target.dataset.confirmMatchTie !== undefined) { confirmTiebreak('m', Number(target.dataset.confirmMatchTie)).catch(error => toast(error.message, true)); return; }
    if (target.dataset.cancelWait) { send('cancel-player-wait', { playerId: target.dataset.cancelWait }).catch(() => {}); return; }
    if (target.dataset.banPass !== undefined) { send('ban-song', { playerIndex: Number(target.dataset.banPass), songId: null, confirmed: true }).catch(() => {}); return; }
    if (target.dataset.group) { send('set-qualifier-display', { group: target.dataset.group }).catch(() => {}); return; }
    if (target.dataset.match) { send('select-match', { matchId: target.dataset.match }).catch(() => {}); return; }
    if (target.dataset.command) {
      const type = target.dataset.command;
      if (type === 'qualify') { confirmQualification().catch(error => toast(error.message, true)); return; }
      if (type === 'randomise-groups' && !confirm('Randomly redistribute all players between Groups A and B? This is only available before scoring.')) return;
      if (type === 'draw-candidates' && B.currentMatch(state)?.candidates.length && !confirm('Redraw candidates? Existing bans and picks will be cleared for this match. Previously selected match/tiebreak songs remain unavailable to other matches.')) return;
      send(type, {}, { guard() { if (type === 'draw-match-tiebreak') assertScoresSaved('match', state.tournament.currentMatchId); } }).catch(() => {}); return;
    }
    if (target.dataset.banSong) { const m = B.currentMatch(state), pi = Number(target.dataset.banPlayer); send('ban-song', { playerIndex: pi, songId: m.bans[pi] === target.dataset.banSong ? null : target.dataset.banSong }).catch(() => {}); return; }
    if (target.dataset.focusSong) { focusSongId = target.dataset.focusSong; render(); return; }
    if (target.dataset.songProgress !== undefined) { send('set-song-progress', { index: Number(target.dataset.songProgress) }).catch(() => {}); return; }
    if (target.hasAttribute('data-reset')) { if (confirm('Reset songs, bans and scores for this unfinished match? Other matches and qualifier results are kept. Previously selected songs remain reserved to this match.')) send('reset-current-match').catch(() => {}); return; }
    if (target.hasAttribute('data-bye')) { const note = $('bye-note'), snapshot = snapshotDrafts([draftKey(note)]); if (confirm('Record this vacant match as a bye and advance its available player?')) send('record-bye', { note: note.value }, { snapshot }).catch(() => {}); return; }
    if (target.hasAttribute('data-lottery')) { const note = $('bye-note'), winner = $('draw-winner'), snapshot = snapshotDrafts([draftKey(note), draftKey(winner)]); const m = B.currentMatch(state), fieldIds = [['W1', 'W2'], ['W3', 'W4'], ['W5', 'W6'], ['L1', 'L2'], ['L3', 'L4']].find(ids => ids.includes(m?.id)) || [], field = state.tournament.matches.filter(x => fieldIds.includes(x.id)); const clear = field.some(x => x.candidates.length || x.songs.length || x.bans.some(Boolean)); if (confirm(`Record a four-player vacancy lottery? The chosen player advances; the other two will play each other.${clear ? '\nClear the existing unscored selection in both matches in this field?' : ''}`)) send('lottery-bye', { playerId: winner.value || null, note: note.value, confirmClear: clear }, { snapshot }).catch(() => {}); return; }
    if (target.hasAttribute('data-reveal-host')) { if (confirm('Publish the MC song to all broadcast overlays now?')) send('reveal-host-song').catch(() => {}); return; }
    if (target.hasAttribute('data-new-song')) { editingSongId = null; render(); $('song-title').focus(); return; }
    if (target.dataset.editSong) { editingSongId = target.dataset.editSong; render(); $('song-title').focus(); return; }
    if (target.hasAttribute('data-export')) {
      fetch('../api/export', { headers: { Authorization: 'Bearer ' + token } }).then(response => { if (!response.ok) throw new Error('Pair this device again to export.'); return response.blob(); }).then(blob => { const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = 'match-state-backup.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }).catch(error => toast(error.message, true));
    }
  });
  document.addEventListener('input', event => { if (state) rememberDraft(event.target); });
  document.addEventListener('change', event => {
    const el = event.target; if (!state) return;
    rememberDraft(el);
    if (el.id === 'readiness-player') { readinessPlayerId = el.value; render(); return; }
    if (el.form?.dataset.scoreEditor) {
      const kind = el.form.dataset.scoreEditor, legacy = kind === 'q' ? !proposal() : kind === 'm' && state.tournament.ruleset !== 'proposal-2026';
      if (legacy && el.id === el.form.dataset.prefix) {
        const snapshot = snapshotDrafts([draftKey(el)]), payload = { score: el.value === '' ? null : Number(el.value), songIndex: Number(el.dataset.songIndex) };
        if (kind === 'q') send('set-qualifier-score', { ...payload, playerId: el.dataset.qualifierScore }, { snapshot }).catch(() => {});
        else send('set-match-score', { ...payload, matchId: el.dataset.matchId, playerIndex: Number(el.dataset.matchScore) }, { snapshot }).catch(() => {});
      }
      return;
    }
    const snapshot = snapshotDrafts([draftKey(el)]);
    if (el.id === 'backup-id') { selectedBackupId = el.value; backupPreview = null; backupEpoch++; render(); return; }
    if (el.id === 'correction-match') { correctionMatchId = el.value; correctionPreview = null; correctionEpoch++; render(); return; }
    if (el.dataset.activeSlot !== undefined) { const group = state.qualifier.activeGroup, index = Number(el.dataset.activeSlot), value = el.value; send('set-qualifier-display', () => { const ids = [...state.qualifier.activePlayers]; ids[index] = value; return { players: ids.filter(Boolean) }; }, { snapshot, guard() { if (state.qualifier.activeGroup !== group) throw new Error('当前组别已切换，旧选手选择未提交。'); } }).catch(() => {}); }
    if (el.hasAttribute('data-qualifier-progress')) { const group = state.qualifier.activeGroup; send('set-qualifier-display', { currentSong: Number(el.value) }, { snapshot, guard() { if (state.qualifier.activeGroup !== group) throw new Error('当前组别已切换，旧曲目进度未提交。'); } }).catch(() => {}); }
    if (el.dataset.qualifierScore) send('set-qualifier-score', { playerId: el.dataset.qualifierScore, songIndex: Number(el.dataset.songIndex), score: el.value === '' ? null : Number(el.value) }, { snapshot }).catch(() => {});
    if (el.dataset.tiePlayer) send('set-tie-priority', { playerId: el.dataset.tiePlayer, priority: el.value === '' ? null : Number(el.value) }, { snapshot }).catch(() => {});
    if (el.dataset.matchScore !== undefined) send('set-match-score', { matchId: el.dataset.matchId, playerIndex: Number(el.dataset.matchScore), songIndex: Number(el.dataset.songIndex), score: el.value === '' ? null : Number(el.value) }, { snapshot }).catch(() => {});
    if (el.hasAttribute('data-stage')) send('set-stage', { stage: el.value }, { snapshot }).catch(() => {});
  });
  document.addEventListener('submit', event => {
    if (event.target.id === 'pair-form') return; event.preventDefault(); if (!state) return;
    const form = event.target;
    const scope = form.dataset.draftScope, entity = scope?.split(':')[1];
    if (form.dataset.scoreEditor) { submitScore(form, scope).then(result => { if (result) toast(form.dataset.scoreEditor === 'qc' ? 'Challenge 总分已保存' : form.dataset.scoreEditor === 'qt' && challenge() ? '加赛分数已保存' : '分数与 ACC 已保存'); }).catch(error => toast(error.message, true)); return; }
    if (form.dataset.numberPlayer) { draftForm(scope, 'set-player-number', values => ({ playerId: form.dataset.numberPlayer, number: Number(values[`number-${form.dataset.numberPlayer}`]) })).catch(() => {}); return; }
    if (form.id === 'plan-form') { if (confirm('按建议书比赛规则设置方案？已有比赛成绩时不能切换方案。')) draftForm(scope, 'set-qualifier-plan', values => ({ plan: values['qualifier-plan'] })).catch(() => {}); return; }
    if (form.id === 'competition-roster-form') { if (confirm('保存完整参赛名单？保留未改名选手的 ID，开赛后不可更改名单。')) draftForm(scope, 'set-competition-roster', values => ({ names: values['competition-roster'].split('\n') })).catch(() => {}); return; }
    if (['readiness-form', 'wait-form', 'dq-form', 'rematch-form'].includes(form.id)) { submitIncident(form, scope).catch(error => toast(error.message, true)); return; }
    if (form.dataset.renamePlayer) draftForm(scope, 'rename-player', values => ({ playerId: form.dataset.renamePlayer, name: values[`rename-name-${form.dataset.renamePlayer}`] })).then(() => { render(); toast('名称已修改，选手 ID 与成绩保留。'); }).catch(() => {});
    if (form.id === 'source-form') draftForm(scope, 'set-broadcast-sources', values => ({ layout: entity, slots: Array.from({ length: entity === 'qualifier' ? 3 : 2 }, (_, i) => ({ capture: values[`source-capture-${i}`], handcam: values[`source-handcam-${i}`] })) }), { guard() { if (scope !== sourceScope()) throw new Error('当前选手或显示模式已变化，来源草稿未提交，请重新核对。'); } }).then(() => { render(); toast('来源名称已保存，请核对实际 OBS 画面。'); }).catch(() => {});
    if (form.id === 'restore-form') restoreBackup(scope).catch(error => toast(error.code === 'STALE' ? '预览已过期，理由草稿已保留，请重新查看摘要。' : error.message, true));
    if (form.id === 'correction-form') reopenResult(scope).catch(error => toast(error.message, true));
    if (form.id === 'event-form') draftForm(scope, 'set-event', values => Object.fromEntries(Object.keys(state.event).filter(key => values[`event-${key.replace('ZH', '-zh')}`] !== undefined).map(key => [key, values[`event-${key.replace('ZH', '-zh')}`]]))).then(() => { toast('赛事资料已保存'); render(); }).catch(() => {});
    if (form.id === 'group-songs-form') draftForm(scope, 'set-qualifier-songs', values => ({ group: entity, ids: Array.from({ length: 3 }, (_, i) => values[`group-song-${i}`]) })).then(() => toast('组别曲目已保存')).catch(() => {});
    if (form.id === 'roster-form') { if (confirm('更新此组名单？未改名选手会保留分数；新增或删除会改变参赛名单。修改显示名称请使用下方独立改名功能。')) draftForm(scope, 'set-roster', values => ({ group: entity, names: values.roster.split('\n') })).catch(() => {}); }
    if (form.id === 'seed-form') { if (confirm('按这八个种子创建或替换尚未开始的赛程？')) draftForm(scope, 'seed-bracket', values => ({ ids: Array.from({ length: 8 }, (_, i) => values[`seed-${i}`] || null), verified: true, note: values['seed-note'] }), { guard() { if (entity !== encodeURIComponent(seedContext(state))) throw new Error('比赛方案或晋级名单已变化，请重新核对手动种子。'); } }).catch(() => {}); }
    if (form.id === 'result-form') confirmResult(scope).catch(error => toast(error.message, true));
    if (form.id === 'final-candidates-form') draftForm(scope, 'set-final-candidates', values => ({ matchId: entity, ids: Array.from({ length: finalCount(state.tournament.matches.find(m => m.id === entity)) }, (_, i) => values[`final-candidate-${i}`]) })).catch(() => {});
    if (form.id === 'final-picks-form') draftForm(scope, 'set-final-picks', values => ({ matchId: entity, audienceIds: [values['audience-1'], values['audience-2']], hostId: values['host-pick'] })).catch(() => {});
    if (form.id === 'song-form') draftForm(scope, 'upsert-song', values => ({ song: { id: entity === 'new' ? null : entity, title: values['song-title'], artist: values['song-artist'], difficulty: values['song-difficulty'], level: Math.trunc(Number(values['song-level'])), art: values['song-art'], previewAudio: values['song-preview-audio'], eligible: values['song-eligible'] } })).then(() => { toast('曲目已保存'); editingSongId = null; render(); }).catch(() => {});
  });
  if (token) connect(); else { $('pairing').hidden = false; $('connection').innerHTML = '<span class="dot"></span>Pair this device'; }
})();
