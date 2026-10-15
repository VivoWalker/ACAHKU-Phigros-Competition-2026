"""Verify imported competition previews using their real files and Chromium.

Requires ffmpeg, ffprobe, Python Playwright and Chromium. Uses an isolated event
directory and fixture pairing codes; never opens the real event data directory.
Run after importing public/assets/song-preview/manifest.json. No audio routes,
synthetic media, or media clock acceleration are used.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import tempfile
from urllib.request import Request, urlopen

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results' / 'bundled-song-previews'))
REPORT = {'checks': [], 'files': [], 'browser_errors': [], 'audio_responses': []}
spec = importlib.util.spec_from_file_location('selection_audio_helpers', ROOT / 'test/selection-audio-browser.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
helper = helpers.helper

SERVER = r"""
const fs=require('node:fs'),path=require('node:path');
const dir=process.argv[1],state=require('./lib/default-state').createDefaultState();
for(const song of state.library){
  delete song.previewAudio;
  song.eligible=/^competition-2026-de-0[1-6]$/.test(song.id);
}
const act=(type,payload={})=>require('./lib/tournament').applyAction(state,{type,payload:{
  matchId:state.tournament.currentMatchId,...payload}});
act('seed-bracket',{ids:state.qualifier.players.map(player=>player.id),ruleset:'proposal-2026',verified:true});
act('set-scene',{scene:'song-selection'});
fs.writeFileSync(path.join(dir,'match-state.json'),JSON.stringify(state));
const broadcast=require('./server').createBroadcastServer({dataDir:dir,
  pin:'fixed-final-main-fixture',scorekeeperPin:'fixed-final-score-fixture'});
