(function () {
  const B = Broadcast, e = B.escape, canvas = document.getElementById('canvas'), mount = document.getElementById('scene');
  const requested = document.body.dataset.scene || 'start';
  const query = new URLSearchParams(location.search);
  const follow = query.has('follow') ? query.get('follow') !== '0' : requested === 'start' || requested === 'live';
  const fixed = query.get('fixed') === '1', details = query.get('details') === '1';
  const cameraOverride = ['0', '1'].includes(query.get('cameras')) ? query.get('cameras') === '1' : null;
  const showHandcams = s => cameraOverride ?? (s.broadcast?.showHandcams === true);
  canvas.classList.toggle('show-details', details);
  const rankPage = Number.parseInt(query.get('rankPage'), 10);
  const fixedRankPage = Number.isInteger(rankPage) && rankPage > 0;
  let rankingTick = 0;
  let state, shown, markup, branding = { logo: null, visual: null, socLogo: null, kiramekiLogo: null };
  const url = path => '/' + encodeURI(path);
  const art = song => url(song?.art || 'assets/song/cover-1.svg');
  function fit() {
    const scale = Math.min(innerWidth / 1920, innerHeight / 1080);
    canvas.style.transform = `scale(${scale})`;
    canvas.style.left = `${(innerWidth - 1920 * scale) / 2}px`;
    canvas.style.top = `${(innerHeight - 1080 * scale) / 2}px`;
  }
  addEventListener('resize', fit); fit();
  function logo(className = '') {
    return branding.logo ? `<img class='phigros-logo ${className}' src='${e(url(branding.logo))}' alt='Phigros'>` : `<span class='phigros-wordmark ${className}'>Phigros</span>`;
  }
  function clubLogos(className = '') {
    const logos = [['soc', branding.socLogo, '香港大學動漫聯盟'], ['kirameki', branding.kiramekiLogo, 'Kirameki']];
    const images = logos.filter(([, path]) => path).map(([kind, path, label]) => `<img class='club-logo ${kind}' data-club-logo='${kind}' src='${e(url(path))}' alt='${e(label)}'>`).join('');
    return images ? `<div class='club-logos ${className}' aria-label='社團標誌'>${images}</div>` : '';
  }
  function backdrop(holes = []) {
    const cutouts = holes.map(([x, y, w, h]) => `<rect x='${x}' y='${y}' width='${w}' height='${h}' fill='black'/>`).join('');
    const image = branding.visual ? `<image href='${e(url(branding.visual))}' x='-120' y='-180' width='2160' height='1440' preserveAspectRatio='xMidYMid slice' filter='url(#art-blur)' opacity='.28'/>` : '';
    return `<svg class='broadcast-backdrop' viewBox='0 0 1920 1080' aria-hidden='true'><defs><mask id='capture-mask' maskUnits='userSpaceOnUse' x='0' y='0' width='1920' height='1080'><rect x='12' y='12' width='1896' height='1056' fill='white'/>${cutouts}</mask><linearGradient id='event-gradient' x1='0' y1='0' x2='1' y2='1'><stop stop-color='#321c35'/><stop offset='.55' stop-color='#24232e'/><stop offset='1' stop-color='#111820'/></linearGradient><filter id='art-blur'><feGaussianBlur stdDeviation='48'/></filter></defs><g mask='url(#capture-mask)'><rect width='1920' height='1080' fill='url(#event-gradient)'/>${image}<path d='M 1420 0 L 1130 1080 L 1920 1080 L 1920 0 Z' fill='#080d15' opacity='.17'/><rect x='13' y='13' width='1894' height='1054' fill='none' stroke='#e8e3ef' stroke-opacity='.24' stroke-width='2'/></g></svg>`;
  }
  function header(s, context = '') {
    return `<header class='topbar'><div class='brand'>${logo()}<span class='event-title'>${e(s.event.title)}</span></div><div class='header-right'>${context ? `<div class='topmeta'>${e(context)}</div>` : ''}${clubLogos()}</div></header>`;
  }
  function footer(label, context = '') {
    return `<footer class='footer'><span>${e(label)}</span>${context ? `<span>${e(context)}</span>` : ''}</footer>`;
  }
  function title(text, sub = '') {
    return `<div class='scene-head'><h1>${e(text)}</h1>${sub ? `<p>${e(sub)}</p>` : ''}</div>`;
  }
  function visual(className = '') {
    return branding.visual ? `<figure class='key-visual ${className}'><img src='${e(url(branding.visual))}' alt='ACAHKU Phigros competition artwork'></figure>` : '';
  }
  function start(s) {
    const clubs = clubLogos('hero-club-logos');
    return backdrop() + `<div class='event-start ${branding.visual ? 'with-art' : 'without-art'}'>${visual('start-art')}<section class='event-copy'>${logo('hero-logo')}<h1 style='font-size:${s.event.title.length > 60 ? 60 : s.event.title.length > 36 ? 78 : 90}px'>${e(s.event.title)}</h1><p class='event-line'>${e(B.date(s.event.date))}<br>${e(s.event.time)} · ${e(s.event.venue)}</p><div class='organiser-row ${clubs ? 'with-club-logos' : ''}'><p class='organiser'>${e(s.event.organiserZH || s.event.organiser)}</p>${clubs}</div></section></div>`;
  }
  function waiting(s, context, label, names, currentSong, songCount, song) {
    return backdrop() + header(s, context) + `<div class='waiting-body ${branding.visual ? 'with-art' : 'without-art'}'><section class='waiting-copy'><div class='section-label'>準備中 <span>PREPARING</span></div><h1>${e(label)}</h1><div class='waiting-players'>${names.map(name => `<p>${e(name)}</p>`).join('')}</div><div class='waiting-song'><span>接下來 · SONG ${currentSong + 1} / ${songCount}</span><h2>${e(song?.title || '選曲中')}</h2></div></section>${visual('waiting-art')}</div>`;
  }
  function qualifierWaiting(s) {
    const q = s.qualifier, songs = q.groups[q.activeGroup].songs;
    return waiting(s, '預選賽 · QUALIFIERS', `Group ${q.activeGroup}`, q.activePlayers.map(id => B.name(s, id)), q.currentSong, 3, B.song(s, songs[q.currentSong]));
  }
  function doubleWaiting(s) {
    const m = B.currentMatch(s);
    if (!m) return backdrop() + header(s, '雙淘汰賽') + title('等待晉級選手', 'DOUBLE ELIMINATION') + visual('standby-art');
    return waiting(s, m.id === 'GF' ? '總決賽 · GRAND FINALS' : '雙淘汰賽 · DOUBLE ELIMINATION', `R${m.round} · ${m.id}`, m.players.map(id => id ? B.name(s, id) : '待定'), m.currentSong, m.id === 'GF' ? 3 : 2, m.songs[m.currentSong]);
  }
  function playerName(s, id, scores, songs, index, kind) {
    const total = scores?.some(score => score !== null && score !== undefined) ? B.score(B.total(scores)) : '—';
    const scoresLine = details ? `<div class='song-scores'>${songs.map((song, i) => `<span class='score-row' title='${e(song?.title || '待定')}'>S${i + 1} <b>${B.score(scores?.[i])}</b></span>`).join('')}</div>` : '';
    return `<section class='player-info ${kind} player-${index + 1}'><div class='player-name'><h2>${e(id ? B.name(s, id) : '待定')}</h2><div class='player-total'><span>TOTAL</span><strong>${total}</strong></div></div>${scoresLine}</section>`;
  }
  function capture(rect, kind = 'gameplay', player = '', playerId = '') {
    const [x, y, width, height] = rect;
    return `<div class='capture ${kind}' data-capture='${kind}' data-feed='${kind === 'webcam' ? 'handcam' : 'capture-card'}' data-player-id='${e(playerId || '')}' aria-label='${e(player)} ${kind === 'webcam' ? '手元 handcam' : '采集卡 capture card'}' style='left:${x}px;top:${y}px;width:${width}px;height:${height}px'></div>`;
  }
  function handcam(rect, name, id) {
    const [x, y, width] = rect;
    return `<span class='handcam-label' style='left:${x}px;top:${y - 44}px;width:${width}px'>手元 · HANDCAM</span>` + capture(rect, 'webcam', name, id);
  }
  function songBand(song, current, count, kind = '') {
    return `<div class='song-band ${kind}'><span>SONG ${current + 1} / ${count}</span><h2>${e(song?.title || '選曲中')}</h2>${song && !song.hidden ? `<span class='difficulty'>${e(song.difficulty)} ${e(song.level)}</span>` : ''}</div>`;
  }
  function qualifierMatch(s) {
    const q = s.qualifier, songs = q.groups[q.activeGroup].songs.map(id => B.song(s, id));
    const cameras = showHandcams(s);
    const frames = [[64, 300, 576, 324], [672, 300, 576, 324], [1280, 300, 576, 324]];
    const cams = cameras ? [[64, 800, 240, 135], [672, 800, 240, 135], [1280, 800, 240, 135]] : [];
    return backdrop([...frames, ...cams]) + header(s, `預選賽 · GROUP ${q.activeGroup}`) + `<div class='match-layout qualifier ${cameras ? 'with-cameras' : ''}'>${frames.map((rect, i) => {
      const id = q.activePlayers[i], name = id ? B.name(s, id) : '待定';
      return playerName(s, id, B.player(s, id)?.scores, songs, i, 'qualifier-player') + capture(rect, 'gameplay', name, id) + (cams[i] ? handcam(cams[i], name, id) : '');
    }).join('')}${songBand(songs[q.currentSong], q.currentSong, 3, 'qualifier-song')}</div>`;
  }
  function doubleMatch(s) {
    const m = B.currentMatch(s);
    if (!m) return doubleWaiting(s);
    const cameras = showHandcams(s);
    const frames = [[64, 280, 872, 490.5], [984, 280, 872, 490.5]];
    const cams = cameras ? [[64, 846, 224, 126], [1632, 846, 224, 126]] : [];
    const count = m.id === 'GF' ? 3 : 2, songs = m.songs.length ? m.songs : Array(count).fill(null);
    return backdrop([...frames, ...cams]) + header(s, `${m.id === 'GF' ? '總決賽' : '雙淘汰賽'} · R${m.round} · ${m.id}`) + `<div class='match-layout double ${cameras ? 'with-cameras' : ''}'>${m.players.map((id, i) => playerName(s, id, m.scores[i], songs, i, 'double-player') + capture(frames[i], 'gameplay', id ? B.name(s, id) : '待定', id) + (cams[i] ? handcam(cams[i], id ? B.name(s, id) : '待定', id) : '')).join('')}${songBand(m.songs[m.currentSong], m.currentSong, count, 'double-song')}</div>`;
  }
  function qualifierResults(s) {
    const ranks = ['A', 'B'].map(group => B.rankings(s, group));
    const compact = ranks.some(group => group.length > 4);
    return backdrop() + header(s, '預選賽 · QUALIFIERS') + title('現在排名', 'CURRENT RANKING') + `<div class='ranking-tables ${compact ? 'compact' : ''}'>${['A', 'B'].map((group, i) => {
      const players = ranks[i], pages = Math.max(1, Math.ceil(players.length / 8));
      const page = fixedRankPage ? Math.min(rankPage - 1, pages - 1) : rankingTick % pages;
      const from = page * 8, visible = players.slice(from, from + 8);
      return `<section><h2>GROUP ${group}${pages > 1 ? `<span class='rank-range'>${from + 1}–${Math.min(from + 8, players.length)} / ${players.length}</span>` : ''}</h2><table><thead><tr><th>#</th><th>Player</th><th>Total</th></tr></thead><tbody>${visible.map(p => `<tr><td>${p.rank}</td><td>${e(p.name)}</td><td>${p.scores.some(n => n !== null) ? B.score(p.total) : '—'}</td></tr>`).join('')}</tbody></table></section>`;
    }).join('')}</div>` + footer(ranks.some(group => group.length > 8) && !fixedRankPage ? '各組分開排名 · 每 12 秒換頁' : '各組分開排名 · GROUP STANDINGS');
  }
  function result(s) {
    if (s.stage === 'qualifier') return qualifierResults(s);
    const r = s.result;
    if (!r) return backdrop() + header(s, '比賽結果') + title('等待比賽結果', 'RESULTS');
    const index = r.players.indexOf(r.winnerId), placement = r.placements[r.winnerId] || 'ADVANCES';
    return backdrop() + header(s, `比賽結果 · R${r.round} · ${r.matchId}`) + `<div class='result-wrap'><section class='winner-panel'><div class='section-label'>${e(placement)}</div><h1>${e(r.winnerId ? B.name(s, r.winnerId) : '空缺場次')}</h1>${r.type === 'score' ? `<div class='winner-score'>${B.score(r.totals[index])}</div>` : `<p class='result-note'>${e(r.type === 'draw' ? '抽籤晉級' : '輪空晉級')}</p>`}</section><section class='result-rows'>${r.players.filter(Boolean).map(id => { const i = r.players.indexOf(id); return `<div class='result-row'><h2>${e(B.name(s, id))}</h2><strong>${r.type === 'score' ? B.score(r.totals[i]) : '—'}</strong><p>${e(r.placements[id] || (id === r.winnerId ? 'ADVANCES' : B.losses(s, id) >= 2 ? 'ELIMINATED' : 'LOSERS’ BRACKET'))}</p></div>`; }).join('')}</section></div>`;
  }
  function node(s, m) {
    const source = x => x.type === 'seed' ? '#' + x.value : (x.type === 'winner' ? 'W ' : 'L ') + x.value;
    const special = m.resultType && m.resultType !== 'score' ? m.resultType === 'draw' ? '抽籤晉級' : '輪空' : '';
    return `<article class='bracket-node ${e(m.status)}'><div class='node-label'><span>${e(m.id)}</span><span>${m.status === 'live' ? 'LIVE' : m.status === 'ready' ? 'NEXT' : ''}</span></div>${m.players.map((id, i) => `<div class='node-player ${id && id === m.winnerId ? 'win' : ''}'>${e(id ? B.name(s, id) : m.status === 'pending' ? source(m.sources[i]) : '輪空')}</div>`).join('')}${special ? `<div class='node-note'>${e(special)}</div>` : ''}</article>`;
  }
  function bracket(s) {
    if (!s.tournament.seeded) return backdrop() + header(s, '賽程') + title('等待晉級選手', 'TOURNAMENT BRACKET');
    return backdrop() + header(s, `賽程 · ${s.tournament.matches.filter(m => m.status === 'complete').length} / 14`) + title('雙淘汰賽賽程', 'TOURNAMENT BRACKET') + `<div class='bracket-wrap'><div class='bracket-grid'>${Array.from({ length: 6 }, (_, i) => `<div class='bracket-column'><div class='round-title'>R${i + 1}</div>${['WB', 'LB', 'GF'].map(type => {
      const matches = s.tournament.matches.filter(m => m.round === i + 1 && m.bracket === type);
      return matches.length ? `<div class='bracket-heading'>${type === 'WB' ? 'WINNERS' : type === 'LB' ? 'LOSERS' : 'FINALS'}</div>${matches.map(m => node(s, m)).join('')}` : '';
    }).join('')}</div>`).join('')}</div></div>`;
  }
  function selection(s) {
    const m = B.currentMatch(s);
    if (!m) return doubleWaiting(s);
    const focus = m.songs[m.currentSong] || m.candidates.find(c => c.id === m.bans.filter(Boolean).at(-1)) || m.candidates[0];
    return backdrop() + header(s, `R${m.round} · ${m.id}`) + title(m.id === 'GF' ? '決賽選曲' : '選曲', 'SONG SELECTION') + `<div class='selection'><div class='candidate-list ${m.id === 'GF' ? 'final-list' : ''}'>${m.candidates.map((song, i) => {
      const banned = m.bans.indexOf(song.id), picked = m.songs.some(x => !x.hidden && x.id === song.id);
      return `<div class='candidate ${banned >= 0 ? 'banned' : ''} ${picked ? 'picked' : ''}'><span class='index'>${String(i + 1).padStart(2, '0')}</span><h3>${e(song.title)}</h3><span class='candidate-status'>${banned >= 0 ? 'BAN' : picked ? 'PICK' : e(song.difficulty + ' ' + song.level)}</span></div>`;
    }).join('') || `<p class='empty-copy'>選曲中</p>`}</div><section><div class='selection-art'><img src='${e(art(focus))}' alt='${e(focus?.title || 'Song artwork')}'></div><div class='selection-detail'><h2>${e(focus?.title || '選曲中')}</h2><div class='picks'>${m.songs.map((song, i) => `<span>${i + 1} · ${e(song.title)}</span>`).join('')}</div></div><div class='selection-state'>${m.id === 'GF' ? `<span>AUDIENCE · ${m.audiencePicks.length}/2</span><span>MC · ${m.hostRevealed ? 'REVEALED' : 'SEALED'}</span>` : m.players.map((id, i) => `<span>${e(id ? B.name(s, id) : '待定')} · ${m.bans[i] ? 'BAN ✓' : 'CHOOSING'}</span>`).join('')}</div></section></div>`;
  }
  const renderers = { start, 'qualifier-waiting': qualifierWaiting, 'double-elimination-waiting': doubleWaiting, 'qualifier-match': qualifierMatch, 'double-elimination-match': doubleMatch, result, bracket, 'song-selection': selection };
  function render() {
    if (!state) return;
    const scene = fixed || !follow ? requested === 'live' ? state.scene : requested : state.scene;
    const next = (renderers[scene] || start)(state);
    if (next === markup) return;
    const oldSrc = mount.querySelector('.selection-art img')?.getAttribute('src');
    mount.innerHTML = next; markup = next; canvas.dataset.renderedScene = scene;
    canvas.dataset.branding = branding.visual ? 'visual' : 'text';
    canvas.dataset.displayMode = showHandcams(state) ? 'dual' : 'single';
    if (shown !== scene) { mount.classList.remove('scene-enter'); void mount.offsetWidth; mount.classList.add('scene-enter'); }
    const windowEl = mount.querySelector('.selection-art');
    if (windowEl && oldSrc && oldSrc !== windowEl.querySelector('img').getAttribute('src') && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const img = windowEl.querySelector('img'), old = img.cloneNode(); old.src = oldSrc; old.setAttribute('aria-hidden', 'true'); windowEl.append(old);
      img.animate([{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }], { duration: 220, easing: 'cubic-bezier(.22,1,.36,1)' });
      old.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(-100%)' }], { duration: 220, easing: 'cubic-bezier(.22,1,.36,1)' }).finished.then(() => old.remove()).catch(() => old.remove());
    }
    shown = scene;
  }
  setInterval(() => {
    if (!fixedRankPage && state?.stage === 'qualifier' && canvas.dataset.renderedScene === 'result' && ['A', 'B'].some(group => B.rankings(state, group).length > 8)) {
      rankingTick++; render();
    }
  }, 12000);
  fetch('/api/branding').then(response => response.ok ? response.json() : null).then(result => {
    if (!result) return;
    branding = result; render();
  }).catch(() => {});
  const socket = createBroadcastSocket('/overlay');
  socket.on('state', next => { state = next; render(); });
  socket.on('connect', () => canvas.classList.remove('is-offline'));
  socket.on('disconnect', () => canvas.classList.add('is-offline'));
  socket.on('connect_error', () => canvas.classList.add('is-offline'));
})();
