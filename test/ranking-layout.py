"""Optional long-roster OBS regression using temporary tournament data.
Requires Python Playwright, Pillow and Chromium; never changes event data/assets.
"""
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from urllib.parse import urlsplit

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'test-results'
OUT.mkdir(exist_ok=True)


def player_name(group, rank):
    return f'{group} Player {rank:02}'


def check_page(page, first, last, screenshot=None):
    sections = page.locator('.ranking-tables > section')
    assert sections.count() == 2
    observed = []
    for index, group in enumerate(['A', 'B']):
        section = sections.nth(index)
        assert f'GROUP {group}' in section.locator('h2').inner_text()
        assert re.fullmatch(rf'{first}[–-]{last}\s*/\s*32', section.locator('.rank-range').inner_text().strip())
        rows = section.locator('tbody tr')
        assert rows.count() == last - first + 1 == 8
        for offset, row in enumerate(rows.all()):
            rank = first + offset
            cells = row.locator('td').all_inner_texts()
            assert cells == [str(rank), player_name(group, rank), f'{3 * (1000000 - rank * 1000):,}'], cells
            assert row.is_visible()
            observed.append(cells[1])
        last_box = rows.last.bounding_box()
        assert last_box['y'] + last_box['height'] < 950, (group, last_box)
        table_box = page.locator('.ranking-tables').bounding_box()
        assert last_box['y'] + last_box['height'] <= table_box['y'] + table_box['height'], (group, 'clipped row')
    if screenshot:
        png = page.screenshot(path=str(OUT / screenshot), omit_background=True, animations='disabled')
        image = Image.open(io.BytesIO(png)).convert('RGBA')
        assert image.size == (1920, 1080)
        assert image.getpixel((0, 0))[3] == 0, 'Outer OBS canvas must stay transparent'
    return observed


with tempfile.TemporaryDirectory(prefix='acahku-ranking-') as data_dir:
    fixture = json.loads((ROOT / 'data' / 'match-state.example.json').read_text())
    fixture['scene'] = 'result'
    fixture['stage'] = 'qualifier'
    fixture['qualifier']['players'] = [
        {'id': f'{group}-{rank}', 'name': player_name(group, rank), 'group': group,
         'scores': [1000000 - rank * 1000] * 3, 'tiePriority': None}
        for group in ['A', 'B'] for rank in range(1, 33)
    ]
    fixture['qualifier']['activePlayers'] = ['A-1', 'A-2', 'A-3']
    (Path(data_dir) / 'match-state.json').write_text(json.dumps(fixture))
    code = """
const {createBroadcastServer}=require('./server');
const s=createBroadcastServer({dataDir:process.argv[1],pin:'ranking-fixture-code'});
s.listen(0,'127.0.0.1').then(a=>console.log(a.port));
process.on('SIGTERM',()=>s.close().then(()=>process.exit()));
"""
    process = subprocess.Popen(['node', '-e', code, data_dir], cwd=ROOT,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        port = int(process.stdout.readline().strip())
        base = f'http://127.0.0.1:{port}'
        with sync_playwright() as p:
            binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium') or shutil.which('google-chrome')
            browser = p.chromium.launch(**({'executable_path': binary} if binary else {}), args=['--no-sandbox'])
            context = browser.new_context(viewport={'width': 1920, 'height': 1080})
            errors, requests = [], []
            context.on('page', lambda page: page.on('pageerror', lambda error: errors.append(str(error))))
            context.on('request', lambda request: requests.append(request.url))
            page = context.new_page()
            for query, first, last, image_name in [
                ('', 1, 8, 'ranking-default.png'),
                ('&rankPage=2', 9, 16, 'ranking-page-2.png'),
                ('&rankPage=4', 25, 32, 'ranking-page-4.png'),
                ('&rankPage=99', 25, 32, 'ranking-page-clamped.png')
            ]:
                page.goto(base + '/overlay/result.html?fixed=1' + query)
                page.wait_for_selector('.ranking-tables tbody tr')
                page.evaluate('document.fonts.ready')
                check_page(page, first, last, image_name)

            # Only the ranking timer is accelerated; Socket.IO and other timers retain their normal delays.
            accelerate_ranking = """
const rankingInterval = window.setInterval.bind(window);
window.setInterval = (handler, delay, ...args) => rankingInterval(handler, delay === 12000 ? 1500 : delay, ...args);
"""
            pinned = context.new_page()
            pinned.add_init_script(accelerate_ranking)
            pinned.goto(base + '/overlay/result.html?fixed=1&rankPage=2')
            pinned.wait_for_selector('.ranking-tables tbody tr')
            check_page(pinned, 9, 16)
            rotating = context.new_page()
            rotating.add_init_script(accelerate_ranking)
            rotating.goto(base + '/overlay/result.html?fixed=1')
            rotating.wait_for_selector('.ranking-tables tbody tr')
            rotating.evaluate('document.fonts.ready')
            observations = []
            for tick in range(8):
                first = (tick % 4) * 8 + 1
                rotating.wait_for_function(
                    '(name) => document.querySelector(".ranking-tables section tbody tr td:nth-child(2)")?.textContent === name',
                    arg=player_name('A', first), timeout=5000)
                observations.extend(check_page(rotating, first, first + 7))
            assert len(observations) == 128
            assert set(observations) == {player_name(group, rank) for group in ['A', 'B'] for rank in range(1, 33)}
            check_page(pinned, 9, 16)  # A fixed page must remain fixed while the other page has rotated twice.
            assert not errors, errors
            external = [url for url in requests if urlsplit(url).hostname not in ['127.0.0.1', None]]
            assert not external, external
            print(json.dumps({'result': 'PASS', 'players_per_group': 32, 'rows_per_page': 8,
                              'fixed_pages': [2, 4], 'out_of_range_clamped': True,
                              'automatic_page_observations': 8, 'row_observations': len(observations),
                              'unique_players_seen': len(set(observations)), 'browser_errors': errors}, indent=2))
            browser.close()
    finally:
        process.terminate()
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
