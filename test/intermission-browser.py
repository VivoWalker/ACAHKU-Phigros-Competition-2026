"""Exercise the real intermission tab, upload and synchronized OBS video playback.

The server, event data and generated video are disposable fixtures. Requires
Chromium, Python Playwright and ffmpeg. Screenshots use ignored test-results/.
"""
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import tempfile

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results/intermission'))
SERVER = """
const app=require('./server').createBroadcastServer({dataDir:process.argv[1],pin:'intermission-main-fixture',scorekeeperPin:'intermission-score-fixture'});
app.listen(0,'127.0.0.1').then(a=>console.log(a.port));
process.on('SIGTERM',()=>app.close().then(()=>process.exit()));
"""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'checks': [], 'browser_errors': [], 'screenshots': []}
    with tempfile.TemporaryDirectory(prefix='intermission-browser-') as directory:
        video = Path(directory) / 'trailer.mp4'
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
                        'color=c=0x273a50:s=640x360:r=12', '-f', 'lavfi', '-i',
                        'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:v', 'libx264',
                        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', str(video)], check=True)
        process = subprocess.Popen(['node', '-e', SERVER, directory], cwd=ROOT, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True)
        try:
            with selectors.DefaultSelector() as ready:
                ready.register(process.stdout, selectors.EVENT_READ)
                assert ready.select(20), 'fixture server did not start'
            port = process.stdout.readline().strip()
            assert port.isdigit(), 'fixture startup failed'
            base = 'http://127.0.0.1:' + port
            with sync_playwright() as pw:
                binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium')
                browser = pw.chromium.launch(**({'executable_path': binary} if binary else {}),
                    args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
                context = browser.new_context(viewport={'width': 1194, 'height': 834}, reduced_motion='reduce')
                context.on('page', lambda page: page.on('pageerror', lambda error: report['browser_errors'].append(str(error))))
                control = context.new_page()
                control.goto(base + '/control/')
                control.fill('#pin', 'intermission-main-fixture'); control.click('#pair-form button')
                control.wait_for_selector('#program-preview')
                control.locator('.tabs [data-tab=intermission]').click()
                control.wait_for_selector('#intermission-preview')
                assert control.locator('#content h1').inner_text() == '休息時間'

                def state():
                    return control.evaluate("async()=>fetch('/api/control-state',{headers:{Authorization:'Bearer '+sessionStorage.getItem('broadcast-token')}}).then(r=>r.json())")

                def wait_scene(scene):
                    control.wait_for_function("async s=>(await fetch('/api/state').then(r=>r.json())).scene===s", arg=scene)

                def save():
                    revision = state()['revision']
                    control.locator('#intermission-form button[type=submit]').click()
                    control.wait_for_function("async r=>(await fetch('/api/state').then(r=>r.json())).revision>r", arg=revision)
                    control.wait_for_function("!document.querySelector('.draft-notice')")

                def screenshot(page, name):
                    path = OUT / (name + '.png')
                    page.screenshot(path=str(path), full_page=page == control)
                    report['screenshots'].append(str(path))

                before = state()
                control.locator('[data-intermission-command=start-intermission]').click(); wait_scene('intermission')
                assert state()['qualifier'] == before['qualifier']
                assert state()['tournament'] == before['tournament']
                control.locator('.tabs [data-tab=broadcast]').click()
                assert control.locator('.production-workflow').get_attribute('data-phase') == 'intermission'
                control.locator('.tabs [data-tab=intermission]').click()
                overlay = context.new_page(); overlay.set_viewport_size({'width': 1920, 'height': 1080})
                overlay.goto(base + '/overlay/live.html')
                overlay.wait_for_selector('.intermission-copy')
                assert overlay.locator('.intermission-copy h1').inner_text() == '休息時間'
                assert overlay.locator('.intermission-copy p').inner_text() == 'INTERMISSION'
                overlay.wait_for_function("document.querySelector('.intermission-art img')?.naturalWidth>0")
                assert overlay.locator('.intermission-art img').evaluate("v=>getComputedStyle(v).objectFit==='contain'")
                assert 'ARCAEA' not in overlay.locator('#scene').inner_text()
                assert overlay.locator('video[data-intermission-video]').count() == 0
                screenshot(overlay, 'obs-intermission-standby')

                fixed_rest = context.new_page(); fixed_rest.set_viewport_size({'width': 1920, 'height': 1080})
                fixed_rest.goto(base + '/overlay/intermission.html?fixed=1&preview=1')
                fixed_rest.wait_for_selector('.intermission-art img')
                trailer_standby = context.new_page(); trailer_standby.set_viewport_size({'width': 1920, 'height': 1080})
                trailer_standby.goto(base + '/overlay/arcaea-trailer.html?fixed=1&preview=1')
                trailer_standby.wait_for_selector('.trailer-standby')
                screenshot(trailer_standby, 'obs-arcaea-standby'); trailer_standby.close()
                control.locator('#toast.visible').wait_for(state='hidden')
                for tab in ['intermission', 'trailer']:
                    control.locator('.tabs [data-tab=' + tab + ']').click()
                    for width, height in [(1194, 834), (390, 844)]:
                        control.set_viewport_size({'width': width, 'height': height})
                        assert control.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                        assert control.locator('[data-intermission-command]').evaluate_all('els=>els.every(e=>e.getBoundingClientRect().height>=44)')
                        if tab == 'intermission':
                            assert control.locator('#intermission-form').count() == 0
                        else:
                            assert control.locator('#intermission-form button').is_visible()
                        screenshot(control, 'control-' + tab + '-' + str(width))
                report['checks'].append('rest shows traditional Chinese/English and the supplied poster character; rest and trailer have separate responsive control tabs and OBS pages')

                control.set_viewport_size({'width': 1194, 'height': 834})
                control.set_input_files('#intermission-upload-file', str(video))
                control.locator('[data-upload-intermission]').click()
                control.wait_for_function("document.querySelector('#intermission-video-path').value.startsWith('media/intermission/')")
                assert not state()['broadcast']['intermission']['videoPath'], 'An upload must not immediately change the live trailer'
                save()
                control.locator('[data-intermission-command=play-intermission-video]').click()
                wait_scene('arcaea-trailer')
                overlay.wait_for_function("document.querySelector('#canvas').dataset.intermissionVideo==='playing'")
                assert overlay.locator('video[data-intermission-video]').evaluate('v=>!v.muted&&v.loop')
                assert overlay.locator('video[data-intermission-video]').bounding_box() == {'x': 0, 'y': 0, 'width': 1920, 'height': 1080}
                assert fixed_rest.locator('video[data-intermission-video]').count() == 0
                assert fixed_rest.locator('.intermission-copy p').inner_text() == 'INTERMISSION'
                preview = control.frame_locator('#intermission-preview')
                preview.locator('video[data-intermission-video]').wait_for()
                assert preview.locator('video[data-intermission-video]').evaluate('v=>v.muted')
                overlay.wait_for_timeout(2300)
                assert overlay.locator('video[data-intermission-video]').evaluate('v=>!v.paused&&!v.ended&&v.currentTime<v.duration')
                identity = overlay.locator('video[data-intermission-video]').evaluate("v=>{v.dataset.fixtureIdentity='stable';return v.dataset.fixtureIdentity}")
                revision = control.evaluate('''async()=>{
                  const socket=io('/control',{forceNew:true,auth:{token:sessionStorage.getItem('broadcast-token')}});
                  const state=await new Promise(resolve=>socket.once('state',resolve));
                  const result=await new Promise(resolve=>socket.emit('command',{expectedRevision:state.revision,action:{type:'set-event',payload:{title:'Arcaea trailer test event'}}},resolve));
                  socket.disconnect(); if(!result.ok)throw Error(result.error); return result.revision;
                }''')
                overlay.wait_for_function('revision=>Number(document.querySelector("#canvas").dataset.renderedRevision)>=revision', arg=revision)
                assert overlay.locator('video[data-intermission-video]').get_attribute('data-fixture-identity') == identity
                overlay.reload(); overlay.wait_for_function("document.querySelector('#canvas').dataset.intermissionVideo==='playing'")
                screenshot(overlay, 'obs-intermission-video-fixture')
                report['checks'].append('uploaded MP4 loops with sound on OBS, stays muted in the control preview and survives updates/reload')

                control.locator('[data-intermission-command=stop-intermission-video]').click()
                wait_scene('intermission')
                overlay.wait_for_function("!document.querySelector('video[data-intermission-video]')")
                overlay.wait_for_selector('.intermission-art img')
                control.uncheck('#intermission-loop'); save()
                control.locator('[data-intermission-command=play-intermission-video]').click()
                overlay.wait_for_function("document.querySelector('#canvas').dataset.intermissionVideo==='ended'")
                assert state()['scene'] == 'arcaea-trailer'
                assert overlay.locator('video[data-intermission-video]').count() == 0
                control.locator('[data-intermission-command=stop-intermission-video]').click(); wait_scene('intermission')
                overlay.wait_for_selector('.intermission-art img')
                control.locator('[data-intermission-command=end-intermission]').click(); wait_scene('double-elimination-waiting')
                overlay.wait_for_function("document.querySelector('#canvas').dataset.renderedScene==='double-elimination-waiting'")
                assert overlay.locator('video[data-intermission-video]').count() == 0
                assert state()['qualifier'] == before['qualifier']
                assert state()['tournament'] == before['tournament']
                report['checks'].append('stopping, single-play completion and returning to DE release the trailer without changing scores or seeds')
                assert not report['browser_errors'], report['browser_errors']
                browser.close()
        finally:
            process.terminate()
            try: process.wait(timeout=8)
            except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=8)
            (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
