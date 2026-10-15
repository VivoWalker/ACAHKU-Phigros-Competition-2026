"""Per-song OBS statistics and completed-match identity regression.

Uses generated tournament fixtures and temporary storage; never reads event data
or pairing credentials. Requires Python Playwright, Chromium and Pillow.
"""
import io
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import tempfile

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results' / 'song-result'))
SERVER = r"""
const {createBroadcastServer}=require('./server');
const {createDefaultState}=require('./lib/default-state');
const {applyAction,publicState}=require('./lib/tournament');
const broadcast=createBroadcastServer({dataDir:process.argv[1],pin:'song-statistics-fixture',scorekeeperPin:'song-statistics-scorer-fixture'});
function fixture(kind){
 const s=createDefaultState(),act=(type,payload={})=>applyAction(s,{type,payload});
 const counters={accuracy:99.1234,perfect:99999,good:12,bad:3,miss:0};
 s.event.title='ACAHKU Phigros Competition';
 if(kind==='qualifier'||kind==='qualifier-second-song'){
  act('set-qualifier-plan',{plan:'A'});
  s.qualifier.activePlayers=['p1','p2','p3'];
  const songIndex=kind==='qualifier'?0:1;
  act('set-qualifier-song-stats',{group:'A',playerId:'p1',songIndex,stats:{score:999123,...counters,...(songIndex?{perfect:Number.MAX_SAFE_INTEGER}:{})}});
  act('set-qualifier-song-stats',{group:'A',playerId:'p2',songIndex,stats:{score:0,perfect:0,good:0,bad:0,miss:0}});
  act('set-qualifier-display',{currentSong:songIndex});
 }else if(kind==='legacy'){
  delete s.qualifier.scoringMode;
  for(const player of s.qualifier.players)delete player.challengeTotal;
  act('set-qualifier-score',{playerId:'p1',songIndex:0,score:987654,judgements:counters});
 }else{
  act('seed-bracket',{ids:s.qualifier.players.map(player=>player.id),verified:true});
  const m=s.tournament.matches.find(match=>match.id==='W1');
  if(kind!=='waiting'){
   act('draw-candidates',{matchId:'W1'});
   act('ban-song',{matchId:'W1',playerIndex:0,songId:m.candidates[0].id});
   act('ban-song',{matchId:'W1',playerIndex:1,songId:m.candidates[1].id});
   act('pick-songs',{matchId:'W1'});
   const values=[[987654,976543],[0,965432]];
   for(let pi=0;pi<2;pi++)for(let si=0;si<2;si++)act('set-match-score',{
    matchId:'W1',playerIndex:pi,songIndex:si,score:values[pi][si],judgements:counters});
   if(kind==='completed'){
    act('record-result',{matchId:'W1',verified:true});
    act('select-match',{matchId:'W2'});
   }
  }
 }
 if(kind==='waiting')act('set-scene',{scene:'double-elimination-waiting'});
 else act('set-scene',{scene:kind==='completed'?'result':kind==='match'?'double-elimination-match':'song-result'});
 return s;
}
broadcast.app.post('/__fixture',(req,res)=>{
 try{
  const s=fixture(req.body.kind);s.revision=broadcast.store.state.revision+1;
  broadcast.store.state=s;broadcast.io.of('/overlay').emit('state',publicState(s));res.json({revision:s.revision});
 }catch(error){res.status(400).json({error:error.message})}
});
broadcast.listen(0,'127.0.0.1').then(address=>console.log(address.port));
process.on('SIGTERM',()=>broadcast.close().then(()=>process.exit()));
"""

