"""Real-browser coverage for the operator-controlled Challenge processing cue.

Only temporary fixture tournaments and dummy pairing codes are used. Requires
Python Playwright, Pillow and Chromium. No live state or credentials are read.
"""
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import tempfile

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results' / 'qualifier-processing'))
REPORT = {'checks': [], 'geometry': [], 'browser_errors': [], 'screenshots': []}


def helper(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT / 'test' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.OUT, module.REPORT = OUT, REPORT
    return module


P = helper('production-console-browser')
C = helper('challenge-qualifier-browser')
C.MAIN_PIN = P.PIN
C.SCORE_PIN = 'production-console-score-fixture'

GEOMETRY = r"""() => {
 const panel=document.querySelector('.qualifier-processing-panel'),canvas=document.querySelector('#canvas');
 const logos=[...document.querySelectorAll('[data-motion-branding] img')];
 const bounds=element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}};
 const rect=bounds(panel),viewport=bounds(canvas),overlaps=[];
 const walker=document.createTreeWalker(canvas,NodeFilter.SHOW_TEXT),texts=[];let node;
 while(node=walker.nextNode()){
  if(!node.textContent.trim()||node.parentElement.closest('svg,script,style,.offline-notice'))continue;
  if(!node.parentElement.checkVisibility({opacityProperty:true,visibilityProperty:true}))continue;
  const range=document.createRange();range.selectNodeContents(node);
  for(const r of range.getClientRects())if(r.width>.2&&r.height>.2)texts.push({node,text:node.textContent.trim(),r});
 }
 for(let i=0;i<texts.length;i++)for(let j=i+1;j<texts.length;j++){
  const a=texts[i],b=texts[j];if(a.node===b.node)continue;
  const w=Math.min(a.r.right,b.r.right)-Math.max(a.r.left,b.r.left),h=Math.min(a.r.bottom,b.r.bottom)-Math.max(a.r.top,b.r.top);
  if(w>.5&&h>.5)overlaps.push({a:a.text,b:b.text,w,h});
 }
 const logoOverlaps=logos.filter(logo=>{const r=bounds(logo);return Math.min(r.right,rect.right)>Math.max(r.left,rect.left)&&Math.min(r.bottom,rect.bottom)>Math.max(r.top,rect.top)});
 return {rect,viewport,overlaps,logoOverlaps:logoOverlaps.map(logo=>logo.className),
  logoZ:logos.map(logo=>getComputedStyle(logo).zIndex),clipped:panel.scrollWidth>panel.clientWidth+1||panel.scrollHeight>panel.clientHeight+1,
  captureHoles:document.querySelectorAll('[data-aperture-key],[data-capture]').length,
  scoreElements:document.querySelectorAll('[data-stat],.challenge-set-card,.song-result-card,.qualifier-player').length,
  footer:document.querySelector('.footer')?.textContent||''};
}"""

MOTION = r"""() => {
 const panel=document.querySelector('.qualifier-processing-panel');
 return {entry:panel.dataset.motionEntry,order:panel.dataset.motionOrder,
  animations:panel.getAnimations().map(animation=>({frames:animation.effect.getKeyframes(),timing:animation.effect.getTiming()}))};
}"""


def check(name, detail=None):
    REPORT['checks'].append({'name': name, 'detail': detail})
    print('PASS ' + name, flush=True)


def processing_idle(page):
    C.idle(page, 'qualifier-processing')
    assert page.locator('.qualifier-processing-panel h1').inner_text() == '結果正在統計中'


def assert_geometry(page, label):
    for width, height in [(1920, 1080), (1194, 834), (834, 1194), (390, 844)]:
        page.set_viewport_size({'width': width, 'height': height})
        page.wait_for_function('''()=>Math.abs(document.querySelector('#canvas').getBoundingClientRect().width-
          Math.min(innerWidth/1920,innerHeight/1080)*1920)<.1''')
        geometry = page.evaluate(GEOMETRY)
        REPORT['geometry'].append({'name': label, 'width': width, **geometry})
        assert not geometry['overlaps'], (label, width, geometry['overlaps'])
        assert not geometry['logoOverlaps'], (label, width, geometry['logoOverlaps'])
        assert not geometry['clipped'], (label, width, 'Clipped processing panel')
        assert all(int(z) >= 1000 for z in geometry['logoZ']), geometry
        assert geometry['captureHoles'] == 0 and geometry['scoreElements'] == 0, geometry
        assert not geometry['footer'], 'Processing cue should not add a lower-left explanatory footer'
        panel, viewport = geometry['rect'], geometry['viewport']
        assert viewport['left'] <= panel['left'] < panel['right'] <= viewport['right'], geometry
        assert viewport['top'] <= panel['top'] < panel['bottom'] <= viewport['bottom'], geometry
        path = OUT / f'{label}-{width}.png'
        png = page.screenshot(path=str(path), omit_background=True, animations='disabled')
        REPORT['screenshots'].append(str(path))
        if width == 1920:
            image = Image.open(io.BytesIO(png)).convert('RGBA')
            for x, y in [(320, 380), (960, 540), (1600, 860)]:
                assert image.getpixel((x, y))[3] == 255, 'Processing must cover the live OBS camera layers'
    page.set_viewport_size({'width': 1920, 'height': 1080})


def assert_branding_refs(page):
    return page.evaluate('''()=>window.__processingLogos.every(logo=>logo.isConnected)&&
      window.__processingBackground===document.querySelector('.broadcast-backdrop')''')


def footer_audit(page, scene):
    C.idle(page, scene)
    result = page.evaluate('''()=>{
      const canvas=document.querySelector('#canvas').getBoundingClientRect();
      return [...document.querySelectorAll('.footer span')].filter(span=>span.checkVisibility({opacityProperty:true,visibilityProperty:true})).map(span=>{
        const r=span.getBoundingClientRect();return {text:span.textContent,left:r.left,center:canvas.left+canvas.width/2};
      });
    }''')
    assert all(item['left'] >= item['center'] for item in result), (scene, 'A left explanatory footer remained', result)
    text = page.locator('#scene').inner_text()
    assert '三首連續遊玩' not in text and '每 12 秒換頁' not in text, (scene, text)


def run(browser, data_dir):
    process, base = P.start_server(data_dir, 'qualifier')
    main_context = score_context = overlay_context = None
    try:
        main_context, main = P.login(browser, base)
        score_context, scorer = C.login(browser, base, 'scorekeeper')
        current = P.state(main)
        players, group = current['qualifier']['activePlayers'], current['qualifier']['activeGroup']
        C.wait_batch(scorer, players)
        context_key = C.state(scorer, 'scorekeeper')['contextKey']
        P.command(main, 'set-broadcast-display', {'showHandcams': True})
        P.command(main, 'set-broadcast-cue', {'stage': 'qualifier', 'scene': 'qualifier-match', 'group': group,
                                          'players': players, 'songIndex': 2})
        P.phase(main, 'match')
        stats = [{'score': 990123-index*1000, 'perfect': 980+index, 'good': 19-index, 'bad': 1, 'miss': 0} for index in range(3)]
        C.fill_challenge(scorer, players[0], stats, 2999123)
        overlay_context = browser.new_context(viewport={'width': 1920, 'height': 1080})
        overlay_context.on('page', lambda page: page.on('pageerror', lambda error: REPORT['browser_errors'].append(str(error))))
        live = overlay_context.new_page()
        live.goto(base + '/overlay/live.html')
        C.idle(live, 'qualifier-match')
        live.evaluate('''()=>{window.__processingLogos=[...document.querySelectorAll('[data-motion-branding] img')];
          window.__processingBackground=document.querySelector('.broadcast-backdrop')}''')
        assert live.locator('[data-capture]').count() == 6
        P.next_step(main, 'processing')
        live.wait_for_selector('.qualifier-processing-panel[data-motion-entry]')
        motion = live.evaluate(MOTION)
        REPORT['entry_motion'] = motion
        assert motion['animations'] and all(item['timing']['easing'].startswith('cubic-bezier') for item in motion['animations']), motion
        assert any('translateX(36px)' in frame.get('transform', '') and frame.get('opacity') == '0'
                   for item in motion['animations'] for frame in item['frames']), motion
        processing_idle(live)
        assert assert_branding_refs(live), 'Processing replaced the shared background or branding DOM'
        assert C.state(scorer, 'scorekeeper')['contextKey'] == context_key
        C.wait_batch(scorer, players)
        assert C.song_field(scorer, players[0], 0).input_value() == str(stats[0]['score'])
        assert scorer.locator('.stale-context').count() == 0
        assert main.locator('form[data-score-editor="qd"]').count() == len(players)*3
        assert main.locator('form[data-score-editor="qc"]').count() == len(players)
        live.wait_for_function('''()=>{const audio=document.querySelector('audio[data-scene-bgm]');
          return audio?.dataset.trackId==='chapter-select'&&!audio.paused&&audio.volume>0}''')
        assert_geometry(live, 'processing')
        check('third song enters an opaque score-free processing screen with nonlinear entry, stable logos, closed capture holes and chapter-select music')
        P.geometry(main, 'processing-staff-score-editors')
        check('processing staff view retains all three correction sheets per current player without overlapping controls')

        for index, player in enumerate(players):
            rows = [{**row, 'score': row['score']-index} for row in stats]
            form = C.fill_challenge(scorer, player, rows, 2999123-index)
            form.locator('[data-save-player]').click()
            C.saved_challenge(scorer, player, rows, 2999123-index, group)
        assert P.state(main)['scene'] == 'qualifier-processing'
        processing_idle(live)
        assert live.locator('[data-stat]').count() == 0
        assert C.state(scorer, 'scorekeeper')['contextKey'] == context_key
        check('all sixteen fields save per current player during processing without automatically revealing any result or changing scorer context')
        main.reload()
        main.wait_for_selector('.production-workflow[data-phase="processing"]')
        main.evaluate(P.COMMANDS)
        live.reload()
        processing_idle(live)
        assert_geometry(live, 'processing-after-refresh')
        check('control and OBS refresh restore the saved processing cue without exposing recorded scores')
        main_context.close(); main_context = None
        score_context.close(); score_context = None
        overlay_context.close(); overlay_context = None
        P.stop_server(process); process = None

        process, base = P.start_server(data_dir, 'qualifier')
        main_context, main = P.login(browser, base)
        P.phase(main, 'processing')
        score_context, scorer = C.login(browser, base, 'scorekeeper')
        C.wait_batch(scorer, players)
        assert C.song_field(scorer, players[0], 3).input_value() == '2999123'
        context_key = C.state(scorer, 'scorekeeper')['contextKey']
        overlay_context = browser.new_context(viewport={'width': 1920, 'height': 1080})
        overlay_context.on('page', lambda page: page.on('pageerror', lambda error: REPORT['browser_errors'].append(str(error))))
        live = overlay_context.new_page()
        live.goto(base + '/overlay/live.html?audio=0')
        processing_idle(live)
        assert_geometry(live, 'processing-after-server-restart')
        live.evaluate('''()=>{window.__processingLogos=[...document.querySelectorAll('[data-motion-branding] img')];
          window.__processingBackground=document.querySelector('.broadcast-backdrop');
          window.__processingExitFrames=[];const animate=Element.prototype.animate;
          Element.prototype.animate=function(frames,timing){
            if(this.matches('.qualifier-processing-panel'))window.__processingExitFrames.push({frames,timing});
            return animate.call(this,frames,timing);
          }}''')
        check('temporary server restart restores the processing scene, active batch and every saved score')
        P.next_step(main, 'set-result')
        live.wait_for_function('window.__processingExitFrames.length>0')
        exits = live.evaluate('window.__processingExitFrames')
        REPORT['exit_motion'] = exits
        assert exits and all(item['timing']['easing'].startswith('cubic-bezier') for item in exits), exits
        assert any('translateX(-36px)' in frame.get('transform', '') and str(frame.get('opacity')) == '0'
                   for item in exits for frame in item['frames']), exits
        C.idle(live, 'song-result')
        assert assert_branding_refs(live), 'Results reveal replaced the persistent background or branding'
        assert live.locator('.challenge-set-card').count() == len(players)
        assert live.locator(f'[data-player-id="{players[0]}"] [data-stat="score"]').all_inner_texts() == ['990,123', '989,123', '988,123']
        assert live.locator(f'[data-player-id="{players[0]}"] [data-stat="challengeTotal"]').inner_text() == '2,999,123'
        assert C.state(scorer, 'scorekeeper')['contextKey'] == context_key
        check('only the operator reveals the complete set, with leftward nonlinear exit and unchanged scorer batch')
        fixed = overlay_context.new_page()
        fixed.goto(base + '/overlay/qualifier-processing.html?fixed=1&audio=0')
        processing_idle(fixed)
        assert_geometry(fixed, 'processing-standalone')
        fixed.close()
        check('standalone fixed OBS processing source renders the same score-free opaque scene')

        for scene in ['song-result', 'result', 'qualifier-waiting', 'start', 'double-elimination-waiting',
                      'double-elimination-match', 'song-selection', 'bracket', 'grand-final-announcement']:
            P.command(main, 'set-scene', {'scene': scene})
            footer_audit(live, scene)
        P.command(main, 'set-stage', {'stage': 'qualifier'})
        P.command(main, 'set-scene', {'scene': 'result'})
        C.idle(live, 'result')
        before = live.locator('.ranking-tables section').first.locator('tbody tr').all_inner_texts()
        live.wait_for_function('''before=>{const section=document.querySelector('.ranking-tables section');
          return section&&JSON.stringify([...section.querySelectorAll('tbody tr')]
          .map(row=>row.innerText))!==JSON.stringify(before)}''', arg=before, timeout=15000)
        assert '每 12 秒換頁' not in live.locator('#scene').inner_text()
        check('all audited scenes remove lower-left explanatory footers while ranking still changes page automatically')
        assert not REPORT['browser_errors'], REPORT['browser_errors']
    finally:
        for context in [main_context, score_context, overlay_context]:
            if context:
                context.close()
        P.stop_server(process)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix='qualifier-processing-browser-') as directory:
            with sync_playwright() as playwright:
                binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium')
                browser = playwright.chromium.launch(executable_path=binary, args=['--no-sandbox',
                    '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'])
                try:
                    run(browser, directory)
                    REPORT['result'] = 'PASS'
                finally:
                    browser.close()
    finally:
        (OUT / 'report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
