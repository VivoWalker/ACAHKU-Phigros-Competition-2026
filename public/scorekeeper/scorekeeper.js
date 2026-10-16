(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const scoreText = value => value === null || value === undefined ? '—' : Number(value).toLocaleString('en-US');
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const judgementNames = ['accuracy', 'perfect', 'good', 'bad', 'miss'];
  const counterNames = judgementNames.slice(1);
  const snapshotValue = field => ({ score: field?.value ?? null, judgements: field?.judgements ?? null });
  const judgementRaw = value => Object.fromEntries(judgementNames.map(name => [name, value?.[name] === undefined || value?.[name] === null ? '' : String(value[name])]));
  const judgementText = (raw, statsOnly = false) => `${statsOnly ? '' : `ACC ${raw?.accuracy === undefined || raw?.accuracy === '' ? '—' : raw.accuracy}% · `}P/G/B/M ${counterNames.map(name => raw?.[name] === undefined || raw?.[name] === '' ? '—' : raw[name]).join('/')}`;
  const drafts = new Map(), fields = new Map(), revisionWaiters = new Set(), pendingCommands = new Set();
  const lifecycle = new AbortController(), listenerOptions = { signal: lifecycle.signal };
  let token = sessionStorage.getItem('scorekeeper-token'), socket, state, view, renderedSignature = '', connectionEpoch = 0, freshEpoch = -1;
  let saving = false, toastTimer, loginPending = false, disposed = false;

  function releasePending() {
    for (const waiter of revisionWaiters) { clearTimeout(waiter.timer); waiter.reject(new Error('連線中斷，草稿已保留。')); }
    revisionWaiters.clear();
    for (const pending of pendingCommands) pending.reject(new Error('未能確認保存結果，請重新連線後核對分數。'));
    pendingCommands.clear();
  }
  function disconnectSocket() {
    const previous = socket; socket = null; connectionEpoch++; freshEpoch = -1;
    previous?.removeAllListeners(); previous?.disconnect();
    releasePending();
  }
  function dispose() {
    if (disposed) return;
    disposed = true; lifecycle.abort(); clearTimeout(toastTimer); toastTimer = null;
    disconnectSocket();
    drafts.clear(); fields.clear(); state = view = token = null; renderedSignature = '';
  }

  function parseScore(raw, maximum = 1000000) {
    if (raw === '') return { valid: true, value: null };
    if (!/^\d{1,7}$/.test(raw)) return { valid: false };
    const value = Number(raw);
    return { valid: Number.isSafeInteger(value) && value <= maximum, value };
  }
  function parseEntry(raw, rawJudgements, field) {
    const parsed = parseScore(raw, field?.challengeTotal ? 3000000 : 1000000);
    if (field?.challengeResult) {
      if (!parsed.valid || parsed.value === null) return { valid: false, error: field.challengeTotal ? '請照錄遊戲三首結算總分：0–3,000,000 的整數；0 有效。' : '請填寫此曲 0–1,000,000 的整數分數；0 有效。' };
      if (field.challengeTotal) return { valid: true, value: { score: parsed.value, judgements: null } };
      if (counterNames.some(name => !/^\d+$/.test(rawJudgements?.[name] || '') || !Number.isSafeInteger(Number(rawJudgements[name])))) return { valid: false, error: '請完整填寫 Perfect / Good / Bad / Miss 的非負整數；0 有效。' };
      return { valid: true, value: { score: parsed.value, judgements: Object.fromEntries(counterNames.map(name => [name, Number(rawJudgements[name])])) } };
    }
    if (field?.scoreOnly) return parsed.valid ? { valid: true, value: { score: parsed.value, judgements: null } } : { valid: false, error: field.challengeTotal ? '請照錄遊戲 Challenge Mode 結算總分：0–3,000,000 的整數。' : '請輸入 0–1,000,000 的整數；不需逗號。' };
    if (!parsed.valid) return { valid: false, error: '請輸入 0–1,000,000 的整數；不需逗號。' };
    const metadata = rawJudgements || judgementRaw(null);
    if (judgementNames.every(name => metadata[name] === '')) return { valid: true, value: { score: parsed.value, judgements: null } };
    if (parsed.value === null) return { valid: false, error: '填寫判定或 ACC 前，請先填寫分數。' };
    if (!/^\d{1,3}(?:\.\d{1,8})?$/.test(metadata.accuracy || '') || Number(metadata.accuracy) > 100) return { valid: false, error: '請照成績頁填寫 0–100 的 Accuracy（%）；不會由判定數推算。' };
    const counters = judgementNames.slice(1), supplied = counters.filter(name => metadata[name] !== '');
    if (supplied.length && (supplied.length !== 4 || supplied.some(name => !/^\d+$/.test(metadata[name]) || !Number.isSafeInteger(Number(metadata[name]))))) return { valid: false, error: 'P / G / B / M 必須全部填寫非負整數，或全部留空。' };
    const value = { accuracy: Number(metadata.accuracy) };
    for (const name of supplied) value[name] = Number(metadata[name]);
    return { valid: true, value: { score: parsed.value, judgements: ScoreRules.normaliseJudgements(value) } };
  }
  function fieldKey(contextKey, kind, player, songIndex) { return JSON.stringify([contextKey, kind, player, songIndex]); }
  function currentView() {
    if (!state) return null;
    const qualifier = state.stage === 'qualifier', match = state.match;
    const group = state.qualifier?.activeGroup || '—';
    const base = qualifier ? state.qualifier : match, tie = base?.tiebreak, source = tie || base;
    const challenge = qualifier && base?.scoringMode === 'challenge-total', challengeTotal = challenge && !tie;
    const count = tie ? 1 : qualifier ? 3 : match?.songs?.length || (match?.id === 'GF' ? 3 : 2);
    const context = qualifier ? `預選賽 · ${base?.plan === 'A' ? group === 'A' ? '第一輪' : '復活輪' : `${group} 組`}` : match ? `${match.id} · ${match.label || '雙淘汰賽'}` : '等候主控設定場次';
    return {
      key: state.contextKey, kind: challengeTotal ? 'qualifier-challenge-result' : `${qualifier ? 'qualifier' : 'match'}${tie ? '-tiebreak' : ''}`, qualifier, tiebreak: !!tie, challenge, challengeTotal, count,
      title: `${context}${tie ? ` · 加賽 ${tie.index + 1}` : ''}`,
      description: challengeTotal ? `主控目前選定 ${group} 組 · 三首歌曲連續遊玩；完成後照結算畫面，填寫各曲分數、Perfect / Good / Bad / Miss 及遊戲總分。` : tie ? challenge ? '記錄本輪加賽分數；只比較分數，原有 Challenge 總分保持不變，賽果由主控確認。' : '記錄本輪加賽分數、成績頁 ACC 及判定；加賽分數不加入原有總分，賽果由主控確認。' : qualifier ? `主控目前選定 ${group} 組 · 比賽歌曲 ${Number(source?.currentSong || 0) + 1} / 3 · ${base?.plan === 'B' ? 'A 組單號 / B 組雙號' : '請核對成績頁 ACC 及判定'}` : match ? `第 ${match.round} 輪 · 比賽歌曲 ${Number(match.currentSong || 0) + 1} / ${count} · 請核對成績頁 ACC 及判定` : '主控選定比賽場次後，會在這裡顯示選手及歌曲。',
      songs: tie ? [tie.song] : source?.songs || [], players: qualifier && !tie ? (source?.players || []).filter(player => base?.activePlayers?.includes(player.id)) : source?.players || [], source, base,
      locked: !base || base.locked || !qualifier && !['ready', 'live'].includes(match?.status),
      baseLocked: !tie && !!base?.baseLocked,
      needsPlan: challenge && (base?.needsPlan || !['A', 'B'].includes(base?.plan)),
      contextLabel: `${context}${tie ? ` · 加賽 ${tie.index + 1}` : ''}`
    };
  }
  function descriptor(player, playerIndex, songIndex) {
    const isTotal = view.challengeTotal && songIndex === 3;
    const song = isTotal ? null : view.songs[songIndex];
    let reason = '';
    if (!player.id) reason = '等候主控指定選手';
    else if (player.disqualified) reason = '此選手已失去參賽資格';
    else if (view.needsPlan) reason = view.base?.lockedReason || '請由主控先設定 Plan A 或 Plan B，再錄入課題模式總分。';
    else if (view.locked) reason = view.qualifier ? '預選賽已鎖定' : view.base?.status === 'complete' ? '賽果已確認，分數已鎖定' : '此場次尚未開始';
    else if (view.baseLocked) reason = '原有分數已鎖定，修正請聯絡主控。';
    else if (song?.hidden || song?.id === 'sealed') reason = '此歌曲尚未公開';
    else if ((!isTotal && !song?.id) || !view.tiebreak && (view.qualifier && (view.songs.length !== 3 || view.songs.some(item => !item?.id)) || !view.qualifier && view.songs.length !== view.count)) reason = '等候主控完成選曲';
    const playerKey = view.qualifier ? player.id : playerIndex;
    return { key: fieldKey(view.key, view.kind, playerKey, songIndex), playerKey: String(playerKey), player, playerIndex, songIndex, song, challengeResult: view.challengeTotal, challengeTotal: isTotal, songStats: view.challengeTotal && !isTotal, scoreOnly: view.challenge && (!view.challengeTotal || isTotal), value: isTotal ? player.challengeTotal ?? null : view.challengeTotal ? player.songStats?.[songIndex]?.score ?? null : player.scores?.[songIndex] ?? null, judgements: view.challengeTotal && !isTotal ? player.songStats?.[songIndex] ? Object.fromEntries(counterNames.map(name => [name, player.songStats[songIndex][name]])) : null : view.challenge ? null : player.judgements?.[songIndex] ?? null, reason };
  }
  function rebuildFields() {
    fields.clear();
    view.players.forEach((player, pi) => { for (let si = 0; si < (view.challengeTotal ? 4 : view.count); si++) { const field = descriptor(player, pi, si); fields.set(field.key, field); } });
  }
  function ready() { return !disposed && !!socket?.connected && !!state && freshEpoch === connectionEpoch; }
  function toast(message) {
    if (disposed) return;
    clearTimeout(toastTimer); $('toast').textContent = message; $('toast').classList.add('show');
    toastTimer = setTimeout(() => $('toast').classList.remove('show'), 5500);
  }
  function connectionText(text, offline) {
    if (disposed) return;
    $('connection').classList.toggle('offline', offline); $('connection').querySelector('span').textContent = text;
  }
  function reviseDrafts() {
    for (const record of drafts.values()) {
      const field = fields.get(record.key);
      if (!field) continue;
      record.server = snapshotValue(field);
      if (record.sending && same(snapshotValue(field), record.pendingValue)) { record.base = snapshotValue(field); record.conflict = false; }
      else if (!same(record.base, snapshotValue(field))) record.conflict = true;
    }
  }
  function scoreFieldHtml(field) {
    const { songIndex: si, player } = field, challenge = field.challengeResult;
    const title = field.challengeTotal ? '三首 Challenge Mode 結算總分' : field.song?.title || '等待選曲';
    const counters = challenge ? [['perfect', 'Perfect'], ['good', 'Good'], ['bad', 'Bad'], ['miss', 'Miss']] : [['perfect', 'P'], ['good', 'G'], ['bad', 'B'], ['miss', 'M']];
    return `<div class="score-field ${field.challengeTotal ? 'challenge-total-field' : ''}" data-field-key="${escape(field.key)}"><label><span class="song-number">${field.challengeTotal ? 'OFFICIAL TOTAL · 遊戲總分' : '第 ' + (si + 1) + ' 首'}</span><span class="song-title" data-song-title>${escape(title)}</span><span class="song-meta" data-song-meta></span>${challenge && !field.challengeTotal ? '<span class="score-label">此曲分數</span>' : ''}<input type="text" inputmode="numeric" autocomplete="off" spellcheck="false" maxlength="16" placeholder="${challenge ? '必填，0 有效' : '尚未計分'}" aria-label="${escape(player.name || '空位')} ${field.challengeTotal ? 'Challenge 總分' : '第 ' + (si + 1) + ' 首分數'}" data-score-key="${escape(field.key)}" data-song-index="${si}"${challenge ? ' required' : ''}${field.challengeTotal ? ' data-challenge-total="true"' : ''}></label>${field.scoreOnly ? '' : `<div class="judgement-fields">${challenge ? '' : `<label class="accuracy-field"><span>成績頁 Accuracy (%)</span><input type="text" inputmode="decimal" autocomplete="off" spellcheck="false" maxlength="12" placeholder="例如 98.7654" aria-label="${escape(player.name || '空位')} 第 ${si + 1} 首 Accuracy" data-judgement-key="${escape(field.key)}" data-judgement-name="accuracy"></label>`}<div class="judgement-counts">${counters.map(([name, label]) => `<label><span>${label}</span><input type="text" inputmode="numeric" autocomplete="off" spellcheck="false" maxlength="16" placeholder="${challenge ? '必填' : '—'}" aria-label="${escape(player.name || '空位')} 第 ${si + 1} 首 ${name}" data-judgement-key="${escape(field.key)}" data-judgement-name="${name}"${challenge ? ' required' : ''}></label>`).join('')}</div><p class="judgement-help">${challenge ? '四項判定數均須填寫；沒有該判定請填 0。' : 'ACC 照原成績頁填寫；P/G/B/M 全填或全留空。'}</p></div>`}<p class="field-status" data-field-status></p><div class="conflict-actions" data-conflict-actions hidden><p class="conflict-message" data-conflict-message></p><button type="button" data-use-server="${escape(field.key)}">採用已保存分數</button><button type="button" data-keep-draft="${escape(field.key)}">保留草稿，準備覆寫</button></div></div>`;
  }
  function cardHtml(player, pi) {
    const playerKey = String(view.qualifier ? player.id : pi);
    return `<form class="player-card ${view.challengeTotal ? 'challenge-result-card' : ''}" data-player-key="${escape(playerKey)}" novalidate>
      <div class="player-header"><div><span class="player-index">${view.qualifier && player.number ? '選手 #' + escape(player.number) : '選手 ' + (pi + 1)}</span><h2 data-player-name>${escape(player.name || '空位')}</h2><span class="on-air" data-on-air hidden>目前直播選手</span></div><div class="saved-total"><span>${view.tiebreak ? '已保存加賽分數' : '已保存總分'}</span><strong data-player-total>${scoreText(view.challengeTotal ? player.challengeTotal : view.tiebreak ? player.scores?.[0] : player.total ?? 0)}</strong></div></div>
      <div class="score-fields" style="--song-count:${view.count}">${Array.from({ length: view.challengeTotal ? 4 : view.count }, (_, si) => scoreFieldHtml(descriptor(player, pi, si))).join('')}</div>${view.challengeTotal ? '<p class="challenge-crosscheck" data-challenge-crosscheck role="status"></p>' : ''}<div class="player-actions"><p data-player-status>所有分數已同步</p><button class="primary-button" type="submit" data-save-player="${escape(playerKey)}">${view.challengeTotal ? '保存完整成績' : '保存分數'}</button></div></form>`;
  }
  function draftNotice() {
    const stale = new Map();
    let active = 0, conflicts = 0;
    for (const record of drafts.values()) {
      if (record.contextKey === view?.key) { active++; if (record.conflict) conflicts++; }
      else {
        const group = stale.get(record.contextKey) || { label: record.contextLabel, records: [] };
        group.records.push(record); stale.set(record.contextKey, group);
      }
    }
    const notice = $('draft-notice');
    notice.hidden = !drafts.size;
    if (!drafts.size) { notice.innerHTML = ''; return; }
    const activeText = active ? `${view?.challengeTotal ? '完整成績草稿尚未保存。' : `${active} 欄分數尚未保存。`}${conflicts ? `其中 ${conflicts} 欄已被其他工作人員修改，請在分數欄下方核對。` : `請按選手下方的「${view?.challengeTotal ? '保存完整成績' : '保存分數'}」。`}` : '';
    const html = `<h2>未保存的分數草稿</h2>${activeText ? `<p>${escape(activeText)}</p>` : ''}${Array.from(stale.entries(), ([key, item]) => `<div class="stale-context"><div><span>${escape(item.label)} · ${item.records.length} 欄草稿</span><p>主控已切換場次；草稿保留在原場次，不能提交到目前場次。</p><p class="stale-draft-values">${item.records.map(record => `${escape(record.playerName)} · ${record.challengeTotal ? 'Challenge 總分' : '第 ' + (record.songIndex + 1) + ' 首'}：${escape(record.raw === '' ? '未計分' : record.raw)}${record.scoreOnly ? '' : ' · ' + escape(judgementText(record.rawJudgements, record.songStats))}`).join('<br>')}</p></div><button type="button" data-discard-context="${escape(key)}" ${saving ? 'disabled' : ''}>丟棄此場次草稿</button></div>`).join('')}`;
    if (notice.innerHTML !== html) notice.innerHTML = html;
  }
  function render() {
    if (disposed || !state) return;
    view = currentView(); rebuildFields(); reviseDrafts();
    $('pairing').hidden = true; $('workspace').hidden = false; $('logout').hidden = false;
    $('event-title').textContent = state.event?.titleZH || state.event?.title || 'ACAHKU / SCORE ENTRY';
    $('context-title').textContent = view.title; $('context-description').textContent = view.description;
    $('score-range').textContent = view.challengeTotal ? '每曲 0–1,000,000' : '0–1,000,000';
    $('score-guidance').textContent = view.challengeTotal ? '總分 0–3,000,000。三首分數、12 項判定數及遊戲總分全部填妥，再保存完整成績；0 有效。' : '填寫後按「保存分數」；留空代表尚未計分。';
    $('sync-status').textContent = ready() ? `資料已同步 · #${state.revision}` : '連線中斷，分數草稿已保留';
    $('score-list').classList.toggle('challenge-results', view.challengeTotal);
    const signature = JSON.stringify([view.key, view.players.map(p => p.id), view.songs.map(s => [s.id, s.title, s.hidden]), view.count, view.challenge]);
    if (signature !== renderedSignature) {
      renderedSignature = signature;
      $('score-list').innerHTML = view.players.length ? view.players.map(cardHtml).join('') : `<section class="empty-state"><h2>尚未有可計分選手</h2><p>${view.qualifier ? '請等候主控選定目前這一批上場選手。' : '請等候主控完成選手與比賽場次設定。'}</p></section>`;
    }
    const matchNotice = view.needsPlan ? view.base?.lockedReason || '請由主控先設定 Plan A 或 Plan B，再錄入課題模式總分。' : view.locked ? view.qualifier ? '預選賽晉級名單已鎖定。分數由主控處理後才能繼續修改。' : view.base?.status === 'complete' ? '此場比賽賽果已確認，分數已鎖定。' : '此場次尚未準備完成，請等候主控設定。' : view.baseLocked ? `加賽已確認，請等候主控確認晉級或賽果、或開啟下一輪加賽。${view.base.baseLockedReason}` : !ready() ? '連線中斷；可繼續填寫草稿，重新連線並同步後才能保存。' : '';
    $('match-notice').hidden = !matchNotice; $('match-notice').textContent = matchNotice;
    for (const form of $('score-list').querySelectorAll('form[data-player-key]')) {
      const pi = view.players.findIndex((player, index) => String(view.qualifier ? player.id : index) === form.dataset.playerKey);
      const player = view.players[pi];
      form.querySelector('[data-player-name]').textContent = player.name || '空位';
      form.querySelector('[data-player-total]').textContent = scoreText(view.challengeTotal ? player.challengeTotal : view.tiebreak ? player.scores?.[0] : player.total ?? 0);
      form.querySelector('[data-on-air]').hidden = !view.qualifier || !state.qualifier.activePlayers?.includes(player.id);
      const playerDrafts = [];
      for (const input of form.querySelectorAll('[data-score-key]')) {
        const field = fields.get(input.dataset.scoreKey), record = drafts.get(field.key), wrapper = input.closest('.score-field');
        if (record) playerDrafts.push(record);
        const raw = record ? record.raw : field.value === null ? '' : String(field.value);
        if (input.value !== raw) input.value = raw;
        input.disabled = !!field.reason;
        input.classList.toggle('is-dirty', !!record); input.classList.toggle('is-conflict', !!record?.conflict);
        const parsed = record ? parseEntry(record.raw, record.rawJudgements, field) : { valid: true };
        const valid = parsed.valid;
        for (const metadataInput of wrapper.querySelectorAll('[data-judgement-key]')) {
          const metadataRaw = record?.rawJudgements || judgementRaw(field.judgements), value = metadataRaw[metadataInput.dataset.judgementName];
          if (metadataInput.value !== value) metadataInput.value = value;
          metadataInput.disabled = !!field.reason;
          metadataInput.classList.toggle('is-dirty', !!record); metadataInput.classList.toggle('is-conflict', !!record?.conflict);
          metadataInput.setAttribute('aria-invalid', String(!valid));
        }
        input.setAttribute('aria-invalid', String(!valid));
        wrapper.classList.toggle('is-current', field.challengeTotal || view.challengeTotal && field.songStats || view.tiebreak || field.songIndex === view.source?.currentSong);
        wrapper.querySelector('[data-song-title]').textContent = field.challengeTotal ? '三首 Challenge Mode 結算總分' : field.song?.title || '等待選曲';
        wrapper.querySelector('[data-song-meta]').textContent = field.challengeTotal ? '照錄遊戲結算總分，作為正式排名依據。總分相同以獨立加賽處理。' : field.song?.hidden ? '尚未公開' : field.song?.id ? `${field.song.difficulty || ''} ${field.song.level ?? ''}`.trim() : '尚未選定歌曲';
        const status = wrapper.querySelector('[data-field-status]');
        status.textContent = field.reason || !valid ? field.reason || parsed.error : record?.conflict ? '已保存分數有變動，請先核對。' : record ? record.sending ? '正在保存…' : '草稿尚未保存' : `已保存：${scoreText(field.value)}${field.judgements?.accuracy === undefined ? '' : ` · ACC ${field.judgements.accuracy}%`}`;
        status.classList.toggle('warning', !!field.reason || !valid || !!record?.conflict);
        wrapper.querySelector('[data-conflict-actions]').hidden = !record?.conflict || !!field.reason;
        wrapper.querySelector('[data-conflict-message]').textContent = record?.conflict ? `已保存：${scoreText(field.value)}${field.scoreOnly ? '' : ' · ' + judgementText(field.judgements, field.songStats)}；你的草稿：${record.raw || '未計分'}${field.scoreOnly ? '' : ' · ' + judgementText(record.rawJudgements, field.songStats)}。${field.scoreOnly ? '請核對分數。' : '分數及判定一併核對。'}` : '';
        for (const button of wrapper.querySelectorAll('[data-conflict-actions] button')) button.disabled = saving;
      }
      const blocked = playerDrafts.some(record => record.conflict || !parseEntry(record.raw, record.rawJudgements, fields.get(record.key)).valid || fields.get(record.key)?.reason);
      form.querySelector('[data-save-player]').disabled = saving || !ready() || !playerDrafts.length || blocked;
      form.querySelector('[data-save-player]').textContent = saving && playerDrafts.some(record => record.sending) ? '正在保存…' : view.challengeTotal ? '保存完整成績' : '保存分數';
      form.querySelector('[data-player-status]').textContent = playerDrafts.length ? `${view.challengeTotal ? '完整成績尚未保存' : `${playerDrafts.length} 欄未保存`}${blocked ? ' · 請先完成並核對所有欄位' : ''}` : '所有分數已同步';
      if (view.challengeTotal) {
        const songScores = [0, 1, 2].map(si => parseScore(form.querySelector(`[data-song-index="${si}"]`).value));
        const total = parseScore(form.querySelector('[data-challenge-total]').value, 3000000), complete = songScores.every(value => value.valid && value.value !== null);
        const sum = complete ? songScores.reduce((value, item) => value + item.value, 0) : null, mismatch = complete && total.valid && total.value !== null && sum !== total.value;
        const crosscheck = form.querySelector('[data-challenge-crosscheck]');
        crosscheck.classList.toggle('warning', mismatch);
        crosscheck.textContent = sum === null ? '三首分數加總：待各曲分數填妥後顯示，供核對。正式排名使用上方照錄的遊戲總分。' : `三首分數加總（核對用）：${scoreText(sum)}。${mismatch ? '與填寫的遊戲總分不同，請核對結算畫面；仍會保留你照錄的遊戲總分。' : '正式排名使用上方照錄的遊戲總分。'}`;
      }
    }
    draftNotice();
  }
  function createDraft(field) {
    return { key: field.key, contextKey: view.key, contextLabel: view.contextLabel, playerKey: field.playerKey, playerName: field.player.name || '空位', scoreOnly: field.scoreOnly, challengeTotal: field.challengeTotal, challengeResult: field.challengeResult, songStats: field.songStats, songIndex: field.songIndex, raw: field.value === null ? '' : String(field.value), rawJudgements: judgementRaw(field.judgements), base: snapshotValue(field), server: snapshotValue(field), conflict: false, sending: false };
  }
  function remember(input) {
    if (disposed) return;
    const key = input.dataset.scoreKey || input.dataset.judgementKey;
    const field = fields.get(key); if (!field || field.reason) return;
    const wrapper = input.closest('.score-field');
    // Capture the complete sheet on its first edit, including untouched values.
    // Another scorer changing any part of this atomic result must be reviewed.
    if (field.challengeResult) for (const item of fields.values()) if (item.playerKey === field.playerKey && !drafts.has(item.key)) drafts.set(item.key, createDraft(item));
    const record = drafts.get(field.key) || createDraft(field);
    record.raw = wrapper.querySelector('[data-score-key]').value;
    record.rawJudgements = field.scoreOnly ? judgementRaw(null) : { ...judgementRaw(null), ...Object.fromEntries(Array.from(wrapper.querySelectorAll('[data-judgement-key]'), node => [node.dataset.judgementName, node.value])) };
    const parsed = parseEntry(record.raw, record.rawJudgements, field);
    if (!field.challengeResult && !record.sending && !record.conflict && parsed.valid && same(parsed.value, snapshotValue(field))) drafts.delete(field.key);
    else drafts.set(field.key, record);
    render();
  }
  function waitForRevision(revision, epoch) {
    if (disposed) return Promise.reject(new Error('此計分頁面已關閉。'));
    if (ready() && state.revision >= revision && connectionEpoch === epoch) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = { revision, epoch, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => { revisionWaiters.delete(waiter); reject(new Error('尚未收到保存後的同步資料，草稿已保留。')); }, 2000);
      revisionWaiters.add(waiter);
    });
  }
  function resolveWaiters() {
    for (const waiter of revisionWaiters) {
      if (connectionEpoch !== waiter.epoch || !socket?.connected) { clearTimeout(waiter.timer); revisionWaiters.delete(waiter); waiter.reject(new Error('連線中斷，草稿已保留。')); }
      else if (ready() && state.revision >= waiter.revision) { clearTimeout(waiter.timer); revisionWaiters.delete(waiter); waiter.resolve(); }
    }
  }
  function assertSaveContext(key, epoch) {
    if (!ready() || epoch !== connectionEpoch) throw new Error('尚未完成連線同步，請稍後再保存。');
    if (state.contextKey !== key) throw new Error('主控已切換場次；原場次草稿已保留。');
  }
  function command(request) {
    return new Promise((resolve, reject) => {
      if (disposed || !socket?.connected) { reject(new Error('尚未完成連線同步，請稍後再保存。')); return; }
      const activeSocket = socket, pending = { reject };
      pendingCommands.add(pending);
      activeSocket.timeout(8000).emit('command', request, (error, result) => {
        if (!pendingCommands.delete(pending)) return;
        if (disposed || socket !== activeSocket) return reject(new Error('連線中斷，草稿已保留。'));
        if (error) return reject(new Error('未能確認保存結果，請重新連線後核對分數。'));
        if (!result?.ok) {
          const messages = { STALE: '比賽資料已更新；草稿保留，請核對後再次保存。', CONTEXT_CHANGED: '主控已切換場次；原場次草稿已保留。', FORBIDDEN: '計分員只能修改目前場次的分數。', INVALID: '未能保存，請核對目前場次、選曲及分數範圍。' };
          return reject(new Error(messages[result?.code] || result?.error || '保存失敗，草稿已保留。'));
        }
        resolve(result);
      });
    });
  }
  async function saveChallengePlayer(playerKey) {
    const key = view.key, epoch = connectionEpoch, group = view.base.activeGroup;
    const snapshot = Array.from(drafts.values()).filter(record => record.contextKey === key && record.playerKey === playerKey).sort((a, b) => a.songIndex - b.songIndex).map(record => ({ record, raw: record.raw, rawJudgements: { ...record.rawJudgements } }));
    if (!snapshot.length) return;
    try {
      assertSaveContext(key, epoch);
      if (snapshot.length !== 4 || snapshot.some(({ record, raw, rawJudgements }) => record.conflict || fields.get(record.key)?.reason || !fields.has(record.key) || !parseEntry(raw, rawJudgements, fields.get(record.key)).valid || !same(record.base, snapshotValue(fields.get(record.key))))) throw new Error('請完整填寫三首分數、所有判定數及遊戲總分，並核對有提示的欄位。');
      const values = snapshot.map(entry => parseEntry(entry.raw, entry.rawJudgements, fields.get(entry.record.key)).value);
      const payload = { group, playerId: fields.get(snapshot[0].record.key).player.id, total: values[3].score, songStats: values.slice(0, 3).map(value => ({ score: value.score, ...value.judgements })) };
      saving = true;
      snapshot.forEach((entry, index) => { entry.record.sending = true; entry.record.pendingValue = values[index]; });
      render();
      const result = await command({ expectedRevision: state.revision, contextKey: key, action: { type: 'set-qualifier-challenge-result', payload } });
      await waitForRevision(result.revision, epoch);
      assertSaveContext(key, epoch);
      const unchanged = snapshot.every((entry, index) => drafts.get(entry.record.key) === entry.record && entry.record.raw === entry.raw && same(entry.record.rawJudgements, entry.rawJudgements) && same(snapshotValue(fields.get(entry.record.key)), values[index]));
      snapshot.forEach((entry, index) => {
        if (drafts.get(entry.record.key) !== entry.record) return;
        if (unchanged) drafts.delete(entry.record.key);
        else { entry.record.base = values[index]; entry.record.conflict = !same(snapshotValue(fields.get(entry.record.key)), values[index]); }
      });
      toast(unchanged ? '已一次保存三首分數、全部判定數及遊戲總分。' : '完整成績已保存；保存期間修改的草稿已保留，請核對後再次保存。');
    } catch (error) { toast(error.message); }
    finally {
      if (!disposed) {
        for (const { record } of snapshot) { record.sending = false; delete record.pendingValue; }
        saving = false; render();
      }
    }
  }
  async function savePlayer(playerKey) {
    if (disposed || saving || !state) return;
    if (view.challengeTotal) return saveChallengePlayer(playerKey);
    const key = view.key, epoch = connectionEpoch;
    const snapshot = Array.from(drafts.values()).filter(record => record.contextKey === key && record.playerKey === playerKey).sort((a, b) => a.songIndex - b.songIndex).map(record => ({ record, raw: record.raw, rawJudgements: { ...record.rawJudgements } }));
    if (!snapshot.length) return;
    let saved = 0;
    try {
      assertSaveContext(key, epoch);
      if (snapshot.some(({ record, raw, rawJudgements }) => record.conflict || !parseEntry(raw, rawJudgements, fields.get(record.key)).valid || fields.get(record.key)?.reason)) throw new Error('請先核對有提示的分數欄，再保存。');
      saving = true; render();
      for (const entry of snapshot) {
        assertSaveContext(key, epoch);
        const record = drafts.get(entry.record.key), field = fields.get(entry.record.key);
        if (!record || record.raw !== entry.raw || !same(record.rawJudgements, entry.rawJudgements)) throw new Error('部分草稿在保存期間有變動，請再次按保存分數。');
        if (record.conflict || !field || field.reason || !same(record.base, snapshotValue(field))) throw new Error('已保存分數有變動，請先核對後再保存。');
        const value = parseEntry(entry.raw, entry.rawJudgements, field).value, { score, judgements } = value;
        record.sending = true; record.pendingValue = value; render();
        const payload = view.qualifier ? { playerId: field.player.id, score, judgements } : { matchId: view.base.id, playerIndex: field.playerIndex, score, judgements };
        if (view.tiebreak) { payload.index = view.source.index; if (view.qualifier) payload.group = view.base.activeGroup; }
        else payload.songIndex = field.songIndex;
        const action = { type: `set-${view.kind}-score`, payload };
        const result = await command({ expectedRevision: state.revision, contextKey: key, action });
        await waitForRevision(result.revision, epoch);
        assertSaveContext(key, epoch);
        saved++;
        const current = drafts.get(record.key);
        if (current === record) {
          record.sending = false; delete record.pendingValue;
          if (record.raw === entry.raw && same(record.rawJudgements, entry.rawJudgements) && same(snapshotValue(fields.get(record.key)), value)) drafts.delete(record.key);
          else { record.base = value; record.conflict = !same(snapshotValue(fields.get(record.key)), value); }
        }
        render();
      }
      toast(`已保存 ${saved} 欄分數。`);
    } catch (error) { toast(`${saved ? `已保存 ${saved} 欄。` : ''}${error.message}`); }
    finally {
      if (!disposed) {
        for (const { record } of snapshot) { record.sending = false; delete record.pendingValue; }
        saving = false; render();
      }
    }
  }
  function connect() {
    if (disposed) return;
    disconnectSocket(); state = null; view = null; renderedSignature = ''; freshEpoch = -1;
    connectionText('正在連線…', true);
    socket = createBroadcastSocket('/scorekeeper', { token });
    const activeSocket = socket;
    socket.on('connect', () => { if (disposed || socket !== activeSocket) return; connectionEpoch++; freshEpoch = -1; connectionText('正在同步…', true); render(); });
    socket.on('state', next => {
      if (disposed || socket !== activeSocket) return;
      state = next; freshEpoch = connectionEpoch; connectionText('已連線', false); render(); resolveWaiters();
    });
    socket.on('disconnect', () => {
      if (disposed || socket !== activeSocket) return;
      connectionEpoch++; freshEpoch = -1; releasePending(); connectionText('連線中斷 · 草稿已保留', true); render();
    });
    socket.on('connect_error', error => {
      if (disposed || socket !== activeSocket) return;
      if (['FORBIDDEN', 'PAIRING_REQUIRED', 'unauthorized'].includes(error.message) || /unauthor|expired|invalid token/i.test(error.message)) {
        sessionStorage.removeItem('scorekeeper-token'); token = null; disconnectSocket(); state = null; view = null; renderedSignature = ''; freshEpoch = -1;
        $('workspace').hidden = true; $('pairing').hidden = false; $('logout').hidden = true;
        $('pair-error').textContent = '計分員登入已失效，請重新輸入計分員密碼。'; connectionText('需要重新登入', true);
      } else { connectionText('無法連線 · 正在重試', true); if (!state) $('pair-error').textContent = '暫時無法連線至比賽伺服器，請檢查網路。'; }
      render();
    });
  }
  $('pair-form').addEventListener('submit', async event => {
    event.preventDefault(); if (disposed || loginPending) return;
    loginPending = true; const button = event.currentTarget.querySelector('button'); button.disabled = true; $('pair-error').textContent = '';
    try {
      const response = await fetch('../api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: $('pin').value, role: 'scorekeeper' }), signal: lifecycle.signal });
      const result = await response.json();
      if (disposed) return;
      if (!response.ok || !result.token || result.role !== 'scorekeeper') throw new Error(response.status === 429 ? '登入嘗試過於頻繁，請稍後再試。' : '計分員密碼不正確，請向主控工作人員確認。');
      token = result.token; sessionStorage.setItem('scorekeeper-token', token); $('pin').value = ''; connect();
    } catch (error) { if (!disposed) $('pair-error').textContent = error instanceof TypeError ? '無法連線至比賽伺服器，請檢查網路後再試。' : error.message; }
    finally { loginPending = false; if (!disposed) button.disabled = false; }
  }, listenerOptions);
  $('logout').addEventListener('click', () => {
    if (disposed) return;
    disconnectSocket(); state = null; view = null;
    sessionStorage.removeItem('scorekeeper-token'); token = null;
    $('workspace').hidden = true; $('pairing').hidden = false; $('logout').hidden = true;
    $('pair-error').textContent = drafts.size ? '已登出；本頁未保存的草稿保留至重新登入。' : ''; connectionText('尚未登入', true);
  }, listenerOptions);
  $('score-list').addEventListener('input', event => { if (event.target.matches('[data-score-key], [data-judgement-key]')) remember(event.target); }, listenerOptions);
  $('score-list').addEventListener('submit', event => {
    event.preventDefault(); const form = event.target.closest('form[data-player-key]'); if (form) savePlayer(form.dataset.playerKey);
  }, listenerOptions);
  $('score-list').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing && event.target.matches('[data-score-key], [data-judgement-key]')) { event.preventDefault(); savePlayer(event.target.closest('form').dataset.playerKey); }
  }, listenerOptions);
  document.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button || saving) return;
    if (button.hasAttribute('data-use-server')) {
      const record = drafts.get(button.dataset.useServer), field = fields.get(button.dataset.useServer);
      if (record?.challengeResult && field && !field.reason) drafts.set(field.key, createDraft(field));
      else if (!record?.challengeResult) drafts.delete(button.dataset.useServer);
      render();
    }
    else if (button.hasAttribute('data-keep-draft')) {
      const record = drafts.get(button.dataset.keepDraft), field = fields.get(button.dataset.keepDraft);
      if (record && field && !field.reason) { record.base = snapshotValue(field); record.server = snapshotValue(field); record.conflict = false; render(); }
    } else if (button.hasAttribute('data-discard-context')) {
      for (const [key, record] of drafts) if (record.contextKey === button.dataset.discardContext) drafts.delete(key);
      render();
    }
  }, listenerOptions);
  addEventListener('pagehide', event => { if (!event.persisted) dispose(); }, listenerOptions);
  if (token) connect();
})();
