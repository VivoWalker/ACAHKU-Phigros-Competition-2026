"""Real-browser DE selection, waiting audio, processing and round-result coverage.

Temporary tournaments, fixture pairing codes and locally generated one-second
preview tones only. Never reads production state or credentials.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results' / 'double-elimination-flow'))
REPORT = {'checks': [], 'screenshots': [], 'browser_errors': [], 'geometry': []}
spec = importlib.util.spec_from_file_location('production_console', ROOT / 'test' / 'production-console-browser.py')
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)
P.OUT, P.REPORT = OUT, REPORT
geometry_spec = importlib.util.spec_from_file_location('difficulty_geometry', ROOT / 'test' / 'difficulty-draw-browser.py')
D = importlib.util.module_from_spec(geometry_spec)
geometry_spec.loader.exec_module(D)
P.GEOMETRY = D.GEOMETRY
P.SERVER = r"""
const fs=require('node:fs'),path=require('node:path');
const state=require('./lib/default-state').createDefaultState(),T=require('./lib/tournament');
const act=(type,payload={})=>T.applyAction(state,{type,payload:T.CURRENT_MATCH_ACTIONS.has(type)?
  {matchId:state.tournament.currentMatchId,...payload}:payload});
state.library.forEach((song,index)=>{song.art='assets/song/cover-'+(index%4+1)+'.svg';
  if(song.eligible)song.title=(song.title+' · Phigros ver. / Long fixture title '+index).slice(0,100);
  song.artist='COMPOSER_FIELD_MUST_STAY_PRIVATE_TO_LIBRARY';song.previewAudio='assets/song-preview/de-fixture-'+song.id+'.mp3'});
act('seed-bracket',{ids:state.qualifier.players.map(player=>player.id),ruleset:'proposal-2026',verified:true});
act('draw-candidates');
const match=state.tournament.matches.find(item=>item.id===state.tournament.currentMatchId);
act('set-broadcast-cue',{stage:'double-elimination',scene:'song-selection',matchId:match.id,songIndex:0});
fs.writeFileSync(path.join(process.argv[1],'match-state.json'),JSON.stringify(state));
const app=require('./server').createBroadcastServer({dataDir:process.argv[1],pin:'production-console-main-fixture',
  scorekeeperPin:'production-console-score-fixture'});
