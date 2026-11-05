"""Both qualifier cutoff tiebreaks through the real next-step controls and audio."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results/qualifier-tiebreak-flow'))
REPORT = {'checks': [], 'browser_errors': []}
spec = importlib.util.spec_from_file_location('production_helpers', ROOT / 'test/production-console-browser.py')
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)
P.REPORT = REPORT
P.SERVER = r"""
const fs=require('node:fs'),path=require('node:path'),T=require('./lib/tournament'),Q=require('./public/js/qualifier-rules');
const state=require('./lib/default-state').createDefaultState(),group=process.argv[2];
const act=(type,payload={})=>T.applyAction(state,{type,payload});
act('set-competition-roster',{names:Array.from({length:12},(_,i)=>'Entrant '+String(i+1).padStart(2,'0'))});
act('set-qualifier-plan',{plan:'A'});
if(group==='B'){
  Q.entries(state,'A').forEach((p,i)=>act('set-qualifier-total',{group:'A',playerId:p.id,total:3000000-i*1000}));
  act('finalize-qualifier-round',{group:'A',verified:true});
}
Q.entries(state,group).forEach((p,i)=>act('set-qualifier-total',{group,playerId:p.id,
  total:i<3?3000000-i*10000:i<5?2800000:2700000-i*10000}));
