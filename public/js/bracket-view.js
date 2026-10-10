(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BroadcastBracket = api;
})(typeof window === 'undefined' ? globalThis : window, function (root) {
  'use strict';
  const GROUP = { WB: '勝者組', LB: '敗者組', GF: '總決賽' };
  const EASE = 'cubic-bezier(.22, 1, .36, 1)', HOLD = 3400, EXIT = 700, EXPAND = 950;
  const signature = m => m.status === 'complete' ? JSON.stringify([m.winnerId, m.loserId, m.resultType]) : '';
  function focusRound(state) {
    return state.tournament.matches.find(m => m.status !== 'complete')?.round || 6;
  }
  function destination(state, match, playerId) {
    if (!playerId || match.status !== 'complete') return null;
    const won = playerId === match.winnerId;
    const target = state.tournament.matches.find(m => m.sources.some(source => source.value === match.id && source.type === (won ? 'winner' : 'loser')));
    if (target) return { kind: won ? 'win' : 'loss', target: target.id, round: target.round,
      label: `${won ? '晉級' : '轉入'} ${GROUP[target.bracket]} · R${target.round} / ${target.id}` };
    if (match.id === 'GF') return { kind: won ? 'champion' : 'runner-up', target: null, label: won ? '冠軍 · CHAMPION' : '亞軍 · RUNNER-UP' };
    return { kind: 'eliminated', target: null, label: match.id === 'L6' ? '季軍 · 淘汰' : '淘汰 · ELIMINATED' };
  }
  function nextMatches(state, round) {
    const ids = new Set(state.tournament.matches.filter(m => m.round === round).map(m => m.id));
    return state.tournament.matches.filter(m => m.sources.some(source => source.type !== 'seed' && ids.has(source.value)));
  }
  function render(state, round) {
    const B = root.Broadcast, e = B.escape, matches = state.tournament.matches;
    const current = matches.filter(m => m.round === round), next = nextMatches(state, round);
    const sourceName = source => source.type === 'seed' ? `種子 #${source.value}` : `${source.value} ${source.type === 'winner' ? '勝者' : '敗者'}`;
    function card(m, preview) {
      return `<article class="bracket-node ${preview ? 'destination-card' : 'focus-card'} ${e(m.status)}" data-match="${e(m.id)}">
        <header class="match-heading"><b>${e(m.id)}</b><span>${GROUP[m.bracket]}${preview ? ` · R${m.round}` : ''}</span><em>${m.status === 'complete' ? '已結束' : m.status === 'live' ? '進行中' : m.status === 'ready' ? '待開始' : '待定'}</em></header>
        ${m.players.map((id, index) => {
          const route = destination(state, m, id), won = id && id === m.winnerId;
          const tone = route?.kind || '', name = id ? B.name(state, id) : m.status === 'pending' ? sourceName(m.sources[index]) : '輪空';
          return `<div class="bracket-player ${e(tone)}" data-bracket-player="${e(id || '')}" data-slot="${m.id}:${index}">
            <div class="player-line"><span class="outcome-mark">${route ? won ? '勝' : '負' : String(index + 1).padStart(2, '0')}</span><strong title="${e(name)}">${e(name)}</strong>${!preview && m.resultType === 'score' ? `<span class="bracket-total">${B.score(B.total(m.scores[index]))}</span>` : ''}</div>
            ${!preview ? `<div class="bracket-route"${route ? ` data-route="${e(route.kind)}"` : ''}><i aria-hidden="true">${route ? '→' : '·'}</i><span>${e(route?.label || (m.resultType === 'bye' || m.resultType === 'draw' ? '輪空／抽籤晉級' : m.status === 'pending' ? sourceName(m.sources[index]) : '等待賽果'))}</span></div>` : ''}
          </div>`;
        }).join('')}
      </article>`;
    }
    const final = matches.find(m => m.id === 'GF'), champion = final?.winnerId, runner = final?.loserId, third = matches.find(m => m.id === 'L6')?.loserId;
    return `<div class="bracket-page-heading"><h1>雙淘汰賽進度</h1><p class="bracket-legend"><span>勝者／晉級</span><span>敗者／轉組</span><span>淘汰</span></p></div>
      <nav class="bracket-rail" aria-label="Round progress">${[1,2,3,4,5,6].map(r => {
        const group = matches.filter(m => m.round === r), done = group.filter(m => m.status === 'complete').length;
        return `<div class="round-step ${r === round ? 'focused' : ''} ${done === group.length ? 'finished' : ''}" data-round-step="${r}"><b>${r === 6 ? 'FINAL' : 'R'+r}</b><span>${done} / ${group.length}${done === group.length ? ' ✓' : ''}</span></div>`;
      }).join('')}</nav>
      <div class="bracket-board" data-focus-round="${round}">
        <section class="bracket-focus" data-motion-key="bracket-round-${round}" data-count="${current.length}"><div class="focus-heading"><h2>${round === 6 ? '總決賽' : 'ROUND '+round}</h2><span>${current.filter(m => m.status === 'complete').length} / ${current.length} 場完成</span></div><div class="focus-matches">${current.map(m => card(m, false)).join('')}</div></section>
        <aside class="bracket-destinations" data-motion-key="bracket-destinations"><div class="destination-heading"><h2>${next.length ? '晉級去向' : '最終名次'}</h2><span>${next.length ? 'ADVANCEMENT' : 'PODIUM'}</span></div><div class="destination-matches">${next.length ? next.map(m => card(m, true)).join('') : `<div class="bracket-podium"><span>CHAMPION</span><h3>${e(champion ? B.name(state, champion) : '冠軍待定')}</h3><span>RUNNER-UP</span><h3>${e(runner ? B.name(state, runner) : '亞軍待定')}</h3><span>THIRD PLACE</span><h3>${e(third ? B.name(state, third) : '季軍待定')}</h3></div>`}</div></aside>
      </div>`;
  }
  function createController(mount, requestRender, fixedRound = null) {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    let seen = null, latest, active = false, round = null, hold = null, timer, pending = null, reveal = null, transition = null, generation = 0;
    const animations = new Set(), restores = [];
    const clock = () => document.timeline.currentTime ?? performance.now();
    function clearVisuals() {
      generation++;
      for (const animation of animations) animation.cancel(); animations.clear();
      for (const restore of restores.splice(0).reverse()) restore();
      mount.querySelectorAll('[data-bracket-ghost]').forEach(n => n.remove());
    }
    function clearHold() { clearTimeout(timer); timer = null; hold = null; }
    function setRound(next) {
      if (next === round) return;
      const old = mount.querySelector('.bracket-focus');
      transition = active && old && !reduce.matches ? { old, start: clock(), to: next } : null;
      round = next;
    }
    function schedule() {
      clearTimeout(timer);
      if (!hold) return;
      timer = setTimeout(() => {
        hold = null; setRound(fixedRound || focusRound(latest)); requestRender();
      }, Math.max(0, hold - clock()));
    }
    function prepare(state, isActive) {
      latest = state;
      const nextSeen = new Map(state.tournament.matches.map(m => [m.id, signature(m)]));
      const corrected = seen && [...seen].some(([id, sig]) => sig && nextSeen.get(id) !== sig);
      const finished = seen ? state.tournament.matches.filter(m => signature(m) && !seen.get(m.id)) : [];
      seen = nextSeen;
      clearVisuals();
      if (corrected) { pending = reveal = transition = null; clearHold(); round = fixedRound || focusRound(state); }
      if (finished.length) pending = { ids: finished.map(m => m.id), round: finished.at(-1).round };
      if (!isActive) { active = false; transition = reveal = null; clearHold(); return round; }
      const entering = !active; active = true;
      if (entering) round = fixedRound || focusRound(state);
      if (pending) {
        // A ready later-round match can finish before the current round.
        // Keep the earliest unfinished round visible while revealing its results.
        round = fixedRound || Math.min(pending.round, focusRound(state));
        reveal = { ...pending, start: clock() + (entering ? 1900 : 0) }; pending = null;
        transition = null;
        if (!reduce.matches && !fixedRound) { hold = reveal.start + HOLD; schedule(); }
        else { clearHold(); round = fixedRound || focusRound(state); }
      } else if (!hold && !transition) setRound(fixedRound || focusRound(state));
      if (round === null) round = fixedRound || focusRound(state);
      return round;
    }
    function afterCommit() {
      if (!active) return;
      const board = mount.querySelector('.bracket-board');
      if (!board) return;
      const token = generation, jobs = [], now = clock();
      const animate = (node, frames, duration, start, onFinish) => {
        if (!node || reduce.matches || now >= start + duration) return;
        const animation = node.animate(frames, { duration, easing: EASE, fill: 'both' });
        animation.startTime = start; animations.add(animation);
        jobs.push(animation.finished.catch(() => {}).then(() => { if (token === generation) onFinish?.(); animations.delete(animation); animation.cancel(); }));
      };
      if (transition && !reduce.matches) {
        board.dataset.bracketPhase = 'round-transition';
        const { old, start } = transition;
        if (now < start + EXIT && !old.isConnected) {
          const ghost = document.createElement('div'); ghost.dataset.bracketGhost = ''; ghost.dataset.motionGhost = '';
          ghost.setAttribute('aria-hidden', 'true'); ghost.inert = true;
          for (const n of [old, ...old.querySelectorAll('[data-motion-key]')]) n.removeAttribute('data-motion-key');
          ghost.append(old); board.append(ghost);
          animate(old, [{ opacity: 1, transform: 'translateX(0) scale(1)' }, { opacity: 0, transform: 'translateX(-90px) scale(.92)' }], EXIT, start, () => ghost.remove());
        }
        animate(board.querySelector('.bracket-focus'), [{ opacity: 0, transform: 'translateX(96px) scale(.86)' }, { opacity: 1, transform: 'translateX(0) scale(1)' }], EXPAND, start + EXIT);
        animate(board.querySelector('.bracket-destinations'), [{ opacity: 0, transform: 'translateX(24px)' }, { opacity: 1, transform: 'translateX(0)' }], 650, start + EXIT + 140);
      }
      if (reveal && now < reveal.start + 2400 && !reduce.matches && !transition) {
        board.dataset.bracketPhase = 'result';
        for (const id of reveal.ids) {
          const m = latest.tournament.matches.find(m => m.id === id);
          if (!m) continue;
          for (const [index, playerId] of [m.winnerId, m.loserId].entries()) {
            if (!playerId) continue;
            const row = board.querySelector(`.bracket-focus [data-match="${id}"] [data-bracket-player="${CSS.escape(playerId)}"]`);
            const start = reveal.start + index * 220;
            animate(row, [{ backgroundColor: 'transparent' }, { backgroundColor: index ? '#ffbc7938' : '#75e6b838', offset: .35 }, { backgroundColor: 'transparent' }], 1600, start);
            animate(row?.querySelector('.bracket-route'), [{ opacity: 0, transform: 'translateX(22px)' }, { opacity: 1, transform: 'translateX(0)' }], 650, start + 180);
            animate(row?.querySelector('.bracket-route i'), [{ transform: 'translateX(8px)', opacity: 0 }, { transform: 'translateX(-5px)', opacity: 1, offset: .7 }, { transform: 'translateX(0)', opacity: 1 }], 850, start + 260);
            const route = destination(latest, m, playerId);
            const target = route?.target && board.querySelector(`.bracket-destinations [data-match="${route.target}"] [data-bracket-player="${CSS.escape(playerId)}"]`);
            animate(target, [{ backgroundColor: 'transparent' }, { backgroundColor: index ? '#ffbc7955' : '#75e6b855', offset: .4 }, { backgroundColor: 'transparent' }], 1200, start + 800);
          }
        }
      }
      if (!jobs.length) { board.dataset.bracketPhase = 'idle'; transition = null; return; }
      Promise.all(jobs).then(() => {
        if (token !== generation) return;
        clearVisuals(); transition = null; board.dataset.bracketPhase = 'idle';
      });
    }
    reduce.addEventListener('change', () => {
      if (reduce.matches) { clearVisuals(); clearHold(); transition = reveal = null; if (latest) round = fixedRound || focusRound(latest); requestRender(); }
    });
    return { prepare, afterCommit, get round() { return round; } };
  }
  return { focusRound, destination, nextMatches, render, createController };
});