app.listen(0,'127.0.0.1').then(address=>console.log(address.port));
process.on('SIGTERM',()=>app.close().then(()=>process.exit()));
"""
PROBE = r"""(() => {
 const play=HTMLMediaElement.prototype.play;window.__previewPlays=[];
 HTMLMediaElement.prototype.play=function(...args){
   if(this.dataset.selectionAudio!==undefined)window.__previewPlays.push({song:this.dataset.songId,time:performance.now()});
   return play.apply(this,args);
 };
})();"""


def check(name):
    REPORT['checks'].append(name)
    print('PASS ' + name, flush=True)


def idle(page, scene):
    page.wait_for_selector(f'#canvas[data-rendered-scene="{scene}"]', state='attached')
    page.wait_for_function("()=>document.querySelector('#scene')?.dataset.motionPhase==='idle'", polling=100)


def screenshot(page, name):
    file = OUT / (name + '.png')
    page.screenshot(path=str(file), animations='disabled', full_page=True)
    REPORT['screenshots'].append(str(file))


def current(page):
    state = P.state(page)
    return next(match for match in state['tournament']['matches'] if match['id'] == state['tournament']['currentMatchId'])


def cards(main, live, phase):
    idle(live, 'song-selection')
    match = current(main)
    for index, song in enumerate(match['candidates']):
        for page, selector in [(live, '.candidate'), (main, '.candidate-row')]:
            row = page.locator(selector).nth(index)
            assert row.locator('.song-difficulty').get_attribute('aria-label') == f"{song['difficulty']} {int(song['level'])}"
            assert row.locator('.song-difficulty b').inner_text() == str(int(song['level']))
            assert row.locator('.song-difficulty>span').inner_text() == song['difficulty']
            assert 'COMPOSER_FIELD' not in row.inner_text()
            # Resolve and measure the current tile in one browser task. A
            # locator handle can detach between resolution and evaluate while
            # the live control rebuilds its rows after a saved pick.
            contrast = page.wait_for_function('''({selector,index}) => {
              const tile = document.querySelectorAll(selector)[index]?.querySelector('.song-difficulty');
              if (!tile) return null;
              const luminance = color => {
                const channels = color.match(/[\\d.]+/g).slice(0, 3).map(Number).map(n => {
                  const v = n / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
                });
                return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
              };
              const background = luminance(getComputedStyle(tile, '::before').backgroundColor);
              return [...tile.children].map(child => {
                const ink = luminance(getComputedStyle(child).color);
                return (Math.max(ink, background) + .05) / (Math.min(ink, background) + .05);
              });
            }''', arg={'selector': selector, 'index': index}).json_value()
            assert all(value >= 4.5 for value in contrast), (phase, song['id'], contrast)
        status = live.locator('.candidate-status').nth(index).inner_text()
        expected = 'BAN' if song['id'] in match['bans'] else 'PICK' if any(item['id'] == song['id'] for item in match['songs']) else ''
        assert status == expected, (phase, song['id'], status, expected)
    assert 'COMPOSER_FIELD' not in main.locator('.song-grid').inner_text()
    boxes = live.locator('.candidate').evaluate_all('''rows=>rows.map(row=>{
      const parts=[row.querySelector('h3'),row.querySelector('.candidate-status'),row.querySelector('.song-difficulty')];
      const r=parts.map(part=>part.getBoundingClientRect());
      return r.some((a,i)=>r.slice(i+1).some(b=>Math.min(a.right,b.right)>Math.max(a.left,b.left)&&Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top)));
    })''')
    assert not any(boxes), (phase, boxes)


def step(main, live, phase, scene):
    P.click_saved(main, '[data-production-next]')
    P.phase(main, phase)
    idle(live, scene)


def loop(live, song):
    live.wait_for_function('''id=>document.querySelector('#canvas')?.dataset.selectionAudioSong===id&&
      document.querySelector('#canvas')?.dataset.selectionAudio==='playing'&&
      window.__previewPlays.filter(item=>item.song===id).length>=2''', arg=song['id'], timeout=10000, polling=100)
    assert live.locator('audio[data-selection-audio]').count() == 1
    assert live.locator('audio[data-selection-audio]').get_attribute('src') == '/' + song['previewAudio']


def processing(main, live, song_index):
    step(main, live, 'processing', 'double-elimination-processing')
    assert live.locator('.qualifier-processing-panel h1').inner_text() == '統計中'
    assert live.locator('.qualifier-processing-panel p').inner_text() == 'RESULTS PROCESSING'
    assert live.locator('[data-stat],[data-capture]').count() == 0
    assert live.locator('.qualifier-processing-art').count() == 1
    assert main.locator('form[data-score-editor="m"]').count() == 2
    live.wait_for_function('''()=>!document.querySelector('audio[data-selection-audio],audio[data-selection-audio-retiring]')''', polling=100)
    evidence = [
        [{'score': 987654, 'accuracy': 99, 'perfect': 900, 'good': 10, 'bad': 1, 'miss': 0},
         {'score': 976543, 'accuracy': 98, 'perfect': 890, 'good': 20, 'bad': 2, 'miss': 1}],
        [{'score': 965432, 'accuracy': 99, 'perfect': 901, 'good': 11, 'bad': 0, 'miss': 2},
         {'score': 954321, 'accuracy': 98, 'perfect': 880, 'good': 30, 'bad': 3, 'miss': 0}]
    ][song_index]
    for pi, stats in enumerate(evidence):
        score = stats['score']
        P.command(main, 'set-match-score', {'matchId': current(main)['id'], 'playerIndex': pi,
                  'songIndex': song_index, 'score': score, 'judgements': {key: value for key, value in stats.items() if key != 'score'}})
    assert P.state(main)['scene'] == 'double-elimination-processing'
    assert live.locator('[data-stat]').count() == 0
    screenshot(live, f'song-{song_index+1}-processing')
    step(main, live, 'song-result', 'song-result')
    assert live.locator('.song-result-score').all_inner_texts() == [f"{row['score']:,}" for row in evidence]


def run(browser, directory, tone):
    process, base = P.start_server(directory, 'regular')
    context = None
    try:
        context, main = P.login(browser, base)
        context.route('**/assets/song-preview/de-fixture-*.mp3', lambda route: route.fulfill(content_type='audio/mpeg', body=tone))
        context.add_init_script(PROBE)
        live = context.new_page()
        live.set_viewport_size({'width': 1920, 'height': 1080})
        live.goto(base + '/overlay/live.html?bgm=0')
        cards(main, live, 'drawn')
        for pi in [0, 1]:
            match = current(main)
            P.click_saved(main, f'[data-ban-player="{pi}"][data-ban-song="{match["candidates"][pi]["id"]}"]')
            cards(main, live, f'ban-{pi}')
        screenshot(live, 'selection-bans-and-difficulty')
        P.click_saved(main, '[data-command="pick-songs"]')
        cards(main, live, 'picked')
        screenshot(live, 'selection-picks-and-difficulty')
        P.geometry(main, 'selection-embedded')
        main.click('.tabs [data-tab="songs"]')
        cards(main, live, 'standalone-picked')
        P.geometry(main, 'selection-standalone')
        main.click('.tabs [data-tab="broadcast"]')
        main.evaluate(P.COMMANDS)
        check('BAN/PICK and permanent difficulty tiles coexist in both control layouts and OBS; composer names are absent')

        step(main, live, 'waiting', 'double-elimination-waiting')
        loop(live, current(main)['songs'][0])
        before = current(main)['waitingPreviewCue']
        P.command(main, 'set-event', {'venue': 'Unrelated update retains the next-song loop'})
        assert current(main)['waitingPreviewCue'] == before
        live.reload()
        loop(live, current(main)['songs'][0])
        check('first-song waiting loops the upcoming clip, survives state updates and resumes after OBS reload')
        live.evaluate("window.__volumeDecoder=document.querySelector('audio[data-selection-audio]')")
        for value in [0, 37, 25]:
            main.locator('#broadcast-volume').evaluate('''(input, value) => {
              input.value=String(value);
              input.dispatchEvent(new Event('input', {bubbles:true}));
              input.dispatchEvent(new Event('change', {bubbles:true}));
            }''', value)
            live.wait_for_function('''value => {
              const audio=document.querySelector('audio[data-selection-audio]');
              return audio&&audio===window.__volumeDecoder&&
                (value===0 ? audio.volume===0 : audio.volume>value/100*.82&&audio.volume<=value/100+.0001);
            }''', arg=value)
            assert current(main)['waitingPreviewCue'] == before
        check('global volume and mute update the waiting decoder in place without changing the saved preview cue')
        step(main, live, 'match', 'double-elimination-match')
        processing(main, live, 0)
        check('song one enters an opaque processing screen, stops previews and keeps score entry available until reveal')
        step(main, live, 'waiting', 'double-elimination-waiting')
        assert current(main)['currentSong'] == 1
        assert current(main)['waitingPreviewCue']['id'] != before['id']
        loop(live, current(main)['songs'][1])
        step(main, live, 'match', 'double-elimination-match')
        processing(main, live, 1)
        check('song two previews its own clip and has an independent processing/reveal step')
        step(main, live, 'round-result', 'result')
        assert live.locator('.round-result-card').count() == 2
        assert live.locator('.round-result-card.is-winner').get_attribute('data-player-id') == current(main)['players'][0]
        assert live.locator('.round-result-card>strong').all_inner_texts() == ['1,953,086', '1,930,864']
        for pi in range(2):
            card = live.locator('.round-result-card').nth(pi)
            assert card.locator('.round-result-judgements,[data-stat="perfect"],[data-stat="good"],[data-stat="bad"],[data-stat="miss"]').count() == 0
            assert card.locator('.round-result-track h3').all_inner_texts() == [song['title'] for song in current(main)['songs']]
            assert card.locator('.round-result-track .song-difficulty').count() == 2
            assert card.locator('.round-result-track .song-difficulty b').evaluate_all("nodes=>nodes.every(node=>getComputedStyle(node).color==='rgb(24, 32, 42)')")
            assert card.locator('.round-result-track h3').evaluate_all('nodes=>nodes.every(node=>parseFloat(getComputedStyle(node).fontSize)>=32)')
            assert card.locator('.round-result-track .song-difficulty b').evaluate_all('nodes=>nodes.every(node=>parseFloat(getComputedStyle(node).fontSize)>=40)')
        assert float(live.locator('.round-result-card>strong').first.evaluate('node=>getComputedStyle(node).fontSize').removesuffix('px')) >= 80
        assert '勝者組' in live.locator('.round-result-card.is-winner .round-result-route').inner_text()
        assert live.locator('.round-result-track h3').evaluate_all('''nodes=>nodes.every(node=>{
          const title=node.getBoundingClientRect(),column=node.parentElement.getBoundingClientRect();
          return title.left>=column.left-.5&&title.right<=column.right+.5;
        })'''), 'Long song titles escaped their individual score columns'
        assert main.locator('.production-result-card').count() == 2
        screenshot(live, 'round-result-readable-totals')
        P.geometry(main, 'round-result-control')
        check('verified results show large side-by-side totals, large song titles/difficulty, both scores, no judgement totals and the correct advancement route')
        assert not REPORT['browser_errors'], REPORT['browser_errors']
    finally:
        if context:
            context.close()
        P.stop_server(process)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix='double-elimination-flow-') as directory:
            tone = Path(directory) / 'preview.mp3'
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
                            '-codec:a', 'libmp3lame', '-y', str(tone)], check=True)
            with sync_playwright() as playwright:
                binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium')
                browser = playwright.chromium.launch(executable_path=binary, args=['--no-sandbox',
                    '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'])
                try:
                    run(browser, directory, tone.read_bytes())
                    REPORT['result'] = 'PASS'
                finally:
                    browser.close()
    finally:
        (OUT / 'report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
