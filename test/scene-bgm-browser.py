"""Real Chromium regression for packaged scene music and preview ownership.

Uses a temporary event, fixture-only pairing codes, real packaged BGM and a
temporary 12-second song-preview tone. No production event or PIN files are
opened. Requires Python Playwright, Chromium and ffmpeg. Reports are ignored
under test-results/scene-bgm or written to BROADCAST_TEST_OUTPUT.
"""
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import tempfile
import time
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results' / 'scene-bgm'))
PIN = 'scene-bgm-browser-fixture-only'
REPORT = {'checks': [], 'browser_errors': [], 'requests': [], 'media': []}
MANIFEST = json.loads((ROOT / 'public/assets/bgm/manifest.json').read_text())
TRACKS = {track['id']: track for track in MANIFEST['tracks']}

SERVER = r"""
const fs=require('node:fs'),path=require('node:path');
const state=require('./lib/default-state').createDefaultState(),T=require('./lib/tournament');
for(const song of state.library){song.previewAudio='assets/song-preview/fixture-'+song.id+'.mp3'}
const act=(type,payload={})=>T.applyAction(state,{type,payload:{matchId:state.tournament.currentMatchId,...payload}});
act('seed-bracket',{ids:state.qualifier.players.map(player=>player.id),ruleset:'proposal-2026',verified:true});
act('set-scene',{scene:'start'});
fs.writeFileSync(path.join(process.argv[1],'match-state.json'),JSON.stringify(state));
const broadcast=require('./server').createBroadcastServer({dataDir:process.argv[1],pin:'scene-bgm-browser-fixture-only',scorekeeperPin:'scene-bgm-score-fixture-only'});
broadcast.listen(0,'127.0.0.1').then(address=>console.log(address.port));
process.on('SIGTERM',()=>broadcast.close().then(()=>process.exit()));
"""

PROBE = r"""(() => {
  const probe=window.__bgmProbe={media:[],events:[],maxBgm:0,maxPreview:0,overlaps:[],sockets:[]};
  const NativeAudio=window.Audio;
  window.Audio=function(...args){
    const audio=new NativeAudio(...args),index=probe.media.push(audio)-1;
    audio.__bgmStats={playCalls:0,loadCalls:0};
    const play=audio.play,load=audio.load;
    audio.play=function(...args){
      audio.__bgmStats.playCalls++;
      if(window.__rejectBgmPlay>0&&audio.src.includes('/assets/bgm/')){
        window.__rejectBgmPlay--;return Promise.reject(new DOMException('Fixture gesture required','NotAllowedError'));
      }
      return play.apply(audio,args);
    };
    audio.load=function(...args){audio.__bgmStats.loadCalls++;return load.apply(audio,args)};
    for(const kind of ['play','playing','pause','ended','error','stalled'])audio.addEventListener(kind,()=>
      probe.events.push({kind,index,at:performance.now(),src:audio.currentSrc||audio.src,time:audio.currentTime,volume:audio.volume}));
    return audio;
  };
  window.Audio.prototype=NativeAudio.prototype;
  let factory;
  Object.defineProperty(window,'createBroadcastSocket',{configurable:true,get(){return factory},set(original){
    factory=(...args)=>{const socket=original(...args);probe.sockets.push(socket);return socket};
  }});
  probe.timer=setInterval(()=>{
    const bgm=probe.media.filter(a=>a.getAttribute('src')?.includes('/assets/bgm/'));
    const preview=probe.media.filter(a=>a.getAttribute('src')?.includes('/assets/song-preview/'));
    probe.maxBgm=Math.max(probe.maxBgm,bgm.length);probe.maxPreview=Math.max(probe.maxPreview,preview.length);
    if(bgm.length&&preview.length&&probe.overlaps.length<20)probe.overlaps.push({at:performance.now(),bgm:bgm.length,preview:preview.length});
  },10);
})();"""

