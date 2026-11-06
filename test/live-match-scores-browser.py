"""Verify live score disclosure with prefilled scores in both webcam layouts."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results/live-match-scores'))
REPORT = {'checks': [], 'browser_errors': []}
spec = importlib.util.spec_from_file_location('production_helpers', ROOT / 'test/production-console-browser.py')
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)
P.REPORT = REPORT
P.SERVER = r"""
const fs=require('node:fs'),path=require('node:path'),T=require('./lib/tournament');
const kind=process.argv[2],id={qualifier:'Q03','qualifier-tie':'Q09',de:'D06','de-tie':'D16',final:'F06'}[kind];
const {state}=require('./scripts/manual-save-loader').loadManualSave(id);
const m=state.tournament.matches.find(item=>item.id===state.tournament.currentMatchId);
if(kind==='final')for(let pi=0;pi<2;pi++)T.applyAction(state,{type:'set-match-score',payload:{matchId:'GF',playerIndex:pi,songIndex:2,score:123456+pi}});
T.applyAction(state,{type:'set-broadcast-cue',payload:state.stage==='qualifier'
 ?{stage:'qualifier',scene:'qualifier-match',group:state.qualifier.activeGroup,players:state.qualifier.activePlayers,songIndex:0}
 :{stage:'double-elimination',scene:'double-elimination-match',matchId:m.id,songIndex:kind==='final'?2:0}});
fs.writeFileSync(path.join(process.argv[1],'match-state.json'),JSON.stringify(state));
const app=require('./server').createBroadcastServer({dataDir:process.argv[1],pin:'production-console-main-fixture',scorekeeperPin:'production-console-score-fixture'});
app.listen(0,'127.0.0.1').then(a=>console.log(a.port));
process.on('SIGTERM',()=>app.close().then(()=>process.exit()));
"""


def exercise(browser, kind):
    with tempfile.TemporaryDirectory(prefix='live-match-scores-') as directory:
        process, base = P.start_server(directory, kind)
        context = None
        try:
            context, main = P.login(browser, base)
            scene = 'qualifier-match' if kind.startswith('qualifier') else 'double-elimination-match'
            pages = []
            for cameras in [0, 1]:
                page = context.new_page()
                page.emulate_media(reduced_motion='reduce')
                page.set_viewport_size({'width': 1920, 'height': 1080})
                page.goto(base + f'/overlay/live.html?cameras={cameras}&details=1')
                page.wait_for_function('s=>document.querySelector("#canvas")?.dataset.renderedScene===s&&document.querySelector("#scene")?.dataset.motionPhase==="idle"', arg=scene)
                pages.append(page)
            if kind != 'final':
                for page in pages:
                    assert page.locator('.player-info .player-total,.player-info .song-scores').count() == 0
            saved = P.state(main)
            match = next((m for m in saved['tournament']['matches'] if m['id'] == saved['tournament']['currentMatchId']), None)
            if kind == 'de':
                P.command(main, 'set-broadcast-cue', {'stage': 'double-elimination', 'scene': scene, 'matchId': match['id'], 'songIndex': 1})
                for page in pages:
                    page.wait_for_function("document.querySelector('.song-band>span')?.textContent==='SONG 2 / 2'")
                    assert page.locator('.player-total>span').all_text_contents() == ['SONG 1', 'SONG 1']
                    assert page.locator('.player-total strong').all_text_contents() == [format(row[0], ',') for row in match['scores']]
                    assert page.locator('.player-info .song-scores').count() == 0
                P.command(main, 'set-match-score', {'matchId': match['id'], 'playerIndex': 0, 'songIndex': 1, 'score': 123456})
                for value, expected in [(0, '0'), (None, '—')]:
                    P.command(main, 'set-match-score', {'matchId': match['id'], 'playerIndex': 0, 'songIndex': 0, 'score': value})
                    for page in pages:
                        page.wait_for_function('e=>document.querySelector(".player-total strong")?.textContent===e', arg=expected)
            elif kind == 'final':
                for page in pages:
                    assert page.locator('.player-total>span').all_text_contents() == ['SONGS 1–2', 'SONGS 1–2']
                    assert page.locator('.player-total strong').all_text_contents() == [format(sum(row[:2]), ',') for row in match['scores']]
                    assert page.locator('.player-info .score-row').count() == 4
                    for row in match['scores']:
                        assert format(row[2], ',') not in '\n'.join(page.locator('.player-info').all_inner_texts())
            pages[0].screenshot(path=str(OUT / (kind + '.png')))
            REPORT['checks'].append(kind + ': live score visibility in both layouts and details mode')
            print('PASS ' + REPORT['checks'][-1], flush=True)
        finally:
            if context:
                context.close()
            P.stop_server(process)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        with sync_playwright() as pw:
            binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium')
            browser = pw.chromium.launch(**({'executable_path': binary} if binary else {}), args=['--no-sandbox'])
            try:
                for kind in ['qualifier', 'qualifier-tie', 'de', 'de-tie', 'final']:
                    exercise(browser, kind)
                assert not REPORT['browser_errors'], REPORT['browser_errors']
            finally:
                browser.close()
    finally:
        (OUT / 'report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
