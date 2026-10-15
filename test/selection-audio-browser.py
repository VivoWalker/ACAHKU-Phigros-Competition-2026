"""Optional real Chromium regression for regular-match song previews.

Uses temporary event data, fixture-only pairing codes and ffmpeg-generated
10- and 12-second tones served by Playwright routes. No fake tracks are committed and
the live event directory is never opened. Requires Python Playwright, Pillow,
Chromium and ffmpeg. Reports go to BROADCAST_TEST_OUTPUT or test-results/selection-audio.
"""
import importlib.util
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import tempfile
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results' / 'selection-audio'))
REPORT = {'checks': [], 'browser_errors': [], 'audio_requests': [], 'geometry': []}
helper_spec = importlib.util.spec_from_file_location('fixed_final_helpers', ROOT / 'test/fixed-final-browser.py')
helper = importlib.util.module_from_spec(helper_spec)
helper_spec.loader.exec_module(helper)

SERVER = r"""
const fs=require('node:fs'),path=require('node:path');
const dir=process.argv[1],fixture=process.argv[2];
const state=require('./lib/default-state').createDefaultState();
const act=(type,payload={})=>require('./lib/tournament').applyAction(state,{type,payload:{
  matchId:state.tournament.currentMatchId,...payload}});
for(const song of state.library){
  if(fixture==='manifest')delete song.previewAudio;
  else song.previewAudio='assets/song-preview/fixture-'+song.id+'.mp3';
}
if(fixture==='manifest'){
  for(const song of state.library)song.eligible=/^competition-2026-de-0[1-6]$/.test(song.id);
  state.library.find(song=>song.id==='competition-2026-de-06').previewAudio='';
}
act('seed-bracket',{ids:state.qualifier.players.map(player=>player.id),ruleset:'proposal-2026',verified:true});
if(fixture==='final'){
  for(const matchId of ['W1','W2','W3','W4','W5','W6','L1','L2','W7','L3','L4','L5','L6']){
    act('select-match',{matchId});act('draw-candidates');
    const match=state.tournament.matches.find(item=>item.id===matchId);
    act('ban-song',{playerIndex:0,songId:match.candidates[0].id});
    act('ban-song',{playerIndex:1,songId:match.candidates[1].id});act('pick-songs');
    for(let playerIndex=0;playerIndex<2;playerIndex++)for(let songIndex=0;songIndex<2;songIndex++)
      act('set-match-score',{playerIndex,songIndex,score:playerIndex?980000:990000});
    act('record-result',{verified:true});
  }
  act('select-match',{matchId:'GF'});
}
act('set-scene',{scene:'song-selection'});
if(fixture==='manifest'){
  act('draw-candidates');act('ban-song',{playerIndex:0,songId:'competition-2026-de-01'});
}
fs.writeFileSync(path.join(dir,'match-state.json'),JSON.stringify(state));
const broadcast=require('./server').createBroadcastServer({dataDir:dir,
  pin:'fixed-final-main-fixture',scorekeeperPin:'fixed-final-score-fixture'});
broadcast.listen(0,'127.0.0.1').then(address=>console.log(address.port));
process.on('SIGTERM',()=>broadcast.close().then(()=>process.exit()));
"""

MEDIA_PROBE = r"""(() => {
  const NativeAudio=window.Audio;
  window.__fixtureMedia=[];window.__fixtureMediaEvents=[];window.__fixtureMediaTrace=[];
  window.Audio=function(...args){
    const media=new NativeAudio(...args),index=window.__fixtureMedia.push(media)-1;
    for(const kind of ['play','playing','pause','ended','error'])media.addEventListener(kind,()=>
      window.__fixtureMediaEvents.push({kind,index,at:Date.now(),src:media.currentSrc||media.src,
        time:media.currentTime,volume:media.volume}));
    return media;
  };
  window.Audio.prototype=NativeAudio.prototype;
  setInterval(()=>{
    for(let index=0;index<window.__fixtureMedia.length;index++){
      const media=window.__fixtureMedia[index];
      if(media.getAttribute('src'))window.__fixtureMediaTrace.push({index,at:Date.now(),
        src:media.currentSrc||media.src,time:media.currentTime,volume:media.volume,paused:media.paused});
    }
  },50);
})();"""


def check(label):
    REPORT['checks'].append(label)
    print('PASS ' + label, flush=True)


