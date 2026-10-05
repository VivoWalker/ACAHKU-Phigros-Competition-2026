"""OBS source-pairing and live display-setting regression.

Uses a legacy state fixture in a temporary directory and actual control-room
buttons. Requires Python Playwright, Pillow and Chromium. No event data is read.
Set BROADCAST_TEST_OUTPUT to choose a directory for screenshots and the report.
"""
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from urllib.parse import urlsplit

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results'))
OUT.mkdir(exist_ok=True, parents=True)
QUALIFIER_CARDS = [(64, 300, 576, 324), (672, 300, 576, 324), (1280, 300, 576, 324)]
QUALIFIER_HANDCAMS = [(64, 800, 240, 135), (672, 800, 240, 135), (1280, 800, 240, 135)]
DOUBLE_CARDS = [(64, 280, 872, 490.5), (984, 280, 872, 490.5)]
DOUBLE_HANDCAMS = [(64, 846, 224, 126), (1632, 846, 224, 126)]


def assert_rect(actual, expected):
    for key, value in zip(['x', 'y', 'width', 'height'], expected):
        assert abs(actual[key] - value) < .1, (key, actual, expected)


def check_sources(page, players, cards, handcams, enabled):
    page.wait_for_function('(count) => document.querySelectorAll("[data-feed=handcam]").length === count',
                           arg=len(players) if enabled else 0)
    game = page.locator('[data-feed="capture-card"]')
    page.wait_for_function('(players) => JSON.stringify(Array.from(document.querySelectorAll("[data-feed=capture-card]"),el=>el.dataset.playerId)) === JSON.stringify(players)', arg=players)
    assert game.count() == len(players)
    for index, player in enumerate(players):
        card = game.nth(index)
        assert card.get_attribute('data-player-id') == player, (index, player)
        assert card.get_attribute('data-capture') == 'gameplay'
        assert_rect(card.bounding_box(), cards[index])
        paired = page.locator(f'[data-player-id="{player}"][data-capture]')
        assert paired.count() == (2 if enabled else 1), (player, paired.count())
        if enabled:
            handcam = page.locator(f'[data-player-id="{player}"][data-feed="handcam"]')
            assert handcam.count() == 1 and handcam.get_attribute('data-capture') == 'webcam'
            assert_rect(handcam.bounding_box(), handcams[index])
    return [el.bounding_box() for el in game.all()]


def check_pixels(page, cards, handcams, enabled, image_name):
    page.evaluate('document.fonts.ready')
    png = page.screenshot(path=str(OUT / image_name), omit_background=True, animations='disabled')
    image = Image.open(io.BytesIO(png)).convert('RGBA')
    samples = 0
    for rect, expected_alpha in [(r, 0) for r in cards] + [(r, 0 if enabled else 255) for r in handcams]:
        x, y, width, height = rect
        for fraction_x in [.15, .5, .85]:
            for fraction_y in [.15, .5, .85]:
                point = (int(x + width * fraction_x), int(y + height * fraction_y))
                assert image.getpixel(point)[3] == expected_alpha, (image_name, point, expected_alpha)
                samples += 1
    assert image.getpixel((0, 0))[3] == 0
    return samples


def text_outside_captures(page):
    # Text ranges measure painted text, without treating a wide empty container
    # as an obstruction. Every visible name/score/song must avoid all OBS holes.
    boxes = page.locator('.player-name h2,.player-total,.song-band,.song-scores,.handcam-label').evaluate_all('''els => els.flatMap(el => {
      if (getComputedStyle(el).display === 'none') return [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), boxes = [];
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(walker.currentNode);
        for (const rect of range.getClientRects()) if (rect.width && rect.height)
          boxes.push({text:walker.currentNode.textContent, x:rect.x,y:rect.y,width:rect.width,height:rect.height});
      }
      return boxes;
    })''')
    for capture in page.locator('[data-capture]').all():
        card = capture.bounding_box()
        for text in boxes:
            intersects = (text['x'] < card['x'] + card['width'] and card['x'] < text['x'] + text['width']
                          and text['y'] < card['y'] + card['height'] and card['y'] < text['y'] + text['height'])
            assert not intersects, ('Text obscures capture', text, card)


