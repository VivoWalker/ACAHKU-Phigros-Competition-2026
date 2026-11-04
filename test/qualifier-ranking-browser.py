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
        check('returning from processing resets page and clock; canceled callbacks cannot advance a new visit')

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