CONNECT = r"""async token => {
  const socket=io('/control',{forceNew:true,auth:{token}});
  await new Promise((resolve,reject)=>{socket.once('state',state=>{window.__fixtureState=state;resolve()});socket.once('connect_error',reject)});
  socket.on('state',state=>window.__fixtureState=state);window.__fixtureSocket=socket;
  window.__fixtureCommand=(type,payload={})=>new Promise((resolve,reject)=>socket.emit('command',{
    expectedRevision:__fixtureState.revision,action:{type,payload:{matchId:__fixtureState.tournament.currentMatchId,...payload}}
  },result=>result.ok?resolve(result):reject(new Error(type+': '+result.error))));
  window.__fixtureCountdown=()=>new Promise((resolve,reject)=>socket.emit('countdown-command',{
    action:'start',expectedRevision:__fixtureState.revision,contextKey:BroadcastCountdown.context(__fixtureState).key
  },result=>result.ok?resolve(result):reject(new Error(result.error))));
}"""


def check(name, detail=None):
    REPORT['checks'].append({'name': name, 'detail': detail})
    print('PASS ' + name, flush=True)


def start_server(directory):
    process = subprocess.Popen(['node', '-e', SERVER, directory], cwd=ROOT,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    with selectors.DefaultSelector() as ready:
        ready.register(process.stdout, selectors.EVENT_READ)
        if not ready.select(timeout=15):
            process.terminate()
            output, errors = process.communicate(timeout=8)
            raise AssertionError('Temporary BGM fixture server did not start: ' + errors + output)
    port = process.stdout.readline().strip()
    if not port.isdigit():
        process.terminate()
        output, errors = process.communicate(timeout=8)
        raise AssertionError('Temporary BGM fixture server did not report a port: ' + errors + output)
    return process, 'http://127.0.0.1:' + port


def stop_server(process):
    process.terminate()
    try:
        process.communicate(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate(timeout=8)


def command(page, action, payload=None):
    return page.evaluate('a=>__fixtureCommand(a.type,a.payload)', {'type': action, 'payload': payload or {}})


def idle(page, scene):
    page.wait_for_function("scene=>document.querySelector('#canvas')?.dataset.renderedScene===scene&&document.querySelector('#scene')?.dataset.motionPhase==='idle'", arg=scene)


def scene(page, name):
    command(page, 'set-scene', {'scene': name})
    idle(page, name)


def media(page):
    return page.evaluate("""()=>({
      status:document.querySelector('#canvas')?.dataset.sceneBgm,
      track:document.querySelector('#canvas')?.dataset.sceneBgmTrack,
      maxBgm:__bgmProbe.maxBgm,maxPreview:__bgmProbe.maxPreview,overlaps:__bgmProbe.overlaps,
      items:__bgmProbe.media.map((a,index)=>({index,src:a.getAttribute('src'),time:a.currentTime,volume:a.volume,paused:a.paused,
        readyState:a.readyState,loop:a.loop,connected:a.isConnected,track:a.dataset.trackId,stats:a.__bgmStats}))
    })""")


def bgm_playing(page, track_id, gain=.25):
    page.wait_for_function("""({id,gain})=>{
      const audio=document.querySelector('audio[data-scene-bgm]');return audio?.dataset.trackId===id&&!audio.paused
        &&audio.readyState>=2&&audio.currentTime>.05&&Math.abs(audio.volume-gain)<.005
        &&!document.querySelector('audio[data-scene-bgm-retiring]');
    }""", arg={'id': track_id, 'gain': gain * TRACKS[track_id].get('gain', 1)}, timeout=10000)
    return next(item for item in media(page)['items'] if item['src'] and item['track'] == track_id and not item['paused'])


def no_bgm(page):
    assert not page.locator('audio[data-scene-bgm],audio[data-scene-bgm-retiring]').count(), media(page)
    assert all(not item['src'] or '/assets/bgm/' not in item['src'] for item in media(page)['items']), media(page)


def no_audio(page):
    assert not page.locator('audio').count(), media(page)
    assert all(not item['src'] and item['paused'] and item['volume'] == 0 for item in media(page)['items']), media(page)


def main():
    started = time.monotonic()
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix='acahku-scene-bgm-') as scratch, sync_playwright() as playwright:
            tone = Path(scratch) / 'preview.mp3'
            subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
                            'sine=frequency=440:duration=12', '-codec:a', 'libmp3lame', '-b:a', '48k', str(tone)],
                           check=True, capture_output=True)
            preview_bytes = tone.read_bytes()
            binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium') or shutil.which('google-chrome')
            browser = playwright.chromium.launch(**({'executable_path': binary} if binary else {}), args=[
                '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'])
            contexts = []

            def new_page(label, path='/overlay/live.html', initial=None, bgm_error=False):
                context = browser.new_context(viewport={'width': 1920, 'height': 1080}, reduced_motion='reduce')
                contexts.append(context)
                context.add_init_script(PROBE)
                if initial:
                    context.add_init_script(initial)
                context.on('page', lambda item: item.on('pageerror', lambda error: REPORT['browser_errors'].append(str(error))))

                def request(item):
                    path_ = urlparse(item.url).path
                    if path_.startswith('/assets/bgm/') and not path_.endswith('.json') or path_.startswith('/assets/song-preview/') and not path_.endswith('.json'):
                        REPORT['requests'].append({'context': label, 'path': path_, 'at': time.monotonic() - started})

                context.on('request', request)

                def preview_route(route):
                    start, end = 0, len(preview_bytes) - 1
                    range_ = route.request.headers.get('range', '')
                    headers = {'Accept-Ranges': 'bytes', 'Content-Type': 'audio/mpeg'}
                    status = 200
                    if range_.startswith('bytes='):
                        first, _, last = range_[6:].partition('-')
                        start, end = int(first or 0), min(int(last) if last else end, end)
                        headers['Content-Range'] = f'bytes {start}-{end}/{len(preview_bytes)}'
                        status = 206
                    route.fulfill(status=status, headers=headers, body=preview_bytes[start:end + 1])

                context.route('**/assets/song-preview/fixture-*.mp3', preview_route)
                if bgm_error:
                    context.route('**/assets/bgm/chapter-select.ogg', lambda route: route.fulfill(status=404, body='fixture missing track'))
                page = context.new_page()
                page.goto(base + path)
                page.bring_to_front()
                cdp = context.new_cdp_session(page)
                cdp.send('Emulation.setFocusEmulationEnabled', {'enabled': True})
                return page, context

            data_dir = Path(scratch) / 'event'
            data_dir.mkdir()
            process, base = start_server(str(data_dir))
            try:
                live, live_context = new_page('live')
                idle(live, 'start')
                token = live_context.request.post(base + '/api/session', data={'pin': PIN}).json()['token']
                live.evaluate(CONNECT, token)
                first = bgm_playing(live, MANIFEST['scenes']['start'])
                assert first['loop'] and first['stats']['playCalls'] == 1, first
                time_before = first['time']
                for index in range(12):
                    command(live, 'set-event', {'message': 'BGM continuity fixture ' + str(index)})
                for name in ['qualifier-waiting', 'double-elimination-waiting', 'start']:
                    scene(live, name)
                    same = bgm_playing(live, MANIFEST['scenes'][name])
                    assert same['index'] == first['index'] and same['stats']['playCalls'] == 1 and same['time'] >= time_before, (first, same)
                check('main and both waiting scenes loop the packaged chapter menu without restarting across revisions or matching scenes')

                for name in ['song-result', 'result', 'bracket']:
                    command(live, 'set-scene', {'scene': name})
                    live.wait_for_function("document.querySelectorAll('audio[data-scene-bgm],audio[data-scene-bgm-retiring]').length===2", timeout=3000)
                    idle(live, name)
                    value = bgm_playing(live, MANIFEST['scenes'][name])
                    assert value['loop'], value
                assert media(live)['maxBgm'] == 2, media(live)
                check('single-song results, rankings and bracket map to their packaged looping BGM with at most two crossfading media')

                # Native loop changes playback position without replacing the
                # source or requiring JavaScript polling/repeated play calls.
                loop_before = media(live)
                current_index = next(item['index'] for item in loop_before['items'] if item['src'])
                live.evaluate("()=>{const a=document.querySelector('audio[data-scene-bgm]');a.currentTime=a.duration-.18}")
                live.wait_for_function("document.querySelector('audio[data-scene-bgm]')?.currentTime<1", timeout=4000)
                loop_after = bgm_playing(live, MANIFEST['scenes']['bracket'])
                assert loop_after['index'] == current_index and loop_after['stats']['playCalls'] == 1, loop_after
                check('a real OGG reaches its end and loops on the same media element')

                gameplay_requests = len([item for item in REPORT['requests'] if item['context'] == 'live'])
                for name in ['qualifier-match', 'double-elimination-match']:
                    scene(live, name)
                    no_bgm(live)
                command(live, 'set-scene', {'scene': 'qualifier-match'})
                players = live.evaluate("__fixtureState.qualifier.players.filter(p=>p.group==='A').slice(0,3).map(p=>p.id)")
                command(live, 'set-qualifier-display', {'group': 'A', 'players': players, 'currentSong': 0})
                live.evaluate('__fixtureCountdown()')
                live.wait_for_function("document.querySelector('.match-countdown')?.hidden===false")
                no_bgm(live)
                live.wait_for_function("document.querySelector('.match-countdown')?.hidden===true", timeout=9000)
                no_bgm(live)
                assert len([item for item in REPORT['requests'] if item['context'] == 'live']) == gameplay_requests, REPORT['requests']
                check('both gameplay scenes and a real synchronized 3-2-1 countdown contain no BGM source')

                scene(live, 'song-selection')
                command(live, 'draw-candidates')
                live.wait_for_function("document.querySelectorAll('.candidate').length===6")
                live.wait_for_timeout(150)
                no_audio(live)
                assert len([item for item in REPORT['requests'] if item['context'] == 'live']) == gameplay_requests, REPORT['requests']
                ids = live.evaluate("__fixtureState.tournament.matches.find(m=>m.id===__fixtureState.tournament.currentMatchId).candidates.map(s=>s.id)")
                command(live, 'ban-song', {'playerIndex': 0, 'songId': ids[0]})
                live.wait_for_function("(()=>{const a=document.querySelector('audio[data-selection-audio]');return a&&!a.paused&&a.volume>.1})()", timeout=8000)
                no_bgm(live)
                command(live, 'ban-song', {'playerIndex': 1, 'songId': ids[1]})
                live.wait_for_function("id=>document.querySelector('audio[data-selection-audio]')?.dataset.songId===id&&!document.querySelector('audio[data-selection-audio-retiring]')", arg=ids[1], timeout=8000)
                no_bgm(live)
                command(live, 'pick-songs')
                live.wait_for_function("document.querySelector('audio[data-selection-audio]')?.volume>.1", timeout=8000)
                command(live, 'set-scene', {'scene': 'double-elimination-waiting'})
                live.wait_for_function("document.querySelector('audio[data-selection-audio-retiring]')!==null", timeout=3000)
                no_bgm(live)
                idle(live, 'double-elimination-waiting')
                bgm_playing(live, MANIFEST['scenes']['double-elimination-waiting'])
                assert not live.locator('audio[data-selection-audio],audio[data-selection-audio-retiring],audio[data-selection-audio-prepared]').count()
                assert not media(live)['overlaps'], media(live)
                check('six-candidate draw is silent; bans and picks retain previews; menu BGM waits until the outgoing preview is fully released')

                for event, detail in [('obsSourceVisibleChanged', {'visible': False}), ('obsSourceActiveChanged', {'active': False})]:
                    live.evaluate('event=>dispatchEvent(new CustomEvent(event.type,{detail:event.detail}))', {'type': event, 'detail': detail})
                    no_bgm(live)
                    live.wait_for_timeout(100)
                    live.evaluate('event=>dispatchEvent(new CustomEvent(event.type,{detail:event.detail}))', {'type': event, 'detail': {'visible': True, 'active': True}})
                    bgm_playing(live, MANIFEST['scenes']['double-elimination-waiting'])
                live.evaluate("()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'))}")
                no_bgm(live)
                live.evaluate("()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'))}")
                bgm_playing(live, MANIFEST['scenes']['double-elimination-waiting'])
                live.evaluate("__bgmProbe.sockets.find(s=>s.nsp==='/overlay').disconnect()")
                no_bgm(live)
                live.evaluate("__bgmProbe.sockets.find(s=>s.nsp==='/overlay').connect()")
                bgm_playing(live, MANIFEST['scenes']['double-elimination-waiting'])
                check('OBS hidden/inactive, document visibility and socket disconnect immediately unload BGM; reactivation resumes the current scene')

                scene(live, 'start')
                bgm_playing(live, MANIFEST['scenes']['start'])
                for label, path, initial in [
                    ('preview', '/overlay/live.html?preview=1', None),
                    ('all-audio-muted', '/overlay/live.html?audio=0', None),
                    ('bgm-muted', '/overlay/live.html?bgm=0', None),
                    ('zero-volume', '/overlay/live.html?bgmVolume=0', None),
                    ('fixed-offair', '/overlay/qualifier-waiting.html?fixed=1', None),
                    ('hidden-at-load', '/overlay/live.html', "Object.defineProperty(document,'hidden',{configurable:true,get:()=>true})")]:
                    page, context = new_page(label, path, initial)
                    idle(page, 'qualifier-waiting' if label == 'fixed-offair' else 'start')
                    page.wait_for_timeout(250)
                    no_bgm(page)
                    assert not [item for item in REPORT['requests'] if item['context'] == label], (label, REPORT['requests'])
                    context.close()
                control, control_context = new_page('control', '/control/')
                control.fill('#pin', PIN)
                control.click('#pair-form button')
                control.wait_for_selector('#program-preview')
                control.frame_locator('#program-preview').locator('#canvas[data-media-boot]').wait_for()
                assert not [item for item in REPORT['requests'] if item['context'] == 'control'], REPORT['requests']
                control_context.close()
                check('control iframe, preview/audio/bgm mute modes, zero volume, off-air fixed source and hidden initial page request no audio')

                volume, volume_context = new_page('volume', '/overlay/live.html?bgmVolume=0.12')
                quieter = bgm_playing(volume, MANIFEST['scenes']['start'], gain=.12)
                assert abs(quieter['volume'] - .12 * TRACKS[MANIFEST['scenes']['start']].get('gain', 1)) < .005, quieter
                volume_context.close()
                check('URL bgmVolume scales the normalized packaged track gain')

                blocked, blocked_context = new_page('blocked', initial='window.__rejectBgmPlay=1')
                blocked.wait_for_function("document.querySelector('#canvas')?.dataset.sceneBgm==='blocked'")
                blocked.locator('.selection-audio-prompt:visible').wait_for()
                no_bgm(blocked)
                before = len(media(blocked)['items'])
                blocked.wait_for_timeout(500)
                assert len(media(blocked)['items']) == before, media(blocked)
                blocked.click('.selection-audio-prompt')
                bgm_playing(blocked, MANIFEST['scenes']['start'])
                assert blocked.locator('.selection-audio-prompt').is_hidden()
                blocked_context.close()
                check('autoplay rejection shows the shared audio gesture button and retries only after its click')

                error_page, error_context = new_page('error', bgm_error=True)
                error_page.wait_for_function("document.querySelector('#canvas')?.dataset.sceneBgm==='error'")
                no_bgm(error_page)
                count = len([item for item in REPORT['requests'] if item['context'] == 'error'])
                for index in range(8):
                    command(live, 'set-event', {'message': 'No retry loop fixture ' + str(index)})
                error_page.wait_for_timeout(400)
                assert len([item for item in REPORT['requests'] if item['context'] == 'error']) == count == 1, REPORT['requests']
                scene(live, 'song-result')
                bgm_playing(error_page, MANIFEST['scenes']['song-result'])
                error_page.evaluate("document.querySelector('audio[data-scene-bgm]').dispatchEvent(new Event('stalled'))")
                loaded = len(media(error_page)['items'])
                for index in range(8):
                    command(live, 'set-event', {'message': 'No stalled restart fixture ' + str(index)})
                error_page.wait_for_timeout(250)
                assert len(media(error_page)['items']) == loaded, media(error_page)
                error_context.close()
                check('a missing BGM source has no revision/download retry loop; another scene recovers and stalled events do not duplicate media')

                live.bring_to_front()
                bgm_playing(live, MANIFEST['scenes']['song-result'])
                live.evaluate("dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))")
                bgm_playing(live, MANIFEST['scenes']['song-result'])
                live.evaluate("dispatchEvent(new PageTransitionEvent('pagehide',{persisted:false}))")
                no_audio(live)
                live.wait_for_timeout(100)
                no_audio(live)
                assert not live.locator('.selection-audio-prompt').count()
                check('BFCache retains its current music; final pagehide unloads every BGM/preview source and removes the audio prompt')
                REPORT['media'] = media(live)
                assert REPORT['media']['maxBgm'] <= 2 and not REPORT['media']['overlaps'], REPORT['media']
                assert not REPORT['browser_errors'], REPORT['browser_errors']
            finally:
                for context in contexts:
                    context.close()
                browser.close()
                stop_server(process)
    finally:
        REPORT['durationSeconds'] = round(time.monotonic() - started, 2)
        (OUT / 'report.json').write_text(json.dumps(REPORT, indent=2), encoding='utf-8')
        print('REPORT ' + str(OUT / 'report.json'), flush=True)


if __name__ == '__main__':
    main()
