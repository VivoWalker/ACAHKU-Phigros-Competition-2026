(function () {
  const B = Broadcast, e = B.escape, canvas = document.getElementById('canvas'), mount = document.getElementById('scene');
  const requested = document.body.dataset.scene || 'start';
  const query = new URLSearchParams(location.search);
  const follow = query.has('follow') ? query.get('follow') !== '0' : requested === 'start' || requested === 'live';
  const fixed = query.get('fixed') === '1';
  let state, shown, markup;
  function fit() { const scale = Math.min(innerWidth / 1920, innerHeight / 1080); canvas.style.transform = `scale(${scale})`; canvas.style.left = `${(innerWidth - 1920 * scale) / 2}px`; canvas.style.top = `${(innerHeight - 1080 * scale) / 2}px`; }
  addEventListener('resize', fit); fit();
  const art = s => `../${s?.art || 'assets/song/cover-1.svg'}`;
  const badge = s => s && !s.hidden ? `<span class="difficulty">${e(s.difficulty)} ${e(s.level)}</span>` : '';
  function header(s, subtitle = '') { return `<header class="topbar surface"><div class="brand"><b>ACAHKU</b><span>${e(s.event.title)} / ${e(s.event.date.slice(0, 4))}</span></div><div class="topmeta">${e(subtitle || (s.stage === 'qualifier' ? 'QUALIFIERS' : 'DOUBLE ELIMINATION'))}<br><span class="muted">${e(s.event.venue)} · ${e(s.event.time)}</span></div></header>`; }
  function footer(s, status = '') { return `<footer class="footer surface"><span>${e(s.event.organiserZH)} · ${e(B.date(s.event.date))}</span><span>${e(status || s.event.title)}</span></footer>`; }
  function track(s, index) { return `<div class="track surface"><img src="${e(art(s))}" alt=""><div><div class="aux">SONG ${index + 1} ${badge(s)}</div><h3>${e(s?.title || 'Awaiting selection')}</h3><div class="aux">${e(s?.artist || '')}</div></div></div>`; }
  function heading(label, title, aux = '', chip = '') { return `<div class="scene-head"><div class="label accent">${e(label)}</div><h1>${e(title)}</h1><p class="aux">${e(aux)}</p>${chip ? `<span class="chip">${e(chip)}</span>` : ''}</div>`; }
  function start(s) { return header(s, 'THE STAGE IS SET') + `<div class="event-start"><img class="event-art" src="../assets/event/signal.svg" alt=""><section class="event-copy"><div class="label accent">LIVE TOGETHER / PLAY TOGETHER</div><h1 style="font-size:${s.event.title.length > 85 ? 58 : s.event.title.length > 55 ? 72 : 90}px">${e(s.event.title)}</h1><p class="org">${e(s.event.organiser)}</p><p class="aux">${e(s.event.organiserZH)}</p><p class="date">${e(B.date(s.event.date))}</p><div class="details"><div><strong>${e(s.event.time)}</strong><span>EVENT TIME / 活動時間</span></div><div><strong>${e(s.event.venue)}</strong><span>VENUE / 場地</span></div></div><p class="message">${e(s.event.message)}</p></section></div>` + footer(s, 'WELCOME TO THE COMPETITION'); }
  function qualifierWaiting(s) {
    const q = s.qualifier, group = q.activeGroup, ranked = B.rankings(s, group);
    return header(s) + heading('QUALIFIERS / 預選賽', `Group ${group} — Up next`, 'Three players. Three songs. One place on the bracket.', 'WAITING') + `<div class="waiting-body"><div class="player-stack">${q.activePlayers.map((id, i) => { const p = B.player(s, id); return `<div class="wait-player surface"><div class="seed">0${i + 1}</div><div><h2>${e(p?.name)}</h2><p class="aux">GROUP ${group} · CURRENT RANK ${ranked.find(x => x.id === id)?.rank || '—'}</p></div></div>`; }).join('') || '<div class="surface empty-copy">Select the next three players</div>'}</div><div class="wait-tracks">${q.groups[group].songs.map((id, i) => track(B.song(s, id), i)).join('')}<div class="surface ready-strip">NEXT · SONG ${q.currentSong + 1} / 3</div></div></div>` + footer(s, `GROUP ${group} / TOP FOUR ADVANCE`);
  }
  function doubleWaiting(s) {
    const m = B.currentMatch(s);
    if (!m) return header(s) + heading('DOUBLE ELIMINATION', 'The next chapter awaits', 'The top four from each group will advance.') + footer(s, 'AWAITING QUALIFIER RESULTS');
    return header(s, `R${m.round} / ${m.bracket === 'WB' ? 'WINNERS’ BRACKET' : m.bracket === 'LB' ? 'LOSERS’ BRACKET' : 'GRAND FINALS'}`) + heading(`MATCH ${m.id}`, `R${m.round} — ${m.label}`, 'Ready for the next head-to-head.', m.status.toUpperCase()) + `<div class="waiting-body"><div class="player-stack">${m.players.map(id => `<div class="wait-player surface"><div class="seed">#${id ? B.seed(s, id) : '—'}</div><div><h2>${e(B.name(s, id))}</h2><p class="aux">${B.losses(s, id)} ${B.losses(s, id) === 1 ? 'LOSS' : 'LOSSES'} · ${m.bracket}</p></div></div>`).join('<div class="versus">VS.</div>')}</div><div class="wait-tracks">${m.songs.length ? m.songs.map(track).join('') : '<div class="surface ready-strip"><h2>Song selection</h2><p class="aux">Candidates → bans → final draw</p></div>'}<div class="surface ready-strip">${m.id === 'GF' ? 'THREE SONGS / AUDIENCE + MC' : 'TWO SONGS / HIGHEST TOTAL WINS'}</div></div></div>` + footer(s, `MATCH ${m.id} / SONG ${m.currentSong + 1} OF ${m.id === 'GF' ? 3 : 2}`);
  }
  function competitor(s, id, scores, songs, group, currentSong, rank, two) {
    const p = B.player(s, id);
    return `<section class="competitor"><div class="capture" data-capture="gameplay" aria-label="Transparent gameplay capture area"></div><div class="name-band surface"><span class="seed">${two ? '#' + (id ? B.seed(s, id) : '—') : String(rank || '—').padStart(2, '0')}</span><div style="min-width:0"><h2>${e(p?.name || 'Awaiting player')}</h2><p class="aux">${e(group)} · ${two ? B.losses(s, id) + ' LOSSES' : 'GROUP RANK ' + (rank || '—')}</p></div></div><div class="score-panel surface">${songs.map((song, i) => `<div class="score-row ${i === currentSong ? 'current' : ''}"><span class="song-title">${i + 1}. ${e(song?.title || 'Awaiting song')}</span><strong>${B.score(scores?.[i])}</strong></div>`).join('')}<div class="score-total"><span>TOTAL</span><strong>${B.score(B.total(scores))}</strong></div></div><div class="webcam" data-capture="webcam" aria-label="Transparent webcam area"><span class="webcam-label">${e(p?.name || 'CAM')}</span></div></section>`;
  }
  function qualifierMatch(s) {
    const q = s.qualifier, group = q.activeGroup, ranks = B.rankings(s, group), songs = q.groups[group].songs.map(id => B.song(s, id));
    return header(s, `QUALIFIERS / GROUP ${group} / SONG ${q.currentSong + 1} OF 3`) + `<div class="match-layout">${Array.from({ length: 3 }, (_, i) => { const id = q.activePlayers[i]; return competitor(s, id, B.player(s, id)?.scores || [null, null, null], songs, 'GROUP ' + group, q.currentSong, ranks.find(p => p.id === id)?.rank, false); }).join('')}</div>` + footer(s, `GROUP ${group} / THREE-PLAYER QUALIFIER`);
  }
  function doubleMatch(s) {
    const m = B.currentMatch(s);
    if (!m) return doubleWaiting(s);
    const songs = m.songs.length ? m.songs : Array(m.id === 'GF' ? 3 : 2).fill(null);
    return header(s, `R${m.round} — ${m.label} / ${m.id}`) + `<div class="match-layout two">${m.players.map((id, i) => competitor(s, id, m.scores[i], songs, m.bracket, m.currentSong, null, true)).join('')}</div><div class="match-ribbon"><span class="chip">SONG ${m.currentSong + 1} / ${songs.length}</span><span>${e(m.songs[m.currentSong]?.title || 'Awaiting song selection')}</span></div>` + footer(s, 'TWO PLAYERS / ONE NEXT CHAPTER');
  }
  function result(s) {
    const r = s.result;
    if (!r) return header(s) + heading('RESULT ANNOUNCEMENT / 賽果', 'Awaiting the result', 'The next result will appear here.') + footer(s);
    const index = r.players.indexOf(r.winnerId), placement = r.placements[r.winnerId] || 'ADVANCES';
    const next = s.tournament.matches.find(m => m.status === 'ready');
    return header(s, `MATCH ${r.matchId} / R${r.round}`) + heading('RESULT ANNOUNCEMENT / 賽果', r.label, r.type === 'score' ? 'The score is final.' : `${r.type === 'draw' ? 'Lottery advancement' : 'Bye'} · ${r.note}`) + `<div class="result-wrap"><section class="winner-panel surface white"><div class="label">${e(placement)}</div><h1>${e(r.winnerId ? B.name(s, r.winnerId) : 'Vacant match')}</h1><div class="winner-score">${B.score(r.totals[index])}</div><p class="small">${r.winnerId ? 'SEED #' + B.seed(s, r.winnerId) : 'NO PLAYER ADVANCES'}</p></section><div class="result-rows">${r.players.filter(Boolean).map(id => { const i = r.players.indexOf(id); return `<div class="result-row surface"><header><h2>${e(B.name(s, id))}</h2><span>${B.score(r.totals[i])}</span></header><div class="placement accent">${e(r.placements[id] || (id === r.winnerId ? 'ADVANCES' : B.losses(s, id) >= 2 ? 'ELIMINATED' : 'TO LOSERS’ BRACKET'))}</div><div class="aux">${B.losses(s, id)} LOSSES · SEED #${B.seed(s, id)}</div></div>`; }).join('')}</div></div><div class="next-match">${next ? `UP NEXT · ${e(next.id)} · ${e(B.name(s, next.players[0]))} vs. ${e(B.name(s, next.players[1]))}` : 'COMPETITION COMPLETE'}</div>` + footer(s, `MATCH ${r.matchId} / ${r.type.toUpperCase()}`);
  }
  function node(s, m) {
    const source = x => x.type === 'seed' ? '#' + x.value : (x.type === 'winner' ? 'W ' : 'L ') + x.value;
    const target = s.tournament.matches.filter(x => x.sources.some(y => y.value === m.id && y.type === 'loser')).map(x => x.id).join(', ');
    const winnerTarget = s.tournament.matches.filter(x => x.sources.some(y => y.value === m.id && y.type === 'winner')).map(x => x.id).join(', ');
    return `<article class="bracket-node ${e(m.status)}"><div class="node-label"><span>${e(m.id)} · ${e(m.bracket)}</span><span>${m.status === 'live' ? 'LIVE' : m.status === 'ready' ? 'NEXT' : m.status === 'complete' ? 'FINAL' : 'WAIT'}</span></div>${m.players.map((id, i) => `<div class="node-player ${id && id === m.winnerId ? 'win' : ''}"><span>${id ? '#' + B.seed(s, id) : '·'}</span><span style="overflow:hidden;text-overflow:ellipsis">${e(id ? B.name(s, id) : m.status === 'pending' ? source(m.sources[i]) : 'Bye')}</span>${id ? `<span class="loss-count">${B.losses(s, id)}L</span>` : ''}</div>`).join('')}<div class="node-note">${m.resultType && m.resultType !== 'score' ? e(m.resultType.toUpperCase() + ' · ' + m.note) : m.id === 'GF' ? 'Champion / Runner-up' : `W: ${e(winnerTarget || 'Champion')} · L: ${e(target || 'OUT')}`}</div></article>`;
  }
  function bracket(s) {
    if (!s.tournament.seeded) return header(s) + heading('TOURNAMENT PROGRESS', 'The bracket is waiting', 'Eight qualifiers. Fourteen matches. One champion.') + footer(s);
    return header(s, 'WINNERS’ BRACKET / LOSERS’ BRACKET') + heading('TOURNAMENT PROGRESS / 賽程', 'Road to the Grand Finals') + `<div class="bracket-wrap"><div class="bracket-note">${s.tournament.matches.filter(m => m.status === 'complete').length} / 14 COMPLETE · 2 LOSSES = ELIMINATED</div><div class="bracket-grid">${Array.from({ length: 6 }, (_, i) => `<div class="bracket-column"><div class="round-title">R${i + 1}</div>${['WB', 'LB', 'GF'].map(type => { const matches = s.tournament.matches.filter(m => m.round === i + 1 && m.bracket === type); return matches.length ? `<div class="bracket-heading">${type === 'WB' ? 'WINNERS' : type === 'LB' ? 'LOSERS' : 'FINALS'}</div>${matches.map(m => node(s, m)).join('')}` : ''; }).join('')}</div>`).join('')}</div><div class="standings">${s.tournament.seeds.map((id, i) => `<span class="${B.losses(s, id) >= 2 ? 'out' : ''}">#${i + 1} ${e(id ? B.name(s, id) : 'Vacant')} · ${B.losses(s, id)}L</span>`).join('')}</div></div>` + footer(s, 'WB WINNER → NEXT WB ROUND · LB WINNER → NEXT LB ROUND');
  }
  function selection(s) {
    const m = B.currentMatch(s);
    if (!m) return doubleWaiting(s);
    const focus = m.songs[m.currentSong] || m.candidates.find(c => c.id === m.bans.filter(Boolean).at(-1)) || m.candidates[0];
    return header(s, `MATCH ${m.id} / R${m.round}`) + heading(m.id === 'GF' ? 'GRAND FINALS / FINAL SELECTION' : 'SONG SELECTION / 選曲', m.id === 'GF' ? 'The audience takes the lead.' : 'Six songs. Two bans. Two picks.', m.id === 'GF' ? 'Two audience picks. One sealed MC pick.' : 'Each player bans one. The remaining four enter the final draw.') + `<div class="selection"><div class="candidate-list ${m.id === 'GF' ? 'final-list' : ''}">${m.candidates.map((song, i) => { const banned = m.bans.indexOf(song.id), picked = m.songs.some(x => !x.hidden && x.id === song.id); return `<div class="candidate ${banned >= 0 ? 'banned' : ''} ${picked ? 'picked' : ''}"><span class="index">${String(i + 1).padStart(2, '0')}</span><div><h3>${e(song.title)}</h3><div class="aux">${e(banned >= 0 ? 'BAN · ' + B.name(s, m.players[banned]) : song.artist)}</div></div><span>${e(song.difficulty)} ${e(song.level)}</span></div>`; }).join('') || '<div class="surface empty-copy">Awaiting candidate draw</div>'}</div><div><div class="selection-art" data-art-id="${e(focus?.id)}"><img src="${e(art(focus))}" alt="${e(focus?.title || 'Tournament artwork')}"></div><div class="selection-detail surface"><div class="label">${m.songs.length ? 'MATCH SONGS' : 'CANDIDATE DRAW'}</div><h2>${e(focus?.title || 'Ready when you are.')}</h2><div class="picks">${m.songs.map((song, i) => `<span>${i + 1} / ${e(song.title)} ${badge(song)}</span>`).join('') || '<span class="muted">Final songs will appear after selection.</span>'}</div></div><div class="selection-state">${m.id === 'GF' ? `<div class="surface">AUDIENCE · ${m.audiencePicks.length}/2</div><div class="surface">MC · ${m.hostRevealed ? 'REVEALED' : 'SEALED'}</div>` : m.players.map((id, i) => `<div class="surface">${e(B.name(s, id))}<br><span class="accent">${m.bans[i] ? 'BAN LOCKED' : 'CHOOSING BAN'}</span></div>`).join('')}</div></div></div>` + footer(s, `${m.id === 'GF' ? 'THREE' : 'TWO'} SONGS / HIGHEST COMBINED SCORE WINS`);
  }
  const renderers = { start, 'qualifier-waiting': qualifierWaiting, 'double-elimination-waiting': doubleWaiting, 'qualifier-match': qualifierMatch, 'double-elimination-match': doubleMatch, result, bracket, 'song-selection': selection };
  function render() {
    const scene = fixed || !follow ? requested === 'live' ? state.scene : requested : state.scene;
    const next = (renderers[scene] || start)(state);
    if (next === markup) return;
    const oldArt = mount.querySelector('.selection-art img');
    const oldSrc = oldArt?.getAttribute('src');
    mount.innerHTML = next; markup = next; canvas.dataset.renderedScene = scene;
    if (shown !== scene) { mount.classList.remove('scene-enter'); void mount.offsetWidth; mount.classList.add('scene-enter'); }
    const windowEl = mount.querySelector('.selection-art');
    if (windowEl && oldSrc && oldSrc !== windowEl.querySelector('img').getAttribute('src') && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const img = windowEl.querySelector('img'); const old = img.cloneNode(); old.src = oldSrc; old.setAttribute('aria-hidden', 'true'); old.style.cssText = 'position:absolute;inset:0;width:100%;height:100%'; windowEl.append(old);
      img.animate([{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }], { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)' });
      old.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(-100%)' }], { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)' }).finished.then(() => old.remove()).catch(() => old.remove());
    }
    shown = scene;
  }
  const socket = createBroadcastSocket('/overlay');
  socket.on('state', next => { state = next; render(); });
  socket.on('connect', () => canvas.classList.remove('is-offline'));
  socket.on('disconnect', () => canvas.classList.add('is-offline'));
  socket.on('connect_error', () => canvas.classList.add('is-offline'));
})();
