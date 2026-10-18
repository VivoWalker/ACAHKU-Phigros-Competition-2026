"""Chromium integration coverage for the hidden third Grand Final song.

All event data, pairing codes and the generated five-second video are disposable
fixtures. Real event data and credentials are never opened. Requires Python
Playwright, Pillow, ffmpeg and Chromium; outputs are ignored under test-results.
"""
import importlib.util
import io
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import tempfile
import time
import uuid

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results/final-sequence'))
REPORT = {'checks': [], 'browser_errors': [], 'geometry': [], 'screenshots': [], 'effects': []}
spec = importlib.util.spec_from_file_location('final_helpers', ROOT / 'test/fixed-final-browser.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
production_spec = importlib.util.spec_from_file_location('production_helpers', ROOT / 'test/production-console-browser.py')
production = importlib.util.module_from_spec(production_spec)
production_spec.loader.exec_module(production)
SECRET = 'What do you want more than a Happy ending?'

SERVER = r"""
const fs=require('node:fs'),path=require('node:path');
const dir=process.argv[1],file=path.join(dir,'match-state.json');
const state=require('./lib/default-state').createDefaultState(),T=require('./lib/tournament');
const act=(type,payload={})=>T.applyAction(state,{type,payload:{matchId:state.tournament.currentMatchId,...payload}});
act('seed-bracket',{ids:state.qualifier.players.map(p=>p.id),ruleset:'proposal-2026',verified:true});
for(const matchId of ['W1','W2','W3','W4','W5','W6','L1','L2','W7','L3','L4','L5','L6']){
  act('select-match',{matchId});act('draw-candidates');
  const match=state.tournament.matches.find(m=>m.id===matchId);
  act('ban-song',{playerIndex:0,songId:match.candidates[0].id});
  act('ban-song',{playerIndex:1,songId:match.candidates[1].id});act('pick-songs');
  for(let pi=0;pi<2;pi++)for(let si=0;si<2;si++)act('set-match-score',{playerIndex:pi,songIndex:si,score:pi?980000:990000});
  act('record-result',{verified:true});
}
act('select-match',{matchId:'GF'});
act('start-final-announcement',{songIndex:1});
act('set-broadcast-cue',{stage:'double-elimination',scene:'song-result',matchId:'GF',songIndex:1});
for(let pi=0;pi<2;pi++)for(let si=0;si<2;si++)act('set-match-score',{playerIndex:pi,songIndex:si,
  score:pi?980000-si*1000:990000-si*1000,
  judgements:{accuracy:pi?98:99,perfect:pi?970:980,good:15,bad:3,miss:2}});
fs.writeFileSync(file,JSON.stringify(state));
const app=require('./server').createBroadcastServer({dataDir:dir,pin:'fixed-final-main-fixture',scorekeeperPin:'fixed-final-score-fixture'});
app.listen(0,'127.0.0.1').then(a=>console.log(a.port));
process.on('SIGTERM',()=>app.close().then(()=>process.exit()));
"""


def check(name, detail=None):
    REPORT['checks'].append({'name': name, 'detail': detail})
    print('PASS ' + name, flush=True)


def start_server(directory):
    process = subprocess.Popen(['node', '-e', SERVER, directory], cwd=ROOT,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    with selectors.DefaultSelector() as ready:
        ready.register(process.stdout, selectors.EVENT_READ)
        if not ready.select(timeout=20):
            helper.stop_server(process)
            raise AssertionError('The temporary final server did not start')
    port = process.stdout.readline().strip()
    if not port.isdigit():
        output, errors = process.communicate(timeout=8)
        raise AssertionError(port + errors + output)
    return process, 'http://127.0.0.1:' + port


def snapshot(page, name):
    path = OUT / name
    result = page.screenshot(path=str(path), omit_background=True)
    REPORT['screenshots'].append(str(path))
    return Image.open(io.BytesIO(result)).convert('RGBA')


def motion(page, name):
    if os.environ.get('BROADCAST_TEST_GIF') != '1':
        return
    frames = []
    for _ in range(24):
        frames.append(preview_frame(page).resize((960, 540)))
        page.wait_for_timeout(80)
    path = OUT / name
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=110, loop=0)
    REPORT.setdefault('animations', []).append(str(path))


def preview_frame(page):
    """Keep OBS alpha holes black in GIF previews instead of Chromium's white matte."""
    foreground = Image.open(io.BytesIO(page.screenshot(omit_background=True))).convert('RGBA')
    background = Image.new('RGBA', foreground.size, (0, 0, 0, 255))
    background.alpha_composite(foreground)
    return background.convert('RGB')


def collect_purification(page, frames, level):
    """Capture the distributed pixel holes growing through each clearing stage."""
    started = time.monotonic()
    timeline = []
    for index in range(24):
        due = started + index * .1
        delay = due - time.monotonic()
        if delay > 0:
            page.wait_for_timeout(delay * 1000)
        frames.append(preview_frame(page))
        timeline.append(round((time.monotonic() - started) * 1000))
    REPORT.setdefault('transition_frames', []).append({'level': level, 'milliseconds': timeline})


def save_purification(frames):
    if not frames:
        return
    path = OUT / 'purification-three-stages.gif'
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=100, loop=0)
    REPORT.setdefault('animations', []).append(str(path))


