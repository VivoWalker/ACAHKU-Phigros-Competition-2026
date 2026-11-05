"""Confirmed event standings, pagination, correction and native OBS geometry.

Only temporary tournaments and fixture pairing codes are used.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results/final-standings'))
REPORT = {'checks': [], 'browser_errors': [], 'screenshots': []}


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'test' / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


P = module('production_helpers', 'production-console-browser.py')
P.REPORT = REPORT
CLOCK = module('ranking_helpers', 'qualifier-ranking-browser.py').CLOCK
P.SERVER = r"""
const fs=require('node:fs'),path=require('node:path');
const {fixture}=require('./test/helpers/final-standings-state');
const count=Number(process.argv[2]),state=fixture(count,count!==16);
if(count===16)require('./lib/tournament').applyAction(state,{type:'set-broadcast-cue',payload:{
  stage:'double-elimination',scene:'double-elimination-processing',matchId:'GF',songIndex:1}});
fs.writeFileSync(path.join(process.argv[1],'match-state.json'),JSON.stringify(state));
const app=require('./server').createBroadcastServer({dataDir:process.argv[1],
  pin:'production-console-main-fixture',scorekeeperPin:'production-console-score-fixture'});
app.listen(0,'127.0.0.1').then(address=>console.log(address.port));
process.on('SIGTERM',()=>app.close().then(()=>process.exit()));
"""


def idle(page, scene='final-standings'):
    page.wait_for_function('''scene=>document.querySelector('#canvas')?.dataset.renderedScene===scene
      &&document.querySelector('#scene')?.dataset.motionPhase==='idle' ''', arg=scene)


def check(name):
    REPORT['checks'].append(name)
    print('PASS ' + name, flush=True)


def shot(page, name):
    path = OUT / (name + '.png')
    page.screenshot(path=str(path), animations='disabled', full_page=page.url.endswith('/control/'))
    REPORT['screenshots'].append(str(path))


def geometry(page):
    failures = page.evaluate('''()=>{
      const problems=[];
      for(const node of document.querySelectorAll('.final-standings-heading,.standings-podium-card,.standings-group')){
        const r=node.getBoundingClientRect();
        if(r.left<60||r.top<150||r.right>1860||r.bottom>1030)problems.push(node.className+' outside safe area');
      }
      for(const card of document.querySelectorAll('.standings-podium-card')){
        const award=card.querySelector('.podium-award').getBoundingClientRect(),name=card.querySelector('h3').getBoundingClientRect();
        if(award.bottom>name.top)problems.push('award overlaps name');
        if(name.bottom>card.getBoundingClientRect().bottom)problems.push('podium name outside card');
      }
      for(const group of document.querySelectorAll('.standings-group')){
        if(group.querySelector('header').getBoundingClientRect().bottom>group.querySelector('ul').getBoundingClientRect().top+1)problems.push('group title overlaps names');
        for(const name of group.querySelectorAll('li'))if(name.getBoundingClientRect().bottom>1030)problems.push('name below safe area');
      }
      return problems;
    }''')
    assert not failures, failures
    assert page.evaluate("document.fonts.check('500 48px Saira')")


def verify_podium(page, saved):
    matches = {m['id']: m for m in saved['tournament']['matches']}
    ids = [matches['GF']['winnerId'], matches['GF']['loserId'], matches['L6']['loserId']]
    for place, player_id in enumerate(ids, 1):
        assert page.locator(f'[data-podium-place="{place}"] h3').get_attribute('data-player-id') == player_id
    return ids


def exercise(browser, count):
    directory = tempfile.mkdtemp(prefix='acahku-final-standings-')
    process = context = None
    try:
        process, base = P.start_server(directory, str(count))
        context, main = P.login(browser, base)
        live = context.new_page()
        live.set_viewport_size({'width': 1920, 'height': 1080})
        live.add_init_script(CLOCK)
        live.goto(base + '/overlay/live.html')
        fixed = context.new_page()
        fixed.set_viewport_size({'width': 1920, 'height': 1080})
        fixed.goto(base + '/overlay/final-standings.html?audio=0')
        idle(fixed)
        if count == 16:
            assert main.locator('[data-production-cue]').filter(has_text='總排名').is_disabled()
            assert fixed.locator('.standings-pending').count() == 1
            error = main.evaluate("()=>window.__fixtureCommand('set-scene',{scene:'final-standings'}).then(()=>null,error=>error.message)")
            assert 'Confirm all match results' in error
            P.command(main, 'record-result', {'matchId': 'GF', 'verified': True})
            P.command(main, 'set-broadcast-cue', {'stage': 'double-elimination', 'scene': 'result', 'matchId': 'GF'})
            check('A fully scored final cannot announce standings until its result is confirmed')
        P.click_saved(main, '[data-production-next]')
        main.wait_for_selector('.production-workflow[data-phase="final-standings"]')
        idle(live)
        idle(fixed)
        live.evaluate('document.fonts.ready')
        saved = P.state(main)
        podium = verify_podium(live, saved)
        top = live.locator('[data-standings-group="top-eight"]')
        assert top.locator('li').count() == 5
        assert '不分先後' in top.inner_text()
        assert live.locator('.standings-group ol,.standings-group [data-stat]').count() == 0
        assert set(top.locator('li').evaluate_all('nodes=>nodes.map(n=>n.dataset.playerId)')) == set(saved['tournament']['seeds']) - set(podium)
        assert main.locator('.control-standings-podium article').count() == 3
        assert main.locator('.control-standings-group li').count() == count - 3
        geometry(live)
        shot(live, f'final-standings-{count}')
        shot(main, f'control-{count}')
        check(f'{count} entrants: confirmed podium and equal unordered groups agree across control and OBS')
        if count == 64:
            expected = [p['id'] for p in saved['qualifier']['players'] if p['id'] not in saved['tournament']['seeds']]
            seen = []
            for index in range(5):
                group = live.locator('[data-standings-group="remaining"]')
                assert group.locator('.standings-page').inner_text() == f'{index + 1} / 5'
                seen.extend(group.locator('li').evaluate_all('nodes=>nodes.map(n=>n.dataset.playerId)'))
                geometry(live)
                live.evaluate('window.__rankingClock.tick()')
                idle(live)
            assert seen == expected
            assert live.locator('.standings-page').inner_text() == '1 / 5'
            live.evaluate('window.__rankingClock.tick()')
            idle(live)
            clock = live.evaluate('window.__rankingClock.pending()')
            P.command(main, 'set-broadcast-volume', {'volume': .4})
            live.wait_for_function('revision=>Number(document.querySelector("#canvas").dataset.renderedRevision)>=revision', arg=P.state(main)['revision'])
            assert live.locator('.standings-page').inner_text() == '2 / 5'
            assert live.evaluate('window.__rankingClock.pending()') == clock
            P.command(main, 'set-scene', {'scene': 'bracket'})
            idle(live, 'bracket')
            P.click_saved(main, '[data-production-next]')
            idle(live)
            assert live.locator('.standings-page').inner_text() == '1 / 5'
            if clock:
                live.evaluate('id=>window.__rankingClock.fireRetired(id)', clock[0]['id'])
                idle(live)
                assert live.locator('.standings-page').inner_text() == '1 / 5'
            check('All 56 remaining entrants cycle without duplicates; reentry resets page one and stale timers cannot advance it')
        elif count == 8:
            assert live.locator('.standings-groups.single-group').count() == 1
            assert live.locator('[data-standings-group="remaining"]').count() == 0
            check('An eight-player event has no empty ninth-place panel')
        else:
            P.command(main, 'reopen-result', {'matchId': 'GF', 'affectedMatchIds': [], 'reason': 'Fixture revised final score.'})
            fixed.wait_for_selector('.standings-pending')
            assert fixed.locator('.standings-podium-card').count() == 0
            for player in [0, 1]:
                for song in [0, 1]:
                    P.command(main, 'set-match-score', {'matchId': 'GF', 'playerIndex': player, 'songIndex': song, 'score': 980000 if player else 990000})
            P.command(main, 'record-result', {'matchId': 'GF', 'verified': True})
            fixed.wait_for_selector('.standings-podium-card')
            idle(fixed)
            assert verify_podium(fixed, P.state(main))[0] == podium[1]
            check('Reopening the final removes stale awards and reconfirmation updates the podium')
        main.set_viewport_size({'width': 390, 'height': 844})
        assert main.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        if count != 16:
            shot(main, f'control-mobile-{count}')
            assert main.locator('.control-standings-podium h3').count() == 3
    finally:
        if context:
            context.close()
        P.stop_server(process)
        shutil.rmtree(directory, ignore_errors=True)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.environ.get('CHROME_BINARY') or shutil.which('chromium') or playwright.chromium.executable_path,
            args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
        try:
            for count in [16, 64, 8]:
                exercise(browser, count)
            assert not REPORT['browser_errors'], REPORT['browser_errors']
        finally:
            browser.close()
            (OUT / 'report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
