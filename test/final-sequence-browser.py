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
SECRET = 'Rebirth — Browser Fixture Only'

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
        frames.append(Image.open(io.BytesIO(page.screenshot())).convert('RGB').resize((960, 540)))
        page.wait_for_timeout(80)
    path = OUT / name
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=110, loop=0)
    REPORT.setdefault('animations', []).append(str(path))


def collect_purification(page, frames, level):
    """Capture the real growing centre opening, rather than only its endpoint."""
    started = time.monotonic()
    timeline = []
    for index in range(24):
        due = started + index * .1
        delay = due - time.monotonic()
        if delay > 0:
            page.wait_for_timeout(delay * 1000)
        frames.append(Image.open(io.BytesIO(page.screenshot())).convert('RGB'))
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


def effect(page):
    return page.evaluate('''()=>{const c=document.querySelector('#canvas'),g=c.querySelector('[data-finale-effects]');
      return {dataset:{...c.dataset},classes:c.className,group:g?{dataset:{...g.dataset},
        opacity:getComputedStyle(g).opacity,nodes:g.querySelectorAll('*').length}:null,
        animations:document.querySelector('#scene').getAnimations({subtree:true}).map(a=>({name:a.animationName,
          iterations:a.effect?.getTiming().iterations,state:a.playState})),
        video:[...document.querySelectorAll('video')].map(v=>({src:v.currentSrc,paused:v.paused,time:v.currentTime,ended:v.ended})),
        audio:[...document.querySelectorAll('audio')].map(a=>({src:a.currentSrc,paused:a.paused,volume:a.volume}))};}''')


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
                geometry(live, 'first-two-summary')
                snapshot(live, '01-first-two-summary.png')
                control_geometry(crew, 'first-two-summary')
                check('the first two songs have a subtotal screen, never an awarded champion or leaked third-song title')

                control_click(crew, '[data-production-next]')
                helper.idle(live, 'double-elimination-waiting')
                assert SECRET not in live.locator('#scene').inner_text()
                assert SECRET not in json.dumps(public_state(live), ensure_ascii=False)
                geometry(live, 'sealed-corrupted-waiting')
                snapshot(live, '02-sealed-corrupted-waiting.png')
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
                snapshot(live, '04-revealed-corrupted-waiting.png')
                check('the uploaded-video interface plays fullscreen, stops BGM and returns to the revealed waiting screen at the shared cue deadline')

                crew.wait_for_function("()=>document.querySelector('[data-production-next]')?.textContent.includes('進入第 3 首比賽')")
                control_click(crew, '[data-production-next]')
                helper.idle(live, 'double-elimination-match')
                assert current(crew)['currentSong'] == 2
                node_counts = []
                transition_frames = []
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
                    if level >= 3:
                        assert not any(item['state'] == 'running' and
                                       any(name in item['name'] for name in ['jitter', 'flicker', 'dislocation'])
                                       for item in info['animations']), info
                    REPORT['effects'].append({'level': level, **info})
                    node_counts.append(info['group']['nodes'])
                    geometry(live, 'match-effect-' + str(level))
                    image = snapshot(live, '05-match-effect-' + str(level) + '.png')
                    # Primary capture rectangles must stay genuine alpha holes;
                    # all corruption and hope highlights belong to their surround.
                    for x, y in [(300, 450), (1250, 450)]:
                        assert image.getpixel((x, y))[3] == 0, (level, x, y, image.getpixel((x, y)))
                assert len(set(node_counts)) == 1, node_counts
                save_purification(transition_frames)
                check('all three purification stages and the normal-effect switch preserve text geometry, logos and transparent capture windows')

                for pi in [0, 1]:
                    helper.command(crew, 'set-match-score', {'matchId': 'GF', 'playerIndex': pi, 'songIndex': 2,
                        'score': 800000 if pi == 0 else 1000000,
                        'judgements': {'accuracy': 80 if pi == 0 else 100, 'perfect': 800 if pi == 0 else 1000, 'good': 0, 'bad': 0, 'miss': 0}})
                helper.command(crew, 'record-result', {'matchId': 'GF', 'verified': True})
                final = current(crew)
                assert final['status'] == 'complete' and final['winnerId'] == final['players'][1], final
                helper.command(crew, 'set-scene', {'scene': 'result'})
                helper.idle(live, 'result')
                geometry(live, 'three-song-grand-final-results')
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