def current(crew):
    return next(match for match in helper.state(crew)['tournament']['matches'] if match['id'] == 'GF')


def control_click(crew, selector):
    revision = helper.state(crew)['revision']
    crew.locator(selector).first.click()
    crew.wait_for_function('revision=>window.__fixtureState.revision>revision', arg=revision)


def public_state(page):
    return page.evaluate("()=>fetch('/api/state').then(r=>r.json())")


def geometry(page, phase):
    for width, height in [(1920, 1080), (1194, 834), (390, 844)]:
        page.set_viewport_size({'width': width, 'height': height})
        page.wait_for_function('''()=>Math.abs(document.querySelector('#canvas').getBoundingClientRect().width-
          Math.min(innerWidth/1920,innerHeight/1080)*1920)<.1''')
        result = page.evaluate('''()=>{const stage=document.querySelector('#canvas').getBoundingClientRect();
          const rect=e=>{const b=e.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom}};
          const logos=[...document.querySelectorAll('[data-motion-branding] .phigros-logo,[data-motion-branding] .club-logo')];
          const heads=[...document.querySelectorAll('.scene-head,.event-title,.topmeta')];
          return {width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,
            stage:rect(document.querySelector('#canvas')),logos:logos.map(e=>({box:rect(e),
              z:Number(getComputedStyle(e).zIndex),opacity:Number(getComputedStyle(e).opacity),complete:e.complete&&e.naturalWidth>0})),
            heads:heads.map(e=>({box:rect(e),text:e.textContent})),
            capture:[...document.querySelectorAll('.capture-window')].map(rect)};}''')
        assert result['scroll'] <= width+1, result
        assert len(result['logos']) == 3, result
        for logo in result['logos']:
            assert logo['complete'] and logo['opacity'] >= .999 and logo['z'] >= 1000, logo
            a = logo['box']
            for head in result['heads']:
                b = head['box']
                assert min(a['right'], b['right'])-max(a['left'], b['left']) <= 1 or min(a['bottom'], b['bottom'])-max(a['top'], b['top']) <= 1, (phase, logo, head)
        text = page.evaluate(helper.TEXT_AUDIT)
        assert not text['overlaps'], (phase, width, height, text)
        result['phase'] = phase
        REPORT['geometry'].append(result)
    page.set_viewport_size({'width': 1920, 'height': 1080})
    page.wait_for_function("()=>Math.abs(document.querySelector('#canvas').getBoundingClientRect().width-1920)<.1")