def start_server(data_dir, fixture='regular'):
    process = subprocess.Popen(['node', '-e', SERVER, data_dir, fixture], cwd=ROOT,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    with selectors.DefaultSelector() as ready:
        ready.register(process.stdout, selectors.EVENT_READ)
        if not ready.select(timeout=15):
            process.terminate()
            stdout, stderr = process.communicate(timeout=8)
            raise AssertionError('Temporary audio server did not start: ' + stderr + stdout)
    port = process.stdout.readline().strip()
    if not port.isdigit():
        process.terminate()
        stdout, stderr = process.communicate(timeout=8)
        raise AssertionError('Temporary audio server did not report a port: ' + port + stdout + stderr)
    return process, f'http://127.0.0.1:{port}'


def current_match(crew):
    state = helper.state(crew)
    return next(match for match in state['tournament']['matches'] if match['id'] == state['tournament']['currentMatchId'])


def media_state(page):
    return page.evaluate('''() => ({status:document.querySelector('#canvas')?.dataset.selectionAudio,
      song:document.querySelector('#canvas')?.dataset.selectionAudioSong,
      media:window.__fixtureMedia.map((media,index)=>({index,src:media.currentSrc||media.src,
        attribute:media.getAttribute('src'),time:media.currentTime,volume:media.volume,paused:media.paused,
        duration:Number.isFinite(media.duration)?media.duration:null})),events:window.__fixtureMediaEvents})''')


def wait_playing(page, song_id):
    page.wait_for_function('''id => window.__fixtureMedia.some(media=>
      media.getAttribute('src')?.includes(id)&&!media.paused&&media.currentTime>.05&&media.volume>.1)''',
                           arg=song_id, timeout=8000)
    return next(media for media in media_state(page)['media'] if media['attribute'] and song_id in media['attribute'] and not media['paused'])


def wait_silent(page):
    page.wait_for_function('''()=>window.__fixtureMedia.every(media=>media.paused&&media.volume===0)''', timeout=5000)


def focused_title(page, title):
    page.wait_for_function('''title=>document.querySelector('.selection-detail h2')?.textContent===title&&
      [...document.querySelectorAll('.selection-art img')].some(image=>image.alt===title&&image.complete&&image.naturalWidth>0)''',
                           arg=title, timeout=10000)


def no_media(page):
    assert page.evaluate('window.__fixtureMedia.length') == 0, media_state(page)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='acahku-preview-browser-') as scratch, sync_playwright() as playwright:
        fixture_file = Path(scratch) / 'fixture.mp3'
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
                        'sine=frequency=440:duration=12', '-codec:a', 'libmp3lame', '-b:a', '48k', str(fixture_file)],
                       check=True, capture_output=True)
        fixture_bytes = fixture_file.read_bytes()
        short_fixture_file = Path(scratch) / 'fixture-10.mp3'
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
                        'sine=frequency=660:duration=10', '-codec:a', 'libmp3lame', '-b:a', '48k', str(short_fixture_file)],
                       check=True, capture_output=True)
        short_fixture_bytes = short_fixture_file.read_bytes()
        short_fixture_paths = set()
        binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium') or shutil.which('google-chrome')
        browser = playwright.chromium.launch(**({'executable_path': binary} if binary else {}), args=[
            '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding'])
        contexts = []

        def new_context(label, width=1920, height=1080, manifest=None):
            context = browser.new_context(viewport={'width': width, 'height': height})
            context.add_init_script(MEDIA_PROBE)
            context.on('page', lambda page: page.on('pageerror', lambda error: REPORT['browser_errors'].append(str(error))))

            def audio_route(route):
                request = route.request
                REPORT['audio_requests'].append({'context': label, 'path': urlparse(request.url).path,
                                                 'range': request.headers.get('range')})
                headers = {'Accept-Ranges': 'bytes', 'Content-Type': 'audio/mpeg'}
                audio_bytes = short_fixture_bytes if urlparse(request.url).path in short_fixture_paths else fixture_bytes
                body, status = audio_bytes, 200
                range_ = request.headers.get('range', '')
                if range_.startswith('bytes='):
                    start_text, _, end_text = range_[6:].partition('-')
                    start = int(start_text or 0)
                    end = min(int(end_text) if end_text else len(audio_bytes) - 1, len(audio_bytes) - 1)
                    body, status = audio_bytes[start:end+1], 206
                    headers['Content-Range'] = f'bytes {start}-{end}/{len(audio_bytes)}'
                route.fulfill(status=status, headers=headers, body=body)

            context.route('**/assets/song-preview/*.mp3', audio_route)
            if manifest is not None:
                context.route('**/assets/song-preview/manifest.json', lambda route: route.fulfill(
                    status=200, content_type='application/json', body=json.dumps(manifest)))
            contexts.append(context)
            return context

        data_dir = Path(scratch) / 'regular'
        data_dir.mkdir()
        process, base = start_server(str(data_dir))
        try:
            crew_context = new_context('control', 1194, 834)
            crew = helper.login(crew_context, base)
            live_context = new_context('live')
            # OBS and the server may run on machines whose wall clocks differ.
            # Cues must follow the synchronized server clock, not this local one.
            live_context.add_init_script('''{const actualNow=Date.now.bind(Date);Date.now=()=>actualNow()+300000;}''')
            live = live_context.new_page()
            live.goto(base + '/overlay/live.html')
            helper.idle(live, 'song-selection')
            helper.command(crew, 'draw-candidates')
            helper.idle(live, 'song-selection')
            live.wait_for_timeout(700)
            match = current_match(crew)
            assert len(match['candidates']) == 6
            no_media(live)
            assert not REPORT['audio_requests'], REPORT['audio_requests']
            check('all six candidates draw silently without requesting audio')

            first, second = match['candidates'][:2]
            # No manifest duration is supplied: the player must learn the real
            # 10-second decoder duration instead of looping on its 12-second fallback.
            short_fixture_paths.add('/' + first['previewAudio'])
            helper.command(crew, 'ban-song', {'playerIndex': 0, 'songId': first['id']})
            first_media = wait_playing(live, first['id'])
            focused_title(live, first['title'])
            live.wait_for_function('''id=>window.__fixtureMediaEvents.filter(event=>
              event.kind==='playing'&&event.src.includes(id)).length>=2''', arg=first['id'], timeout=16000)
            loop_media = wait_playing(live, first['id'])
            assert loop_media['index'] > first_media['index']
            trace = live.evaluate('window.__fixtureMediaTrace')
            first_samples = [sample for sample in trace if sample['index'] == first_media['index'] and not sample['paused']]
            assert any(0 < sample['volume'] < .6 and sample['time'] < .6 for sample in first_samples)
            assert any(0 < sample['volume'] < .6 and sample['time'] > 9.4 for sample in first_samples)
            assert 9.9 < loop_media['duration'] < 10.2
            check('P1 ban learns a real 10-second clip duration, fades in and out, and loops its own jacket and audio')

            live.wait_for_timeout(550)
            old_index = loop_media['index']
            transition_at = live.evaluate('Date.now()')
            helper.command(crew, 'ban-song', {'playerIndex': 1, 'songId': second['id']})
            second_media = wait_playing(live, second['id'])
            focused_title(live, second['title'])
            trace = live.evaluate('window.__fixtureMediaTrace')
            old_fade = [sample for sample in trace if sample['index'] == old_index and sample['at'] >= transition_at]
            assert any(.02 < sample['volume'] < .7 for sample in old_fade), old_fade
            assert media_state(live)['media'][old_index]['paused']
            assert second_media['index'] > old_index
            check('P2 ban fades out the preceding loop and switches music and artwork to the newly banned song')

            live.evaluate("window.dispatchEvent(new CustomEvent('obsSourceVisibleChanged',{detail:{visible:false}}))")
            wait_silent(live)
            live.wait_for_timeout(100)
            hidden_count = live.evaluate('window.__fixtureMedia.length')
            live.evaluate("window.dispatchEvent(new CustomEvent('obsSourceActiveChanged',{detail:{active:false}}))")
            live.evaluate("window.dispatchEvent(new CustomEvent('obsSourceVisibleChanged',{detail:{visible:true}}))")
            live.wait_for_timeout(650)
            assert live.evaluate('window.__fixtureMedia.length') == hidden_count
            wait_silent(live)
            live.evaluate("window.dispatchEvent(new CustomEvent('obsSourceActiveChanged',{detail:{active:true}}))")
            wait_playing(live, second['id'])
            check('OBS visibility and active-source events stop hidden audio and resume only the currently active cue despite five-minute clock skew')

            before = media_state(live)
            playing = next(media for media in before['media'] if media['attribute'] and not media['paused'])
            helper.command(crew, 'set-event', {'message': 'Audio browser fixture: unrelated state revision.'})
            live.wait_for_timeout(650)
            after = media_state(live)['media'][playing['index']]
            assert not after['paused'] and after['time'] > playing['time'] + .3
            assert len(media_state(live)['media']) == len(before['media'])
            check('unrelated state revisions preserve the existing decoder and playback position')

            muted_context = new_context('muted-preview')
            muted = muted_context.new_page()
            muted.goto(base + '/overlay/live.html?preview=1')
            helper.idle(muted, 'song-selection')
            focused_title(muted, second['title'])
            no_media(muted)
            for frame in crew.frames:
                assert frame.evaluate('window.__fixtureMedia?.length||0') == 0
            assert not [request for request in REPORT['audio_requests'] if request['context'] in ['control', 'muted-preview']]
            check('control iframe and preview=1 mirror artwork without creating or requesting audio')

            helper.command(crew, 'ban-song', {'playerIndex': 0, 'songId': match['candidates'][2]['id']})
            helper.command(crew, 'ban-song', {'playerIndex': 1, 'songId': match['candidates'][3]['id']})
            helper.command(crew, 'set-scene', {'scene': 'bracket'})
            wait_silent(live)
            live.wait_for_timeout(700)
            assert not live.locator('audio[data-selection-audio]').count()
            helper.command(crew, 'draw-candidates')
            helper.command(crew, 'set-scene', {'scene': 'song-selection'})
            helper.idle(live, 'song-selection')
            wait_silent(live)
            live.wait_for_timeout(600)
            assert not live.locator('audio[data-selection-audio]').count()
            check('rapid bans, scene exit and a fresh draw cancel pending audio and remove released media')

            match = current_match(crew)
            helper.command(crew, 'ban-song', {'playerIndex': 0, 'songId': match['candidates'][0]['id']})
            helper.command(crew, 'ban-song', {'playerIndex': 1, 'songId': match['candidates'][1]['id']})
            banned = wait_playing(live, match['candidates'][1]['id'])
            live.wait_for_timeout(550)
            pick_at = live.evaluate('Date.now()')
            helper.command(crew, 'pick-songs')
            picks = current_match(crew)['songs']
            assert len(picks) == 2
            picked_first = wait_playing(live, picks[0]['id'])
            focused_title(live, picks[0]['title'])
            assert media_state(live)['media'][banned['index']]['paused']
            pick_fade = live.evaluate('window.__fixtureMediaTrace').copy()
            assert any(sample['index'] == banned['index'] and sample['at'] >= pick_at and .02 < sample['volume'] < .7 for sample in pick_fade)
            picked_second = wait_playing_with_timeout(live, picks[1]['id'], 16000)
            focused_title(live, picks[1]['title'])
            assert picked_second['index'] > picked_first['index']
            assert current_match(crew)['currentSong'] == 0, 'Preview must not advance the scorekeeping song cursor'
            focused_title(muted, picks[1]['title'])
            no_media(muted)
            check('the final draw fades the ban clip, plays pick one then pick two, and switches both jackets without changing scoring progress')

            live.wait_for_function('''()=>document.querySelector('#canvas')?.dataset.selectionAudio==='complete' ''', timeout=16000)
            wait_silent(live)
            complete_count = live.evaluate('window.__fixtureMedia.length')
            live.wait_for_timeout(1000)
            assert live.evaluate('window.__fixtureMedia.length') == complete_count
            focused_title(live, picks[1]['title'])
            helper.command(crew, 'set-event', {'message': 'Audio browser fixture: finished previews remain stopped.'})
            live.wait_for_timeout(500)
            assert live.evaluate('window.__fixtureMedia.length') == complete_count
            live.reload()
            helper.idle(live, 'song-selection')
            live.wait_for_timeout(600)
            no_media(live)
            focused_title(live, picks[1]['title'])
            check('pick two ends in silence and completed selections do not replay on state changes or page reload')

            for width, height in [(1920, 1080), (1280, 720), (1194, 834), (834, 1194)]:
                live.set_viewport_size({'width': width, 'height': height})
                live.wait_for_timeout(100)
                geometry = live.evaluate('''()=>{
                  const canvas=document.querySelector('#canvas').getBoundingClientRect();
                  const elements=[...document.querySelectorAll('[data-motion-branding] img,.selection,.scene-head')]
                    .filter(element=>element.checkVisibility({opacityProperty:true,visibilityProperty:true}));
                  return {canvas:{x:canvas.x,y:canvas.y,w:canvas.width,h:canvas.height},elements:elements.map(element=>{
                    const box=element.getBoundingClientRect();return {name:element.className,x:box.x,y:box.y,w:box.width,h:box.height}})};
                }''')
                boxes = geometry['elements']
                assert len([box for box in boxes if 'club-logo' in box['name']]) == 2, geometry
                assert any(box['name'] == 'selection' for box in boxes), geometry
                assert any('scene-head' in box['name'] for box in boxes), geometry
                for index, a in enumerate(boxes):
                    for b in boxes[index+1:]:
                        overlap_w = min(a['x']+a['w'], b['x']+b['w'])-max(a['x'], b['x'])
                        overlap_h = min(a['y']+a['h'], b['y']+b['h'])-max(a['y'], b['y'])
                        assert overlap_w <= .5 or overlap_h <= .5, (width, height, a, b)
                geometry.update({'width': width, 'height': height})
                REPORT['geometry'].append(geometry)
            live.screenshot(path=str(OUT / 'song-selection-preview-complete.png'))
            check('song selection and persistent logos remain separate at four display sizes')
        finally:
            helper.stop_server(process)
            for context in contexts:
                context.close()
            contexts.clear()

        manifest_dir = Path(scratch) / 'manifest'
        manifest_dir.mkdir()
        process, base = start_server(str(manifest_dir), 'manifest')
        try:
            manifest = {'schemaVersion': 1, 'tracks': [
                {'songIds': ['competition-2026-de-01'],
                 'output': 'assets/song-preview/bundled-competition-2026-de-01.mp3', 'duration': 12},
                {'songIds': ['competition-2026-de-06'],
                 'output': 'assets/song-preview/blank-disabled-competition-2026-de-06.mp3', 'duration': 12}]}
            crew_context = new_context('manifest-control', 1194, 834)
            crew = helper.login(crew_context, base)
            match = current_match(crew)
            assert 'previewAudio' not in next(song for song in match['candidates'] if song['id'] == 'competition-2026-de-01')
            manifest_context = new_context('manifest', manifest=manifest)
            manifest_page = manifest_context.new_page()
            manifest_page.goto(base + '/overlay/live.html')
            wait_playing(manifest_page, 'competition-2026-de-01')
            assert any(request['context'] == 'manifest' and 'bundled-competition-2026-de-01' in request['path']
                       for request in REPORT['audio_requests'])
            helper.command(crew, 'ban-song', {'playerIndex': 1, 'songId': 'competition-2026-de-06'})
            manifest_page.wait_for_function('''()=>document.querySelector('#canvas')?.dataset.selectionAudio==='missing' ''')
            wait_silent(manifest_page)
            manifest_page.wait_for_timeout(600)
            blank = next(song for song in current_match(crew)['candidates'] if song['id'] == 'competition-2026-de-06')
            assert blank['previewAudio'] == ''
            focused_title(manifest_page, blank['title'])
            assert not any(request['context'] == 'manifest' and 'blank-disabled' in request['path']
                           for request in REPORT['audio_requests'])
            check('bundled manifest supplies audio to saved candidates without paths while an explicitly blank path keeps a song disabled')
        finally:
            helper.stop_server(process)
            for context in contexts:
                context.close()
            contexts.clear()

        final_dir = Path(scratch) / 'final'
        final_dir.mkdir()
        process, base = start_server(str(final_dir), 'final')
        try:
            final_context = new_context('final')
            final = final_context.new_page()
            final.goto(base + '/overlay/live.html')
            helper.idle(final, 'song-selection')
            assert final.locator('[data-final-song]').count() == 2
            final.wait_for_timeout(1000)
            no_media(final)
            assert not [request for request in REPORT['audio_requests'] if request['context'] == 'final']
            check('the actual fixed Grand Final remains silent and retains both original announcement cards')
        finally:
            helper.stop_server(process)
            for context in contexts:
                context.close()
        assert not REPORT['browser_errors'], REPORT['browser_errors']
        REPORT['result'] = 'PASS'
        (OUT / 'report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'result': REPORT['result'], 'checks': REPORT['checks'], 'report': str(OUT / 'report.json')}, ensure_ascii=False, indent=2))
        browser.close()


def wait_playing_with_timeout(page, song_id, timeout):
    page.wait_for_function('''id=>window.__fixtureMedia.some(media=>
      media.getAttribute('src')?.includes(id)&&!media.paused&&media.currentTime>.05&&media.volume>.1)''',
                           arg=song_id, timeout=timeout)
    return wait_playing(page, song_id)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        REPORT.update({'result': 'FAIL', 'failure': str(error)})
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / 'report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n')
        raise
