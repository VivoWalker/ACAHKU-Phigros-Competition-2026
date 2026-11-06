"""Rolling draw, staged ACC decision and staged DE tiebreak in real Chromium.

Uses temporary event files and fixture-only pairing codes. BROADCAST_RECORD_VIDEO=1
records a native OBS visual-only video. Real preview and selection-sound playback
are verified separately through the media and Web Audio probes.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results/staged-broadcast'))
REPORT = {'checks': [], 'browser_errors': [], 'screenshots': []}
spec = importlib.util.spec_from_file_location('production_helpers', ROOT / 'test/production-console-browser.py')
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)
P.REPORT = REPORT
P.SERVER = r"""
const fs=require('node:fs'),path=require('node:path'),T=require('./lib/tournament');
const state=require('./lib/default-state').createDefaultState();
const act=(type,payload={})=>T.applyAction(state,{type,payload:T.CURRENT_MATCH_ACTIONS.has(type)?{matchId:state.tournament.currentMatchId,...payload}:payload});
act('seed-bracket',{ids:state.qualifier.players.map(player=>player.id),ruleset:'proposal-2026'});
act('draw-candidates');for(const playerIndex of [0,1])act('ban-song',{playerIndex,songId:state.tournament.matches[0].candidates[playerIndex].id});
act('set-broadcast-cue',{stage:'double-elimination',scene:'song-selection',matchId:'W1'});
fs.writeFileSync(path.join(process.argv[1],'match-state.json'),JSON.stringify(state));
const app=require('./server').createBroadcastServer({dataDir:process.argv[1],pin:'production-console-main-fixture',scorekeeperPin:'production-console-score-fixture'});
app.listen(0,'127.0.0.1').then(address=>console.log(address.port));process.on('SIGTERM',()=>app.close().then(()=>process.exit()));
"""
PROBE = r"""(() => {
  const NativeAudio=window.Audio;window.__media=[];window.Audio=function(...args){const audio=new NativeAudio(...args);window.__media.push(audio);return audio};
  const NativeContext=window.AudioContext;window.__switchContexts=[];window.__switchStarts=[];
  window.AudioContext=function(...args){const ctx=new NativeContext(...args);window.__switchContexts.push(ctx);const gain=ctx.createGain.bind(ctx),source=ctx.createBufferSource.bind(ctx);ctx.__gains=[];
    ctx.createGain=()=>{const node=gain();ctx.__gains.push(node);return node};ctx.createBufferSource=()=>{const node=source(),start=node.start.bind(node);node.start=(...args)=>{window.__switchStarts.push(performance.now());return start(...args)};return node};return ctx};
  window.__highlights=[];setInterval(()=>{const canvas=document.querySelector('#canvas'),row=document.querySelector('.roulette-highlight');
    if(row)window.__highlights.push({index:canvas?.dataset.rouletteIndex,id:row.dataset.selectionSong});},30);
})();"""


def idle(page, scene):
    page.wait_for_function('''scene=>document.querySelector('#canvas')?.dataset.renderedScene===scene
      &&document.querySelector('#scene')?.dataset.motionPhase==='idle' ''', arg=scene)


def draw_phase(page, name, index):
    page.wait_for_function('''([phase,index])=>document.querySelector('#canvas')?.dataset.roulettePhase===phase
      &&document.querySelector('#canvas')?.dataset.rouletteIndex===String(index)''', arg=[name, index], timeout=45000)


def check(message):
    REPORT['checks'].append(message)
    print('PASS ' + message, flush=True)


def shot(page, name):
    page.screenshot(path=str(OUT / (name + '.png')), animations='disabled')
    REPORT['screenshots'].append(name + '.png')


def run(browser, base):
    context, main = P.login(browser, base)
    video_options = {'record_video_dir': str(OUT / 'recording'), 'record_video_size': {'width': 1920, 'height': 1080}} if os.environ.get('BROADCAST_RECORD_VIDEO') == '1' else {}
    video_context = browser.new_context(viewport={'width': 1920, 'height': 1080}, **video_options)
    live = video_context.new_page()
    live.on('pageerror', lambda error: REPORT['browser_errors'].append(str(error)))
    live.add_init_script(PROBE)
    live.goto(base + '/overlay/live.html?bgm=0')
    idle(live, 'song-selection')
    P.click_saved(main, '[data-command="pick-songs"]')
    saved = P.state(main)
    match = next(m for m in saved['tournament']['matches'] if m['id'] == 'W1')
    cue = match['selectionPreviewCue']
    draw_phase(live, 'rolling', 0)
    assert live.locator('.candidate.picked').count() == 0
    assert main.locator('.selected-track').count() == 0
    assert main.locator('[data-production-next]').is_disabled()
    shot(live, '01-first-roll')
    draw_phase(live, 'preview', 0)
    assert live.locator('.candidate.picked').count() == 1
    assert match['songs'][1]['title'] not in live.locator('.picks').inner_text()
    live.wait_for_function('id=>document.querySelector("#canvas").dataset.selectionAudioSong===id&&document.querySelector("#canvas").dataset.selectionAudio==="playing"', arg=cue['songIds'][0])
    shot(live, '02-first-song')
    mirror = context.new_page()
    mirror.goto(base + '/overlay/live.html?audio=0&bgm=0')
    idle(mirror, 'song-selection')
    draw_phase(mirror, 'preview', 0)
    assert mirror.locator('.candidate.picked').count() == 1
    mirror.close()
    check('An OBS source opened during the first preview resumes the shared cue without rerolling or revealing the second song')
    draw_phase(live, 'rolling', 1)
    assert live.evaluate('window.__media.filter(audio=>audio.dataset.selectionAudio!==undefined).every(audio=>audio.paused)')
    P.command(main, 'set-broadcast-volume', {'volume': .4})
    live.wait_for_function('()=>window.__switchContexts.length>0&&Math.abs(window.__switchContexts[0].__gains[0].gain.value-.4)<.01')
    assert next(m for m in P.state(main)['tournament']['matches'] if m['id'] == 'W1')['selectionPreviewCue'] == cue
    shot(live, '03-second-roll')
    draw_phase(live, 'preview', 1)
    assert live.locator('.candidate.picked').count() == 2
    live.wait_for_function('id=>document.querySelector("#canvas").dataset.selectionAudioSong===id&&document.querySelector("#canvas").dataset.selectionAudio==="playing"', arg=cue['songIds'][1])
    highlights = live.evaluate('window.__highlights')
    for index in [0, 1]:
        ids = {row['id'] for row in highlights if row['index'] == str(index)}
        assert ids == set(cue['roulette']['poolIds']) - ({cue['songIds'][0]} if index else set()), ids
    assert live.evaluate('window.__switchStarts.length') >= 16
    assert main.frame_locator('#program-preview').locator('audio').evaluate_all('nodes=>nodes.every(node=>node.paused)')
    shot(live, '04-second-song')
    draw_phase(live, 'complete', 1)
    assert not main.locator('[data-production-next]').is_disabled()
    check('Four unbanned songs roll, first song previews, three remaining songs roll, second song previews; master volume and silent staff preview agree')
    video = live.video
    video_context.close()
    if video:
        video.save_as(str(OUT / 'rolling-song-draw.webm'))
    live = context.new_page()
    live.set_viewport_size({'width': 1920, 'height': 1080})
    live.goto(base + '/overlay/live.html?bgm=0')
    idle(live, 'song-selection')
    draw_phase(live, 'complete', 1)
    check('Reload after the reveal keeps the saved draw and never replays the animation')
    for pi in [0, 1]:
        for si in [0, 1]:
            P.command(main, 'set-match-score', {'matchId': 'W1', 'playerIndex': pi, 'songIndex': si,
                'score': 990000 if pi == si else 980000, 'judgements': {'accuracy': 99.1234 if pi == 0 and si == 0 else 99}})
    P.command(main, 'record-result', {'matchId': 'W1', 'verified': True})
    idle(live, 'result')
    assert live.locator('.round-result-card.is-winner').count() == 0
    assert live.locator('[data-stat="average-accuracy"]').count() == 0
    assert '待 ACC 判定' in live.locator('.round-result-heading').inner_text()
    assert live.locator('[data-stat="total"]').all_inner_texts() == ['1,970,000', '1,970,000']
    shot(live, '05-tied-scores')
    P.click_saved(main, '[data-production-next]')
    idle(live, 'result')
    live.wait_for_selector('[data-result-phase="accuracy"]')
    assert live.locator('[data-stat="average-accuracy"]').all_inner_texts() == ['99.0617%', '99.0000%']
    assert live.locator('.is-winner').count() == 0
    assert live.locator('[data-stat="accuracy"]').count() == 4
    shot(live, '06-average-accuracy')
    live.reload()
    idle(live, 'result')
    assert live.locator('[data-result-phase="accuracy"]').count() == 2
    P.click_saved(main, '[data-production-next]')
    idle(live, 'result')
    live.wait_for_selector('[data-result-phase="verdict"]')
    assert live.locator('.round-result-card.is-winner').count() == 1
    shot(live, '07-final-verdict')
    check('Equal round totals show the tie first, reveal both four-decimal mean ACC values next, and announce the winner only on the final step; reload preserves the current step')
    P.command(main, 'select-match', {'matchId': 'W2'})
    P.command(main, 'draw-candidates', {'matchId': 'W2'})
    for pi in [0, 1]:
        P.command(main, 'ban-song', {'matchId': 'W2', 'playerIndex': pi, 'songId': None, 'confirmed': True})
    P.command(main, 'pick-songs', {'matchId': 'W2'})
    for pi in [0, 1]:
        for si in [0, 1]:
            P.command(main, 'set-match-score', {'matchId': 'W2', 'playerIndex': pi, 'songIndex': si, 'score': 990000, 'judgements': {'accuracy': 99}})
    P.command(main, 'draw-match-tiebreak', {'matchId': 'W2'})
    idle(live, 'double-elimination-waiting')
    tie = next(m for m in P.state(main)['tournament']['matches'] if m['id'] == 'W2')['tiebreaks'][-1]
    assert live.locator('.waiting-song h2').inner_text() == '加賽曲目待公布'
    shot(live, '08-tiebreak-sealed')
    P.click_saved(main, '[data-production-next]')
    idle(live, 'double-elimination-tiebreak-announcement')
    assert live.locator('.selection-focus-card h2').inner_text() == tie['song']['title']
    assert live.locator('.tiebreak-heading p').inner_text() == 'TIEBREAKER SONG REVEAL'
    shot(live, '09-tiebreak-announcement')
    P.click_saved(main, '[data-production-next]')
    idle(live, 'double-elimination-waiting')
    assert live.locator('.waiting-song h2').inner_text() == tie['song']['title']
    assert live.locator('.waiting-chart').inner_text() == f"{tie['song']['difficulty']} {tie['song']['level']}"
    P.click_saved(main, '[data-production-next]')
    idle(live, 'double-elimination-match')
    P.click_saved(main, '[data-production-next]')
    idle(live, 'double-elimination-processing')
    for pi in [0, 1]:
        P.command(main, 'set-match-tiebreak-score', {'matchId': 'W2', 'index': 0, 'playerIndex': pi, 'score': 990000 - pi * 10000,
            'judgements': {'accuracy': 99, 'perfect': 900, 'good': 8, 'bad': 0, 'miss': 0}})
    P.click_saved(main, '[data-production-next]')
    idle(live, 'song-result')
    assert live.locator('.song-result-card').count() == 2
    shot(live, '10-tiebreak-result')
    check('DE tiebreak cancels an earlier rolling draw and follows concealed waiting → song reveal → named waiting → match → processing → scored result')
    assert not REPORT['browser_errors'], REPORT['browser_errors']
    context.close()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    directory = tempfile.mkdtemp(prefix='acahku-staged-broadcast-')
    process = None
    try:
        process, base = P.start_server(directory, 'regular')
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=os.environ.get('CHROME_BINARY') or shutil.which('chromium') or p.chromium.executable_path,
                args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
            try:
                run(browser, base)
            finally:
                browser.close()
    finally:
        P.stop_server(process)
        shutil.rmtree(directory, ignore_errors=True)
        (OUT / 'report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
