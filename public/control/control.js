(function () {
  const B = Broadcast, e = B.escape, $ = id => document.getElementById(id);
  let state, socket, activeTab = 'broadcast', connections = { overlays: 0, controls: 0 }, focusSongId, editingSongId = null;
  let queue = Promise.resolve(), toastTimer, token = sessionStorage.getItem('broadcast-token');
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
  const playerOptions = (selected, group, blank = true) => options(state.qualifier.players.filter(p => !group || p.group === group).map(p => [p.id, p.name]), selected, blank);
  const songOptions = (selected, pool = state.library) => options(pool.map(s => [s.id, `${s.title} / ${s.difficulty} ${s.level}`]), selected);
  const heading = (tag, title, description, action = '') => `<div class="page-heading"><div><div class="eyebrow">${tag}</div><h1>${title}</h1><p>${description}</p></div>${action ? `<div class="heading-action">${action}</div>` : ''}</div>`;
  const matchActions = new Set(['draw-candidates', 'ban-song', 'pick-songs', 'set-final-candidates', 'set-final-picks', 'reveal-host-song', 'set-song-progress', 'set-match-score', 'record-result', 'record-bye', 'lottery-bye', 'reset-current-match']);
  const drafts = new Map();
  const valueOf = el => el.type === 'checkbox' ? el.checked : el.value;
  const normal = (record, value) => typeof value === 'boolean' ? value : record.numeric && value !== '' ? String(Number(value)) : String(value ?? '').trim();
  const equal = (record, a, b) => normal(record, a) === normal(record, b);
  const draftKey = el => el.dataset.draftScope ? `${el.dataset.draftScope}|${el.id}` : null;
  const matchContext = (s, id) => { const m = s.tournament.matches.find(item => item.id === id); return JSON.stringify([m?.players, m?.songs.map(song => song.id), m?.candidates.map(song => song.id)]); };
  const qualifierContext = (s, id) => { const p = B.player(s, id); return JSON.stringify([p?.group, s.qualifier.groups[p?.group]?.songs]); };
  const sourceContext = (s = state) => { const status = s.broadcast?.sourceStatus; return JSON.stringify([status?.layout, status?.layout === 'qualifier' ? s.qualifier.activeGroup : s.tournament.currentMatchId, status?.showHandcams, status?.slots.map(slot => [slot.playerId, slot.playerName])]); };
  const sourceScope = (s = state) => `sources:${s.broadcast?.sourceStatus?.layout}:${encodeURIComponent(sourceContext(s))}`;
  function formScope(form) {
    const group = state.qualifier.activeGroup, match = state.tournament.currentMatchId;
    const signature = encodeURIComponent(matchContext(state, match));
    if (form.dataset.renamePlayer) return `rename:${form.dataset.renamePlayer}`;
    return ({ 'event-form': 'event', 'song-form': `song:${editingSongId || 'new'}`, 'group-songs-form': `group-songs:${group}`, 'roster-form': `roster:${group}`, 'seed-form': 'seeds', 'result-form': `result:${match}:${signature}`, 'final-candidates-form': `candidates:${match}:${signature}`, 'final-picks-form': `picks:${match}:${signature}`, 'source-form': sourceScope(), 'restore-form': `restore:${selectedBackupId}`, 'correction-form': `correction:${correctionMatchId}` })[form.id];
  }
  function formValues(scope, s = state) {
    const [kind, entity] = scope.split(':');
    const m = s.tournament.matches.find(match => match.id === entity);
    if (kind === 'event') return Object.fromEntries(Object.entries(s.event).map(([key, value]) => [`event-${key.replace('ZH', '-zh')}`, value]));
    if (kind === 'song') {
      const song = s.library.find(item => item.id === entity);
      return { 'song-title': song?.title || '', 'song-artist': song?.artist || '', 'song-difficulty': song?.difficulty || 'IN', 'song-level': String(song?.level ?? 15), 'song-art': song?.art || 'assets/song/cover-1.svg', 'song-eligible': song?.eligible !== false };
    }
    if (kind === 'group-songs') return Object.fromEntries(s.qualifier.groups[entity].songs.map((id, i) => [`group-song-${i}`, id]));
    if (kind === 'roster') return { roster: s.qualifier.players.filter(p => p.group === entity).map(p => p.name).join('\n') };
    if (kind === 'seeds') {
      const seeds = s.tournament.seeded ? s.tournament.seeds : Array.from({ length: 4 }, (_, i) => [B.rankings(s, 'A')[i]?.id || null, B.rankings(s, 'B')[i]?.id || null]).flat();
      return Object.fromEntries(seeds.map((id, i) => [`seed-${i}`, id || '']));
    }
    if (kind === 'result') return { 'referee-winner': '', 'result-note': '' };
    if (kind === 'special') return { 'draw-winner': '', 'bye-note': '' };
    if (kind === 'candidates') return Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`final-candidate-${i}`, m?.candidates[i]?.id || s.library[i]?.id || '']));
    if (kind === 'picks') return { 'audience-1': m?.audiencePicks[0] || m?.candidates[0]?.id || '', 'audience-2': m?.audiencePicks[1] || m?.candidates[1]?.id || '', 'host-pick': m?.hostPick?.id || m?.candidates[2]?.id || '' };
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
      if (el.dataset.matchScore !== undefined) {
        const matchId = el.dataset.matchId, pi = Number(el.dataset.matchScore), si = Number(el.dataset.songIndex);
        scope = `match-score:${matchId}:${encodeURIComponent(matchContext(state, matchId))}`; read = s => String(s.tournament.matches.find(m => m.id === matchId)?.scores[pi][si] ?? '');
      } else if (el.dataset.qualifierScore) {
        const id = el.dataset.qualifierScore, si = Number(el.dataset.songIndex);
        scope = `qualifier-score:${id}:${encodeURIComponent(qualifierContext(state, id))}`; read = s => String(B.player(s, id)?.scores[si] ?? '');
      } else if (el.dataset.tiePlayer) {
        const id = el.dataset.tiePlayer; scope = `tie:${id}`; read = s => String(B.player(s, id)?.tiePriority ?? '');
      } else if (['draw-winner', 'bye-note'].includes(el.id)) {
        const matchId = state.tournament.currentMatchId, id = el.id;
        scope = `special:${matchId}:${encodeURIComponent(matchContext(state, matchId))}`; read = s => formValues(scope, s)[id];
      } else if (el.dataset.activeSlot !== undefined || el.hasAttribute('data-qualifier-progress')) {
        const group = state.qualifier.activeGroup;
        scope = `qualifier-display:${group}`;
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
      if (kind === 'qualifier-score' && encodeURIComponent(qualifierContext(state, id)) !== signature) { record.conflict = true; continue; }
      if (kind === 'qualifier-display' && state.qualifier.activeGroup !== id) { record.conflict = true; continue; }
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
    notice._conflictKeys = conflicts.map(record => record.key);
    const display = value => e(String(value ?? '空值').slice(0, 160));
    notice.innerHTML = `<strong>${conflicts.length ? '编辑冲突 · 草稿已保留' : '未提交草稿'}</strong><p>${drafts.size} 个字段尚未提交。${conflicts.length ? '其他操作员修改了其中 ' + conflicts.length + ' 个字段；请核对以下差异后再提交。' : '切换标签页或收到实时更新时会保留草稿。'}</p>${conflicts.length ? `<ul class="draft-conflicts">${conflicts.map(record => `<li><strong>${e(record.scope.split(':').slice(0, 2).join(' · '))} · ${e(record.label.slice(0, 100))}</strong><span>服务器：${display(record.read(state))}</span><span>保留草稿：${display(record.value)}</span></li>`).join('')}</ul><div class="form-actions">${button('采用以上服务器版本', 'data-draft-resolution="server"')}${button('保留以上草稿并重新确认', 'data-draft-resolution="review"')}</div>` : ''}`;
  }
  async function confirmResult(scope) {
    const id = scope.split(':')[1]; await queue;
    if (state.tournament.currentMatchId !== id || encodeURIComponent(matchContext(state, id)) !== scope.split(':')[2]) throw new Error('当前场次、选手或曲目已变化，请重新核对赛果。');
    const m = state.tournament.matches.find(match => match.id === id);
    if (!m?.scores.flat().every(score => score !== null)) throw new Error('请先保存双方所有曲目的分数。');
    const revision = state.revision, values = { ...formValues(scope), ...Object.fromEntries(snapshotDrafts(scope).map(item => [item.record.id, item.value])) };
    const totals = m.scores.map(B.total), winner = totals[0] === totals[1] ? values['referee-winner'] : m.players[totals[0] > totals[1] ? 0 : 1];
    if (!winner) throw new Error('平分时请先选择裁判判定的获胜者并填写理由。');
    if (!confirm(`确认场次 ${id} / R${m.round}\n${B.name(state, m.players[0])}：${B.score(totals[0])}\n${B.name(state, m.players[1])}：${B.score(totals[1])}\n获胜者：${B.name(state, winner)}\n确认后推进赛程。`)) return;
    return draftForm(scope, 'record-result', fields => ({ matchId: id, tieWinnerId: fields['referee-winner'] || null, note: fields['result-note'] }), { expectedRevision: revision });
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
    if (!confirm(`恢复备份版本 ${preview.backup.revision}\n${preview.backup.event.title}\n已完成 ${preview.backup.completedMatches} 场，双淘汰已记 ${preview.backup.matchScoredSlots} 个分数\n将替换当前赛事版本 ${preview.revision}，当前版本会自动备份。\n理由：${reason}`)) return;
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
    if (socket) socket.disconnect();
    socket = createBroadcastSocket('/control', { token });
    socket.on('connect', () => { $('pairing').hidden = true; $('workspace').hidden = false; controlStatus(true); });
    socket.on('state', next => { state = next; render(); $('sync-status').textContent = `Saved · revision ${next.revision}`; });
    socket.on('connections', next => { connections = next; refreshConnections(); });
    socket.on('disconnect', () => controlStatus(false));
    socket.on('connect_error', error => {
      controlStatus(false);
      if (error.message === 'PAIRING_REQUIRED') { socket.disconnect(); token = null; sessionStorage.removeItem('broadcast-token'); $('workspace').hidden = true; $('pairing').hidden = false; $('connection').innerHTML = '<span class="dot"></span>Pair this device'; }
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
    if ($('crew-count')) $('crew-count').textContent = `${connections.controls} control device${connections.controls === 1 ? '' : 's'}`;
  }
  function sourcePanel() {
    const status = state.broadcast?.sourceStatus;
    if (!status) return '<section class="panel broadcast-sources-panel"><h2>OBS 来源人工核对</h2><p class="secondary">等待来源状态。</p></section>';
    const dirty = [...drafts.values()].some(record => record.scope === sourceScope());
    return `<section class="panel broadcast-sources-panel"><div class="section-heading"><div><h2>OBS 来源人工核对</h2><p class="secondary">只记录工作人员的人工检查；不连接 OBS，也不验证实际视频。</p></div><strong class="source-check-status ${status.confirmed ? 'checked' : 'unchecked'}" data-confirmed="${status.confirmed}">${status.confirmed ? '已人工核对' : '尚未核对'}</strong></div><form id="source-form"><div class="source-slot-grid">${status.slots.map(slot => `<fieldset><legend>位置 ${slot.index + 1} · ${e(slot.playerName || '空位')}</legend><label for="source-capture-${slot.index}">擷取卡来源名称<input id="source-capture-${slot.index}" value="${e(slot.capture)}" maxlength="80" placeholder="OBS 内的来源名称"></label><label for="source-handcam-${slot.index}">手元来源名称${status.showHandcams ? '（必填）' : '（单画面可留空）'}<input id="source-handcam-${slot.index}" value="${e(slot.handcam)}" maxlength="80"></label></fieldset>`).join('')}</div><div class="form-actions">${button('保存来源名称', 'type="submit"')}${button('已查看实际 OBS 画面，人工核对并确认', `type="button" data-confirm-sources ${dirty ? 'disabled' : ''}`)}</div></form><p class="secondary">请先保存名称，再在实际 OBS 中逐一检查当前选手与来源。选手、场次、名字或显示模式变化后需要重新核对。${status.confirmedAt ? '上次人工核对：' + e(new Date(status.confirmedAt).toLocaleString('zh-HK')) : ''}</p></section>`;
  }
  function renamePlayers() {
    return `<section class="panel rename-panel"><details id="rename-details"><summary>修改显示名称 · 保留选手 ID 与成绩</summary><p class="secondary">改名不会重新创建选手，不改变分组、种子、已记分或赛果。</p><div class="rename-grid">${state.qualifier.players.filter(p => p.group === state.qualifier.activeGroup).map(p => `<form id="rename-form-${e(p.id)}" data-rename-player="${e(p.id)}"><label for="rename-name-${e(p.id)}">${e(p.name)}<input id="rename-name-${e(p.id)}" value="${e(p.name)}" maxlength="48" required></label>${button('保存名称', 'type="submit"')}</form>`).join('')}</div></details></section>`;
  }
  const actionLabels = {
    'set-event': '修改赛事资料', 'set-scene': '切换直播场景', 'set-stage': '切换赛事阶段',
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
  function operationsPanel() {
    const completed = state.tournament.matches.filter(m => m.status === 'complete');
    const correction = correctionPreview?.matchId === correctionMatchId ? correctionPreview : null;
    const restoration = backupPreview?.backup.id === selectedBackupId ? backupPreview : null;
    const correctionStale = correction && correction.revision !== state.revision, restoreStale = restoration && restoration.revision !== state.revision;
    return `<section class="panel operations-panel"><div class="section-heading"><div><h2>赛果纠错与备份恢复</h2><p class="secondary">先查看具体影响，再填写理由并确认。期间有新操作时必须重新预览。</p></div>${button('刷新备份列表', 'data-load-backups')}</div><div class="operations-grid"><section><h3>已完成场次纠错</h3><label for="correction-match">需要重新打开的场次<select id="correction-match">${options(completed.map(m => [m.id, `${m.id} · ${m.label}`]), correctionMatchId)}</select></label><div class="form-actions">${button('查看纠错影响', `data-preview-correction ${correctionMatchId ? '' : 'disabled'}`)}</div>${correction ? `<div class="impact-summary"><p>预览版本 ${correction.revision} · 场次 ${e(correctionMatchId)}</p>${correctionStale ? '<strong data-preview-stale>预览已过期，请重新查看影响；理由草稿保留。</strong>' : ''}${correction.impact.blockedReason ? `<p class="error">${e(correction.impact.blockedReason)}</p>` : ''}<p>本场保留曲目及分数并重新开放。下游需要重新进行：</p><ul>${correction.impact.affectedMatches.map(m => `<li>${e(m.id)} · ${e(m.label)}${m.hasResult ? ' · 已有赛果' : m.hasScores ? ' · 已有记分' : m.hasStartedSelection || m.hasOverride ? ' · 已有选曲或抽签' : ' · 尚未开始'}</li>`).join('') || '<li>没有下游场次</li>'}</ul></div><form id="correction-form"><label for="correction-reason">纠错理由<textarea id="correction-reason" maxlength="240" required></textarea></label>${correction.impact.requiresConfirmation ? '<label class="checkbox-label"><input id="correction-confirm-clear" type="checkbox">我已核对并同意清除以上下游场次的选曲、记分、抽签及赛果</label>' : ''}<div class="form-actions">${button('按上述影响重新打开赛果', `type="submit" ${correctionStale || correction.impact.blockedReason ? 'disabled' : ''}`)}</div></form>` : '<p class="secondary">查看影响后才可操作。</p>'}</section><section><h3>恢复自动备份</h3><label for="backup-id">备份<select id="backup-id">${options(backupList.map(b => [b.id, `版本 ${b.revision} · ${b.completedMatches} 场完成 · ${new Date(b.createdAt).toLocaleString('zh-HK')}`]), selectedBackupId)}</select></label><div class="form-actions">${button('查看恢复摘要', `data-preview-backup ${selectedBackupId ? '' : 'disabled'}`)}</div>${restoration ? `<div class="impact-summary"><p>${e(restoration.backup.event.title)} · ${e(restoration.backup.event.date)} · ${e(restoration.backup.event.venue)}</p><p>当前赛事版本 ${restoration.revision} → 备份版本 ${restoration.backup.revision}</p><p>已完成 ${restoration.backup.completedMatches} 场；预选赛 ${restoration.backup.qualifierScoredSlots} 个分数；双淘汰 ${restoration.backup.matchScoredSlots} 个分数。</p><p>备份赛果：${e(restoration.backup.matchResults.map(m => m.matchId).join(', ') || '无')}</p>${restoreStale ? '<strong data-preview-stale>预览已过期，请重新查看摘要；理由草稿保留。</strong>' : ''}<p>恢复会替换整个赛事状态；恢复前会自动保留当前版本。</p></div><form id="restore-form"><label for="restore-reason">恢复理由<textarea id="restore-reason" maxlength="500" required></textarea></label><div class="form-actions">${button('确认恢复此备份', `type="submit" ${restoreStale ? 'disabled' : ''}`)}</div></form>` : `<p class="secondary">${backupsLoaded ? '选取备份并查看摘要后才可恢复。' : '点击刷新备份列表。'}</p>`}</section></div><details id="audit-details"><summary>最近操作记录</summary><ol class="audit-list">${(state.auditLog || []).slice(-10).reverse().map(item => `<li><time>${e(new Date(item.at).toLocaleString('zh-HK'))}</time> · 版本 ${item.revision} · ${e(actionLabels[item.type] || item.type)}${item.reason ? `<p>${e(item.reason)}</p>` : ''}</li>`).join('') || '<li>尚无操作记录</li>'}</ol></details></section>`;
  }
  function broadcast() {
    const selected = B.scenes.find(s => s[0] === state.scene), m = B.currentMatch(state), q = state.qualifier;
    const showHandcams = state.broadcast?.showHandcams === true;
    return heading('CONTROL ROOM / 直播控制', 'Your next moment, on air.', 'Manage the show. Keep the rhythm moving.', `<span class="pill"><span>${state.stage === 'qualifier' ? 'QUALIFIERS' : 'DOUBLE ELIMINATION'}</span></span>`) +
      `<section class="panel broadcast-display-panel"><div class="section-heading"><div><h2>畫面顯示</h2><p class="secondary">每位選手的直播畫面</p></div></div><div class="display-mode-buttons" role="group" aria-label="選手畫面顯示模式">${button('<strong class="display-mode-title">單畫面</strong><span class="display-mode-description">擷取卡主畫面</span>', `data-broadcast-handcams="false" class="display-mode-button ${showHandcams ? '' : 'selected'}" aria-pressed="${!showHandcams}"`, !showHandcams)}${button('<strong class="display-mode-title">雙畫面</strong><span class="display-mode-description">擷取卡主畫面 + 手元小窗</span>', `data-broadcast-handcams="true" class="display-mode-button ${showHandcams ? 'selected' : ''}" aria-pressed="${showHandcams}"`, showHandcams)}</div><p class="secondary">先在 OBS 擺好擷取卡與手元來源，將網頁 Layout 放在最上層。切換後，網頁即時顯示或隱藏手元小窗。</p></section>` +
      `<div class="broadcast-grid"><section class="preview-panel"><div class="panel-header"><h2>Program preview</h2><span class="on-air"><i class="dot"></i>LIVE STATE</span></div><div class="preview-shell" id="preview-container"></div><div class="preview-caption"><span>1920 × 1080 · transparent overlay</span><a href="../overlay/live.html" target="_blank" rel="noopener">Open overlay ${B.icon('next')}</a></div><div class="status-strip"><div class="status-cell"><span class="micro">Current stage</span><strong>${state.stage === 'qualifier' ? 'Qualifiers' : 'Double elimination'}</strong><small>${state.stage === 'qualifier' ? 'Group ' + q.activeGroup : m ? `R${m.round} · ${m.bracket}` : 'Awaiting seeding'}</small></div><div class="status-cell"><span class="micro">Current match</span><strong>${state.stage === 'qualifier' ? `${q.activePlayers.length} players` : m?.id || '—'}</strong><small>${state.stage === 'qualifier' ? 'Three-player layout' : m?.label || 'Eight qualifying seeds'}</small></div><div class="status-cell"><span class="micro">Song progress</span><strong>${state.stage === 'qualifier' ? q.currentSong + 1 + ' / 3' : m ? `${m.currentSong + 1} / ${m.id === 'GF' ? 3 : 2}` : '—'}</strong><small>${e(state.stage === 'qualifier' ? B.song(state, q.groups[q.activeGroup].songs[q.currentSong])?.title : m?.songs[m.currentSong]?.title || 'Awaiting selection')}</small></div></div><div class="current-bar"><div><span class="micro">On air now</span><h3>${e(selected[1])}</h3><p>${e(state.event.title)} · ${e(state.event.venue)}</p></div><div>${button('Edit match ' + B.icon('next'), `data-tab="${state.stage === 'qualifier' ? 'qualifiers' : 'bracket'}"`)}</div></div></section><aside class="panel"><div class="panel-header"><h2>Scenes <span class="secondary">畫面</span></h2><span class="micro">${String(B.scenes.findIndex(s => s[0] === state.scene) + 1).padStart(2, '0')} / 08</span></div><div class="scene-list">${B.scenes.map(([id, title, zh], i) => `<button class="scene-button" data-scene="${id}" aria-pressed="${id === state.scene}"><span class="scene-number">${String(i + 1).padStart(2, '0')}</span><span><span class="scene-name">${title}</span><small>${zh}</small></span><span class="scene-arrow">${id === state.scene ? '●' : B.icon('next')}</span></button>`).join('')}</div><div class="scene-section-note"><div id="overlay-count">Overlay status</div><div id="crew-count" style="margin-top:5px">Control devices</div><div style="margin-top:10px">OBS WebSocket · not configured</div></div></aside></div>` + sourcePanel();
  }
  function qualifiers() {
    const q = state.qualifier, group = q.activeGroup, players = B.rankings(state, group), groupSongs = q.groups[group].songs.map(id => B.song(state, id));
    const locked = state.tournament.seeded ? 'disabled' : '';
    return heading('QUALIFIERS / 預選賽', `Group ${group}. Every point counts.`, 'Three songs per group. The top four advance.', `<div class="group-switch">${['A', 'B'].map(g => `<button class="phi-surface ${g === group ? 'selected' : ''}" data-group="${g}">Group ${g}</button>`).join('')}</div>`) +
      `<div class="section-grid"><section class="panel"><div class="section-heading"><div><h2>On-stage players</h2><p class="secondary">選擇三位同場選手</p></div>${button('Show match ↗', 'data-scene="qualifier-match"', true)}</div><div class="field-grid three">${Array.from({ length: 3 }, (_, i) => `<label for="active-${i}">Slot ${i + 1}<select id="active-${i}" data-active-slot="${i}">${playerOptions(q.activePlayers[i], group)}</select></label>`).join('')}</div><label for="qualifier-progress" style="margin-top:20px">Current song<select id="qualifier-progress" data-qualifier-progress>${groupSongs.map((s, i) => `<option value="${i}" ${i === q.currentSong ? 'selected' : ''}>SONG ${i + 1} · ${e(s?.title)}</option>`).join('')}</select></label></section><section class="panel"><div class="section-heading"><div><h2>Group song set</h2><p class="secondary">兩組使用不同的三首曲目</p></div></div><form id="group-songs-form"><div class="field-grid three">${q.groups[group].songs.map((id, i) => `<label for="group-song-${i}">Song ${i + 1}<select id="group-song-${i}" ${locked}>${songOptions(id)}</select></label>`).join('')}</div><div class="form-actions">${button('Save song set', `type="submit" ${locked}`)}<span class="secondary">Locked after scoring begins.</span></div></form></section></div>` +
      `<section class="panel" style="margin-top:26px"><div class="section-heading"><div><h2>Scores & standings</h2><p class="secondary">分數變更會即時儲存及同步</p></div>${button('Advance top four ' + B.icon('next'), `data-command="qualify" ${locked}`, true)}</div>${locked ? '<div class="notice">Qualifier results are locked. The bracket has been seeded.</div>' : ''}<div class="score-table-wrap"><table class="score-table"><thead><tr><th>RANK</th><th>PLAYER</th>${groupSongs.map((s, i) => `<th>SONG ${i + 1}<div class="song-caption" title="${e(s?.title)}">${e(s?.title)}</div></th>`).join('')}<th>TOTAL</th><th>TIE ORDER</th></tr></thead><tbody>${players.map(p => `<tr><td class="rank ${p.rank <= 4 ? 'advances' : ''}">${p.tied ? '=' : ''}${p.rank}</td><td class="player-name">${e(p.name)}<div class="song-caption">${p.scores.every(n => n !== null) ? p.rank <= 4 ? 'QUALIFYING POSITION' : 'COMPLETE' : 'SCORES INCOMPLETE'}</div></td>${p.scores.map((n, i) => `<td><input id="qs-${e(p.id)}-${i}" type="number" inputmode="numeric" min="0" max="1000000" step="1" value="${n ?? ''}" placeholder="—" aria-label="${e(p.name)} song ${i + 1} score" data-qualifier-score="${e(p.id)}" data-song-index="${i}" ${locked}></td>`).join('')}<td class="total">${B.score(p.total)}</td><td><input class="priority" id="tie-${e(p.id)}" type="number" min="1" max="64" value="${p.tiePriority ?? ''}" placeholder="—" aria-label="${e(p.name)} tie priority" data-tie-player="${e(p.id)}" ${locked}></td></tr>`).join('')}</tbody></table></div><p class="secondary" style="margin-top:16px">For equal totals, enter unique tie priorities (1 goes first). Seeds alternate A1, B1, A2, B2…; manual seeding is available in Bracket.</p><details id="roster-details"><summary>Player roster & random grouping <span class="secondary">選手名單與隨機分組</span></summary><form id="roster-form"><label for="roster">Group ${group} players <span>One name per line / 每行一位選手</span><textarea id="roster" ${locked}>${e(q.players.filter(p => p.group === group).map(p => p.name).join('\n'))}</textarea></label><div class="form-actions">${button('Update roster', `type="submit" ${locked}`)}${button('Randomise A / B', `type="button" data-command="randomise-groups" ${locked}`)}</div></form></details></section>` + renamePlayers();
  }
  function seedEditor() {
    const rankedA = B.rankings(state, 'A'), rankedB = B.rankings(state, 'B');
    const defaults = Array.from({ length: 4 }, (_, i) => [rankedA[i]?.id || null, rankedB[i]?.id || null]).flat();
    const seeds = state.tournament.seeded ? state.tournament.seeds : defaults;
    const locked = state.tournament.matches.some(m => m.status === 'complete' || m.scores.flat().some(n => n !== null));
    return `<form id="seed-form"><div class="notice">Manual seeding can bypass qualifier scoring. Leave a slot empty for a vacancy. First round: #1–#8, #4–#5, #2–#7, #3–#6.</div><div class="field-grid eight">${Array.from({ length: 8 }, (_, i) => `<label for="seed-${i}">Seed #${i + 1}<select id="seed-${i}" ${locked ? 'disabled' : ''}>${playerOptions(seeds[i])}</select></label>`).join('')}</div><div class="form-actions">${button(state.tournament.seeded ? 'Update seeds' : 'Create 14-match bracket', `type="submit" ${locked ? 'disabled' : ''}`, true)}</div></form>`;
  }
  function bracket() {
    const m = B.currentMatch(state), t = state.tournament;
    if (!m) return heading('DOUBLE ELIMINATION / 雙淘汰賽', 'Eight seeds. One champion.', 'Advance the qualifier winners, or enter seeds manually.') + `<section class="panel"><div class="section-heading"><h2>Set the starting field</h2></div>${seedEditor()}</section>`;
    const count = m.id === 'GF' ? 3 : 2, complete = m.status === 'complete', disabled = complete || m.status === 'pending' ? 'disabled' : '';
    let round = 0;
    return heading('DOUBLE ELIMINATION / 雙淘汰賽', 'The bracket, in motion.', 'Record each result to open the next matches.', button('Show bracket ↗', 'data-scene="bracket"', true)) +
      `<div class="section-grid"><section class="section-stack"><div class="panel"><div class="section-heading"><h2>Match schedule</h2><span class="micro">${t.matches.filter(x => x.status === 'complete').length} / 14 COMPLETE</span></div><div class="bracket-list">${t.matches.map(match => { const divider = match.round !== round ? `<div class="round-break">ROUND ${match.round}</div>` : ''; round = match.round; const targets = t.matches.filter(x => x.sources.some(y => y.type === 'winner' && y.value === match.id)).map(x => x.id).join(', '), loserTargets = t.matches.filter(x => x.sources.some(y => y.type === 'loser' && y.value === match.id)).map(x => x.id).join(', '); return divider + `<div class="match-row ${match.status}"><span class="match-id">${match.id}</span><div><h3>${e(match.label)}</h3><div class="versus-text">${match.players.map(id => id ? e(B.name(state, id)) : match.status === 'pending' ? 'TBD' : 'Vacant').join(' vs. ')}</div><div class="bracket-paths">${targets ? 'Winner → ' + targets : 'Winner → Champion'} · ${loserTargets ? 'Loser → ' + loserTargets : match.id === 'GF' ? 'Runner-up' : 'Loser eliminated'}</div></div><div>${['ready', 'live'].includes(match.status) ? button(match.status === 'live' ? 'Active' : 'Select', `data-match="${match.id}" class="btn-small"`, match.status === 'live') : `<span class="state-text">${match.status === 'complete' ? `${e(B.name(state, match.winnerId))}<br>${match.resultType.toUpperCase()}` : 'Waiting'}</span>`}</div></div>`; }).join('')}</div></div><div class="panel"><details id="seed-details" style="margin-top:0;border-top:0;padding-top:0"><summary>Seeding & vacancies</summary>${seedEditor()}</details>${t.drawLog.length ? `<div class="notice">${t.drawLog.map(d => `DRAW · ${e(B.name(state, d.winnerId))} → ${e(d.target)} · ${e(d.note)}`).join('<br>')}</div>` : ''}</div></section><section class="section-stack"><div class="panel"><div class="match-header"><div><h2>R${m.round} — ${e(m.label)}</h2><p>${m.bracket} · ${m.status.toUpperCase()} · ${count} SONGS</p></div><span class="match-code">${m.id}</span></div><div class="score-entry">${m.players.map((id, pi) => `<div class="player-score"><h3>${e(B.name(state, id))}</h3><div class="player-meta">SEED #${id ? B.seed(state, id) : '—'} · ${B.losses(state, id)} LOSSES</div>${Array.from({ length: count }, (_, si) => `<label for="ms-${m.id}-${pi}-${si}">Song ${si + 1}<span>${e(m.songs[si]?.title || 'Awaiting song selection')}${m.id === 'GF' && si === 2 && !m.hostRevealed ? ' · PRIVATE' : ''}</span><input id="ms-${m.id}-${pi}-${si}" type="number" min="0" max="1000000" step="1" inputmode="numeric" placeholder="—" value="${m.scores[pi][si] ?? ''}" data-match-score="${pi}" data-song-index="${si}" data-match-id="${m.id}" ${disabled || !id || m.songs.length !== count || m.id === 'GF' && si === 2 && !m.hostRevealed ? 'disabled' : ''}></label>`).join('')}<div class="total-band"><span class="micro">Total</span><strong>${B.score(B.total(m.scores[pi]))}</strong></div></div>`).join('')}</div><div class="progress-buttons">${Array.from({ length: count }, (_, i) => button(`SONG ${i + 1} / ${count}`, `data-song-progress="${i}" ${disabled || !m.songs[i] || m.id === 'GF' && i === 2 && !m.hostRevealed ? 'disabled' : ''}`, i === m.currentSong)).join('')}</div><div class="form-actions">${button('Select songs ' + B.icon('next'), 'data-tab="songs"')}${button('Show match ↗', 'data-scene="double-elimination-match"', true)}</div><details id="result-details"><summary>Record result <span class="secondary">確認賽果並推進賽程</span></summary><form id="result-form"><label for="referee-winner">Referee winner (only for tied totals)<select id="referee-winner" ${disabled}>${options(m.players.filter(Boolean).map(id => [id, B.name(state, id)]))}</select></label><label for="result-note" style="margin-top:16px">Adjudication note <span>Required for a tie / 平分時必填</span><textarea id="result-note" class="report-note" ${disabled}></textarea></label><div class="form-actions">${button('Confirm result & advance', `type="submit" ${disabled}`, true)}</div></form></details><details id="special-details"><summary>Vacancy, bye & lottery <span class="secondary">輪空與抽籤</span></summary><label for="draw-winner">Lottery winner <span>Leave empty for a random draw among the three eligible players.</span><select id="draw-winner" ${disabled}>${options(t.seeds.filter(Boolean).map(id => [id, B.name(state, id)]))}</select></label><label for="bye-note" style="margin-top:16px">Record note<input id="bye-note" placeholder="Vacant slot / lottery record" ${disabled}></label><div class="form-actions">${button('Record vacant-match bye', `data-bye ${disabled}`)}${button('Draw four-player bye', `data-lottery ${disabled}`)}</div><p class="secondary">Lottery is available in a four-player entry field with three players and one vacancy, before either match is scored. The other two players remain paired.</p></details><div class="form-actions" style="border-top:1px solid #2e3d49;padding-top:20px">${button('Reset current match', `data-reset class="danger" ${disabled}`)}</div></div></section></div>`;
  }
  function songSelection() {
    const m = B.currentMatch(state);
    if (!m) return heading('SONG SELECTION / 選曲', 'Build the field first.', 'Seed the bracket and select a match to begin.', button('Go to bracket →', 'data-tab="bracket"', true));
    const gf = m.id === 'GF', done = m.status === 'complete' || m.status === 'pending', disabled = done ? 'disabled' : '';
    const focus = m.candidates.find(s => s.id === focusSongId) || m.songs[m.currentSong] || m.candidates[0];
    return heading(`SONG SELECTION / ${m.id} · R${m.round}`, gf ? 'The final has its own rhythm.' : 'Draw. Ban. Let fate decide.', gf ? 'Eight candidates. Two audience choices. One MC selection.' : 'Six candidates. One ban per player. Two random match songs.', button('Show selection ↗', 'data-scene="song-selection"', true)) +
      `${done ? '<div class="notice">This match is locked. Select a ready match in Bracket.</div>' : ''}<div class="song-grid"><section><div class="panel-header"><h2>${gf ? 'Grand Finals candidates' : 'Candidate pool'}</h2><span class="micro">${m.candidates.length} / ${gf ? 8 : 6} SONGS</span></div>${!gf ? `<div class="form-actions" style="margin:0 0 18px">${button(m.candidates.length ? 'Redraw 6 candidates ' + B.icon('random') : 'Draw 6 candidates ' + B.icon('random'), `data-command="draw-candidates" ${disabled || m.scores.flat().some(n => n !== null) ? 'disabled' : ''}`, true)}</div>` : ''}<div class="candidate-catalog">${m.candidates.map((song, i) => `<div class="candidate-row ${focus?.id === song.id ? 'focused' : ''} ${m.bans.includes(song.id) ? 'banned' : ''} ${m.songs.some(s => s.id === song.id) ? 'picked' : ''}" data-focus-song="${e(song.id)}"><span class="index">${String(i + 1).padStart(2, '0')}</span><div style="min-width:0"><button class="song-preview-button" data-focus-song="${e(song.id)}" aria-label="Preview ${e(song.title)}">${e(song.title)}</button><div class="song-info">${e(song.artist)} · ${e(song.difficulty)} ${e(song.level)}</div></div>${!gf ? `<div class="ban-actions">${m.players.map((id, pi) => `<button class="ban-button ${m.bans[pi] === song.id ? 'active' : ''}" data-ban-song="${e(song.id)}" data-ban-player="${pi}" aria-label="${e(B.name(state, id))} ban ${e(song.title)}" ${disabled || m.songs.length || m.bans[1 - pi] === song.id ? 'disabled' : ''}>P${pi + 1}<br>BAN</button>`).join('')}</div>` : '<span class="micro">CANDIDATE</span>'}</div>`).join('') || '<div class="panel"><p class="secondary">Candidates will appear here when the draw is ready.</p></div>'}</div>${gf ? `<details id="final-candidates" ${m.candidates.length ? '' : 'open'}><summary>Set eight candidates <span class="secondary">可包含常規曲庫以外曲目</span></summary><form id="final-candidates-form"><div class="field-grid">${Array.from({ length: 8 }, (_, i) => `<label for="final-candidate-${i}">Candidate ${i + 1}<select id="final-candidate-${i}" ${disabled}>${songOptions(m.candidates[i]?.id || state.library[i]?.id)}</select></label>`).join('')}</div><div class="form-actions">${button('Set eight candidates', `type="submit" ${disabled}`)}</div></form></details>` : `<div class="notice">P1 · ${e(B.name(state, m.players[0]))}<br>P2 · ${e(B.name(state, m.players[1]))}</div>`}</section><section><div class="song-focus"><div class="cover-window"><img src="../${e(focus?.art || 'assets/song/cover-1.svg')}" alt="${e(focus?.title || 'Tournament artwork')}"></div><div class="song-focus-title"><div style="min-width:0;flex:1"><h2>${e(focus?.title || 'Awaiting the draw.')}</h2><p>${e(focus?.artist || 'The next two songs start here.')}</p></div>${focus ? `<div class="difficulty-block"><b>${e(focus.level)}</b><span>${e(focus.difficulty)}</span></div>` : ''}</div></div><div class="panel"><div class="section-heading"><div><h2>Match songs</h2><p class="secondary">選曲結果自動寫入比賽畫面</p></div></div>${m.songs.length ? m.songs.map((song, i) => `<div class="selected-track"><span class="order">0${i + 1}</span><div><h3>${e(song.title)}</h3><small>${e(song.difficulty)} ${e(song.level)} · ${e(song.artist)}</small></div>${gf && i === 2 && !m.hostRevealed ? '<span class="locked-label">PRIVATE</span>' : ''}</div>`).join('') : '<p class="secondary">The final songs have not been selected.</p>'}${!gf ? `<div class="selection-progress" style="margin-top:22px"><div>P1 BAN <span>${m.bans[0] ? 'LOCKED' : 'PENDING'}</span></div><div>P2 BAN <span>${m.bans[1] ? 'LOCKED' : 'PENDING'}</span></div></div><div class="form-actions">${button('Draw 2 match songs ' + B.icon('random'), `data-command="pick-songs" ${disabled || m.songs.length || !m.bans.every(Boolean) ? 'disabled' : ''}`, true)}</div>` : `<form id="final-picks-form" style="margin-top:20px"><div class="field-grid"><label for="audience-1">Audience pick 1<select id="audience-1" ${disabled}>${songOptions(m.audiencePicks[0] || m.candidates[0]?.id, m.candidates)}</select></label><label for="audience-2">Audience pick 2<select id="audience-2" ${disabled}>${songOptions(m.audiencePicks[1] || m.candidates[1]?.id, m.candidates)}</select></label></div><div class="private-block"><h3>Private MC selection <span class="secondary">僅工作人員可見</span></h3><label for="host-pick">MC pick<select id="host-pick" ${disabled}>${songOptions(m.hostPick?.id || m.candidates[2]?.id, m.candidates)}</select></label></div><div class="form-actions">${button('Lock audience & MC picks', `type="submit" ${disabled || m.candidates.length !== 8 ? 'disabled' : ''}`, true)}</div></form><div class="form-actions">${button(m.hostRevealed ? 'MC song revealed' : 'Reveal MC song to broadcast', `data-reveal-host ${disabled || !m.hostPick || m.hostRevealed ? 'disabled' : ''}`)}</div>`}<div class="form-actions">${button('Enter scores →', 'data-tab="bracket"')}</div></div></section></div>`;
  }
  function eventSettings() {
    const song = state.library.find(s => s.id === editingSongId);
    return heading('EVENT & LIBRARY / 活動與曲庫', 'Make it your competition.', 'Event details and local song metadata, in one place.', button('Export state backup ' + B.icon('folder'), 'data-export')) +
      `<div class="section-grid"><section class="panel"><div class="section-heading"><div><h2>Event information</h2><p class="secondary">活動資訊</p></div></div><form id="event-form"><div class="field-grid"><label class="wide" for="event-title">Event name<input id="event-title" name="title" value="${e(state.event.title)}" maxlength="120" required></label><label class="wide" for="event-organiser">Organiser<input id="event-organiser" name="organiser" value="${e(state.event.organiser)}" maxlength="180"></label><label class="wide" for="event-organiser-zh">Organiser / 繁體中文<input id="event-organiser-zh" name="organiserZH" value="${e(state.event.organiserZH)}"></label><label for="event-date">Date<input id="event-date" name="date" type="date" value="${e(state.event.date)}" required></label><label for="event-time">Time<input id="event-time" name="time" value="${e(state.event.time)}"></label><label for="event-venue">Venue<input id="event-venue" name="venue" value="${e(state.event.venue)}" required></label><label for="event-message">Broadcast tagline<input id="event-message" name="message" value="${e(state.event.message)}"></label></div><div class="form-actions">${button('Save event information', 'type="submit"', true)}</div></form><label for="event-stage" style="margin-top:26px">Current stage<select id="event-stage" data-stage><option value="qualifier" ${state.stage === 'qualifier' ? 'selected' : ''}>Qualifiers</option><option value="double-elimination" ${state.stage === 'double-elimination' ? 'selected' : ''}>Double elimination</option></select></label></section><section class="panel"><div class="section-heading"><div><h2>Song library</h2><p class="secondary">本地曲庫 · ${state.library.length} songs</p></div>${button('New song +', 'data-new-song')}</div><p class="secondary">Sample song metadata is editable. Confirm the official event pool and levels before match day.</p><form id="song-form" style="margin-top:22px"><div class="field-grid"><label class="wide" for="song-title">Title<input id="song-title" value="${e(song?.title || '')}" required maxlength="100"></label><label class="wide" for="song-artist">Artist<input id="song-artist" value="${e(song?.artist || '')}" maxlength="100"></label><label for="song-difficulty">Difficulty<select id="song-difficulty">${options(['EZ', 'HD', 'IN', 'AT'].map(x => [x, x]), song?.difficulty || 'IN', false)}</select></label><label for="song-level">Level<input id="song-level" type="number" min="1" max="20" step="0.1" value="${song?.level ?? 15}" required></label><label class="wide" for="song-art">Local artwork path <span>Place artwork in public/assets/song/</span><input id="song-art" value="${e(song?.art || 'assets/song/cover-1.svg')}" required></label><label class="checkbox-label wide"><input id="song-eligible" type="checkbox" ${song?.eligible !== false ? 'checked' : ''}> Include in regular 6-song draws</label></div><div class="form-actions">${button(song ? 'Save song' : 'Add song', 'type="submit"', true)}${song ? '<span class="secondary">Existing match selections keep their original metadata.</span>' : ''}</div></form><div class="library-list">${state.library.map(s => `<div class="library-row"><div>${e(s.title)}<div class="secondary">${e(s.difficulty)} ${e(s.level)} · ${s.eligible ? 'REGULAR POOL' : 'FINALS ONLY'}</div></div><button data-edit-song="${e(s.id)}" aria-label="Edit ${e(s.title)}">Edit ↗</button></div>`).join('')}</div></section></div>` + operationsPanel();
  }
  const pages = { broadcast, qualifiers, bracket, songs: songSelection, event: eventSettings };
  function render() {
    if (!state) return;
    const active = document.activeElement;
    const focusAttributes = ['data-scene', 'data-focus-song', 'data-ban-song', 'data-ban-player', 'data-command', 'data-song-progress', 'data-broadcast-handcams'];
    const keyboardSelector = active?.tagName === 'BUTTON' ? focusAttributes.filter(key => active.hasAttribute(key)).map(key => `[${key}="${CSS.escape(active.getAttribute(key))}"]`).join('') : '';
    const focused = active && active.id && $('content').contains(active) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) ? { id: active.id, scope: active.dataset.draftScope, start: active.selectionStart, end: active.selectionEnd } : null;
    const openDetails = [...$('content').querySelectorAll('details[open][id]')].map(el => el.id);
    const previousArtWindow = $('content').querySelector('.cover-window');
    const previousSrc = previousArtWindow?.querySelector('img:not([data-motion-cover-old])')?.getAttribute('src');
    const previousFocus = $('content').querySelector('.candidate-row.focused')?.dataset.focusSong;
    const nextHTML = pages[activeTab]();
    const template = document.createElement('template'); template.innerHTML = nextHTML;
    reconcileDrafts(); prepareDrafts(template.content);
    const nextArtWindow = template.content.querySelector('.cover-window'), desiredCover = nextArtWindow?.querySelector('img');
    const requestedCover = desiredCover ? { src: desiredCover.getAttribute('src'), alt: desiredCover.getAttribute('alt') || '' } : null;
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
      const candidates = B.currentMatch(state)?.candidates || [];
      const nextFocus = $('content').querySelector('.candidate-row.focused')?.dataset.focusSong;
      const previousIndex = candidates.findIndex(s => s.id === previousFocus), nextIndex = candidates.findIndex(s => s.id === nextFocus);
      const direction = previousIndex >= 0 && nextIndex >= 0 && nextIndex < previousIndex ? -1 : 1;
      BroadcastMotion.coverSlide(artWindow, previousSrc, direction, requestedCover);
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
    refreshDraftNotice(); refreshConnections();
  }
  document.addEventListener('click', event => {
    const target = event.target.closest('button,[data-focus-song]'); if (!target || target.disabled || !state) return;
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
    if (target.dataset.group) { send('set-qualifier-display', { group: target.dataset.group }).catch(() => {}); return; }
    if (target.dataset.match) { send('select-match', { matchId: target.dataset.match }).catch(() => {}); return; }
    if (target.dataset.command) {
      const type = target.dataset.command;
      if (type === 'qualify' && !confirm('Lock qualifier results and seed the top four from each group?')) return;
      if (type === 'randomise-groups' && !confirm('Randomly redistribute all players between Groups A and B? This is only available before scoring.')) return;
      if (type === 'draw-candidates' && B.currentMatch(state)?.candidates.length && !confirm('Redraw candidates? Existing bans and picks will be cleared for this match.')) return;
      send(type).catch(() => {}); return;
    }
    if (target.dataset.banSong) { const m = B.currentMatch(state), pi = Number(target.dataset.banPlayer); send('ban-song', { playerIndex: pi, songId: m.bans[pi] === target.dataset.banSong ? null : target.dataset.banSong }).catch(() => {}); return; }
    if (target.dataset.focusSong) { focusSongId = target.dataset.focusSong; render(); return; }
    if (target.dataset.songProgress !== undefined) { send('set-song-progress', { index: Number(target.dataset.songProgress) }).catch(() => {}); return; }
    if (target.hasAttribute('data-reset')) { if (confirm('Reset songs, bans and scores for this unfinished match? Other matches and qualifier results are kept.')) send('reset-current-match').catch(() => {}); return; }
    if (target.hasAttribute('data-bye')) { const note = $('bye-note'), snapshot = snapshotDrafts([draftKey(note)]); if (confirm('Record this vacant match as a bye and advance its available player?')) send('record-bye', { note: note.value }, { snapshot }).catch(() => {}); return; }
    if (target.hasAttribute('data-lottery')) { const note = $('bye-note'), winner = $('draw-winner'), snapshot = snapshotDrafts([draftKey(note), draftKey(winner)]); if (confirm('Record a four-player vacancy lottery? The chosen player advances; the other two will play each other.')) send('lottery-bye', { playerId: winner.value || null, note: note.value }, { snapshot }).catch(() => {}); return; }
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
    if (form.dataset.renamePlayer) draftForm(scope, 'rename-player', values => ({ playerId: form.dataset.renamePlayer, name: values[`rename-name-${form.dataset.renamePlayer}`] })).then(() => { render(); toast('名称已修改，选手 ID 与成绩保留。'); }).catch(() => {});
    if (form.id === 'source-form') draftForm(scope, 'set-broadcast-sources', values => ({ layout: entity, slots: Array.from({ length: entity === 'qualifier' ? 3 : 2 }, (_, i) => ({ capture: values[`source-capture-${i}`], handcam: values[`source-handcam-${i}`] })) }), { guard() { if (scope !== sourceScope()) throw new Error('当前选手或显示模式已变化，来源草稿未提交，请重新核对。'); } }).then(() => { render(); toast('来源名称已保存，请核对实际 OBS 画面。'); }).catch(() => {});
    if (form.id === 'restore-form') restoreBackup(scope).catch(error => toast(error.code === 'STALE' ? '预览已过期，理由草稿已保留，请重新查看摘要。' : error.message, true));
    if (form.id === 'correction-form') reopenResult(scope).catch(error => toast(error.message, true));
    if (form.id === 'event-form') draftForm(scope, 'set-event', values => Object.fromEntries(Object.keys(state.event).map(key => [key, values[`event-${key.replace('ZH', '-zh')}`]]))).then(() => { toast('赛事资料已保存'); render(); }).catch(() => {});
    if (form.id === 'group-songs-form') draftForm(scope, 'set-qualifier-songs', values => ({ group: entity, ids: Array.from({ length: 3 }, (_, i) => values[`group-song-${i}`]) })).then(() => toast('组别曲目已保存')).catch(() => {});
    if (form.id === 'roster-form') { if (confirm('更新此组名单？未改名选手会保留分数；新增或删除会改变参赛名单。修改显示名称请使用下方独立改名功能。')) draftForm(scope, 'set-roster', values => ({ group: entity, names: values.roster.split('\n') })).catch(() => {}); }
    if (form.id === 'seed-form') { if (confirm('按这八个种子创建或替换尚未开始的赛程？')) draftForm(scope, 'seed-bracket', values => ({ ids: Array.from({ length: 8 }, (_, i) => values[`seed-${i}`] || null) })).catch(() => {}); }
    if (form.id === 'result-form') confirmResult(scope).catch(error => toast(error.message, true));
    if (form.id === 'final-candidates-form') draftForm(scope, 'set-final-candidates', values => ({ matchId: entity, ids: Array.from({ length: 8 }, (_, i) => values[`final-candidate-${i}`]) })).catch(() => {});
    if (form.id === 'final-picks-form') draftForm(scope, 'set-final-picks', values => ({ matchId: entity, audienceIds: [values['audience-1'], values['audience-2']], hostId: values['host-pick'] })).catch(() => {});
    if (form.id === 'song-form') draftForm(scope, 'upsert-song', values => ({ song: { id: entity === 'new' ? null : entity, title: values['song-title'], artist: values['song-artist'], difficulty: values['song-difficulty'], level: Number(values['song-level']), art: values['song-art'], eligible: values['song-eligible'] } })).then(() => { toast('曲目已保存'); editingSongId = null; render(); }).catch(() => {});
  });
  if (token) connect(); else { $('pairing').hidden = false; $('connection').innerHTML = '<span class="dot"></span>Pair this device'; }
})();