act('set-broadcast-cue',{stage:'qualifier',scene:'result',group,players:Q.entries(state,group).slice(-3).map(p=>p.id),songIndex:2});
fs.writeFileSync(path.join(process.argv[1],'match-state.json'),JSON.stringify(state));
const app=require('./server').createBroadcastServer({dataDir:process.argv[1],pin:'production-console-main-fixture',scorekeeperPin:'production-console-score-fixture'});
app.listen(0,'127.0.0.1').then(a=>console.log(a.port));process.on('SIGTERM',()=>app.close().then(()=>process.exit()));
"""
PROBE = r"""(() => {
  const NativeAudio=window.Audio;window.__tieAudio=[];
  window.Audio=function(...args){const audio=new NativeAudio(...args);window.__tieAudio.push(audio);return audio;};
})();"""


def idle(page, scene):
    page.wait_for_function('''scene=>document.querySelector('#canvas')?.dataset.renderedScene===scene
      &&document.querySelector('#scene')?.dataset.motionPhase==='idle' ''', arg=scene)


def step(main, live, phase, scene):
    P.click_saved(main, '[data-production-next]')
    main.wait_for_selector(f'.production-workflow[data-phase="{phase}"]')
    idle(live, scene)


def screenshot(page, name):
    page.screenshot(path=str(OUT / (name + '.png')), animations='disabled')


def run(browser, directory, group):
    process, base = P.start_server(directory, group)
    context = None
    try:
        context, main = P.login(browser, base)
        main.set_viewport_size({'width': 1440, 'height': 1000})
        live = context.new_page()
        live.add_init_script(PROBE)
        live.set_viewport_size({'width': 1920, 'height': 1080})
        live.goto(base + '/overlay/live.html?bgm=0&rankPage=1')
        idle(live, 'result')
        assert live.locator('.ranking-tables tr.is-qualification-tie').count() == 2
        assert '準備晉級加賽' in main.locator('[data-production-next]').inner_text()
        step(main, live, 'waiting', 'qualifier-waiting')
        saved = P.state(main)
        tie = saved['qualifier']['rounds'][group]['tiebreaks'][-1]
        expected_title = 'Aleph-0' if group == 'A' else 'ぱぴぷぴぷぴぱ'
        expected_level = '16' if group == 'A' else '15'
        assert tie['song']['title'] == expected_title
        assert saved['qualifier']['activePlayers'] == tie['playerIds']
        assert live.locator('.waiting-players>p').count() == 2
        assert expected_title not in live.locator('#scene').inner_text()
        assert '待公布' in live.locator('.waiting-song').inner_text()
        assert live.evaluate('window.__tieAudio.length') == 0
        screenshot(live, group + '-1-sealed-ready')

        step(main, live, 'selection', 'qualifier-tiebreak-announcement')
        assert live.locator('.selection-focus-card h2').inner_text() == expected_title
        assert live.locator('.selection-focus-card .song-difficulty').get_attribute('aria-label') == 'IN ' + expected_level
        assert live.locator('.tiebreak-heading p').inner_text() == 'TIEBREAKER SONG REVEAL'
        assert live.locator('.tiebreak-heading h1').evaluate('node=>parseFloat(getComputedStyle(node).fontSize)') >= 72
        assert live.evaluate('''()=>{
          const rect=selector=>document.querySelector(selector).getBoundingClientRect();
          const heading=rect('.tiebreak-heading'),players=rect('.tiebreak-contestants p'),cover=rect('.selection-art'),detail=rect('.selection-detail');
          return heading.bottom<players.top && heading.right<cover.left && cover.bottom<detail.top && detail.bottom<1030;
        }'''), 'Bilingual title, contestants, artwork and song details must occupy separate areas'
        live.wait_for_function('''()=>document.querySelector('#canvas').dataset.selectionAudio==='playing'
          &&window.__tieAudio.some(audio=>!audio.paused&&audio.currentTime>.05&&audio.volume>0)''')
        live.wait_for_function("()=>document.querySelector('.selection-art img').complete&&document.querySelector('.selection-art img').naturalWidth>0")
        live.evaluate('()=>window.__playingTieAudio=window.__tieAudio.find(audio=>!audio.paused)')
        cue = P.state(main)['qualifier']['rounds'][group]['tiebreaks'][-1]['previewCue']
        P.command(main, 'set-broadcast-volume', {'volume': .4})
        live.wait_for_function('''()=>window.__tieAudio.includes(window.__playingTieAudio)
          &&Math.abs(window.__playingTieAudio.volume-.4)<.01''')
        assert P.state(main)['qualifier']['rounds'][group]['tiebreaks'][-1]['previewCue'] == cue
        screenshot(live, group + '-2-announcement')
        live.reload()
        idle(live, 'qualifier-tiebreak-announcement')
        assert live.locator('.selection-focus-card h2').inner_text() == expected_title
        assert P.state(main)['qualifier']['rounds'][group]['tiebreaks'][-1]['previewCue'] == cue

        step(main, live, 'waiting', 'qualifier-waiting')
        assert expected_title in live.locator('.waiting-song').inner_text()
        assert 'IN ' + expected_level in live.locator('.waiting-chart').inner_text()
        live.wait_for_function('()=>window.__tieAudio.every(audio=>audio.paused)')
        screenshot(live, group + '-3-ready')
        step(main, live, 'match', 'qualifier-match')
        assert live.locator('[data-capture="gameplay"]').count() == 2
        step(main, live, 'processing', 'qualifier-processing')
        assert live.locator('.qualifier-processing-panel h1').inner_text() == '統計中'
        for index, player_id in enumerate(tie['playerIds']):
            form = main.locator(f'form[data-score-editor="qt"][data-entity="{player_id}"]')
            prefix = form.get_attribute('data-prefix')
            form.locator('[id="' + prefix + '"]').fill(str(980000 + index * 10000))
            for key, value in [('perfect', 900), ('good', 5), ('bad', 0), ('miss', 0)]:
                form.locator('[id="' + prefix + '-' + key + '"]').fill(str(value))
            P.click_saved(main, f'form[data-score-editor="qt"][data-entity="{player_id}"] button[type="submit"]')
        screenshot(live, group + '-4-processing')
        step(main, live, 'song-result', 'song-result')
        assert live.locator('.song-result-card').count() == 2
        assert live.locator('.song-result-score').all_inner_texts() == ['980,000', '990,000']
        screenshot(live, group + '-5-tiebreak-result')
        step(main, live, 'ranking', 'result')
        assert live.locator('.ranking-tables tr.is-qualification-tie').count() == 0
        current_group = live.locator('.ranking-tables>section').last
        assert current_group.locator('tr.is-qualifying').count() == 4
        winner = next(p['name'] for p in saved['qualifier']['players'] if p['id'] == tie['playerIds'][1])
        assert 'is-qualifying' in current_group.locator('tbody tr').filter(has_text=winner).get_attribute('class')
        screenshot(live, group + '-6-confirmed-ranking')
        REPORT['checks'].append('Round ' + group + ': sealed two-player waiting → song reveal with real preview → named waiting → match → processing → scored result → confirmed top four')
        print('PASS ' + REPORT['checks'][-1], flush=True)
    finally:
        if context:
            context.close()
        P.stop_server(process)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        with sync_playwright() as pw:
            binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium') or shutil.which('google-chrome')
            browser = pw.chromium.launch(**({'executable_path': binary} if binary else {}), args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
            try:
                for group in ['A', 'B']:
                    with tempfile.TemporaryDirectory(prefix='qualifier-tiebreak-flow-') as directory:
                        run(browser, directory, group)
                assert not REPORT['browser_errors'], REPORT['browser_errors']
            finally:
                browser.close()
    finally:
        (OUT / 'report.json').write_text(json.dumps(REPORT, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
