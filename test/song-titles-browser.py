"""Complete song titles in OBS, both director layouts and the host panel."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results/song-titles'))
REPORT = {'checks': [], 'geometry': [], 'browser_errors': []}
spec = importlib.util.spec_from_file_location('production_helpers', ROOT / 'test/production-console-browser.py')
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)
P.REPORT = REPORT
P.SERVER = r"""
const fs=require('node:fs'),path=require('node:path'),T=require('./lib/tournament');
const state=require('./lib/default-state').createDefaultState();
// This fixture checks typography, independently of official draw-stock planning.
delete state.event.competitionVersion;
T.applyAction(state,{type:'seed-bracket',payload:{ids:state.qualifier.players.map(p=>p.id),ruleset:'proposal-2026',verified:true}});
const fixture=process.argv[2],m=state.tournament.matches.find(m=>m.id===state.tournament.currentMatchId);
const pool=state.library.filter(s=>s.eligible);
let songs=fixture.startsWith('official-')?pool.slice(Number(fixture.split('-')[1])*6,Number(fixture.split('-')[1])*6+6):
  [14,6,9,2,20,30].map(n=>state.library.find(s=>s.id==='competition-2026-de-'+String(n).padStart(2,'0')));
if(['stress','picked','rolling'].includes(fixture)){
  const titles=[('INFiNiTE ENERZY -Overdoze- / '+ 'Extended title ').repeat(4).slice(0,100),
    '超長中文曲名測試'.repeat(12).slice(0,100),'ぱぴぷぴぷぴぱ・終わりのない音楽'.repeat(6).slice(0,100),
    'W'.repeat(100),('PRAGMATISM -RESURRECTION- / '+ 'Full title ').repeat(4).slice(0,100),
    ('楽曲名 / Song Title & <Final> 「完全版」 ').repeat(4).slice(0,100)];
  songs.forEach((song,i)=>song.title=titles[i]);
}
songs.forEach((song,i)=>{song.art='assets/song/cover-'+(i%4+1)+'.svg';song.previewAudio=''});
m.candidates=structuredClone(songs);
const act=(type,payload={})=>T.applyAction(state,{type,payload:{matchId:m.id,...payload}});
if(fixture==='picked'||fixture==='rolling'){
  act('ban-song',{playerIndex:0,songId:m.candidates[0].id});
  act('ban-song',{playerIndex:1,songId:m.candidates[1].id});
  act('pick-songs');m.selectionPreviewCue.startedAt=Date.now()+(fixture==='rolling'?10000:-120000);
  if(fixture==='rolling')m.selectionPreviewCue.durations=[.25,.25];
}else act('set-broadcast-cue',{stage:'double-elimination',scene:'song-selection',songIndex:0});
fs.writeFileSync(path.join(process.argv[1],'match-state.json'),JSON.stringify(state));
const app=require('./server').createBroadcastServer({dataDir:process.argv[1],pin:'production-console-main-fixture',
 scorekeeperPin:'production-console-score-fixture',hostPin:'song-titles-host-fixture'});
