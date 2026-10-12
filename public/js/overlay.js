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
  let state, committedCover, committedFocus, branding = { logo: null, visual: null, socLogo: null, kiramekiLogo: null };
  const motion = BroadcastMotion.createScene(mount, { canvas });
  const countdownLayer = BroadcastCountdown.createLayer(canvas);
  let countdownClient;
  const shownScene = () => fixed || !follow ? requested === 'live' ? state?.scene : requested : state?.scene;
  const refreshCountdown = () => countdownLayer.update(countdownClient, state, shownScene());
  const requestedRound = Number(query.get('round'));
  const bracketMotion = BroadcastBracket.createController(mount, () => render(), Number.isInteger(requestedRound) && requestedRound >= 1 && requestedRound <= 6 ? requestedRound : null);
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
    return branding.logo ? `<img data-motion-key='phigros-logo' class='phigros-logo ${className}' src='${e(url(branding.logo))}' alt='Phigros'>` : `<span data-motion-key='phigros-wordmark' class='phigros-wordmark ${className}'>Phigros</span>`;
  }
  function clubLogos(className = '') {
    const logos = [['soc', branding.socLogo, '香港大學動漫聯盟'], ['kirameki', branding.kiramekiLogo, 'Kirameki']];
    const images = logos.filter(([, path]) => path).map(([kind, path, label]) => `<img data-motion-key='club-${kind}' class='club-logo ${kind}' data-club-logo='${kind}' src='${e(url(path))}' alt='${e(label)}'>`).join('');
    return images ? `<div class='club-logos ${className}' aria-label='社團標誌'>${images}</div>` : '';
  }
  function backdrop(holes = []) {
    // The fixed SVG window clips the moving cutout to its calibrated OBS slot.
    // Moving the black mask reveals the video below without moving that source.
    const cutouts = holes.map(([x, y, w, h]) => `<svg data-aperture-window='${x}:${y}:${w}:${h}' x='${x}' y='${y}' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}' overflow='hidden'><rect data-aperture-key='${x}:${y}:${w}:${h}' data-aperture-rect='[${x},${y},${w},${h}]' width='${w}' height='${h}' fill='black'/></svg>`).join('');
    const image = branding.visual ? `<image href='${e(url(branding.visual))}' x='-120' y='-180' width='2160' height='1440' preserveAspectRatio='xMidYMid slice' filter='url(#art-blur)' opacity='.28'/>` : '';
    return `<svg data-motion-static class='broadcast-backdrop' viewBox='0 0 1920 1080' aria-hidden='true'><defs><mask id='capture-mask' maskUnits='userSpaceOnUse' x='0' y='0' width='1920' height='1080'><rect x='12' y='12' width='1896' height='1056' fill='white'/>${cutouts}</mask><linearGradient id='event-gradient' x1='0' y1='0' x2='1' y2='1'><stop stop-color='#321c35'/><stop offset='.55' stop-color='#24232e'/><stop offset='1' stop-color='#111820'/></linearGradient><filter id='art-blur'><feGaussianBlur stdDeviation='48'/></filter></defs><g mask='url(#capture-mask)'><rect width='1920' height='1080' fill='url(#event-gradient)'/>${image}<path d='M 1420 0 L 1130 1080 L 1920 1080 L 1920 0 Z' fill='#080d15' opacity='.17'/><rect x='13' y='13' width='1894' height='1054' fill='none' stroke='#e8e3ef' stroke-opacity='.24' stroke-width='2'/></g></svg>`;
  }
  function header(s, context = '') {
    return `<header class='topbar'><div class='brand'>${logo()}<span data-motion-key='event-title' class='event-title'>${e(s.event.title)}</span></div><div class='header-right'>${context ? `<div data-motion-block class='topmeta'>${e(context)}</div>` : ''}${clubLogos()}</div></header>`;
  }
  function footer(label, context = '') {
    return `<footer data-motion-block class='footer'><span>${e(label)}</span>${context ? `<span>${e(context)}</span>` : ''}</footer>`;
  }
  function title(text, sub = '') {
    return `<div data-motion-block class='scene-head'><h1>${e(text)}</h1>${sub ? `<p>${e(sub)}</p>` : ''}</div>`;
  }
  function visual(className = '') {
    return branding.visual ? `<figure data-motion-key='event-art' class='key-visual ${className}'><img src='${e(url(branding.visual))}' alt='ACAHKU Phigros competition artwork'></figure>` : '';
  }
  const entrant = (s, id) => ({ id, name: id ? `${B.player(s, id)?.number ? '#' + B.player(s, id).number + ' · ' : ''}${B.name(s, id)}` : '待定' });
  const entrantText = player => `<span${player.id ? ` data-motion-key='player-${e(player.id)}'` : ''}>${e(player.name)}</span>`;
  const songText = song => `<span data-motion-key='song-${e(song?.hidden ? 'sealed' : song?.id || 'pending')}'>${e(song?.title || '選曲中')}</span>`;
  function start(s) {
    const clubs = clubLogos('hero-club-logos');
    return backdrop() + `<div class='event-start ${branding.visual ? 'with-art' : 'without-art'}'>${visual('start-art')}<section class='event-copy'>${logo('hero-logo')}<h1 data-motion-block style='font-size:${s.event.title.length > 60 ? 60 : s.event.title.length > 36 ? 78 : 90}px'>${e(s.event.title)}</h1><p data-motion-block class='event-line'>${e(B.date(s.event.date))}<br>${e(s.event.time)} · ${e(s.event.venue)}</p><div class='organiser-row ${clubs ? 'with-club-logos' : ''}'><p data-motion-block class='organiser'>${e(s.event.organiserZH || s.event.organiser)}</p>${clubs}</div></section></div>`;
  }
  function waiting(s, context, label, names, currentSong, songCount, song) {
    return backdrop() + header(s, context) + `<div class='waiting-body ${branding.visual ? 'with-art' : 'without-art'}'><section class='waiting-copy'><div data-motion-block class='section-label'>準備中 <span>PREPARING</span></div><h1 data-motion-block>${e(label)}</h1><div class='waiting-players'>${names.map(player => `<p data-motion-block>${entrantText(player)}</p>`).join('')}</div><div data-motion-block class='waiting-song'><span>接下來 · SONG ${currentSong + 1} / ${songCount}</span><h2>${songText(song)}</h2></div></section>${visual('waiting-art')}</div>`;
  }
  function qualifierWaiting(s) {
    const q = s.qualifier, songs = q.groups[q.activeGroup].songs;
    const tie = B.qualifierTiebreak(s);
    return waiting(s, '預選賽 · QUALIFIERS', tie ? `TIEBREAK ${tie.index + 1}` : B.qualifierLabel(s), q.activePlayers.map(id => entrant(s, id)), tie ? 0 : q.currentSong, tie ? 1 : 3, tie?.song || B.song(s, songs[q.currentSong]));
  }
  function doubleWaiting(s) {
    const m = B.currentMatch(s);
    if (!m) return backdrop() + header(s, '雙淘汰賽') + title('等待晉級選手', 'DOUBLE ELIMINATION') + visual('standby-art');
    const tie = B.matchTiebreak(s);
    return waiting(s, m.id === 'GF' ? '總決賽 · GRAND FINALS' : '雙淘汰賽 · DOUBLE ELIMINATION', `R${m.round} · ${m.id}${tie ? ` · TIEBREAK ${tie.index + 1}` : ''}`, m.players.map(id => entrant(s, id)), tie ? 0 : m.currentSong, tie ? 1 : m.id === 'GF' ? 3 : 2, tie?.song || m.songs[m.currentSong]);
  }
  function playerName(s, id, scores, songs, index, kind) {
    const total = scores?.some(score => score !== null && score !== undefined) ? B.score(B.total(scores)) : '—';
    const scoresLine = details ? `<div class='song-scores'>${songs.map((song, i) => `<span class='score-row' title='${e(song?.title || '待定')}'>S${i + 1} <b>${B.score(scores?.[i])}</b></span>`).join('')}</div>` : '';
    return `<section data-motion-block class='player-info ${kind} player-${index + 1}'><div class='player-name'><h2>${entrantText(entrant(s, id))}</h2><div class='player-total'><span>TOTAL</span><strong>${total}</strong></div></div>${scoresLine}</section>`;
  }
  function capture(rect, kind = 'gameplay', player = '', playerId = '') {
    const [x, y, width, height] = rect;
    return `<div data-motion-key='capture-${x}:${y}:${width}:${height}' data-motion-static class='capture ${kind}' data-capture-key='${x}:${y}:${width}:${height}' data-capture='${kind}' data-feed='${kind === 'webcam' ? 'handcam' : 'capture-card'}' data-player-id='${e(playerId || '')}' aria-label='${e(player)} ${kind === 'webcam' ? '手元 handcam' : '采集卡 capture card'}' style='left:${x}px;top:${y}px;width:${width}px;height:${height}px'></div>`;
  }
  function handcam(rect, name, id) {
    const [x, y, width] = rect;
    return `<span data-motion-block class='handcam-label' style='left:${x}px;top:${y - 44}px;width:${width}px'>手元 · HANDCAM</span>` + capture(rect, 'webcam', name, id);
  }
  function songBand(song, current, count, kind = '', label = '') {
    return `<div data-motion-block class='song-band ${kind}'><span>${e(label || `SONG ${current + 1} / ${count}`)}</span><h2>${songText(song)}</h2>${song && !song.hidden ? `<span class='difficulty'>${e(song.difficulty)} ${e(song.level)}</span>` : ''}</div>`;
  }
  function qualifierMatch(s) {
    const q = s.qualifier, songs = q.groups[q.activeGroup].songs.map(id => B.song(s, id));
    const tie = B.qualifierTiebreak(s);
    const cameras = showHandcams(s);
    const frames = [[64, 300, 576, 324], [672, 300, 576, 324], [1280, 300, 576, 324]];
    const cams = cameras ? [[64, 800, 240, 135], [672, 800, 240, 135], [1280, 800, 240, 135]] : [];
    return backdrop([...frames, ...cams]) + header(s, B.qualifierLabel(s)) + `<div class='match-layout qualifier ${cameras ? 'with-cameras' : ''}'>${frames.map((rect, i) => {
      const id = q.activePlayers[i], name = id ? B.name(s, id) : '待定';
      return playerName(s, id, tie ? [tie.scores[id] ?? null] : B.player(s, id)?.scores, tie ? [tie.song] : songs, i, 'qualifier-player') + capture(rect, 'gameplay', name, id) + (cams[i] ? handcam(cams[i], name, id) : '');
    }).join('')}${songBand(tie?.song || songs[q.currentSong], q.currentSong, 3, 'qualifier-song', tie ? `TIEBREAK ${tie.index + 1}` : '')}</div>`;
  }
  function doubleMatch(s) {
    const m = B.currentMatch(s);
    if (!m) return doubleWaiting(s);
    const cameras = showHandcams(s);
    const frames = [[64, 280, 872, 490.5], [984, 280, 872, 490.5]];
    const cams = cameras ? [[64, 846, 224, 126], [1632, 846, 224, 126]] : [];
    const count = m.id === 'GF' ? 3 : 2, songs = m.songs.length ? m.songs : Array(count).fill(null);
    const tie = B.matchTiebreak(s);
    return backdrop([...frames, ...cams]) + header(s, `${m.id === 'GF' ? '總決賽' : '雙淘汰賽'} · R${m.round} · ${m.id}`) + `<div class='match-layout double ${cameras ? 'with-cameras' : ''}'>${m.players.map((id, i) => playerName(s, id, tie ? [tie.scores[i]] : m.scores[i], tie ? [tie.song] : songs, i, 'double-player') + capture(frames[i], 'gameplay', id ? B.name(s, id) : '待定', id) + (cams[i] ? handcam(cams[i], id ? B.name(s, id) : '待定', id) : '')).join('')}${songBand(tie?.song || m.songs[m.currentSong], m.currentSong, count, 'double-song', tie ? `TIEBREAK ${tie.index + 1}` : '')}</div>`;
  }
  function qualifierResults(s) {
    const ranks = ['A', 'B'].map(group => B.rankings(s, group));
    const compact = ranks.some(group => group.length > 4);
    return backdrop() + header(s, '預選賽 · QUALIFIERS') + title('現在排名', 'CURRENT RANKING') + `<div class='ranking-tables ${compact ? 'compact' : ''}'>${['A', 'B'].map((group, i) => {
      const players = ranks[i], pages = Math.max(1, Math.ceil(players.length / 8));
      const page = fixedRankPage ? Math.min(rankPage - 1, pages - 1) : rankingTick % pages;
      const from = page * 8, visible = players.slice(from, from + 8);
      return `<section data-motion-block><h2>${e(B.qualifierLabel(s, group))}${pages > 1 ? `<span class='rank-range'>${from + 1}–${Math.min(from + 8, players.length)} / ${players.length}</span>` : ''}</h2><table><thead><tr><th>#</th><th>Player</th><th>Total</th></tr></thead><tbody>${visible.map(p => `<tr><td>${p.rank}${p.tied ? ' =' : ''}</td><td>${e(p.name)}</td><td>${p.scores.some(n => n !== null) ? B.score(p.total) : '—'}</td></tr>`).join('')}</tbody></table></section>`;
    }).join('')}</div>` + footer(ranks.some(group => group.length > 8) && !fixedRankPage ? `${s.qualifier.plan === 'A' ? '各輪獨立排名' : '各組分開排名'} · 每 12 秒換頁` : s.qualifier.plan === 'A' ? '各輪獨立排名 · ROUND STANDINGS' : '各組分開排名 · GROUP STANDINGS');
  }
  function result(s) {
    if (s.stage === 'qualifier') return qualifierResults(s);
    const r = s.result;
    if (!r) return backdrop() + header(s, '比賽結果') + title('等待比賽結果', 'RESULTS');
    const index = r.players.indexOf(r.winnerId), placement = r.placements[r.winnerId] || 'ADVANCES';
    return backdrop() + header(s, `比賽結果 · R${r.round} · ${r.matchId}`) + `<div class='result-wrap'><section data-motion-block class='winner-panel'><div class='section-label'>${e(placement)}</div><h1>${r.winnerId ? entrantText(entrant(s, r.winnerId)) : '空缺場次'}</h1>${r.type === 'score' ? `<div class='winner-score'>${B.score(r.totals[index])}</div>${['accuracy', 'tiebreak'].includes(r.decisionReason) ? `<p class='result-note'>${r.decisionReason === 'accuracy' ? 'WIN ON ACCURACY' : 'TIEBREAK WINNER'}</p>` : ''}` : `<p class='result-note'>${e(r.type === 'forfeit' ? '對手取消資格 · FORFEIT' : r.type === 'draw' ? '抽籤晉級' : '輪空晉級')}</p>`}</section><section class='result-rows'>${r.players.filter(Boolean).map(id => { const i = r.players.indexOf(id); return `<div data-motion-block class='result-row result-${BroadcastBracket.destination(s, s.tournament.matches.find(m => m.id === r.matchId), id)?.kind || ''}'><h2>${id === r.winnerId ? e(B.name(s, id)) : entrantText(entrant(s, id))}</h2><strong>${r.type === 'score' ? B.score(r.totals[i]) : '—'}</strong><p>${e(BroadcastBracket.destination(s, s.tournament.matches.find(m => m.id === r.matchId), id)?.label || r.placements[id] || '—')}</p></div>`; }).join('')}</section></div>`;
  }
  function bracket(s) {
    if (!s.tournament.seeded) return backdrop() + header(s, '賽程') + title('等待晉級選手', 'TOURNAMENT BRACKET');
    return backdrop() + header(s, `賽程 · ${s.tournament.matches.filter(m => m.status === 'complete').length} / 14`) + BroadcastBracket.render(s, bracketMotion.round);
  }
  function selection(s) {
    const m = B.currentMatch(s);
    if (!m) return doubleWaiting(s);
    const tie = B.matchTiebreak(s), focus = tie?.song || m.songs[m.currentSong] || m.candidates.find(c => c.id === m.bans.filter(Boolean).at(-1)) || m.candidates[0];
    return backdrop() + header(s, `R${m.round} · ${m.id}`) + title(tie ? `TIEBREAK ${tie.index + 1}` : m.id === 'GF' ? '決賽選曲' : '選曲', 'SONG SELECTION') + `<div class='selection'><div class='candidate-list ${m.id === 'GF' ? 'final-list' : ''}'>${(tie ? [tie.song] : m.candidates).map((song, i) => {
      const banned = m.bans.indexOf(song.id), picked = m.songs.some(x => !x.hidden && x.id === song.id);
      return `<div data-motion-key='candidate-${e(song.id)}' class='candidate ${banned >= 0 ? 'banned' : ''} ${picked ? 'picked' : ''}'><span class='index'>${String(i + 1).padStart(2, '0')}</span><h3>${e(song.title)}</h3><span class='candidate-status'>${banned >= 0 ? 'BAN' : picked ? 'PICK' : e(song.difficulty + ' ' + song.level)}</span></div>`;
    }).join('') || `<p data-motion-block class='empty-copy'>選曲中</p>`}</div><section><div data-motion-key='selection-cover' class='selection-art'><img src='${e(art(focus))}' alt='${e(focus?.title || 'Song artwork')}'></div><div class='selection-detail'><h2>${songText(focus)}</h2><div data-motion-block class='picks'>${m.songs.map((song, i) => `<span>${i + 1} · ${e(song.title)}</span>`).join('')}</div></div><div data-motion-block class='selection-state'>${m.id === 'GF' ? `<span>AUDIENCE · ${m.audiencePicks.length}/2</span><span>MC · ${m.hostRevealed ? 'REVEALED' : 'SEALED'}</span>` : m.players.map((id, i) => `<span>${e(id ? B.name(s, id) : '待定')} · ${m.bans[i] ? 'BAN ✓' : m.bansConfirmed?.[i] ? 'PASS ✓' : 'CHOOSING'}</span>`).join('')}</div></section></div>`;
  }
  const renderers = { start, 'qualifier-waiting': qualifierWaiting, 'double-elimination-waiting': doubleWaiting, 'qualifier-match': qualifierMatch, 'double-elimination-match': doubleMatch, result, bracket, 'song-selection': selection };
  function render() {
    if (!state) return;
    const scene = fixed || !follow ? requested === 'live' ? state.scene : requested : state.scene;
    refreshCountdown();
    bracketMotion.prepare(state, scene === 'bracket' && state.tournament.seeded);
    const next = (renderers[scene] || start)(state);
    const mode = showHandcams(state) ? 'dual' : 'single', hasVisual = !!branding.visual, revision = state.revision;
    const m = B.currentMatch(state), focus = B.matchTiebreak(state)?.song || m?.songs[m.currentSong] || m?.candidates.find(c => c.id === m.bans.filter(Boolean).at(-1)) || m?.candidates[0];
    const focusIndex = m?.candidates.findIndex(song => song.id === focus?.id);
    motion.update(next, { scene, animateEntries: scene !== 'bracket', onCommit({ previousScene }) {
      canvas.dataset.renderedScene = scene;
      canvas.dataset.renderedRevision = String(revision);
      canvas.dataset.branding = hasVisual ? 'visual' : 'text';
      canvas.dataset.displayMode = mode;
      const windowEl = mount.querySelector('.selection-art'), src = windowEl ? art(focus) : undefined;
      if (windowEl && previousScene !== scene) {
        BroadcastMotion.coverSlide(windowEl, committedCover, 1, { src, alt: focus?.title || 'Song artwork', immediate: true });
      } else if (windowEl && committedCover) {
        const direction = focusIndex >= 0 && committedFocus >= 0 && focusIndex < committedFocus ? -1 : 1;
        BroadcastMotion.coverSlide(windowEl, committedCover, direction, { src, alt: focus?.title || 'Song artwork' });
      }
      committedCover = src; committedFocus = focusIndex;
      bracketMotion.afterCommit();
    } });
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
  countdownClient = BroadcastCountdown.createClient(socket, refreshCountdown);
  socket.on('state', next => { state = next; render(); });
  socket.on('connect', () => canvas.classList.remove('is-offline'));
  socket.on('disconnect', () => canvas.classList.add('is-offline'));
  socket.on('connect_error', () => canvas.classList.add('is-offline'));
})();