def fully_readable(page, selector, count, phase):
    """Audit actual glyph rectangles before clipping, including wrapped lines.

    textContent alone passes when an overflow-hidden title has been shortened by
    the browser. Check every rendered line against its own box and every clipping
    ancestor, so the real final-song title must remain visible in its entirety.
    """
    result = page.evaluate('''({selector})=>[...document.querySelectorAll(selector)].map(element=>{
      const stage=document.querySelector('#canvas').getBoundingClientRect(),scale=stage.width/1920;
      const box=e=>{const b=e.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom}};
      const css=getComputedStyle(element),bounds=box(element),walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
      const lines=[],clipped=[];let text;
      while(text=walker.nextNode()){
        if(!text.textContent.trim())continue;
        const range=document.createRange();range.selectNodeContents(text);
        for(const r of range.getClientRects()){
          const line={left:r.left,right:r.right,top:r.top,bottom:r.bottom,text:text.textContent};lines.push(line);
          for(let ancestor=text.parentElement;ancestor;ancestor=ancestor.parentElement){
            const style=getComputedStyle(ancestor),b=box(ancestor),tolerance=1.25*scale;
            // Chromium's Range includes Saira's font ascent/descent padding,
            // even when those pixels contain no glyph. Allow those metrics at
            // a line's top/bottom, but never enough to conceal another line.
            const verticalTolerance=Math.max(tolerance,parseFloat(getComputedStyle(text.parentElement).fontSize)*.25*scale);
            if((['hidden','clip','auto','scroll'].includes(style.overflowX)&&
                 (line.left<b.left-tolerance||line.right>b.right+tolerance))||
               (['hidden','clip','auto','scroll'].includes(style.overflowY)&&
                 (line.top<b.top-verticalTolerance||line.bottom>b.bottom+verticalTolerance)))
              clipped.push({line,ancestor:ancestor.className||ancestor.id,box:b});
          }
        }
      }
      return {text:element.textContent.trim(),box:bounds,lines,clipped,
        ellipsis:css.textOverflow==='ellipsis',width:element.clientWidth,scrollWidth:element.scrollWidth,
        height:element.clientHeight,scrollHeight:element.scrollHeight};
    })''', {'selector': selector})
    assert len(result) == count, (phase, selector, result)
    for item in result:
        assert item['lines'] and not item['clipped'], (phase, selector, item)
        assert item['scrollWidth'] <= item['width'] + 1, (phase, selector, item)
    REPORT.setdefault('readability', []).append({'phase': phase, 'selector': selector, 'items': result})
    return result


def subtotal_geometry(page, phase):
    geometry(page, phase)
    # Header name and cumulative total occupy separate rows; every song keeps
    # one full score and all four judgement counters in distinct grid cells.
    fully_readable(page, '[data-finale-subtotal]', 2, phase)
    fully_readable(page, '.finale-base-total>span', 2, phase)
    fully_readable(page, '.finale-base-song-head>span', 4, phase)
    fully_readable(page, '.finale-base-song-head>h3', 4, phase)
    fully_readable(page, '.finale-base-judgements dt', 20, phase)
    fully_readable(page, '.finale-base-judgements dd', 20, phase)
    bounds = page.evaluate('''()=>[...document.querySelectorAll('.finale-total-card')].map(card=>{
      const b=card.getBoundingClientRect(),items=[...card.querySelectorAll('.finale-total-header,.finale-base-song')];
      return {card:{top:b.top,bottom:b.bottom,left:b.left,right:b.right},items:items.map(e=>{
        const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right};})};})''')
    for entry in bounds:
        for item in entry['items']:
            assert all(item[key] >= entry['card'][key] - 1 for key in ['top', 'left']), entry
            assert all(item[key] <= entry['card'][key] + 1 for key in ['bottom', 'right']), entry


def graphic_styles(page):
    return page.evaluate('''()=>[...document.querySelectorAll('#scene *,.club-logo,.phigros-logo,.key-visual img')].filter(element=>
      !element.closest('svg')&&!element.closest('[data-motion-exits]')).map((element,index)=>{
        const css=getComputedStyle(element);return {key:element.tagName+':'+element.className+':'+index,
          boxShadow:css.boxShadow,filter:css.filter,outlineStyle:css.outlineStyle,outlineWidth:css.outlineWidth,
          borders:['Top','Right','Bottom','Left'].map(side=>{const width=css['border'+side+'Width'],
            style=css['border'+side+'Style'];return {width,style,
              color:parseFloat(width)>0&&style!=='none'?css['border'+side+'Color']:''};})};})''')


