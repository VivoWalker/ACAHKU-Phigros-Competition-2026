"""Challenge-set, single-song OBS statistics and match identity regression.

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
 if(kind.startsWith('qualifier')){
  act('set-qualifier-plan',{plan:'A'});
  for(let songIndex=0;songIndex<3;songIndex++){
   act('set-qualifier-song-stats',{group:'A',playerId:'p1',songIndex,stats:{score:999123-songIndex*1000,...counters,
     ...(kind==='qualifier-long'?{perfect:Number.MAX_SAFE_INTEGER,good:Number.MAX_SAFE_INTEGER,bad:Number.MAX_SAFE_INTEGER,miss:Number.MAX_SAFE_INTEGER}:{})}});
   act('set-qualifier-song-stats',{group:'A',playerId:'p2',songIndex,stats:{score:0,perfect:0,good:0,bad:0,miss:0}});
  }
  act('set-qualifier-total',{group:'A',playerId:'p1',total:2999001});
  act('set-qualifier-total',{group:'A',playerId:'p2',total:0});
  act('set-qualifier-display',{currentSong:kind==='qualifier-second-song'?1:0,
    players:kind==='qualifier-empty'?[]:kind==='qualifier-one'?['p1']:kind==='qualifier-two'?['p1','p2']:['p1','p2','p3']});
  if(kind==='qualifier-long'){
   for(const player of s.qualifier.players)player.name='極長選手名稱 Long Player Name '.repeat(3);
   for(const id of s.qualifier.groups.A.songs)s.library.find(song=>song.id===id).title='Retribution ~ Cycle of Redemption ~ 極長曲目標題 '.repeat(4);
  }
  if(kind==='qualifier-tie'){
   act('set-qualifier-total',{group:'A',playerId:'p2',total:2999001});
   act('draw-qualifier-tiebreak',{group:'A',playerIds:['p1','p2']});
   act('set-qualifier-tiebreak-score',{group:'A',index:0,playerId:'p1',score:987654});
  }
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
 const cards=[...document.querySelectorAll('.song-result-card,.song-result-heading,.challenge-set-card,.challenge-set-heading,.result-wrap')];
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

                for kind in ['qualifier', 'qualifier-second-song', 'qualifier-one', 'qualifier-two', 'qualifier-empty',
                             'qualifier-long', 'qualifier-tie', 'legacy', 'double', 'completed', 'waiting']:
                    fixture(kind)
                    if kind.startswith('qualifier') and kind != 'qualifier-tie':
                        expected_count = 0 if kind.endswith('empty') else 1 if kind.endswith('one') else 2 if kind.endswith('two') else 3
                        assert page.locator('.challenge-set-card').count() == expected_count
                        assert page.locator('.song-result-card').count() == 0
                        assert page.locator('.challenge-set-results').get_attribute('data-count') == str(expected_count)
                        for card in page.locator('.challenge-set-card').all():
                            assert card.locator('.challenge-set-song').count() == 3
                            assert card.locator('.challenge-set-song').evaluate_all('rows=>rows.map(row=>row.dataset.songIndex)') == ['0', '1', '2']
                            assert all(card.locator('.challenge-set-song').evaluate_all('rows=>rows.map(row=>Boolean(row.dataset.songId))'))
                        if expected_count:
                            card = page.locator('.challenge-set-card[data-player-id=p1]')
                            assert card.locator('[data-stat=score]').all_inner_texts() == ['999,123', '998,123', '997,123']
                            # The official game result is preserved instead of replacing it with an inferred sum.
                            assert card.locator('[data-stat=challengeTotal]').inner_text() == '2,999,001'
                            assert sum([999123, 998123, 997123]) != 2999001
                        if expected_count >= 2:
                            card = page.locator('.challenge-set-card[data-player-id=p2]')
                            assert card.locator('.challenge-set-song [data-stat]').all_inner_texts() == ['0'] * 15
                            assert card.locator('[data-stat=challengeTotal]').inner_text() == '0'
                        if expected_count == 3:
                            assert page.locator('.challenge-set-card[data-player-id=p3] [data-stat]').all_inner_texts() == ['—'] * 16
                        if kind == 'qualifier-long':
                            assert page.locator('.challenge-set-card[data-player-id=p1] [data-stat=perfect]').all_inner_texts() == ['9,007,199,254,740,991'] * 3
                    elif kind == 'qualifier-tie':
                        assert page.locator('.challenge-set-card').count() == 0
                        assert page.locator('.song-result-card').count() == 2
                        assert 'TIEBREAK 1' in page.locator('.song-result-heading').inner_text()
                        assert page.locator('[data-player-id=p1] [data-stat=score]').inner_text() == '987,654'
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
                    for width, height in [(1920, 1080), (1194, 834), (834, 1194), (390, 844)]:
                        page.set_viewport_size({'width': width, 'height': height})
                        page.wait_for_function('''()=>Math.abs(document.querySelector('#canvas').getBoundingClientRect().width-
                          Math.min(innerWidth/1920,innerHeight/1080)*1920)<.1''')
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
                fixed.wait_for_selector('.challenge-set-card')
                assert fixed.locator('.challenge-set-card').count() == 3
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
                fixture('qualifier')
                page.wait_for_selector('.challenge-set-heading[data-motion-entry]')
                page.wait_for_selector('.challenge-set-card[data-motion-entry]')
                set_entries = page.locator('.challenge-set-card').evaluate_all('''cards=>cards.map(card=>({
                  x:JSON.parse(card.dataset.motionEntryRect).left,order:Number(card.dataset.motionOrder),
                  frames:card.getAnimations().flatMap(animation=>animation.effect.getKeyframes()),
                  easing:card.getAnimations().map(animation=>animation.effect.getTiming().easing)
                }))''')
                assert len(set_entries) == 3
                assert all(a['x'] < b['x'] and a['order'] < b['order'] for a, b in zip(set_entries, set_entries[1:])), set_entries
                assert all(any('translateX(36px)' in frame.get('transform', '') and frame.get('opacity') == '0'
                               for frame in entry['frames']) for entry in set_entries), set_entries
                assert all(entry['easing'] and all(easing.startswith('cubic-bezier') for easing in entry['easing']) for entry in set_entries), set_entries
                page.wait_for_function('document.querySelector("#scene").dataset.motionPhase==="idle"')
                assert all(handle.evaluate('(logo)=>logo.isConnected') for handle in logo_refs)
                report['checks'].append('full Challenge results retain logos and stagger all three cards from left to right with nonlinear entry animations')
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
