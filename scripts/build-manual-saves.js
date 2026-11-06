#!/usr/bin/env node
'use strict';

// This generator runs in its own process. Deterministic clocks and randomness
// are installed before loading the tournament modules, never in the server.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--output' || !args[1] || args[1].startsWith('--')))
    throw new Error('Usage: node scripts/build-manual-saves.js [--output DIRECTORY]');
  const output = args.length ? path.resolve(args[1]) : path.join(__dirname, '../test/manual-saves');
  fs.mkdirSync(output, { recursive: true });
  let seed = 0xaca2026, clock = Date.UTC(2026, 0, 1);
  const NativeDate = Date;
  function random() {
    seed = (seed + 0x6D2B79F5) | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  }
  function uuid() {
    const bytes = Buffer.from(Array.from({ length: 16 }, () => Math.floor(random() * 256)));
    bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128;
    const hex = bytes.toString('hex');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
  }
  crypto.randomInt = (min, max) => {
    if (max === undefined) { max = min; min = 0; }
    return min + Math.floor(random() * (max - min));
  };
  crypto.randomUUID = uuid;
  Math.random = random;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { randomUUID: uuid } });
  globalThis.Date = class extends NativeDate {
    constructor(...values) { super(...(values.length ? values : [clock])); }
    static now() { return clock; }
  };
  const T = require('../lib/tournament');
  const Q = require('../public/js/qualifier-rules');
  const Waiting = require('../public/js/waiting-preview');
  const { createDefaultState } = require('../lib/default-state');
  const { validateState } = require('../lib/state-validation');
  const { sourceStatus } = require('../lib/broadcast-check');
  const catalog = [];
  const copy = state => structuredClone(state);
  const match = state => state.tournament.matches.find(m => m.id === state.tournament.currentMatchId);
  function action(state, type, payload = {}) {
    clock += 1000;
    const body = T.CURRENT_MATCH_ACTIONS.has(type) ? { matchId: state.tournament.currentMatchId, ...payload } : payload;
    T.applyAction(state, { type, payload: body });
    state.revision++; state.updatedAt = new Date().toISOString();
    validateState(state);
    return state;
  }
  const command = (type, payload = {}, expected = {}, reject = '') => ({ type, payload, expected, ...(reject ? { reject } : {}) });
  const qCue = (state, scene, group = state.qualifier.activeGroup, songIndex = 2) =>
    action(state, 'set-broadcast-cue', { stage: 'qualifier', scene, group, songIndex,
      players: Q.activeTiebreak(state, group)?.playerIds || Q.entries(state, group).slice(0, 3).map(p => p.id) });
  const deCue = (state, scene, songIndex = 0) =>
    action(state, 'set-broadcast-cue', { stage: 'double-elimination', scene, matchId: match(state).id, songIndex });
  function stats(total) {
    const base = Math.floor(total / 3);
    return Array.from({ length: 3 }, (_, i) => ({ score: base + (i < total % 3 ? 1 : 0),
      perfect: 940 + i * 11, good: 12 + i, bad: 2, miss: 3 - i }));
  }
  function fresh(count = 16, plan = 'A') {
    const state = createDefaultState();
    action(state, 'set-competition-roster', { names: Array.from({ length: count }, (_, i) => 'TEST Player ' + String(i + 1).padStart(2, '0')) });
    action(state, 'set-qualifier-plan', { plan });
    for (const p of state.qualifier.players) action(state, 'set-player-readiness', {
      playerId: p.id, device: true, globalVersion: true, headphones: true, charts: true, streamConsent: true
    });
    state.broadcast.audioVolume = .25;
    qCue(state, 'qualifier-waiting', 'A', 0);
    return state;
  }
  function fillRound(state, group, mode = 'normal') {
    qCue(state, 'qualifier-waiting', group, 0);
    Q.entries(state, group).forEach((p, i) => {
      let total = 2990000 - i * 10000 - (group === 'B' ? 1000 : 0);
      if (mode === 'harmless' && i === 1) total = 2990000;
      if (mode === 'cutoff' || mode === 'three-way') {
        if (i >= 3 && i <= (mode === 'three-way' ? 5 : 4)) total = 2900000;
        else if (i > 3) total = 2880000 - i * 10000;
      }
      action(state, 'set-qualifier-challenge-result', { group, playerId: p.id, total, songStats: stats(total) });
    });
    qCue(state, 'result', group);
    return state;
  }
  function qualifier(mode = 'normal', group = 'A') {
    const state = fresh();
    if (group === 'B') { fillRound(state, 'A'); action(state, 'finalize-qualifier-round', { group: 'A', verified: true }); }
    return fillRound(state, group, mode);
  }
  function startQualifierTie(state) {
    action(state, 'draw-qualifier-tiebreak', { group: state.qualifier.activeGroup, playerIds: Q.tiedSets(state, state.qualifier.activeGroup)[0] });
    return state;
  }
  function qualifierTieScores(state) {
    const group = state.qualifier.activeGroup, tie = Q.activeTiebreak(state);
    tie.playerIds.forEach((playerId, i) => action(state, 'set-qualifier-tiebreak-score', {
      group, index: 0, playerId, score: 980000 + i * 1000,
      judgements: { perfect: 950 + i, good: 12, bad: 1, miss: 2 }
    }));
    return state;
  }
  function seeded() {
    const state = fresh(24, 'B');
    for (const group of ['A', 'B']) { fillRound(state, group); action(state, 'finalize-qualifier-round', { group, verified: true }); }
    action(state, 'qualify', { verified: true });
    action(state, 'set-scene', { scene: 'bracket' });
    return state;
  }
  const seededBase = seeded();
  function selected(id = 'W1', state = copy(seededBase)) {
    action(state, 'select-match', { matchId: id });
    action(state, 'draw-candidates');
    action(state, 'set-scene', { scene: 'song-selection' });
    return state;
  }
  function banned(state) {
    for (const playerIndex of [0, 1]) action(state, 'ban-song', { playerIndex, songId: match(state).candidates[playerIndex].id });
    return state;
  }
  function picked(state = selected()) { banned(state); action(state, 'pick-songs'); return state; }
  function scoreMatch(state, mode = 'normal') {
    for (const playerIndex of [0, 1]) for (let songIndex = 0; songIndex < match(state).scores[0].length; songIndex++) {
      const tied = mode !== 'normal';
      action(state, 'set-match-score', { playerIndex, songIndex,
        score: tied ? 990000 : playerIndex ? 980000 - songIndex * 1000 : 990000 - songIndex * 1000,
        ...(mode === 'missing-accuracy' ? {} : { judgements: { accuracy: mode === 'accuracy' ? playerIndex ? 99 : 99.1234 : 99,
          perfect: 960 - playerIndex * 10, good: 12, bad: 1, miss: 2 } })
      });
    }
    return state;
  }
  function tieMatch() {
    const state = picked(); scoreMatch(state, 'tie'); action(state, 'draw-match-tiebreak'); return state;
  }
  function finalReady() {
    const state = copy(seededBase);
    for (const [id] of T.DEFINITIONS) {
      if (id === 'GF') break;
      selected(id, state); banned(state); action(state, 'pick-songs'); scoreMatch(state);
      action(state, 'record-result', { verified: true });
    }
    action(state, 'select-match', { matchId: 'GF' });
    return state;
  }
  const finalBase = finalReady();
  function finalSealed() {
    const state = copy(finalBase); scoreMatch(state);
    action(state, 'show-final-two-totals'); action(state, 'start-final-finale'); return state;
  }
  function finalRevealed() { const state = finalSealed(); action(state, 'reveal-final-finale'); return state; }
  function finalFinished() {
    const state = finalRevealed(); scoreMatch(state); action(state, 'record-result', { verified: true }); return state;
  }
  const finalDone = finalFinished();
  function save(id, slug, state, title, steps, expected, probes = [], extra = {}) {
    const value = copy(state);
    const bytes = crypto.createHash('sha256').update('manual-save:' + id).digest().subarray(0, 16);
    bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128;
    const hex = bytes.toString('hex');
    value.eventId = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
    value.event.title = '[TEST ' + id + '] ' + title;
    const target = Waiting.context(value);
    if (match(value)?.waitingPreviewCue && target) match(value).waitingPreviewCue.contextKey = target.key;
    validateState(value);
    const file = id + '-' + slug + '.json', contents = JSON.stringify(value, null, 2) + '\n';
    fs.writeFileSync(path.join(output, file), contents);
    const actions = probes.map(probe => ({ ...probe, payload: T.CURRENT_MATCH_ACTIONS.has(probe.type) ?
      { matchId: value.tournament.currentMatchId, ...probe.payload } : probe.payload }));
    catalog.push({ id, title, file, group: id[0], scene: value.scene, stage: value.stage,
      sha256: crypto.createHash('sha256').update(contents).digest('hex'), steps, expected, probes: actions, ...extra });
  }

  const ready = fresh();
  save('Q01', 'ready-countdown', ready, '预选赛准备与开赛倒计时',
    ['打开 OBS 测试源，核对三位选手及 4:3 窗口。', '进入比赛画面，按「開始倒計時 · 3 2 1 START」。'],
    ['三位选手各占一路 webcam。', '完整显示 3、2、1、START 后返回比赛；刷新来源不从头重播。'],
    [command('set-broadcast-cue', { stage: 'qualifier', scene: 'qualifier-match', group: 'A', players: ready.qualifier.activePlayers, songIndex: 0 }, { 'state.scene': 'qualifier-match' })]);
  const input = copy(ready); qCue(input, 'qualifier-processing');
  const first = input.qualifier.activePlayers[0];
  save('Q02', 'challenge-entry', input, 'Challenge 三曲录分',
    ['用记分员页面录入一名选手的三首分数、P/G/B/M 和官方总分。', '先留空一项尝试保存，再补齐保存。'],
    ['缺项不能作为完整成绩保存；0 是合法数值。', '保存后主控与记分员显示同一套 16 项数据。'],
    [command('set-qualifier-challenge-result', { group: 'A', playerId: first, total: 2955000, songStats: stats(2955000) },
      { ['state.qualifier.rounds.A.results.' + first + '.challengeTotal']: 2955000 })]);
  const normalQ = qualifier(); qCue(normalQ, 'song-result');
  save('Q03', 'challenge-results', normalQ, '预选三曲统计结果',
    ['检查当前三名选手的三首歌曲成绩、判定及官方总分。', '进入当前排名。'],
    ['分数和官方总分都已预填，可直接核对。', '切入当前排名从第一页开始；Round 1 尚未确认时只显示本轮。'],
    [command('set-broadcast-cue', { stage: 'qualifier', scene: 'result', group: 'A', players: normalQ.qualifier.activePlayers, songIndex: 2 }, { 'state.scene': 'result' })]);
  const harmless = qualifier('harmless');
  save('Q04', 'harmless-tie', harmless, '非晋级线同分',
    ['观察前两名同分。', '核对本轮，继续复活轮。'],
    ['同分双方都在晋级区，不要求加赛。', '比赛可以正常推进，前四名仍有绿色标记。'],
    [command('finalize-qualifier-round', { group: 'A', verified: true }, { 'state.qualifier.rounds.A.locked': true, 'state.qualifier.activeGroup': 'B' })]);
  const cutoff = qualifier('cutoff');
  save('Q05', 'cutoff-tie', cutoff, '第四第五名同分',
    ['查看当前排名的晋级线。', '按主要操作按钮准备加赛。'],
    ['第四、第五名为黄色，未提前判定谁晋级。', '本轮确认受阻，随后只安排这两位选手加赛。'],
    [command('finalize-qualifier-round', { group: 'A', verified: true }, {}, 'tiebreak'),
      command('draw-qualifier-tiebreak', { group: 'A', playerIds: Q.tiedSets(cutoff, 'A')[0] }, { 'state.scene': 'qualifier-waiting' })]);
  const multiple = qualifier('three-way');
  save('Q06', 'three-way-cutoff', multiple, '三人同分争夺晋级位',
    ['检查第四到第六名的同分标记。', '准备晋级加赛。'],
    ['全部三位相关选手都被标记，不遗漏第三人。', '加赛准备名单包含这三人。'],
    [command('draw-qualifier-tiebreak', { group: 'A', playerIds: Q.tiedSets(multiple, 'A')[0] }, { 'state.qualifier.activePlayers.length': 3 })]);
  const qTie = startQualifierTie(copy(cutoff));
  save('Q07', 'round-one-tiebreak-reveal', qTie, 'Round 1 加赛曲公布',
    ['先观察准备页和记分员页面。', '按「公布加賽曲目」，听完预览后返回准备页。'],
    ['公布前只显示两位选手，曲目保密且记分员锁定。', '公布 Aleph-0、IN 16、曲绘和中英文标题，并播放一次预览。'],
    [command('set-broadcast-cue', { stage: 'qualifier', scene: 'qualifier-tiebreak-announcement', group: 'A', players: qTie.qualifier.activePlayers, songIndex: 0 },
      { 'state.scene': 'qualifier-tiebreak-announcement', 'state.qualifier.rounds.A.tiebreaks.0.revealed': true })]);
  const qScoring = copy(qTie); qCue(qScoring, 'qualifier-tiebreak-announcement', 'A', 0); qCue(qScoring, 'qualifier-processing', 'A', 0);
  save('Q08', 'tiebreak-score-entry', qScoring, '预选加赛判定录入',
    ['在主控和记分员页面分别检查加赛录分表。', '为两人填写分数和 Perfect、Good、Bad、Miss 后保存。'],
    ['两端都有四类判定字段，只显示本场加赛选手。', '保存后统计结果与输入一致。'],
    [command('set-qualifier-tiebreak-score', { group: 'A', index: 0, playerId: qScoring.qualifier.activePlayers[0], score: 987654,
      judgements: { perfect: 940, good: 12, bad: 1, miss: 2 } })]);
  const qResult = qualifierTieScores(copy(qScoring)); qCue(qResult, 'song-result', 'A', 0);
  save('Q09', 'confirmed-qualifiers', qResult, '加赛后确认晋级名单',
    ['核对加赛成绩：右侧选手分数较高。', '确认加赛，再查看晋级名单。'],
    ['加赛胜者进入前四，绿色标记恢复。', '没有黄色未决晋级线；可以确认本轮。'],
    [command('confirm-qualifier-tiebreak', { group: 'A', index: 0, verified: true }, { 'state.scene': 'result' }),
      command('finalize-qualifier-round', { group: 'A', verified: true }, { 'state.qualifier.rounds.A.locked': true })]);
  const revival = startQualifierTie(qualifier('cutoff', 'B'));
  save('Q10', 'revival-tiebreak-reveal', revival, '复活轮加赛曲公布',
    ['按「公布加賽曲目」。', '检查难度、曲绘、标题和乐曲片段。'],
    ['公布 ぱぴぷぴぷぴぱ、IN 15。', '展示的是复活轮加赛，不沿用 Aleph-0。'],
    [command('set-broadcast-cue', { stage: 'qualifier', scene: 'qualifier-tiebreak-announcement', group: 'B', players: revival.qualifier.activePlayers, songIndex: 0 },
      { 'state.scene': 'qualifier-tiebreak-announcement' })]);
  const paged = fresh(24, 'B'); fillRound(paged, 'A'); fillRound(paged, 'B'); qCue(paged, 'result', 'A');
  save('Q11', 'ranking-pagination', paged, 'Plan B 排名循环与重入',
    ['停留排名页至少 12 秒。', '离开排名页，再切回来。'],
    ['每组 12 人，按 8 人一页循环。', '每次进入都从第一页开始，分数更新不把页码强制重置。']);

  const rest = copy(seededBase); action(rest, 'start-intermission');
  save('B01', 'intermission-poster', rest, '中场休息看板',
    ['查看休息画面。', '核对左侧文字和右侧主视觉。'],
    ['左侧显示繁体中文及英文休息标题，右侧为主视觉。', '进入休息页不自动播放预告。'],
    [command('end-intermission', {}, { 'state.stage': 'double-elimination' })]);
  save('B02', 'arcaea-trailer', rest, '中场 Arcaea 视频',
    ['切到「Arcaea 預告」标签，按「播放預告」。', '调节全局音量、静音，再刷新一个 OBS 测试源。'],
    ['另一个页面播放 Arcaea 预告；工作人员预览静音。', '视频与菜单音频不叠加，刷新按同一播放时钟恢复。'],
    [command('play-intermission-video', {}, { 'state.scene': 'arcaea-trailer' })]);
  save('D01', 'seeded-bracket', seededBase, '双淘汰赛签表',
    ['查看 24 人预选产生的八人签表。', '选择 W1，进入准备。'],
    ['八个晋级席位和种子有对应选手。', '待定上游场次不能提前比赛。'],
    [command('select-match', { matchId: 'W1' }, { 'state.tournament.currentMatchId': 'W1' })]);
  const candidates = selected();
  save('D02', 'ban-cards', candidates, 'BAN 曲卡片与难度',
    ['给左侧选手 BAN 一首候选曲。', '核对整块变红、难度等级和 BAN 标记。'],
    ['六首候选都可辨认曲名与难度。', 'BAN 标记不覆盖等级，被禁曲面板明显变红。'],
    [command('ban-song', { playerIndex: 0, songId: match(candidates).candidates[0].id })]);
  const draw = banned(selected());
  save('D03', 'rolling-draw', draw, '滚动抽曲与两首预览',
    ['OBS 测试源准备好后按「Draw 2 match songs」。', '观察整段高亮抽选和音乐预览。'],
    ['四首滚动高亮 → 第一首公布及预览 → 剩三首滚动 → 第二首公布及预览。', '选曲音效跟随全局音量，已 BAN 曲不会被抽中；刷新不重抽。'],
    [command('pick-songs', {}, { 'state.scene': 'song-selection' })]);
  const waiting = picked(); deCue(waiting, 'double-elimination-waiting');
  save('D04', 'upcoming-song-loop', waiting, '下一首准备预览循环',
    ['听准备页正在循环的乐曲片段。', '切换到第二首准备，再进入比赛。'],
    ['只循环下一首要比赛的歌曲。', '进入比赛或统计中后停止片段，音量与其他界面一致。'],
    [command('set-broadcast-cue', { stage: 'double-elimination', scene: 'double-elimination-waiting', matchId: 'W1', songIndex: 1 },
      { 'state.tournament.matches.0.currentSong': 1 })]);
  const gameplay = copy(waiting); deCue(gameplay, 'double-elimination-match');
  save('D05', 'webcam-countdown', gameplay, '双淘汰 webcam 与倒计时',
    ['核对左右选手各一路 4:3 webcam。', '开始倒计时，并在倒数期间刷新一个来源。'],
    ['主画布 1920×1080，视频窗口各为 872×654。', '姓名、总分及曲目不遮挡视频；所有来源显示同一倒数。'],
    [command('set-broadcast-cue', { stage: 'double-elimination', scene: 'double-elimination-processing', matchId: 'W1', songIndex: 0 },
      { 'state.scene': 'double-elimination-processing' })]);
  const processing = picked(); scoreMatch(processing); deCue(processing, 'double-elimination-processing');
  save('D06', 'processing', processing, '单曲结果统计中',
    ['查看统计中画面。', '按主要操作按钮显示本曲统计。'],
    ['左边是「統計中」及英文，右边为主视觉。', '统计中与单曲结果是两个独立步骤。'],
    [command('set-broadcast-cue', { stage: 'double-elimination', scene: 'song-result', matchId: 'W1', songIndex: 0 }, { 'state.scene': 'song-result' })]);
  const songResult = copy(processing); deCue(songResult, 'song-result');
  save('D07', 'single-song-results', songResult, '双淘汰单曲成绩',
    ['核对双方当前单曲的分数和 P/G/B/M。', '按主要操作按钮准备下一首。'],
    ['本页只对应第一首，而非两曲总和。', '下一步切到第二首准备，歌曲标题同步。'],
    [command('set-broadcast-cue', { stage: 'double-elimination', scene: 'double-elimination-waiting', matchId: 'W1', songIndex: 1 },
      { 'state.scene': 'double-elimination-waiting' })]);
  const won = copy(processing); action(won, 'record-result', { verified: true });
  save('D08', 'round-advancement', won, '两曲总分与胜败分流',
    ['查看已确认的 W1 整轮赛果。', '打开 Bracket，核对胜者与败者下一场。'],
    ['显示两首歌、难度、各自分数和总分。', '胜者为绿色，败者转入败者组；整轮结果不显示总 P/G/B/M。'],
    [command('set-broadcast-cue', { stage: 'double-elimination', scene: 'bracket', matchId: 'W1' }, { 'state.scene': 'bracket' })]);
  const lower = copy(seededBase);
  for (const id of ['W1', 'W2', 'W3', 'W4']) { selected(id, lower); banned(lower); action(lower, 'pick-songs'); scoreMatch(lower); action(lower, 'record-result', { verified: true }); }
  selected('L1', lower); banned(lower); action(lower, 'pick-songs'); scoreMatch(lower); action(lower, 'record-result', { verified: true });
  save('D09', 'second-loss-elimination', lower, '败者组淘汰',
    ['查看 L1 结果和下一场流向。', '确认落败选手的显示状态。'],
    ['第二次失利者标为淘汰，使用红色。', '胜者继续败者组；淘汰者不再进入后续对阵。']);
  const missing = picked(); scoreMatch(missing, 'missing-accuracy'); action(missing, 'show-tied-round-result');
  save('D10', 'tied-total-missing-acc', missing, '总分同分与补录 ACC',
    ['观察整轮总分相同的中性结果页。', '通过「補錄各曲 ACC」补齐双方两首 ACC。'],
    ['没有提前显示胜者。', 'ACC 缺失时不能跳过比较直接宣布胜负。'],
    [command('advance-result-presentation', { matchId: 'W1', expectedPhase: 'scores' }, {}, 'accuracy')]);
  const accuracy = picked(); scoreMatch(accuracy, 'accuracy'); action(accuracy, 'show-tied-round-result');
  save('D11', 'reveal-average-acc', accuracy, '公布平均 ACC',
    ['先核对相同的两曲总分，再按「公布平均 ACC」。', '查看两首 ACC 和四位小数的平均值。'],
    ['平均值由两首 ACC 算出。', '公布平均值时双方仍保持中性，胜者尚未发布。'],
    [command('advance-result-presentation', { matchId: 'W1', expectedPhase: 'scores' }, { 'state.tournament.matches.0.resultPresentation': 'accuracy' })]);
  const accuracyShown = copy(accuracy); action(accuracyShown, 'advance-result-presentation', { matchId: 'W1', expectedPhase: 'scores' });
  save('D12', 'acc-verdict', accuracyShown, 'ACC 最终判定',
    ['核对左侧平均 ACC 较高。', '按「公布最終判定」并确认裁判核对。'],
    ['确认之后才显示绿色胜者和晋级流向。', 'Bracket 按 ACC 判定结果推进。'],
    [command('advance-result-presentation', { matchId: 'W1', expectedPhase: 'accuracy', verified: true },
      { 'state.tournament.matches.0.status': 'complete', 'state.tournament.matches.0.resultPresentation': 'verdict' })]);
  const equal = picked(); scoreMatch(equal, 'tie'); action(equal, 'show-tied-round-result');
  action(equal, 'advance-result-presentation', { matchId: 'W1', expectedPhase: 'scores' });
  save('D13', 'equal-acc-tiebreak', equal, '平均 ACC 仍然相同',
    ['查看双方相同的平均 ACC。', '按「平均 ACC 相同 · 準備加賽」。'],
    ['明确提示需要加赛，没有虚构胜者。', '进入只显示两位选手、暂不公布加赛曲的准备页。'],
    [command('advance-result-presentation', { matchId: 'W1', expectedPhase: 'accuracy' },
      { 'state.scene': 'double-elimination-waiting', 'state.tournament.matches.0.tiebreaks.length': 1 })]);
  const deTie = tieMatch();
  save('D14', 'tiebreak-reveal', deTie, '双淘汰加赛曲公布',
    ['先查看准备页与记分员锁定状态。', '按「公布加賽曲目」，听预览，再回准备页。'],
    ['公布前曲目保密；公布页有中英文大标题、曲绘、歌名、难度与等级。', '返回准备页后保留歌名和难度。'],
    [command('set-broadcast-cue', { stage: 'double-elimination', scene: 'double-elimination-tiebreak-announcement', matchId: 'W1' },
      { 'state.scene': 'double-elimination-tiebreak-announcement', 'state.tournament.matches.0.tiebreaks.0.revealed': true })]);
  const deTieScoring = copy(deTie); deCue(deTieScoring, 'double-elimination-tiebreak-announcement'); deCue(deTieScoring, 'double-elimination-processing');
  save('D15', 'tiebreak-score-entry', deTieScoring, '双淘汰加赛判定录入',
    ['打开主控与记分员，填写双方加赛分数和 P/G/B/M。', '保存后进入本曲统计。'],
    ['两端都有四类判定输入。', '当前仅有这一首加赛，不会误写基础两曲成绩。'],
    [command('set-match-tiebreak-score', { index: 0, playerIndex: 0, score: 987654, judgements: { accuracy: 99, perfect: 950, good: 12, bad: 1, miss: 2 } })]);
  const deTieResult = copy(deTieScoring);
  for (const playerIndex of [0, 1]) action(deTieResult, 'set-match-tiebreak-score', { index: 0, playerIndex, score: playerIndex ? 990000 : 980000,
    judgements: { accuracy: 99, perfect: 950, good: 12, bad: 1, miss: 2 } });
  deCue(deTieResult, 'song-result');
  save('D16', 'tiebreak-confirmation', deTieResult, '加赛确认后整轮赛果',
    ['核对右侧选手赢得加赛。', '确认加赛并确认整轮赛果。'],
    ['确认后右侧选手晋级。', '基础两曲仍是同分；判定依据标为加赛，不篡改原始成绩。'],
    [command('confirm-match-tiebreak', { index: 0, verified: true }),
      command('record-result', { verified: true }, { 'state.result.decisionReason': 'tiebreak' })]);

  const announce = copy(finalBase); delete match(announce).finalAnnouncement;
  // Announcement is optional persisted runtime metadata; prepare its idle
  // screen so the operator starts the actual shared clock after OBS is ready.
  announce.scene = 'grand-final-announcement';
  save('F01', 'fixed-song-announcement', announce, '决赛前两曲依次公布',
    ['准备 OBS 测试源，按「公布決賽第一首」。', '观察两首固定曲依次公布与预览。'],
    ['Cthugha 与 Petrichor 使用同一时钟依次公布。', '当前比赛歌曲与公布流程不会互相覆盖。'],
    [command('start-final-announcement', { songIndex: 0 }, { 'state.scene': 'grand-final-announcement' })]);
  const subtotal = copy(finalBase); scoreMatch(subtotal); action(subtotal, 'show-final-two-totals');
  save('F02', 'provisional-two-totals', subtotal, '决赛前两首中途总成绩',
    ['核对双方前两首分数与小计。', '进入最后一首的神秘准备。'],
    ['这里只是中途成绩，没有宣布冠军。', '第三首仍须比赛并计入最终总分。'],
    [command('start-final-finale', {}, { 'state.scene': 'double-elimination-waiting', 'state.tournament.matches.13.finale.stage': 'sealed' })]);
  const sealed = finalSealed();
  save('F03', 'concealed-final-song', sealed, '最后一首保密准备',
    ['查看 OBS 和记分员页面。', '检查第三首信息与输入权限。'],
    ['OBS 使用神秘曲等待表现。', '公布前记分员看不到歌曲真实标题，第三首录分被锁定。'],
    [command('set-match-score', { playerIndex: 0, songIndex: 2, score: 990000 }, {}, 'Reveal')]);
  save('F04', 'final-version-pv', sealed, '新版 Ending Song Video',
    ['准备好 OBS 测试源，按「播放公布視頻」。', '完整播放，期间检查音量、静音和工作人员预览。'],
    ['播放新版 1080p/24fps PV，按 88.512 秒计时。', '播完自动回到准备页并公布 What do you want more than a Happy ending? / AT 17。'],
    [command('play-final-finale-video', {}, { 'state.scene': 'grand-final-video', 'state.tournament.matches.13.finale.videoCue.duration': 88.512 })]);
  const revealed = finalRevealed();
  save('F05', 'purification-effects', revealed, '最后一首净化效果',
    ['检查公布后的歌曲与难度。', '按顺序尝试三阶段净化，再恢复普通效果。'],
    ['红色侵入效果逐步清除，文字抖动逐步减弱。', '最终阶段清除附加效果；视频与信息层位置保持正确。'],
    [command('set-final-finale-effect', { level: 1 }), command('set-final-finale-effect', { level: 2 }),
      command('set-final-finale-effect', { level: 3 }, { 'state.tournament.matches.13.finale.effectLevel': 3 })]);
  const lastSong = copy(revealed); deCue(lastSong, 'double-elimination-processing', 2);
  save('F06', 'third-song-entry', lastSong, '决赛第三首录分',
    ['在记分员页面录入第三首分数及判定。', '主控检查三首累计，再核对整轮赛果。'],
    ['第三首已经解锁，可正常录分。', '三首全部完成前不能确认最终胜者。'],
    [command('record-result', { verified: true }, {}, 'every'),
      command('set-match-score', { playerIndex: 0, songIndex: 2, score: 997000, judgements: { accuracy: 99.7, perfect: 980, good: 8, bad: 0, miss: 1 } })]);
  save('F07', 'three-song-result', finalDone, '决赛整轮三曲赛果',
    ['核对三首分数及总和。', '进入赛事总排名。'],
    ['三首成绩一起决定冠军。', '结果页包含三首歌曲与难度，没有总 P/G/B/M 行。'],
    [command('set-broadcast-cue', { stage: 'double-elimination', scene: 'final-standings' }, { 'state.scene': 'final-standings' })]);
  const finalAccuracy = finalRevealed(); scoreMatch(finalAccuracy, 'accuracy'); action(finalAccuracy, 'show-tied-round-result');
  save('F08', 'three-song-average-acc', finalAccuracy, '决赛三曲平均 ACC',
    ['公布双方平均 ACC。', '核对三首都计入平均，再发布最终判定。'],
    ['总分相同，先展示同分再展示 ACC。', '平均值使用三首，不会只算前两首。'],
    [command('advance-result-presentation', { matchId: 'GF', expectedPhase: 'scores' }),
      command('advance-result-presentation', { matchId: 'GF', expectedPhase: 'accuracy', verified: true }, { 'state.tournament.matches.13.status': 'complete' })]);
  const standings = copy(finalDone); action(standings, 'set-broadcast-cue', { stage: 'double-elimination', scene: 'final-standings' });
  save('F09', 'final-standings', standings, '总排名与无序名次组',
    ['核对冠军、亚军、季军。', '等待第九名以后名单翻页，离开后再返回。'],
    ['前三名分别显示；第四至第八名没有内部排序。', '第九名至最后一名也不排序，16 人名单按页循环，重入从第一页开始。']);

  const forfeit = copy(waiting);
  action(forfeit, 'set-match-score', { playerIndex: 0, songIndex: 0, score: 990000,
    judgements: { accuracy: 99, perfect: 960, good: 12, bad: 1, miss: 2 } });
  save('O01', 'disqualification', forfeit, '取消资格与自动判负',
    ['本场已记录一首成绩；在「裁判工具」选择左侧选手，填写决定记录并取消资格。', '查看本场结果和 Bracket。'],
    ['当前对手获得判负胜利。', '被取消资格者不再进入后续有效对阵，已记录成绩仍可核对。'],
    [command('disqualify-player', { playerId: match(forfeit).players[0], reason: 'other', note: 'Manual rehearsal adjudication decision.' },
      { 'state.result.type': 'forfeit' })]);
  const correction = copy(finalDone); action(correction, 'set-scene', { scene: 'bracket' });
  const impact = T.resultCorrectionImpact(correction, 'W1');
  save('O02', 'result-correction', correction, '重开赛果与下游清除',
    ['在赛果纠错工具选择 W1 并查看影响。', '核对受影响场次、填写理由并确认重开。'],
    ['先展示影响清单；重新打开后根场成绩保留为待核对数据。', '相关下游赛果被清除，总排名撤回；无关支线保留。'],
    [command('reopen-result', { matchId: 'W1', reason: 'Manual rehearsal reviewed result correction.', confirmClear: true,
      affectedMatchIds: impact.affectedMatchIds || impact.affectedMatches.map(m => m.matchId) })]);
  const conflict = copy(processing);
  save('O03', 'two-device-conflict', conflict, '主控与记分员并发草稿',
    ['主控和记分员同时打开，主控改左侧第一首分数但暂不保存。', '记分员改同一分数并保存，再回主控查看草稿。'],
    ['主控未保存内容仍在。', '同一字段冲突需要明确核对，不静默覆盖另一端的新成绩。'],
    [command('set-match-score', { playerIndex: 0, songIndex: 0, score: 991000, judgements: { accuracy: 99.1, perfect: 960, good: 12, bad: 1, miss: 2 } })]);
  const sources = fresh();
  action(sources, 'set-broadcast-sources', { layout: 'qualifier', slots: Array.from({ length: 3 }, (_, i) => ({ capture: 'TEST Webcam ' + (i + 1), handcam: '' })) });
  save('O04', 'obs-source-check', sources, 'Webcam 来源人工核对',
    ['将三路来源名称改成实际 OBS 名称，保存并人工核对。', '切换本批选手，再检查确认状态。'],
    ['单画面填写 Webcam 来源，手元输入隐藏。', '选手或来源变化后，原人工确认失效。'],
    [command('confirm-broadcast-sources', { signature: sourceStatus(sources).signature }, { 'sources.confirmed': true })]);
  const wait = fresh(), absent = wait.qualifier.activePlayers[0];
  action(wait, 'start-player-wait', { playerId: absent, reason: 'absence' });
  save('O05', 'absence-deadline', wait, '缺席等待即将届满',
    ['打开「裁判工具」，观察剩余约 30 秒的等待。', '等待届满，核对是否仍需人工决定。'],
    ['届满仅提示等待结束。', '系统不会自动取消选手资格；人工核对后才能决定。'],
    [command('disqualify-player', { playerId: absent, reason: 'absence', note: 'Manual rehearsal wait review.' }, {}, 'waiting period')],
    { waitRemainingMs: 30000 });
  const rematch = qualifier(); qCue(rematch, 'qualifier-processing');
  const replayPlayer = rematch.qualifier.activePlayers[0];
  save('O06', 'rematch-authorization', rematch, '裁判授权单曲重赛',
    ['为当前一位选手第一首填写游戏错误理由，并核对录像和同意项。', '授权后查看该选手官方 Challenge 总分。'],
    ['重赛额度被记录，不能重复授权同一曲。', '该选手本轮总分撤回等待重录，其他选手成绩保留。'],
    [command('authorize-song-rematch', { stage: 'qualifier', group: 'A', playerId: replayPlayer, songIndex: 0,
      reason: 'game-error', videoChecked: true, unintentional: true, allAgree: true, note: 'Manual rehearsal approved after video review.' },
      { ['state.qualifier.rounds.A.results.' + replayPlayer + '.challengeTotal']: null })]);

  const vacancy = selected();
  action(vacancy, 'disqualify-player', { playerId: match(vacancy).players[0], reason: 'other', note: 'Manual rehearsal pre-match exclusion.' });
  const lotteryPlayer = match(vacancy).players.find(Boolean);
  save('O07', 'vacancy-lottery', vacancy, '开赛前空缺与三人抽签',
    ['查看 W1/W2 四人分区中仅余三人的提示。', '记录现场轮空抽签，核对并清除该分区尚未开赛的选曲。'],
    ['不能跳过抽签直接判轮空。', '抽签后仅一人轮空晋级，另两人重配；不存在虚构败者。'],
    [command('record-bye', {}, {}, 'lottery'),
      command('lottery-bye', { playerId: lotteryPlayer, confirmClear: true, note: 'Manual rehearsal reviewed the three-player draw.' },
        { 'state.tournament.matches.0.status': 'complete', 'state.tournament.matches.0.loserId': null })]);

  const manifest = { version: 1, format: 'acahku-manual-saves', scenarioCount: catalog.length,
    fixtureClock: new NativeDate(Date.UTC(2026, 0, 1)).toISOString(), scenarios: catalog };
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const groups = { Q: '预选赛', B: '中场休息', D: '双淘汰赛', F: '总决赛与总排名', O: '裁判与多端协作' };
  const tick = String.fromCharCode(96), code = value => tick + value + tick;
  const guide = ['# 人工测试存档', '', '共 ' + catalog.length + ' 份独立检查点，使用合成选手和成绩。每份聚焦一个功能。', '',
    '## 启动', '', '在项目目录执行：', '', '    npm run test:manual -- --list', '    npm run test:manual -- --case Q05', '',
    '不带参数时可在终端按编号选择。默认测试端口为 3001；可用 --port 3002 更换。',
    '仅解压存档包时，也可直接运行 node scripts/manual-rehearsal.js --case Q05。',
    '每次加载都创建独立临时测试赛事，配对用测试专用代码：主控 test-main，记分员 test-score。', '',
    '- 主控：http://localhost:3001/control/', '- 记分员：http://localhost:3001/scorekeeper/',
    '- OBS 浏览器源：http://localhost:3001/overlay/live.html', '',
    'OBS 测试浏览器源使用 1920×1080。需要真实摄像头的检查按项目 README 的 4:3 Webcam 坐标设置。',
    'iPad 等设备使用启动日志中的局域网地址。按 Ctrl+C 关闭测试服务，再选择另一个存档；每次切换重新配对。',
    '主控默认打开 Live production；通常使用大按钮逐步推进。选曲在 Song selection，裁判和赛果纠错工具在主控对应面板。',
    '每份 JSON 都是完整赛事状态。视频、公布和抽曲检查点停在触发前，按步骤点击后才开始共享计时。',
    '准备页的循环音乐在加载后使用新时钟。O05 将原有十分钟等待恢复为剩余约 30 秒。',
    '要保留本轮人工输入，可在主控导出状态备份；原始检查点保持可重复加载。',
    '存档引用项目现有曲绘、音乐和视频，测试包无需再复制这些媒体。', '',
    '自动检查：npm test 验证所有存档及关键后续操作；npm run test:manual:browser 打开每份存档的三个页面。',
    '浏览器检查需要项目 requirements-test.txt 和 Chromium；可用 --case Q05 只检查一个节点。', '',
    '命令别名尚未添加时，直接运行 python3 test/manual-saves-browser.py --case Q05。', '',
    '## 校验失败时', '',
    '加载器兼容 Windows CRLF 换行和 UTF-8 BOM；实际内容变化仍会阻止加载。',
    '出现 Manual-save checksum differs 时，在项目根目录重新生成整套测试存档及清单，再启动：', '',
    '    node scripts/build-manual-saves.js', '    node scripts/manual-rehearsal.js --case Q05', '',
    '生成器只写入 test/manual-saves，不修改正式赛事 data。存档与 manifest.json 应一起更新。', '',
    '## 建议优先检查', '',
    'Q04、Q05、Q07、B02、D03、D08、D10、D12、D14、F04、F09。',
    '在下方记录通过、失败和备注；真实摄像头、听感及现场 OBS 输出由操作人员核对。', '',
    '## 存档索引', '', '| 编号 | 功能 | JSON | 人工结果 |', '| --- | --- | --- | --- |'];
  for (const e of catalog) guide.push('| ' + e.id + ' | ' + e.title + ' | [' + e.file + '](' + e.file + ') | 待检查 |');
  for (const [group, title] of Object.entries(groups)) {
    guide.push('', '## ' + title);
    for (const e of catalog.filter(item => item.group === group)) {
      guide.push('', '### ' + e.id + ' · ' + e.title, '', '加载：' + code('npm run test:manual -- --case ' + e.id), '');
      e.steps.forEach((step, i) => guide.push((i + 1) + '. ' + step));
      guide.push('', '预期：', '');
      e.expected.forEach(value => guide.push('- [ ] ' + value));
      guide.push('', '结果 / 备注：____________________');
    }
  }
  fs.writeFileSync(path.join(output, 'README.md'), guide.join('\n') + '\n');
  console.log('Generated ' + catalog.length + ' manual saves in ' + output);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
