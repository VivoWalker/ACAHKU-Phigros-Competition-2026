(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const scoreText = value => value === null || value === undefined ? '—' : Number(value).toLocaleString('en-US');
  const same = (a, b) => (a ?? null) === (b ?? null);
  const drafts = new Map(), fields = new Map(), revisionWaiters = new Set();
  let token = sessionStorage.getItem('scorekeeper-token'), socket, state, view, renderedSignature = '', connectionEpoch = 0, freshEpoch = -1;
  let saving = false, toastTimer, loginPending = false;

  function parseScore(raw) {
    if (raw === '') return { valid: true, value: null };
    if (!/^\d{1,7}$/.test(raw)) return { valid: false };
    const value = Number(raw);
    return { valid: Number.isSafeInteger(value) && value <= 1000000, value };
  }
  function fieldKey(contextKey, kind, player, songIndex) { return JSON.stringify([contextKey, kind, player, songIndex]); }
  function currentView() {
    if (!state) return null;
    const qualifier = state.stage === 'qualifier', match = state.match;
    const group = state.qualifier?.activeGroup || '—';
    const source = qualifier ? state.qualifier : match;
    const count = qualifier ? 3 : match?.id === 'GF' ? 3 : 2;
    return {
      key: state.contextKey, kind: qualifier ? 'qualifier' : 'match', count,
      title: qualifier ? `預選賽 · ${group} 組` : match ? `${match.id} · ${match.label || '雙淘汰賽'}` : '等候主控設定場次',
      description: qualifier ? `主控目前選定 ${group} 組 · 比賽歌曲 ${Number(source?.currentSong || 0) + 1} / 3` : match ? `第 ${match.round} 輪 · 比賽歌曲 ${Number(match.currentSong || 0) + 1} / ${count}` : '主控選定比賽場次後，會在這裡顯示選手及歌曲。',
      songs: source?.songs || [], players: source?.players || [], source,
      locked: !source || source.locked || !qualifier && !['ready', 'live'].includes(match?.status),
      contextLabel: qualifier ? `預選賽 ${group} 組` : match ? `${match.id} · ${match.label || '雙淘汰賽'}` : '未選定場次'
    };
  }
  function descriptor(player, playerIndex, songIndex) {
    const song = view.songs[songIndex];
    let reason = '';
    if (!player.id) reason = '等候主控指定選手';
    else if (view.locked) reason = view.kind === 'qualifier' ? '預選賽已鎖定' : view.source?.status === 'complete' ? '賽果已確認，分數已鎖定' : '此場次尚未開始';
    else if (song?.hidden || song?.id === 'sealed') reason = '此歌曲尚未公開';
    else if (!song?.id || view.kind === 'qualifier' && (view.songs.length !== 3 || view.songs.some(item => !item?.id)) || view.kind === 'match' && view.songs.length !== view.count) reason = '等候主控完成選曲';
    const playerKey = view.kind === 'qualifier' ? player.id : playerIndex;
    return { key: fieldKey(view.key, view.kind, playerKey, songIndex), playerKey: String(playerKey), player, playerIndex, songIndex, song, value: player.scores?.[songIndex] ?? null, reason };
  }
  function rebuildFields() {
    fields.clear();
    view.players.forEach((player, pi) => { for (let si = 0; si < view.count; si++) { const field = descriptor(player, pi, si); fields.set(field.key, field); } });
  }
  function ready() { return !!socket?.connected && !!state && freshEpoch === connectionEpoch; }
  function toast(message) {
    clearTimeout(toastTimer); $('toast').textContent = message; $('toast').classList.add('show');
    toastTimer = setTimeout(() => $('toast').classList.remove('show'), 5500);
  }
  function connectionText(text, offline) {
    $('connection').classList.toggle('offline', offline); $('connection').querySelector('span').textContent = text;
  }
  function reviseDrafts() {
    for (const record of drafts.values()) {
      const field = fields.get(record.key);
      if (!field) continue;
      record.server = field.value;
      if (record.sending && same(field.value, record.pendingValue)) { record.base = field.value; record.conflict = false; }
      else if (!same(record.base, field.value)) record.conflict = true;
    }
  }
  function cardHtml(player, pi) {
    const playerKey = String(view.kind === 'qualifier' ? player.id : pi);
    return `<form class="player-card" data-player-key="${escape(playerKey)}" novalidate>
      <div class="player-header"><div><span class="player-index">選手 ${pi + 1}</span><h2 data-player-name>${escape(player.name || '空位')}</h2><span class="on-air" data-on-air hidden>目前直播選手</span></div><div class="saved-total"><span>已保存總分</span><strong data-player-total>${scoreText(player.total ?? 0)}</strong></div></div>
      <div class="score-fields" style="--song-count:${view.count}">${Array.from({ length: view.count }, (_, si) => {
        const field = descriptor(player, pi, si);
        return `<div class="score-field" data-field-key="${escape(field.key)}"><label><span class="song-number">第 ${si + 1} 首</span><span class="song-title" data-song-title>${escape(field.song?.title || '等待選曲')}</span><span class="song-meta" data-song-meta></span><input type="text" inputmode="numeric" autocomplete="off" spellcheck="false" maxlength="16" placeholder="尚未計分" aria-label="${escape(player.name || '空位')} 第 ${si + 1} 首分數" data-score-key="${escape(field.key)}" data-song-index="${si}"></label><p class="field-status" data-field-status></p><div class="conflict-actions" data-conflict-actions hidden><p class="conflict-message" data-conflict-message></p><button type="button" data-use-server="${escape(field.key)}">採用已保存分數</button><button type="button" data-keep-draft="${escape(field.key)}">保留草稿，準備覆寫</button></div></div>`;
      }).join('')}</div><div class="player-actions"><p data-player-status>所有分數已同步</p><button class="primary-button" type="submit" data-save-player="${escape(playerKey)}">保存分數</button></div></form>`;
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
    const activeText = active ? `${active} 欄分數尚未保存。${conflicts ? `其中 ${conflicts} 欄已被其他工作人員修改，請在分數欄下方核對。` : '請按選手下方的「保存分數」。'}` : '';
    const html = `<h2>未保存的分數草稿</h2>${activeText ? `<p>${escape(activeText)}</p>` : ''}${Array.from(stale.entries(), ([key, item]) => `<div class="stale-context"><div><span>${escape(item.label)} · ${item.records.length} 欄草稿</span><p>主控已切換場次；草稿保留在原場次，不能提交到目前場次。</p><p class="stale-draft-values">${item.records.map(record => `${escape(record.playerName)} · 第 ${record.songIndex + 1} 首：${escape(record.raw === '' ? '未計分' : record.raw)}`).join('<br>')}</p></div><button type="button" data-discard-context="${escape(key)}" ${saving ? 'disabled' : ''}>丟棄此場次草稿</button></div>`).join('')}`;
    if (notice.innerHTML !== html) notice.innerHTML = html;
  }
  function render() {
    if (!state) return;
    view = currentView(); rebuildFields(); reviseDrafts();
    $('pairing').hidden = true; $('workspace').hidden = false; $('logout').hidden = false;
    $('event-title').textContent = state.event?.titleZH || state.event?.title || 'ACAHKU / SCORE ENTRY';
    $('context-title').textContent = view.title; $('context-description').textContent = view.description;
    $('sync-status').textContent = ready() ? `資料已同步 · #${state.revision}` : '連線中斷，分數草稿已保留';
    const signature = JSON.stringify([view.key, view.players.map(p => p.id), view.songs.map(s => [s.id, s.title, s.hidden]), view.count]);
    if (signature !== renderedSignature) {
      renderedSignature = signature;
      $('score-list').innerHTML = view.players.length ? view.players.map(cardHtml).join('') : '<section class="empty-state"><h2>尚未有可計分選手</h2><p>請等候主控完成選手與比賽場次設定。</p></section>';
    }
    const matchNotice = view.locked ? view.kind === 'qualifier' ? '預選賽晉級名單已鎖定。分數由主控處理後才能繼續修改。' : view.source?.status === 'complete' ? '此場比賽賽果已確認，分數已鎖定。' : '此場次尚未準備完成，請等候主控設定。' : !ready() ? '連線中斷；可繼續填寫草稿，重新連線並同步後才能保存。' : '';
    $('match-notice').hidden = !matchNotice; $('match-notice').textContent = matchNotice;
    for (const form of $('score-list').querySelectorAll('form[data-player-key]')) {
      const pi = view.players.findIndex((player, index) => String(view.kind === 'qualifier' ? player.id : index) === form.dataset.playerKey);
      const player = view.players[pi];
      form.querySelector('[data-player-name]').textContent = player.name || '空位';
      form.querySelector('[data-player-total]').textContent = scoreText(player.total ?? 0);
      form.querySelector('[data-on-air]').hidden = view.kind !== 'qualifier' || !state.qualifier.activePlayers?.includes(player.id);
      const playerDrafts = [];
      for (const input of form.querySelectorAll('[data-score-key]')) {
        const field = fields.get(input.dataset.scoreKey), record = drafts.get(field.key), wrapper = input.closest('.score-field');
        if (record) playerDrafts.push(record);
        const raw = record ? record.raw : field.value === null ? '' : String(field.value);
        if (input.value !== raw) input.value = raw;
        input.disabled = !!field.reason;
        input.classList.toggle('is-dirty', !!record); input.classList.toggle('is-conflict', !!record?.conflict);
        const valid = !record || parseScore(record.raw).valid;
        input.setAttribute('aria-invalid', String(!valid));
        wrapper.classList.toggle('is-current', field.songIndex === view.source?.currentSong);
        wrapper.querySelector('[data-song-title]').textContent = field.song?.title || '等待選曲';
        wrapper.querySelector('[data-song-meta]').textContent = field.song?.hidden ? '尚未公開' : field.song?.id ? `${field.song.difficulty || ''} ${field.song.level ?? ''}`.trim() : '尚未選定歌曲';
        const status = wrapper.querySelector('[data-field-status]');
        status.textContent = field.reason || !valid ? field.reason || '請輸入 0–1,000,000 的整數；不需逗號。' : record?.conflict ? '已保存分數有變動，請先核對。' : record ? record.sending ? '正在保存…' : '草稿尚未保存' : `已保存：${scoreText(field.value)}`;
        status.classList.toggle('warning', !!field.reason || !valid || !!record?.conflict);
        wrapper.querySelector('[data-conflict-actions]').hidden = !record?.conflict || !!field.reason;
        wrapper.querySelector('[data-conflict-message]').textContent = record?.conflict ? `已保存：${scoreText(field.value)}；你的草稿：${record.raw || '未計分'}` : '';
        for (const button of wrapper.querySelectorAll('[data-conflict-actions] button')) button.disabled = saving;
      }
      const blocked = playerDrafts.some(record => record.conflict || !parseScore(record.raw).valid || fields.get(record.key)?.reason);
      form.querySelector('[data-save-player]').disabled = saving || !ready() || !playerDrafts.length || blocked;
      form.querySelector('[data-save-player]').textContent = saving && playerDrafts.some(record => record.sending) ? '正在保存…' : '保存分數';
      form.querySelector('[data-player-status]').textContent = playerDrafts.length ? `${playerDrafts.length} 欄未保存${blocked ? ' · 請先核對分數' : ''}` : '所有分數已同步';
    }
    draftNotice();
  }
  function remember(input) {
    const field = fields.get(input.dataset.scoreKey); if (!field || field.reason) return;
    let record = drafts.get(field.key);
    if (!record) record = { key: field.key, contextKey: view.key, contextLabel: view.contextLabel, playerKey: field.playerKey, playerName: field.player.name || '空位', songIndex: field.songIndex, base: field.value, server: field.value, conflict: false, sending: false };
    record.raw = input.value;
    const parsed = parseScore(record.raw);
    if (!record.sending && !record.conflict && parsed.valid && record.raw === (field.value === null ? '' : String(field.value))) drafts.delete(field.key);
    else drafts.set(field.key, record);
    render();
  }
  function waitForRevision(revision, epoch) {
    if (ready() && state.revision >= revision && connectionEpoch === epoch) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = { revision, epoch, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => { revisionWaiters.delete(waiter); reject(new Error('尚未收到保存後的同步資料，草稿已保留。')); }, 2000);
      revisionWaiters.add(waiter);
    });
  }
  function resolveWaiters() {
    for (const waiter of revisionWaiters) {
      if (connectionEpoch !== waiter.epoch || !socket.connected) { clearTimeout(waiter.timer); revisionWaiters.delete(waiter); waiter.reject(new Error('連線中斷，草稿已保留。')); }
      else if (ready() && state.revision >= waiter.revision) { clearTimeout(waiter.timer); revisionWaiters.delete(waiter); waiter.resolve(); }
    }
  }
  function assertSaveContext(key, epoch) {
    if (!ready() || epoch !== connectionEpoch) throw new Error('尚未完成連線同步，請稍後再保存。');
    if (state.contextKey !== key) throw new Error('主控已切換場次；原場次草稿已保留。');
  }
  function command(request) {
    return new Promise((resolve, reject) => {
      socket.timeout(8000).emit('command', request, (error, result) => {
        if (error) return reject(new Error('未能確認保存結果，請重新連線後核對分數。'));
        if (!result?.ok) {
          const messages = { STALE: '比賽資料已更新；草稿保留，請核對後再次保存。', CONTEXT_CHANGED: '主控已切換場次；原場次草稿已保留。', FORBIDDEN: '計分員只能修改目前場次的分數。', INVALID: '未能保存，請核對目前場次、選曲及分數範圍。' };
          return reject(new Error(messages[result?.code] || result?.error || '保存失敗，草稿已保留。'));
        }
        resolve(result);
      });
    });
  }
  async function savePlayer(playerKey) {
    if (saving || !state) return;
    const key = view.key, epoch = connectionEpoch;
    const snapshot = Array.from(drafts.values()).filter(record => record.contextKey === key && record.playerKey === playerKey).sort((a, b) => a.songIndex - b.songIndex).map(record => ({ record, raw: record.raw }));
    if (!snapshot.length) return;
    let saved = 0;
    try {
      assertSaveContext(key, epoch);
      if (snapshot.some(({ record, raw }) => record.conflict || !parseScore(raw).valid || fields.get(record.key)?.reason)) throw new Error('請先核對有提示的分數欄，再保存。');
      saving = true; render();
      for (const entry of snapshot) {
        assertSaveContext(key, epoch);
        const record = drafts.get(entry.record.key), field = fields.get(entry.record.key);
        if (!record || record.raw !== entry.raw) throw new Error('部分草稿在保存期間有變動，請再次按保存分數。');
        if (record.conflict || !field || field.reason || !same(record.base, field.value)) throw new Error('已保存分數有變動，請先核對後再保存。');
        const score = parseScore(entry.raw).value;
        record.sending = true; record.pendingValue = score; render();
        const action = view.kind === 'qualifier' ? { type: 'set-qualifier-score', payload: { playerId: field.player.id, songIndex: field.songIndex, score } } : { type: 'set-match-score', payload: { matchId: view.source.id, playerIndex: field.playerIndex, songIndex: field.songIndex, score } };
        const result = await command({ expectedRevision: state.revision, contextKey: key, action });
        await waitForRevision(result.revision, epoch);
        assertSaveContext(key, epoch);
        saved++;
        const current = drafts.get(record.key);
        if (current === record) {
          record.sending = false; delete record.pendingValue;
          if (record.raw === entry.raw && same(fields.get(record.key)?.value, score)) drafts.delete(record.key);
          else { record.base = score; record.conflict = !same(fields.get(record.key)?.value, score); }
        }
        render();
      }
      toast(`已保存 ${saved} 欄分數。`);
    } catch (error) { toast(`${saved ? `已保存 ${saved} 欄。` : ''}${error.message}`); }
    finally {
      for (const { record } of snapshot) { record.sending = false; delete record.pendingValue; }
      saving = false; render();
    }
  }
  function connect() {
    socket?.disconnect(); state = null; view = null; renderedSignature = ''; freshEpoch = -1;
    connectionText('正在連線…', true);
    socket = createBroadcastSocket('/scorekeeper', { token });
    const activeSocket = socket;
    socket.on('connect', () => { if (socket !== activeSocket) return; connectionEpoch++; freshEpoch = -1; connectionText('正在同步…', true); render(); });
    socket.on('state', next => {
      if (socket !== activeSocket) return;
      state = next; freshEpoch = connectionEpoch; connectionText('已連線', false); render(); resolveWaiters();
    });
    socket.on('disconnect', () => {
      if (socket !== activeSocket) return;
      connectionEpoch++; freshEpoch = -1; connectionText('連線中斷 · 草稿已保留', true); render(); resolveWaiters();
    });
    socket.on('connect_error', error => {
      if (socket !== activeSocket) return;
      if (['FORBIDDEN', 'PAIRING_REQUIRED', 'unauthorized'].includes(error.message) || /unauthor|expired|invalid token/i.test(error.message)) {
        sessionStorage.removeItem('scorekeeper-token'); token = null; socket.disconnect(); state = null; view = null; renderedSignature = ''; freshEpoch = -1;
        $('workspace').hidden = true; $('pairing').hidden = false; $('logout').hidden = true;
        $('pair-error').textContent = '計分員登入已失效，請重新輸入計分員密碼。'; connectionText('需要重新登入', true);
      } else { connectionText('無法連線 · 正在重試', true); if (!state) $('pair-error').textContent = '暫時無法連線至比賽伺服器，請檢查網路。'; }
      render();
    });
  }
  $('pair-form').addEventListener('submit', async event => {
    event.preventDefault(); if (loginPending) return;
    loginPending = true; const button = event.currentTarget.querySelector('button'); button.disabled = true; $('pair-error').textContent = '';
    try {
      const response = await fetch('../api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: $('pin').value, role: 'scorekeeper' }) });
      const result = await response.json();
      if (!response.ok || !result.token || result.role !== 'scorekeeper') throw new Error(response.status === 429 ? '登入嘗試過於頻繁，請稍後再試。' : '計分員密碼不正確，請向主控工作人員確認。');
      token = result.token; sessionStorage.setItem('scorekeeper-token', token); $('pin').value = ''; connect();
    } catch (error) { $('pair-error').textContent = error instanceof TypeError ? '無法連線至比賽伺服器，請檢查網路後再試。' : error.message; }
    finally { loginPending = false; button.disabled = false; }
  });
  $('logout').addEventListener('click', () => {
    socket?.disconnect(); socket = null; state = null; view = null; freshEpoch = -1; connectionEpoch++;
    sessionStorage.removeItem('scorekeeper-token'); token = null;
    $('workspace').hidden = true; $('pairing').hidden = false; $('logout').hidden = true;
    $('pair-error').textContent = drafts.size ? '已登出；本頁未保存的草稿保留至重新登入。' : ''; connectionText('尚未登入', true);
  });
  $('score-list').addEventListener('input', event => { if (event.target.matches('[data-score-key]')) remember(event.target); });
  $('score-list').addEventListener('submit', event => {
    event.preventDefault(); const form = event.target.closest('form[data-player-key]'); if (form) savePlayer(form.dataset.playerKey);
  });
  $('score-list').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing && event.target.matches('[data-score-key]')) { event.preventDefault(); savePlayer(event.target.closest('form').dataset.playerKey); }
  });
  document.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button || saving) return;
    if (button.hasAttribute('data-use-server')) { drafts.delete(button.dataset.useServer); render(); }
    else if (button.hasAttribute('data-keep-draft')) {
      const record = drafts.get(button.dataset.keepDraft), field = fields.get(button.dataset.keepDraft);
      if (record && field && !field.reason) { record.base = field.value; record.server = field.value; record.conflict = false; render(); }
    } else if (button.hasAttribute('data-discard-context')) {
      for (const [key, record] of drafts) if (record.contextKey === button.dataset.discardContext) drafts.delete(key);
      render();
    }
  });
  if (token) connect();
})();
