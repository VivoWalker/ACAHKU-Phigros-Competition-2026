(function () {
  const B = Broadcast, e = B.escape, canvas = document.getElementById('canvas'), mount = document.getElementById('scene');
  const lifecycle = new AbortController(), brandingRequest = new AbortController();
  const listen = (target, type, handler) => target.addEventListener(type, handler, { signal: lifecycle.signal });
  let pageDisposed = false, brandingTimer;
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
  let state, committedCover, branding = { logo: null, visual: null, socLogo: null, kiramekiLogo: null };
  let bootReady = false, resolveInitialState;
  const initialState = new Promise(resolve => { resolveInitialState = resolve; });
  const displayMedia = BroadcastDisplayMedia.createClient();
  const mediaWarmup = BroadcastMediaWarmup.createController({ maxDecoded: 12, concurrency: 2, timeoutMs: 2200, fontTimeoutMs: 1800,
    onStatus(status) {
      if (pageDisposed) return;
      canvas.dataset.mediaWarmup = status.targetPending ? 'loading' : status.failed ? 'fallback' : 'ready';
      canvas.dataset.mediaDecoded = String(status.ready);
      canvas.dataset.mediaPending = String(status.targetPending);
    }
  });
  const motion = BroadcastMotion.createScene(mount, { canvas });
  const countdownLayer = BroadcastCountdown.createLayer(canvas);
  let countdownClient;
  let previewCatalog = new Map(), previewFocus = null, previewRenderPending = false, obsActive = true, obsVisible = true;
  const previewEnabled = query.get('preview') !== '1' && query.get('audio') !== '0';
  const bgmScenes = new Map(), bgmTracks = new Map();
  const bgmVolume = query.has('bgmVolume') && Number.isFinite(Number(query.get('bgmVolume')))
    ? Math.max(0, Math.min(1, Number(query.get('bgmVolume')))) : .25;
  const bgmEnabled = previewEnabled && query.get('bgm') !== '0' && bgmVolume > 0;
  const bgmAllowedScenes = new Set(['start', 'qualifier-waiting', 'qualifier-processing', 'double-elimination-waiting', 'song-result', 'result', 'bracket', 'grand-final-announcement']);
  let bgmStatus = 'silent', selectionStatus = 'silent', audioSyncPending = false;
  const audioPrompt = document.createElement('button');
  audioPrompt.type = 'button'; audioPrompt.className = 'selection-audio-prompt';
  audioPrompt.textContent = 'Enable broadcast audio · 啟用直播音訊'; audioPrompt.hidden = true;
  document.body.append(audioPrompt);
  let previewClockAnchor;
  const previewNow = () => {
    const synced = countdownClient?.now() || 0, localNow = performance.now();
    if (synced > 0) previewClockAnchor = { serverNow: synced, localNow };
    // Reconnection briefly resets the countdown client's anchor. Keep our last
    // synchronized clock until the new sample arrives, never the wall clock.
    return previewClockAnchor ? previewClockAnchor.serverNow + localNow - previewClockAnchor.localNow : 0;
  };
  const selectionAudio = BroadcastSelectionAudio.createPlayer({ enabled: previewEnabled, now: previewNow,
    onFocus(songId) {
      if (pageDisposed) return;
      if (previewFocus === songId) return;
      previewFocus = songId;
      if (!previewRenderPending) {
        previewRenderPending = true;
        queueMicrotask(() => { previewRenderPending = false; render(); });
      }
    },
    onStatus(status) {
      if (pageDisposed) return;
      canvas.dataset.selectionAudio = status.state;
      canvas.dataset.selectionAudioSong = status.songId || '';
      selectionStatus = status.state; refreshAudioPrompt();
      // A preview's outgoing fade owns the audio until its element is released.
      // Starting menu music from this status callback would overlap that fade.
      if (!audioSyncPending) {
        audioSyncPending = true;
        queueMicrotask(() => { audioSyncPending = false; syncBgm(); });
      }
    }
  });
  const sceneBgm = BroadcastSceneBgm.createPlayer({ enabled: bgmEnabled, gain: bgmVolume,
    onStatus(status) {
      if (pageDisposed) return;
      bgmStatus = status.state;
      canvas.dataset.sceneBgm = status.state; canvas.dataset.sceneBgmTrack = status.trackId || '';
      refreshAudioPrompt();
    }
  });
  listen(audioPrompt, 'click', () => { selectionAudio.retry(); sceneBgm.retry(); });
  const shownScene = () => fixed || !follow ? requested === 'live' ? state?.scene : requested : state?.scene;
  const finalAudioScene = (scene, current = state && B.currentMatch(state)) => BroadcastFinalAnnouncement.isFixed(current)
    && !B.matchTiebreak(state) && (scene === 'grand-final-announcement'
      || scene === 'song-selection' && !!BroadcastFinalAnnouncement.audioCue(current));
  function refreshAudioPrompt() {
    if (pageDisposed) return;
    const scene = shownScene(), finale = finalAudioScene(scene);
    const onAir = previewEnabled && obsActive && obsVisible && !document.hidden && countdownClient?.connected && scene === state?.scene;
    audioPrompt.hidden = !onAir || !(bgmStatus === 'blocked' && bgmAllowedScenes.has(scene) && scene !== 'grand-final-announcement' && !finale
      || selectionStatus === 'blocked' && (scene === 'song-selection' || finale));
  }
  function syncBgm() {
    if (pageDisposed) return;
    const scene = shownScene();
    const active = bootReady && bgmEnabled && obsActive && obsVisible && !document.hidden && countdownClient?.connected
      && scene === state?.scene && bgmAllowedScenes.has(scene) && scene !== 'grand-final-announcement'
      && !finalAudioScene(scene) && !selectionAudio.hasMedia;
    sceneBgm.update({ track: bgmTracks.get(bgmScenes.get(scene)) || null, active: !!active });
    refreshAudioPrompt();
  }
  listen(document, 'visibilitychange', () => { render(); syncBgm(); });
  const refreshCountdown = () => countdownLayer.update(countdownClient, state, shownScene());
  const requestedRound = Number(query.get('round'));
  const bracketMotion = BroadcastBracket.createController(mount, () => render(), Number.isInteger(requestedRound) && requestedRound >= 1 && requestedRound <= 6 ? requestedRound : null);
  const finaleEffects = BroadcastFinaleEffects.createController({ canvas, now: previewNow, onPhaseChange: () => render() });
  function syncFinaleEffects() {
    finaleEffects.update({ match: state?.stage === 'double-elimination' ? B.currentMatch(state) : null,
      scene: shownScene(), active: bootReady && obsActive && obsVisible && !document.hidden && countdownClient?.connected === true });
  }
  const url = path => '/' + encodeURI(path);
  const displayPath = path => displayMedia.resolve(path);
  const art = song => url(displayPath(song?.art || 'assets/song/cover-1.svg'));
  function sharedImages() {
    return [branding.logo, branding.visual, branding.socLogo, branding.kiramekiLogo].filter(Boolean).map(path => url(displayPath(path)))
      .concat(displayMedia.background(branding.visual) ? [url(displayMedia.background(branding.visual))] : []);
  }
  function sceneImages(s, scene) {
    const match = B.currentMatch(s);
    if (scene === 'grand-final-announcement' || scene === 'song-selection' && match?.finalMode === 'fixed-two' && !B.matchTiebreak(s)) return B.fixedFinalSongs(s).filter(song => !song.hidden).map(art).concat('/assets/finale/error-texture.png');
    if (scene === 'song-selection') { const focus = selectionFocus(s); return focus && !focus.hidden ? [art(focus)] : []; }
    return [];
  }
  function warmImages(s, scene) {
    const shared = sharedImages(), visible = sceneImages(s, scene), match = B.currentMatch(s);
    const final = s.tournament.matches.find(entry => entry.id === 'GF');
    if (BroadcastFinalAnnouncement.isFixed(final) && ['ready', 'live', 'complete'].includes(final.status))
      shared.push('/assets/finale/error-texture.png');
    const candidates = match?.id !== 'GF' ? (match?.candidates || []).filter(song => !song.hidden).map(art) : [];
    const finals = B.fixedFinalSongs(s).filter(song => !song.hidden).map(art);
    mediaWarmup.setImages([...shared, ...visible, ...candidates, ...finals], { priority: visible, pinned: shared });
    return [...shared, ...visible];
  }
  function selectionFocus(s) {
    const m = B.currentMatch(s), tie = B.matchTiebreak(s);
    const preview = m?.id !== 'GF' && !tie ? [...(m?.songs || []), ...(m?.candidates || [])].find(song => song.id === previewFocus) : null;
    return tie?.song || preview || m?.songs[m.currentSong] || m?.candidates.find(c => c.id === m.selectionPreviewCue?.songIds[0]) || m?.candidates.find(c => c.id === m.bans.filter(Boolean).at(-1)) || m?.candidates[0];
  }
  function previewSongs(m) {
    return [...(m?.songs || []), ...(m?.candidates || [])].filter(song => !song.hidden).map(song => {
      const bundled = previewCatalog.get(song.id);
      const previewAudio = Object.hasOwn(song, 'previewAudio') ? song.previewAudio : bundled?.output || '';
      const finalDuration = m?.id === 'GF' && m.finalMode === 'fixed-two'
        ? BroadcastFinalAnnouncement.PREVIEW_DURATION : undefined;
      return { ...song, previewAudio, previewDuration: previewAudio === bundled?.output ? bundled.duration : finalDuration };
    });
  }
  function fit() {
    const scale = Math.min(innerWidth / 1920, innerHeight / 1080);
    canvas.style.transform = `scale(${scale})`;
    canvas.style.left = `${(innerWidth - 1920 * scale) / 2}px`;
    canvas.style.top = `${(innerHeight - 1080 * scale) / 2}px`;
  }
  listen(window, 'resize', fit); fit();
  function logo(className = '') {
    return branding.logo ? `<img data-motion-key='phigros-logo' class='phigros-logo ${className}' src='${e(url(displayPath(branding.logo)))}' alt='Phigros'>` : `<span data-motion-key='phigros-wordmark' class='phigros-wordmark ${className}'>Phigros</span>`;
  }
  function clubLogos(className = '') {
    const logos = [['soc', branding.socLogo, '香港大學動漫聯盟'], ['kirameki', branding.kiramekiLogo, 'Kirameki']];
    const images = logos.filter(([, path]) => path).map(([kind, path, label]) => `<img data-motion-key='club-${kind}' class='club-logo ${kind}' data-club-logo='${kind}' src='${e(url(displayPath(path)))}' alt='${e(label)}'>`).join('');
    return images ? `<div class='club-logos ${className}' aria-label='社團標誌'>${images}</div>` : '';
  }
  function backdrop(holes = []) {
    // The fixed SVG window clips the moving cutout to its calibrated OBS slot.
    // Moving the black mask reveals the video below without moving that source.
    const cutouts = holes.map(([x, y, w, h]) => `<svg data-aperture-window='${x}:${y}:${w}:${h}' x='${x}' y='${y}' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}' overflow='hidden'><rect data-aperture-key='${x}:${y}:${w}:${h}' data-aperture-rect='[${x},${y},${w},${h}]' width='${w}' height='${h}' fill='black'/></svg>`).join('');
    const baked = displayMedia.background(branding.visual);
    const image = baked ? `<image href='${e(url(baked))}' x='0' y='0' width='1920' height='1080' opacity='.28'/>` : branding.visual ? `<image href='${e(url(branding.visual))}' x='-120' y='-180' width='2160' height='1440' preserveAspectRatio='xMidYMid slice' filter='url(#art-blur)' opacity='.28'/>` : '';
    const blur = baked ? '' : `<filter id='art-blur'><feGaussianBlur stdDeviation='48'/></filter>`;
    return `<svg data-motion-static class='broadcast-backdrop' viewBox='0 0 1920 1080' aria-hidden='true'><defs><mask id='capture-mask' maskUnits='userSpaceOnUse' x='0' y='0' width='1920' height='1080'><rect x='12' y='12' width='1896' height='1056' fill='white'/>${cutouts}</mask><linearGradient id='event-gradient' x1='0' y1='0' x2='1' y2='1'><stop stop-color='#321c35'/><stop offset='.55' stop-color='#24232e'/><stop offset='1' stop-color='#111820'/></linearGradient>${blur}</defs><g mask='url(#capture-mask)'><rect width='1920' height='1080' fill='url(#event-gradient)'/>${image}<path d='M 1420 0 L 1130 1080 L 1920 1080 L 1920 0 Z' fill='#080d15' opacity='.17'/><rect x='13' y='13' width='1894' height='1054' fill='none' stroke='#e8e3ef' stroke-opacity='.24' stroke-width='2'/></g></svg>`;
  }
  function header(s, context = '') {
    return `<header class='topbar'><div class='brand'>${logo()}<span data-motion-key='event-title' class='event-title'>${e(s.event.title)}</span></div><div class='header-right'>${context ? `<div data-motion-block class='topmeta'>${e(context)}</div>` : ''}${clubLogos()}</div></header>`;
  }
  function footer(context) {
    return context ? `<footer data-motion-block class='footer'><span>${e(context)}</span></footer>` : '';
  }
  function title(text, sub = '') {
    return `<div data-motion-block class='scene-head'><h1>${e(text)}</h1>${sub ? `<p>${e(sub)}</p>` : ''}</div>`;
  }
  function visual(className = '') {
    return branding.visual ? `<figure data-motion-key='event-art' class='key-visual ${className}'><img src='${e(url(displayPath(branding.visual)))}' alt='ACAHKU Phigros competition artwork'></figure>` : '';
  }
  const entrant = (s, id) => ({ id, name: id ? `${B.player(s, id)?.number ? '#' + B.player(s, id).number + ' · ' : ''}${B.name(s, id)}` : '待定' });
  const entrantText = player => `<span${player.id ? ` data-motion-key='player-${e(player.id)}'` : ''}>${e(player.name)}</span>`;
  const songText = song => `<span data-motion-key='song-${e(song?.hidden ? 'sealed' : song?.id || 'pending')}'>${e(song?.title || '選曲中')}</span>`;
  function start(s) {
    const clubs = clubLogos('hero-club-logos');
    return backdrop() + `<div class='event-start ${branding.visual ? 'with-art' : 'without-art'}'>${visual('start-art')}<section class='event-copy'>${logo('hero-logo')}<h1 data-motion-block style='font-size:${s.event.title.length > 60 ? 60 : s.event.title.length > 36 ? 78 : 90}px'>${e(s.event.title)}</h1><p data-motion-block class='event-line'>${e(B.date(s.event.date))}<br>${e(s.event.time)} · ${e(s.event.venue)}</p><div class='organiser-row ${clubs ? 'with-club-logos' : ''}'><p data-motion-block class='organiser'>${e(s.event.organiserZH || s.event.organiser)}</p>${clubs}</div></section></div>`;
  }
  function waiting(s, context, label, names, currentSong, songCount, song, selectionNext = false) {
    return backdrop() + header(s, context) + `<div class='waiting-body ${branding.visual ? 'with-art' : 'without-art'}'><section class='waiting-copy'><div data-motion-block class='section-label'>準備中 <span>PREPARING</span></div><h1 data-motion-block>${e(label)}</h1><div class='waiting-players'>${names.map(player => `<p data-motion-block>${entrantText(player)}</p>`).join('')}</div><div data-motion-block class='waiting-song'><span>${selectionNext ? '選曲前準備 · SONG SELECTION NEXT' : `接下來 · SONG ${currentSong + 1} / ${songCount}`}</span><h2>${selectionNext ? '即將開始選曲' : songText(song)}</h2></div></section>${visual('waiting-art')}</div>`;
  }
  function qualifierWaiting(s) {
    const q = s.qualifier, songs = q.groups[q.activeGroup].songs;
    const tie = B.qualifierTiebreak(s);
    return waiting(s, B.challengeQualifier(s) ? '課題模式 · CHALLENGE MODE' : '預選賽 · QUALIFIERS', tie ? `TIEBREAK ${tie.index + 1}` : B.qualifierLabel(s), q.activePlayers.map(id => entrant(s, id)), tie ? 0 : q.currentSong, tie ? 1 : 3, tie?.song || B.song(s, songs[q.currentSong]));
  }
  function qualifierProcessing(s) {
    return backdrop() + header(s, B.qualifierLabel(s)) + `<section data-motion-block class='qualifier-processing-panel'><h1>結果正在統計中</h1><p>RESULTS PROCESSING</p></section>`;
  }
  function doubleWaiting(s) {
    const m = B.currentMatch(s);
    if (!m) return backdrop() + header(s, '雙淘汰賽') + title('等待晉級選手', 'DOUBLE ELIMINATION') + visual('standby-art');
    const tie = B.matchTiebreak(s);
    return waiting(s, m.id === 'GF' ? '總決賽 · GRAND FINALS' : '雙淘汰賽 · DOUBLE ELIMINATION', `R${m.round} · ${m.id}${tie ? ` · TIEBREAK ${tie.index + 1}` : ''}`, m.players.map(id => entrant(s, id)), tie ? 0 : m.currentSong, tie ? 1 : B.matchSongCount(m), tie?.song || m.songs[m.currentSong], !tie && !m.songs.length);
  }
  function playerName(s, id, scores, songs, index, kind, directTotal) {
    const total = directTotal !== undefined ? B.score(directTotal) : scores?.some(score => score !== null && score !== undefined) ? B.score(B.total(scores)) : '—';
    const scoresLine = details && directTotal === undefined ? `<div class='song-scores'>${songs.map((song, i) => `<span class='score-row' title='${e(song?.title || '待定')}'>S${i + 1} <b>${B.score(scores?.[i])}</b></span>`).join('')}</div>` : '';
    const totalLabel = kind === 'qualifier-player' && B.challengeQualifier(s) ? 'CHALLENGE TOTAL' : 'TOTAL';
    return `<section data-motion-block class='player-info ${kind} player-${index + 1}'><div class='player-name'><h2>${entrantText(entrant(s, id))}</h2><div class='player-total'><span>${totalLabel}</span><strong>${total}</strong></div></div>${scoresLine}</section>`;
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
    const tie = B.qualifierTiebreak(s), challenge = B.challengeQualifier(s);
    const cameras = showHandcams(s);
    const frames = [[64, 300, 576, 324], [672, 300, 576, 324], [1280, 300, 576, 324]];
    const cams = cameras ? [[64, 800, 240, 135], [672, 800, 240, 135], [1280, 800, 240, 135]] : [];
    return backdrop([...frames, ...cams]) + header(s, `${B.qualifierLabel(s)}${challenge ? ' · 課題模式' : ''}`) + `<div class='match-layout qualifier ${cameras ? 'with-cameras' : ''}'>${frames.map((rect, i) => {
      const id = q.activePlayers[i], name = id ? B.name(s, id) : '待定';
      const directTotal = challenge ? tie ? tie.scores[id] ?? null : B.qualifierTotal(s, B.player(s, id)) : undefined;
      return playerName(s, id, tie ? [tie.scores[id] ?? null] : B.player(s, id)?.scores, tie ? [tie.song] : songs, i, 'qualifier-player', directTotal) + capture(rect, 'gameplay', name, id) + (cams[i] ? handcam(cams[i], name, id) : '');
    }).join('')}${songBand(tie?.song || songs[q.currentSong], q.currentSong, 3, 'qualifier-song', tie ? `TIEBREAK ${tie.index + 1}` : '')}</div>`;
  }
  function doubleMatch(s) {
    const m = B.currentMatch(s);
    if (!m) return doubleWaiting(s);
    const cameras = showHandcams(s);
    const frames = [[64, 280, 872, 490.5], [984, 280, 872, 490.5]];
    const cams = cameras ? [[64, 846, 224, 126], [1632, 846, 224, 126]] : [];
    const count = B.matchSongCount(m), songs = m.songs.length ? m.songs : Array(count).fill(null);
    const tie = B.matchTiebreak(s);
    return backdrop([...frames, ...cams]) + header(s, `${m.id === 'GF' ? '總決賽' : '雙淘汰賽'} · R${m.round} · ${m.id}`) + `<div class='match-layout double ${cameras ? 'with-cameras' : ''}'>${m.players.map((id, i) => playerName(s, id, tie ? [tie.scores[i]] : m.scores[i], tie ? [tie.song] : songs, i, 'double-player') + capture(frames[i], 'gameplay', id ? B.name(s, id) : '待定', id) + (cams[i] ? handcam(cams[i], id ? B.name(s, id) : '待定', id) : '')).join('')}${songBand(tie?.song || m.songs[m.currentSong], m.currentSong, count, 'double-song', tie ? `TIEBREAK ${tie.index + 1}` : '')}</div>`;
  }
  function qualifierResults(s) {
    const ranks = ['A', 'B'].map(group => B.rankings(s, group));
    const compact = ranks.some(group => group.length > 4), challenge = B.challengeQualifier(s);
    return backdrop() + header(s, challenge ? '課題模式 · CHALLENGE MODE' : '預選賽 · QUALIFIERS') + title('現在排名', challenge ? 'CHALLENGE TOTAL STANDINGS' : 'CURRENT RANKING') + `<div class='ranking-tables ${compact ? 'compact' : ''}'>${['A', 'B'].map((group, i) => {
      const players = ranks[i], pages = Math.max(1, Math.ceil(players.length / 8));
      const page = fixedRankPage ? Math.min(rankPage - 1, pages - 1) : rankingTick % pages;
      const from = page * 8, visible = players.slice(from, from + 8);
      return `<section data-motion-block><h2>${e(B.qualifierLabel(s, group))}${pages > 1 ? `<span class='rank-range'>${from + 1}–${Math.min(from + 8, players.length)} / ${players.length}</span>` : ''}</h2><table><thead><tr><th>#</th><th>Player</th><th>${challenge ? '課題總分' : 'Total'}</th></tr></thead><tbody>${visible.map(p => `<tr><td>${challenge && p.total === null ? '—' : `${p.rank}${p.tied ? ' =' : ''}`}</td><td>${e(p.name)}</td><td>${challenge ? B.score(p.total) : p.scores.some(n => n !== null) ? B.score(p.total) : '—'}</td></tr>`).join('')}</tbody></table></section>`;
    }).join('')}</div>`;
  }
  function challengeSetResult(s) {
    const q = s.qualifier, entries = B.qualifierPlayers(s, q.activeGroup);
    const songs = q.groups[q.activeGroup].songs.map(id => B.song(s, id));
    const players = q.activePlayers.slice(0, 3).filter(Boolean);
    const card = id => {
      const player = entries.find(entry => entry.id === id);
      const rows = songs.map((song, index) => {
        const stats = player?.songStats?.[index];
        const score = B.score(stats?.score);
        return `<section class='challenge-set-song' data-song-index='${index}' data-song-id='${e(song?.id || '')}'><div class='challenge-set-song-heading'><span>SONG ${index + 1}</span><h3 title='${e(song?.title || '選曲中')}'>${e(song?.title || '選曲中')}</h3><span>${song ? `${e(song.difficulty)} ${e(Math.trunc(song.level))}` : '—'}</span></div><dl class='challenge-set-judgements'><div class='challenge-set-song-score'><dt>SCORE</dt><dd data-stat='score' style='font-size:${Math.min(34, Math.floor(255 / score.length))}px'>${score}</dd></div>${['perfect', 'good', 'bad', 'miss'].map(key => { const value = B.score(stats?.[key]); return `<div class='judgement-${key}'><dt>${key.toUpperCase()}</dt><dd data-stat='${key}' title='${e(value)}' style='font-size:${Math.max(16, Math.min(30, Math.floor(135 / value.length)))}px'>${value}</dd></div>`; }).join('')}</dl></section>`;
      }).join('');
      // The game's three-song total is authoritative. Do not infer it from
      // display evidence or replace an unrecorded result with a zero.
      return `<article data-motion-block class='challenge-set-card' data-player-id='${e(id)}'><h2>${entrantText(entrant(s, id))}</h2><div class='challenge-set-songs'>${rows}</div><div class='challenge-set-total'><span>課題總分 · CHALLENGE TOTAL</span><strong data-stat='challengeTotal'>${B.score(player?.challengeTotal)}</strong></div></article>`;
    };
    return backdrop() + header(s, '課題模式 · CHALLENGE MODE') + `<section data-motion-block class='challenge-set-heading'><p>${e(B.qualifierLabel(s))} · 3 SONGS</p><h1>課題總成績 <span>CHALLENGE RESULTS</span></h1></section><div class='challenge-set-results' data-count='${players.length}'>${players.map(card).join('') || '<p data-motion-block class="song-result-empty">等待選手 · AWAITING PLAYERS</p>'}</div>` + footer('遊戲結算總分 · OFFICIAL CHALLENGE TOTAL');
  }
  function songResult(s) {
    const qualifier = s.stage === 'qualifier', q = s.qualifier, m = B.currentMatch(s);
    if (!qualifier && !m) return backdrop() + header(s, '單曲統計') + title('等待比賽成績', 'SONG STATISTICS');
    const tie = qualifier ? B.qualifierTiebreak(s) : B.matchTiebreak(s);
    if (qualifier && B.challengeQualifier(s) && !tie) return challengeSetResult(s);
    const index = qualifier ? q.currentSong : m.currentSong, count = qualifier ? 3 : B.matchSongCount(m);
    const song = tie?.song || (qualifier ? B.song(s, q.groups[q.activeGroup].songs[index]) : m.songs[index]);
    const context = qualifier ? B.qualifierLabel(s) : `R${m.round} · ${m.id} · ${m.label}`;
    const entries = qualifier ? B.qualifierPlayers(s, q.activeGroup) : [];
    const players = (qualifier ? q.activePlayers.slice(0, 3) : m.players.slice(0, 2)).filter(Boolean);
    const card = (id, pi) => {
      if (!qualifier) pi = m.players.indexOf(id);
      const player = entries.find(entry => entry.id === id);
      const stored = qualifier ? player?.songStats?.[index] : null;
      const legacy = qualifier && !Array.isArray(player?.songStats);
      const judgements = tie ? qualifier ? tie.judgements?.[id] : tie.judgements?.[pi] : qualifier ? stored || (legacy ? player?.judgements?.[index] : null) : m.judgements?.[pi]?.[index];
      const score = tie ? qualifier ? tie.scores?.[id] : tie.scores?.[pi] : qualifier ? stored?.score ?? (legacy ? player?.scores?.[index] : null) : m.scores?.[pi]?.[index];
      return `<article data-motion-block class='song-result-card' data-player-id='${e(id)}'><h2>${entrantText(entrant(s, id))}</h2><div class='song-result-total'><span>單曲分數 · SONG SCORE</span><strong class='song-result-score' data-stat='score'>${B.score(score)}</strong></div><dl class='song-result-judgements'>${['perfect', 'good', 'bad', 'miss'].map(key => { const value = B.score(judgements?.[key]); return `<div class='judgement-${key}'><dt>${key.toUpperCase()}</dt><dd data-stat='${key}' style='font-size:${Math.min(46, Math.floor(350 / value.length))}px'>${value}</dd></div>`; }).join('')}</dl></article>`;
    };
    return backdrop() + header(s, qualifier ? '預選賽 · 單曲統計' : '雙淘汰賽 · 單曲統計') + `<section data-motion-block class='song-result-heading'><p><span>${e(context)}</span><span>${tie ? `TIEBREAK ${tie.index + 1}` : `SONG ${index + 1} / ${count}`}</span>${song ? `<span>${e(song.difficulty)} ${e(Math.trunc(song.level))}</span>` : ''}</p><h1>${songText(song)}</h1></section><div class='song-result-cards' data-count='${players.length}'>${players.map(card).join('') || '<p data-motion-block class="song-result-empty">等待選手 · AWAITING PLAYERS</p>'}</div>`;
  }
  function result(s) {
    if (s.stage === 'qualifier') return qualifierResults(s);
    const r = s.result;
    if (!r) return backdrop() + header(s, '比賽結果') + title('等待比賽結果', 'RESULTS');
    const index = r.players.indexOf(r.winnerId), placement = r.placements[r.winnerId] || 'ADVANCES';
    const completed = s.tournament.matches.find(match => match.id === r.matchId);
    return backdrop() + header(s, `比賽結果 · R${r.round} · ${r.matchId}`) + `<div class='result-wrap'><section data-motion-block class='winner-panel'><div class='section-label'>${e(placement)}</div><h1>${r.winnerId ? entrantText(entrant(s, r.winnerId)) : '空缺場次'}</h1>${r.type === 'score' ? `<div class='winner-score'>${B.score(r.totals[index])}</div>${['accuracy', 'tiebreak'].includes(r.decisionReason) ? `<p class='result-note'>${r.decisionReason === 'accuracy' ? 'WIN ON ACCURACY' : 'TIEBREAK WINNER'}</p>` : ''}` : `<p class='result-note'>${e(r.type === 'forfeit' ? '對手取消資格 · FORFEIT' : r.type === 'draw' ? '抽籤晉級' : '輪空晉級')}</p>`}</section><section class='result-rows'>${r.players.filter(Boolean).map(id => { const i = r.players.indexOf(id); return `<div data-motion-block class='result-row result-${BroadcastBracket.destination(s, completed, id)?.kind || ''}'><h2>${id === r.winnerId ? e(B.name(s, id)) : entrantText(entrant(s, id))}</h2><strong>${r.type === 'score' ? B.score(r.totals[i]) : '—'}</strong>${r.type === 'score' && completed ? `<div class='result-song-scores'>${completed.songs.map((song, si) => `<span title='${e(song.title)}'>SONG ${si + 1}<b>${B.score(completed.scores?.[i]?.[si])}</b></span>`).join('')}</div>` : ''}<p>${e(BroadcastBracket.destination(s, completed, id)?.label || r.placements[id] || '—')}</p></div>`; }).join('')}</section></div>`;
  }
  function bracket(s) {
    if (!s.tournament.seeded) return backdrop() + header(s, '賽程') + title('等待晉級選手', 'TOURNAMENT BRACKET');
    return backdrop() + header(s, `賽程 · ${s.tournament.matches.filter(m => m.status === 'complete').length} / 14`) + BroadcastBracket.render(s, bracketMotion.round);
  }
  function selection(s) {
    const m = B.currentMatch(s);
    if (!m) return doubleWaiting(s);
    if (m.finalMode === 'fixed-two' && !B.matchTiebreak(s)) return grandFinalAnnouncement(s);
    const tie = B.matchTiebreak(s), focus = selectionFocus(s);
    return backdrop() + header(s, `R${m.round} · ${m.id}`) + title(tie ? `TIEBREAK ${tie.index + 1}` : m.id === 'GF' ? '決賽選曲' : '選曲', 'SONG SELECTION') + `<div class='selection'><div class='candidate-list ${m.id === 'GF' ? 'final-list' : ''}'>${(tie ? [tie.song] : m.candidates).map((song, i) => {
      const banned = m.bans.indexOf(song.id), picked = m.songs.some(x => !x.hidden && x.id === song.id);
      return `<div data-motion-key='candidate-${e(song.id)}' class='candidate ${banned >= 0 ? 'banned' : ''} ${picked ? 'picked' : ''}'><span class='index'>${String(i + 1).padStart(2, '0')}</span><h3>${e(song.title)}</h3><span class='candidate-status'>${banned >= 0 ? 'BAN' : picked ? 'PICK' : e(song.difficulty + ' ' + song.level)}</span></div>`;
    }).join('') || `<p data-motion-block class='empty-copy'>選曲中</p>`}</div><section><div data-motion-key='selection-cover' class='selection-art'><img src='${e(art(focus))}' alt='${e(focus?.title || 'Song artwork')}'></div><div class='selection-detail'><h2>${songText(focus)}</h2><div data-motion-block class='picks'>${m.songs.map((song, i) => `<span>${i + 1} · ${e(song.title)}</span>`).join('')}</div></div><div data-motion-block class='selection-state'>${m.finalMode === 'fixed-two' ? `<span>加賽曲目 · TIEBREAK SONG</span>` : m.id === 'GF' ? `<span>AUDIENCE · ${m.audiencePicks.length}/2</span><span>MC · ${m.hostRevealed ? 'REVEALED' : 'SEALED'}</span>` : m.players.map((id, i) => `<span>${e(id ? B.name(s, id) : '待定')} · ${m.bans[i] ? 'BAN ✓' : m.bansConfirmed?.[i] ? 'PASS ✓' : 'CHOOSING'}</span>`).join('')}</div></section></div>`;
  }
  function grandFinalAnnouncement(s) {
    const songs = B.fixedFinalSongs(s);
    if (songs.length !== 2) return backdrop() + header(s, 'GRAND FINAL') + title('等待總決賽曲目', 'GRAND FINAL');
    const phase = BroadcastFinalAnnouncement.phase(B.currentMatch(s), previewNow());
    const heading = backdrop() + header(s, 'GRAND FINAL') + title('總決賽曲目', 'GRAND FINAL · SONG REVEAL');
    if (!phase.started || phase.pending) return heading + `<section data-motion-block class='final-song-card final-announcement-pending'><h2>等待公布</h2><p>AWAITING REVEAL</p></section>`;
    const index = phase.index, song = songs[index];
    return heading + `<article data-motion-key='final-song-${e(song.id)}' data-final-song='${e(song.id)}' data-final-index='${index}' class='final-song-card final-announcement-hero'><div data-motion-key='final-cover-${e(song.id)}' class='final-song-art'><img src='${e(art(song))}' alt='${e(song.title)}'></div><section class='final-song-info'><div class='final-song-top'><span>SONG ${String(index + 1).padStart(2, '0')} / 02</span></div><strong class='final-song-difficulty'>${e(song.difficulty)} <b>${e(Math.trunc(song.level))}</b></strong><div class='final-song-copy'><h2>${e(song.title)}</h2><p>${e(song.artist)}</p></div></section></article>`;
  }
  const renderers = { start, 'qualifier-waiting': qualifierWaiting, 'qualifier-processing': qualifierProcessing, 'double-elimination-waiting': doubleWaiting, 'qualifier-match': qualifierMatch, 'double-elimination-match': doubleMatch, 'song-result': songResult, result, bracket, 'song-selection': selection, 'grand-final-announcement': grandFinalAnnouncement };
  function render() {
    if (pageDisposed || !state || !bootReady) return;
    const scene = fixed || !follow ? requested === 'live' ? state.scene : requested : state.scene;
    warmImages(state, scene);
    const current = B.currentMatch(state);
    const finaleAudio = finalAudioScene(scene, current);
    const selectionScene = scene === 'song-selection' && current?.id !== 'GF';
    selectionAudio.update({ cue: finaleAudio ? BroadcastFinalAnnouncement.audioCue(current) : current?.selectionPreviewCue, songs: previewSongs(current),
      active: obsActive && obsVisible && !document.hidden && countdownClient?.connected && countdownClient.now() > 0
        && scene === state.scene && state.stage === 'double-elimination' && current?.status !== 'complete'
        && !B.matchTiebreak(state) && (selectionScene || finaleAudio) });
    syncBgm();
    refreshCountdown();
    syncFinaleEffects();
    bracketMotion.prepare(state, scene === 'bracket' && state.tournament.seeded);
    const next = (renderers[scene] || start)(state);
    const mode = showHandcams(state) ? 'dual' : 'single', hasVisual = !!branding.visual, revision = state.revision;
    const focus = selectionFocus(state);
    motion.update(next, { scene, animateEntries: scene !== 'bracket', onCommit({ previousScene }) {
      canvas.dataset.renderedScene = scene;
      canvas.dataset.renderedRevision = String(revision);
      canvas.dataset.branding = hasVisual ? 'visual' : 'text';
      canvas.dataset.displayMode = mode;
      const windowEl = mount.querySelector('.selection-art'), src = windowEl ? art(focus) : undefined;
      if (windowEl && previousScene !== scene) {
        BroadcastMotion.coverSlide(windowEl, committedCover, { src, alt: focus?.title || 'Song artwork', immediate: true, decodeImage: mediaWarmup.decodeImage });
      } else if (windowEl && committedCover) {
        BroadcastMotion.coverSlide(windowEl, committedCover, { src, alt: focus?.title || 'Song artwork', decodeImage: mediaWarmup.decodeImage });
      }
      committedCover = src;
      bracketMotion.afterCommit();
      syncFinaleEffects();
    } });
  }
  const rankingTimer = setInterval(() => {
    if (!fixedRankPage && state?.stage === 'qualifier' && canvas.dataset.renderedScene === 'result' && ['A', 'B'].some(group => B.rankings(state, group).length > 8)) {
      rankingTick++; render();
    }
  }, 12000);
  async function prepareBranding() {
    brandingTimer = setTimeout(() => brandingRequest.abort(), 1800);
    try {
      const response = await fetch('/api/branding', { signal: brandingRequest.signal });
      if (response.ok) {
        const next = await response.json();
        if (!pageDisposed) branding = next;
      }
    } catch (_) { /* Missing branding leaves the existing text fallback. */ }
    finally { clearTimeout(brandingTimer); }
  }
  Promise.all([displayMedia.ready, prepareBranding(), mediaWarmup.prepareFonts(), initialState]).then(async () => {
    if (pageDisposed) return;
    canvas.dataset.displayAssets = displayMedia.status;
    await mediaWarmup.prepare(warmImages(state, shownScene()));
    if (pageDisposed) return;
    bootReady = true; canvas.dataset.mediaBoot = 'ready'; render();
  }).catch(() => { if (!pageDisposed) { bootReady = true; canvas.dataset.mediaBoot = 'fallback'; render(); } });
  fetch('/assets/song-preview/manifest.json', { signal: lifecycle.signal }).then(response => response.ok ? response.json() : null).then(result => {
    if (pageDisposed || !Array.isArray(result?.tracks)) return;
    previewCatalog = new Map(result.tracks.flatMap(track => (track.songIds || []).map(id => [id, track])));
    render();
  }).catch(() => {});
  fetch('/assets/bgm/manifest.json', { signal: lifecycle.signal }).then(response => response.ok ? response.json() : null).then(result => {
    if (pageDisposed || !Array.isArray(result?.tracks)) return;
    for (const track of result.tracks.slice(0, 16)) {
      if (typeof track.id === 'string' && BroadcastSceneBgm.safePath(track.path)) bgmTracks.set(track.id, track);
    }
    for (const scene of bgmAllowedScenes) if (typeof result.scenes?.[scene] === 'string') bgmScenes.set(scene, result.scenes[scene]);
    syncBgm();
  }).catch(() => {});
  function disposePage(event) {
    // A cached history entry keeps its live controllers for restoration.
    if (event.persisted || pageDisposed) return;
    pageDisposed = true;
    lifecycle.abort(); brandingRequest.abort(); clearTimeout(brandingTimer);
    clearInterval(rankingTimer); resolveInitialState();
    countdownClient?.dispose(); countdownLayer.dispose();
    selectionAudio.dispose(); sceneBgm.dispose(); bracketMotion.dispose(); finaleEffects.dispose(); motion.dispose();
    mediaWarmup.dispose(); displayMedia.dispose();
    socket.removeAllListeners(); socket.disconnect();
    previewCatalog.clear(); bgmTracks.clear(); bgmScenes.clear(); state = null; audioPrompt.remove();
  }
  listen(window, 'pagehide', disposePage);
  listen(window, 'obsSourceActiveChanged', event => { obsActive = event.detail?.active !== false; render(); });
  listen(window, 'obsSourceVisibleChanged', event => { obsVisible = event.detail?.visible !== false; render(); });
  const socket = createBroadcastSocket('/overlay');
  countdownClient = BroadcastCountdown.createClient(socket, () => { refreshCountdown(); render(); });
  socket.on('state', next => { state = next; resolveInitialState(); render(); });
  socket.on('connect', () => canvas.classList.remove('is-offline'));
  socket.on('disconnect', () => { canvas.classList.add('is-offline'); syncFinaleEffects(); });
  socket.on('connect_error', () => { canvas.classList.add('is-offline'); syncFinaleEffects(); });
})();