GEOMETRY = r"""() => {
 const root=document.querySelector('#canvas'),walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),fragments=[];
 let node;
 while(node=walker.nextNode()){
  if(!node.textContent.trim()||node.parentElement.closest('svg,script,style,.offline-notice'))continue;
  if(!node.parentElement.checkVisibility({opacityProperty:true,visibilityProperty:true}))continue;
  const range=document.createRange();range.selectNodeContents(node);
  for(const box of range.getClientRects()){
   const r={left:box.left,right:box.right,top:box.top,bottom:box.bottom};
   for(let parent=node.parentElement;parent;parent=parent.parentElement){
    const css=getComputedStyle(parent),b=parent.getBoundingClientRect();
    if(['hidden','clip','auto','scroll'].includes(css.overflowX)){r.left=Math.max(r.left,b.left);r.right=Math.min(r.right,b.right)}
    if(['hidden','clip','auto','scroll'].includes(css.overflowY)){r.top=Math.max(r.top,b.top);r.bottom=Math.min(r.bottom,b.bottom)}
   }
   if(r.right-r.left>.2&&r.bottom-r.top>.2)fragments.push({r,text:node.textContent.trim().slice(0,60),node});
  }
 }
 const overlaps=[];
 for(let i=0;i<fragments.length;i++)for(let j=i+1;j<fragments.length;j++){
  const a=fragments[i],b=fragments[j];if(a.node===b.node)continue;
  const w=Math.min(a.r.right,b.r.right)-Math.max(a.r.left,b.r.left),h=Math.min(a.r.bottom,b.r.bottom)-Math.max(a.r.top,b.r.top);
  if(w>1&&h>1)overlaps.push({a:a.text,b:b.text,w,h});
 }
 const logos=[...document.querySelectorAll('.club-logo,.phigros-logo,.phigros-wordmark')];
 const cards=[...document.querySelectorAll('.song-result-card,.song-result-heading,.result-wrap')];
 const logoOverlaps=[];
 for(const logo of logos)for(const card of cards){
  const a=logo.getBoundingClientRect(),b=card.getBoundingClientRect();
  if(Math.min(a.right,b.right)>Math.max(a.left,b.left)&&Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top))logoOverlaps.push(logo.className);
 }
 return {overlaps,logoOverlaps,fragments:fragments.length,
  clippedCards:cards.filter(card=>card.scrollHeight>card.clientHeight+1).map(card=>card.className),
  captureHoles:document.querySelectorAll('[data-aperture-key],[data-capture]').length,
  logoZ:logos.map(logo=>getComputedStyle(logo).zIndex)};
}"""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'checks': [], 'geometry': [], 'browser_errors': []}
    with tempfile.TemporaryDirectory(prefix='song-statistics-browser-') as directory:
        process = subprocess.Popen(['node', '-e', SERVER, directory], cwd=ROOT,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            with selectors.DefaultSelector() as ready:
                ready.register(process.stdout, selectors.EVENT_READ)
                assert ready.select(timeout=12), 'Fixture server did not start'
            port = process.stdout.readline().strip()
            assert port.isdigit(), 'Fixture server failed to report port'
            base = 'http://127.0.0.1:' + port
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(executable_path=shutil.which('chromium'), args=['--no-sandbox'])
                context = browser.new_context(viewport={'width': 1920, 'height': 1080}, reduced_motion='reduce')
                page = context.new_page()
                page.on('pageerror', lambda error: report['browser_errors'].append(str(error)))

                def fixture(kind):
                    response = context.request.post(base + '/__fixture', data={'kind': kind})
                    assert response.ok, response.text()
                    revision = response.json()['revision']
                    if page.url == 'about:blank':
                        page.goto(base + '/overlay/live.html?audio=0')
                    page.wait_for_function('revision=>Number(document.querySelector("#canvas").dataset.renderedRevision)>=revision', arg=revision)
                    page.evaluate('document.fonts.ready')

                for kind in ['qualifier', 'qualifier-second-song', 'legacy', 'double', 'completed', 'waiting']:
                    fixture(kind)
                    if kind.startswith('qualifier'):
                        assert page.locator('.song-result-card').count() == 3
                        assert page.locator('[data-player-id=p1] [data-stat=score]').inner_text() == '999,123'
                        assert page.locator('[data-player-id=p2] [data-stat=score]').inner_text() == '0'
                        assert page.locator('[data-player-id=p2] [data-stat=miss]').inner_text() == '0'
                        assert page.locator('[data-player-id=p3] [data-stat]').all_inner_texts() == ['—'] * 5
                        assert ('SONG 2 / 3' if kind.endswith('second-song') else 'SONG 1 / 3') in page.locator('.song-result-heading').inner_text()
                    elif kind == 'legacy':
                        assert page.locator('[data-player-id=p1] [data-stat=score]').inner_text() == '987,654'
                        assert page.locator('[data-player-id=p1] [data-stat=perfect]').inner_text() == '99,999'
                    elif kind == 'double':
                        assert page.locator('.song-result-card').count() == 2
                        assert page.locator('.song-result-score').all_inner_texts() == ['987,654', '0']
                    elif kind == 'completed':
                        assert 'W1' in page.locator('.topmeta').inner_text()
                        assert page.locator('.result-song-scores b').all_inner_texts() == ['987,654', '976,543', '0', '965,432']
                        assert page.locator('.result-row>strong').all_inner_texts() == ['1,964,197', '965,432']
                    else:
                        assert 'SONG SELECTION NEXT' in page.locator('.waiting-song').inner_text()
                        assert 'SONG 1 /' not in page.locator('.waiting-song').inner_text()
                    report['checks'].append(kind)
                    for width, height in [(1920, 1080), (1280, 720), (960, 540), (390, 844)]:
                        page.set_viewport_size({'width': width, 'height': height})
                        if kind != 'waiting':
                            geometry = page.evaluate(GEOMETRY)
                            assert not geometry['overlaps'], (kind, width, geometry['overlaps'])
                            assert not geometry['logoOverlaps'], (kind, width, geometry['logoOverlaps'])
                            assert not geometry['clippedCards'], (kind, width, geometry['clippedCards'])
                            assert geometry['captureHoles'] == 0, (kind, 'Statistics must have no camera holes')
                            assert all(int(value) >= 1000 for value in geometry['logoZ'])
                            report['geometry'].append({'fixture': kind, 'width': width, **geometry})
                        if width in [1920, 390]:
                            png = page.screenshot(path=str(OUT / f'{kind}-{width}.png'), omit_background=True)
                            if width == 1920 and kind != 'waiting':
                                image = Image.open(io.BytesIO(png)).convert('RGBA')
                                assert image.getpixel((500, 520))[3] == 255, 'Statistics background must cover OBS captures'
                fixed = context.new_page()
                fixture('qualifier')
                fixed.goto(base + '/overlay/song-result.html?fixed=1&audio=0')
                fixed.wait_for_selector('.song-result-card')
                assert fixed.locator('.song-result-card').count() == 3
                report['checks'].append('standalone stats page')
                page.set_viewport_size({'width': 1920, 'height': 1080})
                page.emulate_media(reduced_motion='no-preference')
                fixture('match')
                page.wait_for_function('document.querySelector("#scene").dataset.motionPhase==="idle"')
                logo_refs = page.locator('[data-motion-branding] img').element_handles()
                fixture('double')
                page.wait_for_selector('.song-result-card[data-motion-entry]')
                entries = page.locator('.song-result-card').evaluate_all('''cards=>cards.map(card=>({
                  x:JSON.parse(card.dataset.motionEntryRect).left,order:Number(card.dataset.motionOrder),
                  frames:card.getAnimations().flatMap(animation=>animation.effect.getKeyframes()),
                  easing:card.getAnimations().map(animation=>animation.effect.getTiming().easing)
                }))''')
                assert entries[0]['x'] < entries[1]['x'] and entries[0]['order'] < entries[1]['order'], entries
                assert all(any('translateX(36px)' in frame.get('transform', '') and frame.get('opacity') == '0'
                               for frame in entry['frames']) for entry in entries), entries
                assert all(all(easing.startswith('cubic-bezier') for easing in entry['easing']) for entry in entries), entries
                page.wait_for_function('document.querySelector("#scene").dataset.motionPhase==="idle"')
                assert page.locator('[data-aperture-key],[data-capture]').count() == 0
                assert all(handle.evaluate('(logo)=>logo.isConnected') for handle in logo_refs)
                report['checks'].append('stats animate from right in left-to-right order, close capture apertures, retain logos')
                assert not report['browser_errors'], report['browser_errors']
                browser.close()
        finally:
            process.terminate()
            try:
                process.communicate(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
    report['result'] = 'PASS'
    (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({'result': 'PASS', 'checks': report['checks'], 'geometry_checks': len(report['geometry'])}))


if __name__ == '__main__':
    main()
