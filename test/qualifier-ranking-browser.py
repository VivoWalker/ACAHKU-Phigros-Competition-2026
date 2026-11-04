"""Qualifier ranking entry, pagination and Plan A round visibility in Chromium.

Uses a temporary tournament and fixture pairing code. Only the 12-second ranking
clock is controlled; Socket.IO, rendering and all other timers run normally.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results' / 'qualifier-ranking'))
REPORT = {'checks': [], 'screenshots': [], 'browser_errors': []}
spec = importlib.util.spec_from_file_location('production_console', ROOT / 'test' / 'production-console-browser.py')
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)

P.SERVER = r"""
const fs=require('node:fs'),path=require('node:path');
const state=require('./lib/default-state').createDefaultState();
const Q=require('./public/js/qualifier-rules'),T=require('./lib/tournament');
const act=(type,payload={})=>T.applyAction(state,{type,payload});
state.library.forEach((song,i)=>{song.art='assets/song/cover-'+(i%6+1)+'.svg';song.previewAudio=''});
act('set-competition-roster',{names:Array.from({length:20},(_,i)=>'Ranking player '+String(i+1).padStart(2,'0'))});
act('set-qualifier-plan',{plan:'A'});
for(const player of Q.entries(state,'A'))
  act('set-qualifier-total',{group:'A',playerId:player.id,total:3000000-player.number*1000});
act('set-broadcast-cue',{stage:'qualifier',scene:'qualifier-processing',group:'A',songIndex:2,
  players:Q.entries(state,'A').slice(-3).map(player=>player.id)});
