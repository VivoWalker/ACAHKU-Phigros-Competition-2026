(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const storage = value => { try { if (value === undefined) return sessionStorage.getItem('broadcast-host-token');
    if (value === null) sessionStorage.removeItem('broadcast-host-token'); else sessionStorage.setItem('broadcast-host-token', value); } catch {} };
  const media = BroadcastDisplayMedia.createClient();
  let socket, state, ready = false, pending = false, epoch = 0, token = storage();
  function render() {
    const match = state?.match, disabled = !ready || pending;
    $('match-id').textContent = match?.id || '等待主控';
    $('players').innerHTML = (match?.players || []).map((player, i) => `<p><b>P${i + 1}</b><span title="${escape(player.name)}">${escape(player.name)}</span></p>`).join('');
    $('draw-six').disabled = disabled || !state?.available.drawCandidates;
    $('draw-two').disabled = disabled || !state?.available.pickSongs;
    $('candidates').innerHTML = (match?.candidates || []).map(song => {
      const banned = match.bans.includes(song.id), pick = match.songs.findIndex(item => item.id === song.id);
      const art = media.resolve(song.art || 'assets/song/cover-1.svg');
      return `<article class="candidate-card${banned ? ' is-banned' : ''}${pick >= 0 ? ' is-picked' : ''}" data-song-id="${escape(song.id)}">
        <img class="candidate-art" src="/${escape(art)}" alt=""><h2>${pick >= 0 ? `<span class="picked-label">PICK ${pick + 1}</span>` : ''}${escape(song.title)}</h2>
        <span class="song-difficulty" aria-label="${escape(song.difficulty)} ${escape(Math.trunc(song.level))}"><b>${escape(Math.trunc(song.level))}</b><span>${escape(song.difficulty)}</span></span>
        <div class="ban-actions">${[0, 1].map(i => `<button type="button" data-ban-player="${i}" data-ban-song="${escape(song.id)}" aria-pressed="${match.bans[i] === song.id}" ${disabled || !state.available.ban || banned ? 'disabled' : ''}>P${i + 1} Ban</button>`).join('')}</div></article>`;
    }).join('');
  }
  function connect() {
    socket?.removeAllListeners(); socket?.disconnect();
    const current = io('/host', { auth: { token } }); socket = current;
    const invalidate = message => { ready = false; pending = false; epoch++; $('connection').textContent = message; render(); };
    current.on('state', next => {
      if (current !== socket) return;
      state = next; ready = current.connected;
      $('pairing').hidden = true; $('workspace').hidden = false; $('connection').textContent = '已連線';
      render();
    });
    current.on('disconnect', () => { if (current === socket) invalidate('未連線'); });
    current.on('connect_error', error => {
      if (current !== socket) return;
      invalidate('未連線');
      if (['PAIRING_REQUIRED', 'FORBIDDEN'].includes(error.message)) {
        current.disconnect(); token = null; storage(null); state = null;
        $('workspace').hidden = true; $('pairing').hidden = false;
        $('pair-error').textContent = '請使用主持人配對碼登入。';
      }
    });
  }
  $('pair-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true; $('pair-error').textContent = '';
    try {
      const response = await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'host', pin: $('pin').value }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      token = result.token; storage(token); $('pin').value = ''; connect();
    } catch (error) { $('pair-error').textContent = error.message; }
    finally { button.disabled = false; }
  });
  $('workspace').addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled || pending || !ready || !socket?.connected || !state?.match) return;
    const type = button.dataset.command || (button.hasAttribute('data-ban-player') ? 'ban-song' : '');
    if (!['draw-candidates', 'ban-song', 'pick-songs'].includes(type)) return;
    const payload = { matchId: state.match.id, ...(type === 'ban-song' ? { playerIndex: Number(button.dataset.banPlayer), songId: button.dataset.banSong } : {}) };
    const request = { expectedRevision: state.revision, contextKey: state.contextKey, action: { type, payload } };
    const current = socket, connectionId = current.id, sentEpoch = epoch;
    pending = true; $('message').textContent = ''; render();
    current.timeout(8000).emit('command', request, (error, result) => {
      if (current !== socket || !current.connected || current.id !== connectionId || sentEpoch !== epoch) return;
      pending = false;
      if (error || !result?.ok) $('message').textContent = error ? '未收到確認，請核對目前選曲。' :
        ['STALE', 'CONTEXT_CHANGED'].includes(result.code) ? '場次或選曲已更新，請核對後重試。' : result.error;
      render();
    });
  });
  media.ready.then(render);
  window.addEventListener('pagehide', event => { if (!event.persisted) { ready = false; epoch++; socket?.removeAllListeners(); socket?.disconnect(); media.dispose(); } });
  render(); if (token) connect();
})();