with tempfile.TemporaryDirectory(prefix='acahku-display-') as data_dir:
    fixture = json.loads((ROOT / 'data' / 'match-state.example.json').read_text())
    fixture.pop('broadcast', None)  # Exercise an actual pre-setting saved state.
    fixture['scene'] = 'qualifier-match'
    fixture['stage'] = 'qualifier'
    (Path(data_dir) / 'match-state.json').write_text(json.dumps(fixture))
    code = """
const {createBroadcastServer}=require('./server');
const s=createBroadcastServer({dataDir:process.argv[1],pin:'display-fixture-code'});
s.listen(Number(process.argv[2]),'127.0.0.1').then(a=>console.log(a.port));
process.on('SIGTERM',()=>s.close().then(()=>process.exit()));
"""
    process = None

    def start_server(port=0):
        child = subprocess.Popen(['node', '-e', code, data_dir, str(port)], cwd=ROOT,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        actual_port = child.stdout.readline().strip()
        assert actual_port.isdigit(), 'Temporary display server failed: ' + child.stderr.read()
        return child, int(actual_port)

    def stop_server(child):
        child.terminate()
        try:
            child.wait(timeout=8)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()

    try:
        process, port = start_server()
        base = f'http://127.0.0.1:{port}'
        with sync_playwright() as p:
            binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium') or shutil.which('google-chrome')
            browser = p.chromium.launch(**({'executable_path': binary} if binary else {}), args=['--no-sandbox'])
            context = browser.new_context(viewport={'width': 1920, 'height': 1080})
            errors, requests = [], []
            context.on('page', lambda page: page.on('pageerror', lambda error: errors.append(str(error))))
            context.on('request', lambda request: requests.append(request.url))
            crew = context.new_page()
            crew.on('dialog', lambda dialog: dialog.accept())
            crew.set_viewport_size({'width': 1194, 'height': 834})
            crew.goto(base + '/control/')
            crew.fill('#pin', 'display-fixture-code')
            crew.click('#pair-form button')
            crew.wait_for_selector('#program-preview')
            preview = crew.locator('#program-preview').content_frame
            preview.locator('[data-rendered-scene="qualifier-match"]').wait_for()

            def state():
                return context.request.get(base + '/api/state').json()

            def wait_revision(revision):
                crew.wait_for_function('(revision) => fetch("../api/state").then(r=>r.json()).then(s=>s.revision>revision)', arg=revision)

            def set_handcams(enabled):
                assert state().get('broadcast', {}).get('showHandcams', False) != enabled
                revision = state()['revision']
                crew.locator(f'[data-broadcast-handcams="{str(enabled).lower()}"]').click()
                wait_revision(revision)
                assert state()['broadcast']['showHandcams'] is enabled

            live = context.new_page()
            live.goto(base + '/overlay/live.html')
            live.wait_for_selector('[data-rendered-scene="qualifier-match"]')
            navigations, preview_navigations = [], []
            live.on('framenavigated', lambda frame: navigations.append(frame.url) if frame == live.main_frame else None)
            preview_frame = next(frame for frame in crew.frames if '/overlay/live.html' in frame.url)
            crew.on('framenavigated', lambda frame: preview_navigations.append(frame.url) if frame == preview_frame else None)
            crew.evaluate('document.querySelector("#program-preview").dataset.testStable="yes"')
            assert state().get('broadcast', {}).get('showHandcams', False) is False
            players = state()['qualifier']['activePlayers']
            baseline = check_sources(live, players, QUALIFIER_CARDS, QUALIFIER_HANDCAMS, False)
            samples = check_pixels(live, QUALIFIER_CARDS, QUALIFIER_HANDCAMS, False, 'display-qualifier-single-source.png')
            text_outside_captures(live)

            pinned_on, pinned_off = context.new_page(), context.new_page()
            for page, value in [(pinned_on, 1), (pinned_off, 0)]:
                page.goto(base + f'/overlay/qualifier-match.html?fixed=1&cameras={value}')
                page.wait_for_selector('[data-rendered-scene="qualifier-match"]')
                check_sources(page, players, QUALIFIER_CARDS, QUALIFIER_HANDCAMS, bool(value))
            set_handcams(True)
            assert check_sources(live, players, QUALIFIER_CARDS, QUALIFIER_HANDCAMS, True) == baseline
            preview.locator('[data-feed="handcam"]').first.wait_for()
            samples += check_pixels(live, QUALIFIER_CARDS, QUALIFIER_HANDCAMS, True, 'display-qualifier-dual-source.png')
            text_outside_captures(live)
            for page, value in [(pinned_on, True), (pinned_off, False)]:
                check_sources(page, players, QUALIFIER_CARDS, QUALIFIER_HANDCAMS, value)
            set_handcams(False)
            assert check_sources(live, players, QUALIFIER_CARDS, QUALIFIER_HANDCAMS, False) == baseline
            assert crew.evaluate('document.querySelector("#program-preview").dataset.testStable') == 'yes'
            assert not navigations and not preview_navigations, (navigations, preview_navigations)

            # Replace one on-stage player through the normal control-room form.
            crew.click('.tabs [data-tab="qualifiers"]')
            revision = state()['revision']; crew.select_option('#active-0', 'p4'); wait_revision(revision)
            players = state()['qualifier']['activePlayers']
            assert players[0] == 'p4'
            check_sources(live, players, QUALIFIER_CARDS, QUALIFIER_HANDCAMS, False)
            crew.click('.tabs [data-tab="broadcast"]')
            set_handcams(True)
            check_sources(live, players, QUALIFIER_CARDS, QUALIFIER_HANDCAMS, True)

            # Create the bracket through the real manual-seeding form.
            crew.click('.tabs [data-tab="bracket"]')
            revision = state()['revision']; crew.click('#seed-form button[type="submit"]'); wait_revision(revision)
            crew.wait_for_function('fetch("../api/state").then(r=>r.json()).then(s=>s.tournament.seeded)')
            crew.click('.tabs [data-tab="broadcast"]')
            revision = state()['revision']; crew.click('[data-scene="double-elimination-match"]'); wait_revision(revision)
            live.wait_for_selector('[data-rendered-scene="double-elimination-match"]')
            current = state()['tournament']
            assert current['seeded'], current
            match = next((m for m in current['matches'] if m['id'] == current['currentMatchId']), None)
            assert match, current
            players = match['players']
            double_baseline = check_sources(live, players, DOUBLE_CARDS, DOUBLE_HANDCAMS, True)
            samples += check_pixels(live, DOUBLE_CARDS, DOUBLE_HANDCAMS, True, 'display-double-dual-source.png')
            text_outside_captures(live)
            set_handcams(False)
            assert check_sources(live, players, DOUBLE_CARDS, DOUBLE_HANDCAMS, False) == double_baseline
            samples += check_pixels(live, DOUBLE_CARDS, DOUBLE_HANDCAMS, False, 'display-double-single-source.png')
            text_outside_captures(live)
            set_handcams(True)
            check_sources(live, players, DOUBLE_CARDS, DOUBLE_HANDCAMS, True)

            # A declared 700 face must load from the local asset, beyond merely
            # reporting a CSS weight that Chromium could synthesize.
            live.evaluate('document.fonts.load("700 32px Saira")')
            font_faces = live.evaluate('Array.from(document.fonts).filter(f=>f.family.replace(/[\\\"\\\']/g,"")==="Saira").map(f=>({family:f.family,weight:f.weight,status:f.status}))')
            assert any(face['weight'] == '700' and face['status'] == 'loaded' for face in font_faces), font_faces
            font_sizes = live.locator('.player-name h2,.player-total strong,.song-band h2').evaluate_all('els=>els.map(el=>({text:el.textContent,size:getComputedStyle(el).fontSize,weight:getComputedStyle(el).fontWeight}))')
            assert all(int(item['weight']) >= 700 for item in font_sizes), font_sizes

            revision = state()['revision']
            stop_server(process); process = None
            process, restarted_port = start_server(port)
            assert restarted_port == port
            assert state()['revision'] == revision and state()['broadcast']['showHandcams'] is True
            crew.wait_for_selector('#connection:not(.offline)', timeout=15000)
            live.wait_for_function('!document.querySelector("#canvas").classList.contains("is-offline")', timeout=15000)
            check_sources(live, players, DOUBLE_CARDS, DOUBLE_HANDCAMS, True)
            assert not navigations, 'Live source navigated during settings or server restart'
            assert not errors, errors
            external = [url for url in requests if urlsplit(url).hostname not in ['127.0.0.1', None]]
            assert not external, external
            report = {'result': 'PASS', 'legacy_state_fallback': True, 'source_pairing': True,
                      'unchanged_capture_card_positions': True, 'live_and_preview_no_reload': True,
                      'url_overrides': [0, 1], 'restart_persistence': True, 'alpha_samples': samples,
                      'font_faces': font_faces, 'important_text_fonts': font_sizes,
                      'external_requests': 0, 'browser_errors': errors}
            (OUT / 'display-layout-report.json').write_text(json.dumps(report, indent=2) + '\n')
            print(json.dumps(report, indent=2))
            browser.close()
    finally:
        if process:
            stop_server(process)
