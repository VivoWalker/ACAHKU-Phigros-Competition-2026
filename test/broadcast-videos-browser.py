"""Play the supplied full-length MP4s in real Chromium using disposable GF data."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results/broadcast-videos'))
REPORT = {'checks': [], 'browser_errors': []}
spec = importlib.util.spec_from_file_location('finale_helpers', ROOT / 'test/final-sequence-browser.py')
F = importlib.util.module_from_spec(spec)
spec.loader.exec_module(F)
H = F.helper


def check(name):
    REPORT['checks'].append(name)
    print('PASS ' + name, flush=True)


def playing(page, selector, volume, muted=False):
    try:
        page.wait_for_function('''({selector,volume,muted})=>{
      const video=document.querySelector(selector);
      return video&&video.readyState>=3&&!video.paused&&video.currentTime>.05
        &&video.videoWidth===1920&&video.videoHeight===1080
        &&Math.abs(video.volume-volume)<.001&&video.muted===muted;
    }''', arg={'selector': selector, 'volume': volume, 'muted': muted})
    except Exception:
        print(page.evaluate('''()=>({hidden:document.hidden,canvas:{...document.querySelector('#canvas')?.dataset},
          videos:[...document.querySelectorAll('video')].map(v=>({src:v.src,ready:v.readyState,error:v.error?.message,
            width:v.videoWidth,height:v.videoHeight,paused:v.paused,time:v.currentTime,volume:v.volume,muted:v.muted}))})'''), flush=True)
        raise
    metadata = page.locator(selector).evaluate('''video=>({src:video.getAttribute('src'),
      duration:video.duration,time:video.currentTime,volume:video.volume,muted:video.muted})''')
    assert not page.evaluate('''()=>[...document.querySelectorAll('audio')].some(audio=>!audio.paused&&!audio.muted&&audio.volume>0)'''), 'Video overlaps menu/preview audio'
    return metadata


def volume_checks(main, live, selector):
    live.evaluate('selector=>window.__deliveredVideo=document.querySelector(selector)', selector)
    cue = H.state(main)
    for volume in [.4, 0, .25]:
        H.command(main, 'set-broadcast-volume', {'volume': volume})
        live.wait_for_function('''({selector,volume})=>{
          const video=document.querySelector(selector);
          return video===window.__deliveredVideo&&Math.abs(video.volume-volume)<.001&&!video.paused;
        }''', arg={'selector': selector, 'volume': volume})
    after = H.state(main)
    assert after['broadcast'].get('intermission', {}).get('cue') == cue['broadcast'].get('intermission', {}).get('cue')
    assert after['tournament'] == cue['tournament'], 'Changing master volume changed the match or video clock'


def run(browser, directory):
    process, base = F.start_server(directory)
    context = browser.new_context(viewport={'width': 1920, 'height': 1080})
    context.on('page', lambda page: page.on('pageerror', lambda error: REPORT['browser_errors'].append(str(error))))
    try:
        main = H.login(context, base)
        main.set_viewport_size({'width': 1440, 'height': 1000})
        main.click('.tabs [data-tab="trailer"]')
        assert main.input_value('#intermission-video-path') == 'assets/intermission/arcaea-trailer.mp4'
        H.command(main, 'start-intermission')
        live = context.new_page()
        live.goto(base + '/overlay/live.html')
        H.idle(live, 'intermission')
        assert not live.locator('video').count(), 'Entering the rest page auto-started a trailer'
        H.command(main, 'play-intermission-video')
        trailer = playing(live, 'video[data-intermission-video]', .25)
        assert trailer['src'] == '/assets/intermission/arcaea-trailer.mp4'
        assert abs(trailer['duration'] - 29.566341) < .05
        check('bundled Arcaea clip plays on the separate trailer scene without upload; the rest page stays silent')

        staff = context.new_page()
        staff.goto(base + '/overlay/live.html?preview=1')
        playing(staff, 'video[data-intermission-video]', 0, True)
        volume_checks(main, live, 'video[data-intermission-video]')
        previous_time = live.locator('video[data-intermission-video]').evaluate('video=>video.currentTime')
        live.reload()
        resumed = playing(live, 'video[data-intermission-video]', .25)
        assert resumed['time'] >= previous_time - .6
        live.screenshot(path=str(OUT / 'arcaea-trailer.png'))
        check('Arcaea uses the shared volume and mute without replacing its decoder or cue; refresh resumes and staff preview stays silent')

        H.command(main, 'stop-intermission-video')
        H.idle(live, 'intermission')
        live.wait_for_function("()=>!document.querySelector('video')")
        H.command(main, 'show-final-two-totals')
        H.command(main, 'start-final-finale')
        main.click('.tabs [data-tab="songs"]')
        assert main.input_value('#finale-video-path') == 'assets/finale/final-song-reveal.mp4'
        assert abs(float(main.input_value('#finale-video-duration')) - 94.333008) < .001
        H.command(main, 'play-final-finale-video')
        finale = playing(live, 'video[data-finale-video]', .25)
        assert finale['src'] == '/assets/finale/final-song-reveal.mp4'
        assert abs(finale['duration'] - 94.333008) < .05
        public = context.request.get(base + '/api/state').text()
        assert F.SECRET not in public, 'The final song leaked before the reveal video ended'
        playing(staff, 'video[data-finale-video]', 0, True)
        volume_checks(main, live, 'video[data-finale-video]')
        live.screenshot(path=str(OUT / 'final-song-pv.png'))
        H.command(main, 'finish-final-finale-video')
        H.idle(live, 'double-elimination-waiting')
        live.wait_for_function("()=>!document.querySelector('video[data-finale-video]')")
        assert F.SECRET in context.request.get(base + '/api/state').text()
        check('H.264 finale plays with the measured default duration, balanced master volume and silent previews; ending it reveals the song')
        assert not REPORT['browser_errors'], REPORT['browser_errors']
    finally:
        context.close()
        process.terminate()
        try:
            process.communicate(timeout=8)
        except Exception:
            process.kill()
            process.communicate(timeout=8)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix='broadcast-videos-') as directory, sync_playwright() as playwright:
            binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium') or shutil.which('google-chrome')
            browser = playwright.chromium.launch(**({'executable_path': binary} if binary else {}),
                args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
            try:
                run(browser, directory)
            finally:
                browser.close()
    finally:
        (OUT / 'report.json').write_text(json.dumps(REPORT, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
