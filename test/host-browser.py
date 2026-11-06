"""Exercise the restricted host selection panel, synchronization and touch sizes."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results/host'))
REPORT = {'checks': [], 'browser_errors': [], 'screenshots': []}
spec = importlib.util.spec_from_file_location('production_helpers', ROOT / 'test/production-console-browser.py')
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)
P.REPORT = REPORT
P.SERVER = r"""
const fs=require('node:fs'),path=require('node:path');
const {state}=require('./scripts/manual-save-loader').loadManualSave('O08');
fs.writeFileSync(path.join(process.argv[1],'match-state.json'),JSON.stringify(state));
const app=require('./server').createBroadcastServer({dataDir:process.argv[1],pin:'production-console-main-fixture',scorekeeperPin:'production-console-score-fixture',hostPin:'host-browser-fixture'});
app.listen(0,'127.0.0.1').then(a=>console.log(a.port));
process.on('SIGTERM',()=>app.close().then(()=>process.exit()));
"""


def shot(page, name):
    file = OUT / (name + '.png')
    page.screenshot(path=str(file), full_page=True)
    REPORT['screenshots'].append(str(file))


def run(browser, directory):
    process, base = P.start_server(directory, 'host')
    context = None
    try:
        context, main = P.login(browser, base)
        host = context.new_page()
        host.goto(base + '/host/')
        host.fill('#pin', 'host-browser-fixture'); host.click('#pair-form button')
        host.wait_for_selector('#workspace:not([hidden])')
        assert host.locator('#match-id').inner_text() == 'W1'
        assert host.locator('#draw-six').is_enabled() and host.locator('#draw-two').is_disabled()
        assert host.locator('#workspace input,#workspace select,#workspace a').count() == 0
        host.click('#draw-six'); host.wait_for_selector('.candidate-card:nth-child(6)')
        assert host.locator('#draw-six').is_disabled()
        assert P.state(main)['scene'] == 'song-selection'
        assert host.locator('#players p').count() == 2
        assert host.locator('#workspace button').count() == 14
        for width in [390, 768, 1194]:
            host.set_viewport_size({'width': width, 'height': 834})
            assert host.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
            assert host.locator('#workspace button').evaluate_all('els=>els.every(el=>el.getBoundingClientRect().height>=44)')
            shot(host, 'host-candidates-' + str(width))
        host.locator('[data-ban-player="0"]').nth(0).click()
        host.wait_for_selector('.candidate-card:nth-child(1).is-banned')
        host.locator('[data-ban-player="1"]').nth(1).click()
        host.wait_for_selector('.candidate-card:nth-child(2).is-banned')
        host.wait_for_function('!document.querySelector("#draw-two").disabled')
        assert host.locator('[aria-pressed="true"]').count() == 2
        shot(host, 'host-bans')
        host.click('#draw-two'); host.wait_for_selector('.is-picked')
        assert host.locator('.is-picked').count() == 2
        assert host.locator('#workspace button').evaluate_all('els=>els.every(el=>el.disabled)')
        state = P.state(main)
        match = next(m for m in state['tournament']['matches'] if m['id'] == 'W1')
        assert len(match['songs']) == 2 and all(song['id'] not in match['bans'] for song in match['songs'])
        assert all(value is None for row in match['scores'] for value in row)
        shot(host, 'host-picked')
        REPORT['checks'].append('host has only draw-six, P1/P2 bans and draw-two; finalized picks lock all operations')
        P.command(main, 'select-match', {'matchId': 'W2'})
        host.wait_for_function('document.querySelector("#match-id").textContent==="W2"&&!document.querySelector("#draw-six").disabled')
        assert host.locator('.candidate-card').count() == 0
        P.command(main, 'start-intermission')
        host.wait_for_function('[...document.querySelectorAll("#workspace button")].every(el=>el.disabled)')
        REPORT['checks'].append('main control selects the match and suspends host selection during intermission; changes synchronize automatically')
        assert not REPORT['browser_errors'], REPORT['browser_errors']
    finally:
        if context:
            context.close()
        P.stop_server(process)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix='host-browser-') as directory, sync_playwright() as pw:
            binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium')
            browser = pw.chromium.launch(**({'executable_path': binary} if binary else {}), args=['--no-sandbox'])
            try:
                run(browser, directory)
                print('PASS restricted host controls, role synchronization and three viewport sizes', flush=True)
            finally:
                browser.close()
    finally:
        (OUT / 'report.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