broadcast.listen(0,'127.0.0.1').then(address=>console.log(address.port));
process.on('SIGTERM',()=>broadcast.close().then(()=>process.exit()));
"""


def check(label):
    REPORT['checks'].append(label)
    print('PASS ' + label, flush=True)


def start_server(data_dir):
    process = subprocess.Popen(['node', '-e', SERVER, str(data_dir)], cwd=ROOT,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    with selectors.DefaultSelector() as ready:
        ready.register(process.stdout, selectors.EVENT_READ)
        if not ready.select(timeout=15):
            helper.stop_server(process)
            raise AssertionError('Temporary real-media server did not start')
    port = process.stdout.readline().strip()
    if not port.isdigit():
        process.terminate()
        stdout, stderr = process.communicate(timeout=8)
        raise AssertionError('Temporary real-media server failed: ' + port + stdout + stderr)
    return process, f'http://127.0.0.1:{port}'


def audit_files():
    manifest = json.loads((ROOT / 'public/assets/song-preview/manifest.json').read_text())
    assert manifest.get('schemaVersion') == 1 and manifest.get('tracks'), 'Import actual music first'
    catalog = json.loads(subprocess.check_output(['node', '-e',
        "console.log(JSON.stringify(require('./public/js/competition-config').library()))"], cwd=ROOT))
    expected = {song['id'] for song in catalog if not song['id'].startswith('competition-2026-gf-')}
    allowed = {song['id'] for song in catalog}
    mapped, outputs = set(), set()
    for track in manifest['tracks']:
        assert track['songIds'] and not mapped.intersection(track['songIds']), track
        mapped.update(track['songIds'])
        output = track['output']
        assert output.startswith('assets/song-preview/') and Path(output).suffix == '.mp3'
        assert '..' not in Path(output).parts and output not in outputs, output
        outputs.add(output)
        file = ROOT / 'public' / output
        assert file.is_file() and not file.is_symlink(), output
        assert hashlib.sha256(file.read_bytes()).hexdigest() == track['sha256'], output
        info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries',
            'format=duration:stream=codec_name,sample_rate,channels', '-of', 'json', str(file)]))
        length = float(info['format']['duration'])
        assert 10 <= length <= 15 and abs(length - track['duration']) < .00001, (output, length, track)
        assert info['streams'][0]['codec_name'] == 'mp3', output
        assert track['highlightStart'] >= 0 and 10 <= track['highlightDuration'] <= 15, track
        subprocess.run(['ffmpeg', '-v', 'error', '-xerror', '-i', str(file), '-f', 'null', '-'],
                       check=True, capture_output=True, timeout=30)
        for song_id in track['songIds']:
            assert manifest['songs'][song_id]['previewAudio'] == output
            assert manifest['songs'][song_id]['duration'] == track['duration']
        REPORT['files'].append({'path': output, 'duration': length, 'bytes': file.stat().st_size,
                                'songIds': track['songIds']})
    assert expected <= mapped <= allowed, {'missing': sorted(expected - mapped), 'unknown': sorted(mapped - allowed)}
    assert set(manifest['songs']) == mapped
    assert {file.name for file in (ROOT / 'public/assets/song-preview').glob('*.mp3')} == {
        Path(output).name for output in outputs}, 'Stale or unlisted bundled MP3s'
    check(f'{len(outputs)} real MP3s hash-match, fully decode, last 10–15 seconds and cover all {len(expected)} non-final charts')
    return manifest


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = audit_files()
    with tempfile.TemporaryDirectory(prefix='acahku-real-music-') as scratch, sync_playwright() as playwright:
        process, base = start_server(Path(scratch))
        browser = None
        try:
            output = manifest['tracks'][0]['output']
            actual = (ROOT / 'public' / output).read_bytes()
            with urlopen(Request(base + '/' + output, headers={'Range': 'bytes=100-999'}), timeout=10) as response:
                assert response.status == 206
                assert response.headers['Content-Range'] == f'bytes 100-999/{len(actual)}'
                assert response.headers['Accept-Ranges'] == 'bytes'
                assert response.headers['Content-Type'].startswith('audio/mpeg')
                assert response.read() == actual[100:1000]
            check('the actual application serves byte-identical MP3 ranges with HTTP 206 and correct audio headers')

            binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium') or shutil.which('google-chrome')
            browser = playwright.chromium.launch(**({'executable_path': binary} if binary else {}), args=[
                '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding'])
            decode_context = browser.new_context()
            decode_page = decode_context.new_page()
            decode_page.goto(base + '/overlay/live.html?preview=1')
            decoded = decode_page.evaluate('''async tracks=>{
              const context=new AudioContext(),results=[];
              try{for(const track of tracks){
                const response=await fetch('/'+track.output);
                if(!response.ok)throw new Error(track.output+': '+response.status);
                const buffer=await context.decodeAudioData(await response.arrayBuffer());
                const channel=buffer.getChannelData(0);
                let energy=0,peak=0;
                for(const sample of channel){energy+=sample*sample;peak=Math.max(peak,Math.abs(sample));}
                results.push({path:track.output,duration:buffer.duration,peak,
                  rms:Math.sqrt(energy/channel.length),containerDelta:track.duration-buffer.duration});
              }}finally{await context.close();}return results;
            }''', manifest['tracks'])
            for result in decoded:
                assert 10 <= result['duration'] <= 15 and result['rms'] > .001, result
                assert 0 <= result['containerDelta'] < .1, result
                assert result['peak'] <= 1.001, result
            REPORT['browser_decodes'] = decoded
            decode_context.close()
            check('Chromium decodes every real clip to non-silent PCM; MP3 container padding stays below 100 ms')

            def context(label):
                result = browser.new_context(viewport={'width': 1920, 'height': 1080})
                result.add_init_script(helpers.MEDIA_PROBE)
                result.on('page', lambda page: page.on('pageerror', lambda error: REPORT['browser_errors'].append(str(error))))

                def response_seen(response):
                    if '/assets/song-preview/' in response.url and response.url.endswith('.mp3'):
                        REPORT['audio_responses'].append({'context': label, 'status': response.status,
                            'range': response.request.headers.get('range'), 'url': response.url})
                result.on('response', response_seen)
                return result

            crew = helper.login(context('control'), base)
            # Saved events predate bundled previewAudio fields. Editing an
            # unrelated field must keep the displayed fallback, while clearing
            # the preview path must remain an intentional opt-out.
            edit_id = 'competition-2026-q1-01'
            edit_path = manifest['songs'][edit_id]['previewAudio']
            crew.locator('.tabs [data-tab="event"]').click()
            crew.locator(f'[data-edit-song="{edit_id}"]').click()
            assert crew.locator('#song-preview-audio').input_value() == edit_path
            crew.locator('#song-artist').fill('Fixture-only changed artist')
            crew.locator('#song-form button[type="submit"]').click()
            crew.wait_for_function('''data=>window.__fixtureState.library.some(song=>
              song.id===data.id&&song.previewAudio===data.path&&song.artist==='Fixture-only changed artist')''',
                                   arg={'id': edit_id, 'path': edit_path})
            crew.locator(f'[data-edit-song="{edit_id}"]').click()
            crew.locator('#song-preview-audio').fill('')
            crew.locator('#song-form button[type="submit"]').click()
            crew.wait_for_function('''id=>window.__fixtureState.library.some(song=>
              song.id===id&&Object.hasOwn(song,'previewAudio')&&song.previewAudio==='')''', arg=edit_id)
            crew.reload()
            crew.wait_for_selector('#workspace:not([hidden])')
            crew.evaluate(helper.COMMANDS)
            crew.locator('.tabs [data-tab="event"]').click()
            crew.locator(f'[data-edit-song="{edit_id}"]').click()
            assert crew.locator('#song-preview-audio').input_value() == ''
            check('editing a saved song preserves its bundled fallback and an explicitly cleared preview stays disabled after reload')

            # Deliberately use another real bundled clip in a temporary fixture
            # to exercise custom-path timing; this is not a catalog mapping.
            short_id = 'competition-2026-q2-03'
            short_path = manifest['songs'][short_id]['previewAudio']
            state = helper.state(crew)
            override = next(song for song in state['library'] if song['eligible'] and
                            manifest['songs'][song['id']]['duration'] > manifest['songs'][short_id]['duration'] + 1)
            helper.command(crew, 'upsert-song', {'song': {**override, 'previewAudio': short_path}})
            live = context('live').new_page()
            live.goto(base + '/overlay/live.html')
            helper.idle(live, 'song-selection')
            helper.command(crew, 'draw-candidates')
            helper.idle(live, 'song-selection')
            live.wait_for_timeout(700)
            match = helpers.current_match(crew)
            assert len(match['candidates']) == 6
            helpers.no_media(live)
            assert not REPORT['audio_responses']
            check('all six real-library candidates draw silently, including control iframe')

            first = next(song for song in match['candidates'] if song['id'] == override['id'])
            second = next(song for song in match['candidates'] if song['id'] != first['id'])
            helper.command(crew, 'ban-song', {'playerIndex': 0, 'songId': first['id']})
            playing = helpers.wait_playing(live, short_id)
            helpers.focused_title(live, first['title'])
            live.wait_for_function('''id=>window.__fixtureMediaEvents.filter(event=>
              event.kind==='playing'&&event.src.includes(id)).length>=2''', arg=short_id, timeout=18000)
            loop = helpers.wait_playing(live, short_id)
            assert loop['index'] > playing['index']
            events = helpers.media_state(live)['events']
            starts = [event for event in events if event['kind'] == 'playing' and short_id in event['src']]
            length = manifest['songs'][short_id]['duration']
            interval = (starts[1]['at'] - starts[0]['at']) / 1000
            assert abs(interval - length) < .4, (interval, length)
            assert abs(loop['duration'] - length) < .1, (loop, length)
            samples = live.evaluate('window.__fixtureMediaTrace')
            first_samples = [sample for sample in samples if sample['index'] == playing['index'] and not sample['paused']]
            assert any(0 < sample['volume'] < .6 and sample['time'] < .6 for sample in first_samples), first_samples[:10]
            assert any(0 < sample['volume'] < .6 and sample['time'] > length - .65 for sample in first_samples), first_samples[-10:]
            check('a real 10-second custom-path ban fades and loops using its decoded length instead of the chart default of 12 seconds')

            helper.command(crew, 'ban-song', {'playerIndex': 1, 'songId': second['id']})
            helpers.wait_playing(live, second['id'])
            helpers.focused_title(live, second['title'])
            assert helpers.media_state(live)['media'][loop['index']]['paused']
            muted = context('preview').new_page()
            muted.goto(base + '/overlay/live.html?preview=1')
            helper.idle(muted, 'song-selection')
            helpers.focused_title(muted, second['title'])
            helpers.no_media(muted)
            check('P2 switches to its banned real clip and the muted staff preview follows its jacket')

            helper.command(crew, 'pick-songs')
            picks = helpers.current_match(crew)['songs']
            picked_first = helpers.wait_playing(live, picks[0]['id'])
            helpers.focused_title(live, picks[0]['title'])
            picked_second = helpers.wait_playing_with_timeout(live, picks[1]['id'], 18000)
            helpers.focused_title(live, picks[1]['title'])
            helpers.focused_title(muted, picks[1]['title'])
            assert picked_second['index'] > picked_first['index']
            assert helpers.current_match(crew)['currentSong'] == 0
            events = helpers.media_state(live)['events']
            pick_starts = [event for event in events if event['kind'] == 'playing'
                           and event['index'] in [picked_first['index'], picked_second['index']]]
            assert [event['index'] for event in pick_starts] == [picked_first['index'], picked_second['index']], pick_starts
            expected = manifest['songs'][picks[0]['id']]['duration']
            assert abs((pick_starts[1]['at'] - pick_starts[0]['at']) / 1000 - expected) < .4, pick_starts
            live.wait_for_function("()=>document.querySelector('#canvas')?.dataset.selectionAudio==='complete'", timeout=18000)
            helpers.wait_silent(live)
            count = live.evaluate('window.__fixtureMedia.length')
            helper.command(crew, 'set-event', {'message': 'Real bundled music regression: completed sequence stays stopped.'})
            live.wait_for_timeout(700)
            assert live.evaluate('window.__fixtureMedia.length') == count
            helpers.focused_title(live, picks[1]['title'])
            helpers.no_media(muted)
            assert not [response for response in REPORT['audio_responses'] if response['context'] != 'live']
            assert all(response['status'] == 206 for response in REPORT['audio_responses']), REPORT['audio_responses']
            check('both picked real songs play once in order, switch live and staff artwork, stop after song two and never alter scoring progress')
            assert not REPORT['browser_errors'], REPORT['browser_errors']
            REPORT['picked_ids'] = [song['id'] for song in picks]
            REPORT['media_events'] = helpers.media_state(live)['events']
            REPORT['max_container_padding_seconds'] = max(result['containerDelta'] for result in decoded)
            live.screenshot(path=str(OUT / 'completed-real-previews.png'))
        finally:
            if browser:
                browser.close()
            helper.stop_server(process)
            (OUT / 'report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n')
    print(f'PASS {len(REPORT["checks"])} real-media checks; report: {OUT / "report.json"}')


if __name__ == '__main__':
    main()