def text_only_highlights(page, baseline, phase):
    styles = graphic_styles(page)
    assert len(styles) == len(baseline), (phase, len(styles), len(baseline))
    for ordinary, bright in zip(baseline, styles):
        assert ordinary == bright, (phase, ordinary, bright)
    result = page.evaluate('''()=>({text:[...document.querySelectorAll('.player-name h2,.song-band h2,.player-total strong')]
      .map(e=>({text:e.textContent,shadow:getComputedStyle(e).textShadow})),
      hopeGraphics:document.querySelectorAll('[data-finale-hope]').length})''')
    assert result['text'] and all(item['shadow'] != 'none' for item in result['text']), (phase, result)
    assert result['hopeGraphics'] == 0, (phase, result)
    REPORT.setdefault('highlight_audits', []).append({'phase': phase, 'elements': len(styles), **result})


def effect(page):
    return page.evaluate('''()=>{const c=document.querySelector('#canvas'),g=c.querySelector('[data-finale-effects]');
      const clearing=g?.querySelector('#finale-hope-clearing path'),opening=clearing?.getAttribute('d')||'';
      const fingerprint=[...opening].reduce((hash,character)=>Math.imul(hash^character.charCodeAt(0),16777619),2166136261)>>>0;
      return {dataset:{...c.dataset},classes:c.className,group:g?{dataset:{...g.dataset},
        opacity:getComputedStyle(g).opacity,nodes:g.querySelectorAll('*').length,
        clearing:{subpaths:(opening.match(/M/g)||[]).length,curved:/[ACQST]/i.test(opening),
          fingerprint,pathBytes:opening.length,
          ellipses:g.querySelectorAll('[data-finale-hope] ellipse').length}}:null,
        animations:document.querySelector('#scene').getAnimations({subtree:true}).map(a=>({name:a.animationName,
          iterations:a.effect?.getTiming().iterations,state:a.playState})),
        video:[...document.querySelectorAll('video')].map(v=>({src:v.currentSrc,paused:v.paused,time:v.currentTime,ended:v.ended})),
        audio:[...document.querySelectorAll('audio')].map(a=>({src:a.currentSrc,paused:a.paused,volume:a.volume}))};}''')


def profile_geometry(page):
    REPORT['pixel_geometry_timing'] = page.evaluate('''()=>[.28,.65].map(amount=>{
      const samples=[],rectangles=[],bytes=[];
      for(let index=0;index<32;index++){
        const started=performance.now();
        const holes=BroadcastFinaleEffects.pixelHoles(amount,42,20+index*.05,amount<.5?1:.65);
        samples.push(performance.now()-started);rectangles.push(holes.rects.length);
        bytes.push(holes.mask.length+holes.edge.length);
      }
      samples.sort((a,b)=>a-b);
      return {amount,medianMs:samples[16],p95Ms:samples[30],maxMs:samples[31],
        maxRectangles:Math.max(...rectangles),maxPathBytes:Math.max(...bytes)};
    })''')