app.listen(0,'127.0.0.1').then(a=>console.log(a.port));process.on('SIGTERM',()=>app.close().then(()=>process.exit()));
"""
GEOMETRY = r"""selector=>[...document.querySelectorAll(selector)].map(node=>{
  const box=node.getBoundingClientRect(),css=getComputedStyle(node),range=document.createRange();range.selectNodeContents(node);
  const owner=node.closest('.candidate,.selection-focus-card,.picks>span,.candidate-row,.song-focus-title,.selected-track,.candidate-card');
  const parent=owner.getBoundingClientRect(),badge=owner.querySelector('.song-difficulty')?.getBoundingClientRect();
  const scale=node.closest('#canvas')?document.querySelector('#canvas').getBoundingClientRect().width/1920:1;
  const rect=box=>({left:box.left/scale,top:box.top/scale,right:box.right/scale,bottom:box.bottom/scale});
  return {text:node.innerText.trim(),font:parseFloat(css.fontSize),overflow:css.textOverflow,clamp:css.webkitLineClamp,
    clipsX:['hidden','clip'].includes(css.overflowX),clipsY:['hidden','clip'].includes(css.overflowY),
    width:node.clientWidth,scrollWidth:node.scrollWidth,box:rect(box),parent:rect(parent),badge:badge?rect(badge):null,
    lines:[...range.getClientRects()].filter(b=>b.width>0&&b.height>0).map(rect)};
})"""


def assert_titles(items, label, expected=None):
    assert items, (label, 'no song titles')
    if expected is not None:
        assert [item['text'] for item in items] == expected, (label, 'title content changed')
    for item in items:
        assert item['scrollWidth'] <= item['width'] + 1, (label, 'horizontal overflow', item)
        assert item['box']['left'] >= item['parent']['left'] - 1, (label, item)
        assert item['box']['right'] <= item['parent']['right'] + 1, (label, item)
        for line in item['lines']:
            assert line['left'] >= item['parent']['left'] - 1 and line['right'] <= item['parent']['right'] + 1, (label, 'clipped text', item)
            assert line['top'] >= item['parent']['top'] - 1 and line['bottom'] <= item['parent']['bottom'] + 1, (label, 'vertical overflow', item)
            if item['clipsX']:
                assert line['left'] >= item['box']['left'] - 1 and line['right'] <= item['box']['right'] + 1, (label, 'clipped title', item)
            if item['clipsY'] or item['clamp'] not in ['none', '0']:
                assert line['top'] >= item['box']['top'] - 1 and line['bottom'] <= item['box']['bottom'] + 1, (label, 'clipped title lines', item)
        if item['badge']:
            assert item['box']['right'] <= item['badge']['left'] + 1, (label, 'title overlaps difficulty', item)


def check_titles(page, selector, label, expected=None):
    items = page.evaluate(GEOMETRY, selector)
    assert_titles(items, label, expected)
    REPORT['geometry'].append({'label': label, 'titles': items})
    REPORT['checks'].append(label)
    print('PASS ' + label, flush=True)
    return items


def idle(page):
    page.wait_for_function('''document.querySelector('#canvas')?.dataset.renderedScene==='song-selection'
      &&document.querySelector('#scene')?.dataset.motionPhase==='idle' ''')


def run(browser, fixture):
    with tempfile.TemporaryDirectory(prefix='song-titles-') as directory:
        process, base = P.start_server(directory, fixture)
        context = None
        try:
            context, main = P.login(browser, base)
            saved = P.state(main)
            match = next(m for m in saved['tournament']['matches'] if m['id'] == saved['tournament']['currentMatchId'])
            expected = [song['title'] for song in match['candidates']]
            live = context.new_page()
            live.set_viewport_size({'width': 1920, 'height': 1080})
            live.goto(base + '/overlay/live.html?bgm=0')
            if fixture == 'rolling':
                live.evaluate('''()=>{
                  const measure=TITLE_GEOMETRY;window.__songTitleFrames=[];
                  function frame(){
                    const canvas=document.querySelector('#canvas');
                    if(canvas?.dataset.roulettePhase==='rolling'&&document.querySelector('#scene').dataset.motionPhase==='idle')
                      window.__songTitleFrames.push({index:canvas.dataset.rouletteIndex,titles:measure('[data-motion-content] .candidate h3')});
                    window.__songTitleRaf=requestAnimationFrame(frame);
                  }frame();
                }'''.replace('TITLE_GEOMETRY', GEOMETRY))
                live.wait_for_function('document.querySelector("#canvas")?.dataset.roulettePhase==="complete"')
                idle(live)
                frames = live.evaluate('cancelAnimationFrame(window.__songTitleRaf);window.__songTitleFrames')
                REPORT['roulette_frames'] = frames
                assert {frame['index'] for frame in frames} == {'0', '1'}, 'Both real roulette rolls must be sampled'
                for frame in frames:
                    assert_titles(frame['titles'], 'roulette ' + frame['index'], expected)
                REPORT['checks'].append('Both roulette rolls keep full titles, fixed catalogue rows and separate difficulty badges')
                print('PASS ' + REPORT['checks'][-1], flush=True)
                live.screenshot(path=str(OUT / 'rolling-complete-obs.png'))
                return
            idle(live)
            for width, height in [(1920, 1080), (1280, 720), (960, 540)]:
                live.set_viewport_size({'width': width, 'height': height})
                check_titles(live, '[data-motion-content] .candidate h3', f'{fixture}: OBS catalogue {width}', expected)
                check_titles(live, '[data-motion-content] .selection-focus-card h2', f'{fixture}: OBS focused song {width}')
                if fixture == 'picked':
                    check_titles(live, '[data-motion-content] .picks>span>span', f'{fixture}: OBS picked songs {width}')
                    assert live.locator('[data-motion-content] .candidate-status').all_text_contents().count('BAN') == 2
                if width == 1920 and fixture in ['example', 'stress', 'picked']:
                    live.screenshot(path=str(OUT / (fixture + '-obs.png')))
            if fixture.startswith('official-'):
                return
            if fixture == 'example':
                live.set_viewport_size({'width': 1920, 'height': 1080})
                P.command(main, 'ban-song', {'matchId': match['id'], 'playerIndex': 0, 'songId': match['candidates'][4]['id']})
                live.wait_for_function('document.querySelector("[data-motion-content] .candidate.banned")')
                idle(live)
                check_titles(live, '[data-motion-content] .candidate h3', 'BAN labels preserve complete catalogue titles', expected)
                live.screenshot(path=str(OUT / 'example-banned-obs.png'))
            for width, height in [(1440, 1000), (800, 1000), (390, 844)]:
                main.set_viewport_size({'width': width, 'height': height})
                check_titles(main, '.production-embedded .song-preview-button', f'{fixture}: embedded control {width}', expected)
            main.click('.tabs [data-tab="songs"]')
            for width, height in [(1440, 1000), (800, 1000), (390, 844)]:
                main.set_viewport_size({'width': width, 'height': height})
                check_titles(main, '.song-preview-button', f'{fixture}: full control {width}', expected)
                check_titles(main, '.song-focus-title h2', f'{fixture}: control focused song {width}')
                if fixture == 'picked':
                    check_titles(main, '.selected-track h3', f'{fixture}: control picked songs {width}')
                assert main.evaluate('document.documentElement.scrollWidth<=innerWidth+1'), (fixture, width, 'page overflow')
                main.screenshot(path=str(OUT / f'{fixture}-control-{width}.png'), full_page=True)
            host = context.new_page()
            host.goto(base + '/host/')
            host.fill('#pin', 'song-titles-host-fixture')
            host.click('#pair-form button')
            host.wait_for_selector('#workspace:not([hidden])')
            for width, height in [(1440, 1000), (800, 1000), (390, 844)]:
                host.set_viewport_size({'width': width, 'height': height})
                # PICK labels are separate visible text in the host card heading.
                titles = check_titles(host, '.candidate-card h2', f'{fixture}: host {width}')
                assert [item['text'].split('\n')[-1] for item in titles] == expected
                assert host.evaluate('document.documentElement.scrollWidth<=innerWidth+1'), (fixture, width, 'host overflow')
            host.screenshot(path=str(OUT / (fixture + '-host-mobile.png')), full_page=True)
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
                for fixture in ['rolling', 'example', 'stress', 'picked', *[f'official-{i}' for i in range(5)]]:
                    run(browser, fixture)
                assert not REPORT['browser_errors'], REPORT['browser_errors']
            finally:
                browser.close()
    finally:
        (OUT / 'report.json').write_text(json.dumps(REPORT, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