fs.writeFileSync(path.join(process.argv[1],'match-state.json'),JSON.stringify(state));
const app=require('./server').createBroadcastServer({dataDir:process.argv[1],pin:'production-console-main-fixture'});
app.listen(0,'127.0.0.1').then(address=>console.log(address.port));
process.on('SIGTERM',()=>app.close().then(()=>process.exit()));
"""

CLOCK = r"""(() => {
  const jobs=new Map(),retired=new Map();let nextId=2000000000;
  for(const kind of ['Timeout','Interval']) {
    const schedule=window['set'+kind].bind(window),cancel=window['clear'+kind].bind(window);
    window['set'+kind]=(handler,delay,...args)=>{
      if(delay!==12000)return schedule(handler,delay,...args);
      const id=nextId++;jobs.set(id,{id,handler,args,delay,repeat:kind==='Interval'});return id;
    };
    window['clear'+kind]=id=>{
      if(jobs.has(id)){retired.set(id,jobs.get(id));jobs.delete(id)}else cancel(id);
    };
  }
  window.__rankingClock={
    pending:()=>[...jobs.values()].map(({id,delay})=>({id,delay})),
    tick:()=>{
      for(const job of [...jobs.values()]) {
        if(!jobs.has(job.id))continue;
        if(!job.repeat){jobs.delete(job.id);retired.set(job.id,job)}
        job.handler(...job.args);
      }
    },
    fireRetired:id=>{const job=retired.get(id);if(job)job.handler(...job.args)}
  };
})();"""


def check(name):
    REPORT['checks'].append(name)
    print('PASS ' + name, flush=True)


def idle(page, scene, revision=None):
    page.wait_for_selector(f'#canvas[data-rendered-scene="{scene}"]', state='attached')
    page.wait_for_function("()=>document.querySelector('#scene')?.dataset.motionPhase==='idle'", polling=100)
    if revision is not None:
        page.wait_for_function("revision=>Number(document.querySelector('#canvas').dataset.renderedRevision)>=revision",
                               arg=revision, polling=100)


def ranking(page, ranges, labels=None):
    idle(page, 'result')
    sections = page.locator('.ranking-tables > section')
    labels = labels or ['Qualifier Round 1']
    assert sections.count() == len(labels), sections.all_inner_texts()
    for index, (label, visible_range) in enumerate(zip(labels, ranges)):
        section = sections.nth(index)
        assert section.locator('h2').inner_text().startswith(label)
        assert section.locator('.rank-range').inner_text() == visible_range
        assert section.locator('tbody tr').count() <= 8
        for row in section.locator('tbody tr').all():
            rank = row.locator('td').first.inner_text().split()[0]
            qualifies = rank.isdigit() and int(rank) <= 4
            assert ('is-qualifying' in (row.get_attribute('class') or '')) == qualifies
            if qualifies:
                assert 'linear-gradient' in row.evaluate('row=>getComputedStyle(row).backgroundImage')
    if len(labels) == 1:
        assert 'Revival Round' not in page.locator('#scene').inner_text()
        assert page.locator('.ranking-tables.single-group').count() == 1
        box = sections.first.bounding_box()
        canvas = page.locator('#canvas').bounding_box()
        assert abs(box['x'] + box['width']/2 - canvas['x'] - canvas['width']/2) < 1


def pending(page):
    return page.evaluate('window.__rankingClock.pending()')


def tick(page, ranges, labels=None):
    assert pending(page) and all(job['delay'] == 12000 for job in pending(page))
    page.evaluate('window.__rankingClock.tick()')
    ranking(page, ranges, labels)


def screenshot(page, name):
    page.evaluate('document.fonts.ready')
    file = OUT / (name + '.png')
    page.screenshot(path=str(file), animations='disabled', omit_background=True)
    REPORT['screenshots'].append(str(file))


def cutoff_highlights(context, base, main, live, preview):
    current = P.state(main)
    players = {player['number']: player for player in current['qualifier']['players']}
    totals = {number: current['qualifier']['rounds']['A']['results'][player['id']]['challengeTotal']
              for number, player in players.items()}
    standings = context.new_page()
    standings.goto(base + '/control/')
    standings.fill('#pin', P.PIN)
    standings.click('#pair-form button')
    standings.wait_for_selector('.production-workflow')
    standings.click('.tabs [data-tab="qualifiers"]')

    def total(number, value, **extra):
        return P.command(main, 'set-qualifier-total', {'group': 'A', 'playerId': players[number]['id'],
                                                      'total': value, **extra})

    def colors(response, yellow, green):
        for page in [live, preview]:
            idle(page, 'result', response['revision'])
        standings.wait_for_function("revision=>document.querySelector('#sync-status')?.textContent.endsWith('revision '+revision)",
                                    arg=response['revision'], polling=100)
        for page, selector in [(live, '.ranking-tables'), (preview, '.ranking-tables'),
                               (main, '#production-rankings'), (standings, '.score-table')]:
            for class_name, numbers in [('is-qualification-tie', yellow), ('is-qualifying', green)]:
                rows = page.locator(f'{selector} tbody tr.{class_name}')
                assert rows.count() == len(numbers), (selector, class_name, rows.all_inner_texts())
                names = [row.locator('td').nth(1).inner_text() for row in rows.all()]
                assert all(any(players[number]['name'] in name for name in names) for number in numbers), names
                for row in rows.all():
                    assert 'linear-gradient' in row.evaluate('row=>getComputedStyle(row).backgroundImage')
            assert page.locator(f'{selector} tr.is-qualification-tie.is-qualifying').count() == 0

    try:
        response = total(5, totals[4])
        colors(response, [4, 5], [1, 2, 3])
        screenshot(live, 'qualification-cutoff-tie')
        screenshot(main, 'control-cutoff-tie')
        check('fourth/fifth-place ties mark both entrants yellow in OBS, preview and both control ranking views')

        P.command(main, 'draw-qualifier-tiebreak', {'group': 'A', 'playerIds': [players[4]['id'], players[5]['id']]})
        for number, score in [(4, 900000), (5, 910000)]:
            P.command(main, 'set-qualifier-tiebreak-score', {'group': 'A', 'index': 0,
                      'playerId': players[number]['id'], 'score': score})
        response = P.command(main, 'confirm-qualifier-tiebreak', {'group': 'A', 'index': 0, 'verified': True})
        colors(response, [], [1, 2, 3, 5])
        check('confirming the tiebreak removes yellow and marks the actual advancing entrant green')

        total(5, totals[5], verified=True, confirmClearTiebreaks=True,
              reason='Restore unique totals in the temporary ranking fixture.')
        for number in [3, 5, 6]:
            response = total(number, totals[4])
        colors(response, [3, 4, 5, 6], [1, 2])
        check('multi-player ties spanning the cutoff mark every unresolved entrant yellow')
        for number in [3, 5, 6]:
            total(number, totals[number])
        total(2, totals[1])
        response = total(7, totals[6])
        colors(response, [], [1, 2, 3, 4])
        check('ties entirely among qualifiers or eliminated entrants do not receive yellow markings')
        total(2, totals[2])
        response = total(7, totals[7])
        colors(response, [], [1, 2, 3, 4])
    finally:
        standings.close()


def run(browser, directory):
    process, base = P.start_server(directory, 'ranking')
    context = None
    try:
        context = browser.new_context(viewport={'width': 1920, 'height': 1080}, reduced_motion='reduce')
        context.add_init_script(CLOCK)
        context.on('page', lambda page: page.on('pageerror', lambda error: REPORT['browser_errors'].append(str(error))))
        main = context.new_page()
        main.goto(base + '/control/')
        main.fill('#pin', P.PIN)
        main.click('#pair-form button')
        main.wait_for_selector('.production-workflow')
        main.evaluate(P.COMMANDS)
        main.wait_for_selector('#program-preview')
        preview = main.locator('#program-preview').element_handle().content_frame()
        live = context.new_page()
        live.goto(base + '/overlay/live.html?audio=0')
        for page in [live, preview]:
            idle(page, 'qualifier-processing')
            assert pending(page) == [], 'Ranking clock ran before the ranking screen was entered'

        response = P.command(main, 'set-scene', {'scene': 'result'})
        for page in [live, preview]:
            idle(page, 'result', response['revision'])
            ranking(page, ['1–8 / 20'])
            assert len(pending(page)) == 1 and pending(page)[0]['delay'] == 12000
            tick(page, ['9–16 / 20'])
        tick(live, ['17–20 / 20'])
        tick(live, ['1–8 / 20'])
        screenshot(live, 'plan-a-round-1')
        assert main.locator('#production-rankings tr.is-qualifying').count() == 4
        tick(live, ['9–16 / 20'])
        check('control preview and OBS start at page one, hide the future revival round and cycle every 12 seconds')

        timers = [pending(page) for page in [live, preview]]
        response = P.command(main, 'set-event', {'venue': 'Ranking pagination fixture'})
        for page, timer in zip([live, preview], timers):
            idle(page, 'result', response['revision'])
            ranking(page, ['9–16 / 20'])
            assert pending(page) == timer, 'A live state update restarted the ranking clock'
        player = P.state(main)['qualifier']['players'][0]
        response = P.command(main, 'set-qualifier-total', {'group': 'A', 'playerId': player['id'], 'total': 2998999})
        for page, timer in zip([live, preview], timers):
            idle(page, 'result', response['revision'])
            ranking(page, ['9–16 / 20'])
            assert pending(page) == timer, 'A score update restarted the ranking clock'
        check('live state updates preserve the current page and its existing deadline')

        P.command(main, 'set-scene', {'scene': 'qualifier-processing'})
        for page in [live, preview]:
            idle(page, 'qualifier-processing')
            assert pending(page) == []
        P.command(main, 'set-scene', {'scene': 'result'})
        for page, old in zip([live, preview], timers):
            ranking(page, ['1–8 / 20'])
            fresh = pending(page)
            assert fresh and fresh != old
            page.evaluate('id=>window.__rankingClock.fireRetired(id)', old[0]['id'])
            ranking(page, ['1–8 / 20'])
            assert pending(page) == fresh, 'An old queued callback advanced a new visit'
        screenshot(live, 'ranking-reentered-first-page')
        screenshot(main, 'control-qualifying-rankings')
        check('returning from processing resets page and clock; canceled callbacks cannot advance a new visit')
        cutoff_highlights(context, base, main, live, preview)

        for event, field in [('obsSourceActiveChanged', 'active'), ('obsSourceVisibleChanged', 'visible')]:
            tick(live, ['9–16 / 20'])
            live.evaluate('data=>window.dispatchEvent(new CustomEvent(data.event,{detail:{[data.field]:false}}))',
                          {'event': event, 'field': field})
            assert pending(live) == []
            live.evaluate('data=>window.dispatchEvent(new CustomEvent(data.event,{detail:{[data.field]:true}}))',
                          {'event': event, 'field': field})
            ranking(live, ['1–8 / 20'])
        check('reactivating or showing an OBS source also starts on page one')

        pinned = context.new_page()
        pinned.goto(base + '/overlay/result.html?fixed=1&rankPage=2&audio=0')
        ranking(pinned, ['9–16 / 20'])
        assert pending(pinned) == []
        tick(live, ['9–16 / 20'])
        response = P.command(main, 'finalize-qualifier-round', {'group': 'A', 'verified': True})
        labels = ['Qualifier Round 1', 'Revival Round']
        for page in [live, preview]:
            idle(page, 'result', response['revision'])
            ranking(page, ['1–8 / 20', '1–8 / 16'], labels)
        assert P.state(main)['qualifier']['activeGroup'] == 'B'
        screenshot(live, 'plan-a-revival-started')
        tick(live, ['9–16 / 20', '9–16 / 16'], labels)
        tick(live, ['17–20 / 20', '1–8 / 16'], labels)
        ranking(pinned, ['9–16 / 20', '9–16 / 16'], labels)
        assert pending(pinned) == []
        check('finalizing Round 1 reveals revival rankings, resets both tables and preserves an explicitly pinned page')

        response = P.command(main, 'set-qualifier-display', {'group': 'A'})
        idle(live, 'result', response['revision'])
        ranking(live, ['1–8 / 20', '1–8 / 16'], labels)
        tick(live, ['9–16 / 20', '9–16 / 16'], labels)
        live.reload()
        ranking(live, ['1–8 / 20', '1–8 / 16'], labels)
        check('switching rounds and reloading start at page one while keeping the available revival table')
        main.click('.tabs [data-tab="qualifiers"]')
        assert main.locator('.score-table tbody tr.is-qualifying').count() == 4
        for row in main.locator('.score-table tbody tr.is-qualifying').all():
            assert 'linear-gradient' in row.evaluate('row=>getComputedStyle(row).backgroundImage')
        check('only the four eligible entrants receive the same background marking in both control ranking views and OBS')
        assert not REPORT['browser_errors'], REPORT['browser_errors']
    finally:
        if context:
            context.close()
        P.stop_server(process)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix='qualifier-ranking-browser-') as directory:
            with sync_playwright() as playwright:
                binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium')
                browser = playwright.chromium.launch(executable_path=binary, args=['--no-sandbox'])
                try:
                    run(browser, directory)
                    REPORT['result'] = 'PASS'
                finally:
                    browser.close()
    finally:
        (OUT / 'report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