def control_geometry(page, phase):
    for width, height in [(1194, 834), (768, 1024), (390, 844)]:
        page.set_viewport_size({'width': width, 'height': height})
        result = page.evaluate(production.GEOMETRY)
        assert result['scroll'] <= width + 1, (phase, result)
        assert not result['duplicateIds'] and not result['textOverlaps'], (phase, result)
        controls = [item for item in result['boxes'] if item['tag'] in ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']]
        for index, left in enumerate(controls):
            a = left['box']
            for right in controls[index+1:]:
                b = right['box']
                x = min(a['x']+a['w'], b['x']+b['w'])-max(a['x'], b['x'])
                y = min(a['y']+a['h'], b['y']+b['h'])-max(a['y'], b['y'])
                assert x <= 1 or y <= 1, (phase, width, left, right)
        REPORT['geometry'].append({'phase': phase, 'kind': 'main-control', **result})
    page.set_viewport_size({'width': 1194, 'height': 834})


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    asset_dir = ROOT / 'public/assets/finale'
    asset_dir.mkdir(parents=True, exist_ok=True)
    video = asset_dir / ('browser-fixture-' + uuid.uuid4().hex + '.mp4')
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
                    'color=c=0x183756:s=640x360:r=20', '-f', 'lavfi', '-i',
                    'anullsrc=channel_layout=stereo:sample_rate=44100', '-t', '5',
                    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', str(video)], check=True)
    process = None
    try:
        with tempfile.TemporaryDirectory(prefix='acahku-final-sequence-') as directory, sync_playwright() as pw:
            binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium') or shutil.which('google-chrome')
            browser = pw.chromium.launch(**({'executable_path': binary} if binary else {}), args=[
                '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'])
            contexts = []

            def context(width=1920, height=1080):
                item = browser.new_context(viewport={'width': width, 'height': height})
                item.on('page', lambda page: page.on('pageerror', lambda error: REPORT['browser_errors'].append(str(error))))
                contexts.append(item)
                return item

            try:
                process, base = start_server(directory)
                crew = helper.login(context(1194, 834), base)
                live = context().new_page()
                live.goto(base + '/overlay/live.html')
                live.bring_to_front()
                live.context.new_cdp_session(live).send('Emulation.setFocusEmulationEnabled', {'enabled': True})
                helper.idle(live, 'song-result')
                crew.locator('#final-finale-settings').evaluate('element=>element.open=true')
                crew.select_option('#finale-song-id', '')
                for selector, value in [('#finale-title', SECRET), ('#finale-artist', 'Fixture Composer'),
                                        ('#finale-level', '17'), ('#finale-art', 'assets/song/grand-final-2026/petrichor.png'),
                                        ('#finale-video-path', 'assets/finale/' + video.name), ('#finale-video-duration', '5')]:
                    crew.fill(selector, value)
                crew.select_option('#finale-difficulty', 'AT')
                control_click(crew, '#final-finale-form button[type="submit"]')
                assert current(crew)['finale']['song']['title'] == SECRET
                assert len(current(crew)['songs']) == 3 and len(current(crew)['scores'][0]) == 3
                check('the main-control custom-song and local-video settings form saves the actual third song')
                scorer = helper.login(context(1194, 834), base, 'scorekeeper')
                scorer.wait_for_selector('input[data-song-index="2"]:disabled')
                assert SECRET not in scorer.locator('#workspace').inner_text()
                assert scorer.locator('input[data-song-index="2"]').count() == 2
                control_click(crew, '[data-production-next]')
                helper.idle(live, 'grand-final-totals')
                assert current(crew)['status'] != 'complete'
                assert SECRET not in json.dumps(public_state(live), ensure_ascii=False)
                assert '1,979,000' in live.locator('#scene').inner_text()
                subtotal_geometry(live, 'first-two-summary')
                snapshot(live, '01-first-two-summary.png')
                # The reported overlap used ordinary Demo Player names. Also
                # stress the maximum accepted name length through real actions;
                # intentionally shortened names must stay in their own header.
                fixture_player = current(crew)['players'][0]
                fixture_name = next(player['name'] for player in helper.state(crew)['qualifier']['players']
                                    if player['id'] == fixture_player)
                helper.command(crew, 'rename-player', {'playerId': fixture_player,
                    'name': 'Grand Final Challenger with a 48 character name!'})
                live.wait_for_function("()=>document.querySelector('.finale-total-header h2')?.textContent.includes('Grand Final Challenger')")
                live.wait_for_timeout(1000)
                subtotal_geometry(live, 'first-two-summary-long-name')
                helper.command(crew, 'rename-player', {'playerId': fixture_player, 'name': fixture_name})
                live.wait_for_function("name=>document.querySelector('.finale-total-header h2')?.textContent.includes(name)", arg=fixture_name)
                live.wait_for_timeout(800)
                control_geometry(crew, 'first-two-summary')
                check('the first two songs have a subtotal screen, never an awarded champion or leaked third-song title')

                control_click(crew, '[data-production-next]')
                helper.idle(live, 'double-elimination-waiting')
                assert SECRET not in live.locator('#scene').inner_text()
                assert SECRET not in json.dumps(public_state(live), ensure_ascii=False)
                geometry(live, 'sealed-corrupted-waiting')
                snapshot(live, '02-sealed-corrupted-waiting.png')
                if os.environ.get('BROADCAST_TEST_SEALED_GIF') == '1':
                    motion(live, 'sealed-corruption.gif')
                check('sealed waiting shows live garbled text and screen-wide infection without revealing the configured song')

                control_click(crew, '[data-production-next]')
                helper.idle(live, 'grand-final-video')
                live.wait_for_function("()=>[...document.querySelectorAll('video')].some(v=>!v.paused&&v.currentTime>.1)")
                assert all(item['paused'] or item['volume'] == 0 for item in effect(live)['audio']), effect(live)
                assert SECRET not in json.dumps(public_state(live), ensure_ascii=False)
                snapshot(live, '03-reveal-video.png')
                helper.idle(live, 'double-elimination-waiting')
                assert SECRET in live.locator('#scene').inner_text()
                # A scorer joining after the shared deadline sees the real title;
                # no edit is granted while the video still conceals the song.
                scorer.reload()
                scorer.wait_for_selector('input[data-song-index="2"]:enabled')
                assert SECRET in scorer.locator('#workspace').inner_text()
                live.wait_for_timeout(800)
                assert not any(not item['paused'] for item in effect(live)['video']), effect(live)
                geometry(live, 'revealed-corrupted-waiting')
                waiting_title = fully_readable(live, '.finale-next-song', 1, 'revealed-corrupted-waiting')[0]
                assert waiting_title['text'] == SECRET and not waiting_title['ellipsis'], waiting_title
                snapshot(live, '04-revealed-corrupted-waiting.png')
                check('the uploaded-video interface plays fullscreen, stops BGM and returns to the revealed waiting screen at the shared cue deadline')

                helper.command(crew, 'set-broadcast-display', {'showHandcams': True})
                crew.wait_for_function("()=>document.querySelector('[data-production-next]')?.textContent.includes('進入第 3 首比賽')")
                control_click(crew, '[data-production-next]')
                helper.idle(live, 'double-elimination-match')
                assert current(crew)['currentSong'] == 2
                node_counts = []
                cleared_tiles = []
                transition_frames = []
                baseline_graphics = None
                for level in [0, 1, 2, 3, 4]:
                    capture_transition = os.environ.get('BROADCAST_TEST_GIF') == '1' and level in [1, 2, 3]
                    if capture_transition:
                        live.set_viewport_size({'width': 640, 'height': 360})
                    control_click(crew, '[data-final-effect="' + str(level) + '"]')
                    if capture_transition:
                        collect_purification(live, transition_frames, level)
                        live.set_viewport_size({'width': 1920, 'height': 1080})
                    live.wait_for_timeout(2700)
                    info = effect(live)
                    assert info['dataset']['finalePurification'] == str(level), info
                    assert info['group']['clearing']['ellipses'] == 0, info
                    assert not info['group']['clearing']['curved'], info
                    amount = float(info['group']['dataset']['hopeAmount'])
                    assert abs(amount - [0, .28, .65, 1, 0][level]) < .001, info
                    if level in [1, 2, 3]:
                        cleared_tiles.append(float(info['group']['dataset']['clearedTiles']))
                        assert info['group']['clearing']['subpaths'] > (20 if level < 3 else 0), info
                        assert info['group']['clearing']['pathBytes'] < 240000, info
                        live.wait_for_timeout(180)
                        later = effect(live)
                        fingerprint = info['group']['clearing']['fingerprint']
                        if level < 3:
                            assert later['group']['clearing']['fingerprint'] != fingerprint, (level, info, later)
                            assert abs(float(later['group']['dataset']['clearance']) -
                                       float(info['group']['dataset']['clearance'])) < .04, (level, info, later)
                        else:
                            assert later['group']['clearing']['fingerprint'] == fingerprint, (level, info, later)
                    if level >= 3:
                        assert not any(item['state'] == 'running' and
                                       any(name in item['name'] for name in ['jitter', 'flicker', 'dislocation'])
                                       for item in info['animations']), info
                    REPORT['effects'].append({'level': level, **info})
                    node_counts.append(info['group']['nodes'])
                    geometry(live, 'match-effect-' + str(level))
                    match_title = fully_readable(live, '.song-band h2', 1, 'dual-camera-match-effect-' + str(level))[0]
                    assert match_title['text'] == SECRET and not match_title['ellipsis'], match_title
                    if level == 0:
                        baseline_graphics = graphic_styles(live)
                    elif level == 3:
                        text_only_highlights(live, baseline_graphics, 'dual-camera-match-stage-three')
                    image = snapshot(live, '05-match-effect-' + str(level) + '.png')
                    # Primary capture rectangles must stay genuine alpha holes;
                    # all corruption and hope highlights belong to their surround.
                    for x, y in [(300, 450), (1250, 450)]:
                        assert image.getpixel((x, y))[3] == 0, (level, x, y, image.getpixel((x, y)))
                    if level == 2:
                        live.reload()
                        helper.idle(live, 'double-elimination-match')
                        live.wait_for_timeout(800)
                        refreshed = effect(live)
                        assert abs(float(refreshed['group']['dataset']['hopeAmount']) - .65) < .001, refreshed
                        assert refreshed['group']['nodes'] == info['group']['nodes'], refreshed
                        assert abs(float(refreshed['group']['dataset']['clearance']) -
                                   float(info['group']['dataset']['clearance'])) < .04, refreshed
                assert len(set(node_counts)) == 1, node_counts
                assert 0 < cleared_tiles[0] < cleared_tiles[1] < cleared_tiles[2], cleared_tiles
                profile_geometry(live)
                # Operators can also restore corruption or step backwards;
                # removing a clearing stage must not retain stale mask holes.
                for level in [0, 2, 1, 4]:
                    control_click(crew, '[data-final-effect="' + str(level) + '"]')
                    live.wait_for_timeout(2700)
                    restored = effect(live)
                    assert abs(float(restored['group']['dataset']['hopeAmount']) - [0, .28, .65, 1, 0][level]) < .001, restored
                    assert restored['group']['nodes'] == node_counts[0], restored
                save_purification(transition_frames)
                check('jagged pixel holes glitch on the shared clock, grow across three stages, stop at full clearance, survive refresh and preserve text geometry, logos and transparent capture windows')
                helper.command(crew, 'set-broadcast-display', {'showHandcams': False})
                live.wait_for_function("()=>!document.querySelector('.match-layout').classList.contains('with-cameras')")
                live.wait_for_timeout(900)
                fully_readable(live, '.song-band h2', 1, 'single-camera-final-song-title')
                check('subtotal scores and judgements stay separate, the full final title wraps in waiting and both camera layouts, and purification adds glow only to text')

                # Keep the final result on purification stage 3, matching the
                # reported bright champion screen rather than testing it only
                # after all finale styling has been restored to ordinary mode.
                helper.command(crew, 'set-final-finale-effect', {'matchId': 'GF', 'level': 3})
                for pi in [0, 1]:
                    helper.command(crew, 'rename-player', {'playerId': current(crew)['players'][pi],
                        'name': 'Demo Player 0' + str(pi + 1)})
                    helper.command(crew, 'set-match-score', {'matchId': 'GF', 'playerIndex': pi, 'songIndex': 2,
                        'score': 800000 if pi == 0 else 1000000,
                        'judgements': {'accuracy': 80 if pi == 0 else 100, 'perfect': 800 if pi == 0 else 1000, 'good': 0, 'bad': 0, 'miss': 0}})
                helper.command(crew, 'record-result', {'matchId': 'GF', 'verified': True})
                final = current(crew)
                assert final['status'] == 'complete' and final['winnerId'] == final['players'][1], final
                helper.command(crew, 'set-scene', {'scene': 'result'})
                helper.idle(live, 'result')
                live.wait_for_timeout(2700)
                geometry(live, 'three-song-grand-final-results')
                fully_readable(live, '.result-row>strong', 2, 'three-song-grand-final-results')
                fully_readable(live, '.result-song-scores b', 6, 'three-song-grand-final-results')
                assert all(item['boxShadow'] == 'none' and item['filter'] == 'none'
                           for item in graphic_styles(live)), graphic_styles(live)
                snapshot(live, '06-three-song-champion.png')
                check('the third song changes the winner and the champion is calculated from all three totals')
                assert not REPORT['browser_errors'], REPORT['browser_errors']
                check('no browser runtime errors')
            finally:
                for item in contexts:
                    item.close()
                browser.close()
    finally:
        if process:
            helper.stop_server(process)
        video.unlink(missing_ok=True)
        (OUT / 'report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
