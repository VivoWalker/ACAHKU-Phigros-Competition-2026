"""Open every checked-in manual save through its real isolated launcher.

Checks main control, scorekeeper and OBS rendering. Uses test-only credentials
and temporary data; screenshots/reports go to ignored test-results/.
"""
import argparse
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('BROADCAST_TEST_OUTPUT', ROOT / 'test-results/manual-saves'))


def exercise(browser, entry, report):
    process = subprocess.Popen(['node', 'scripts/manual-rehearsal.js', '--case', entry['id'],
                                '--port', '0', '--host', '127.0.0.1', '--json'], cwd=ROOT,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    context = None
    ready = None
    errors = []
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            assert selector.select(20), 'manual launcher did not become ready'
        line = process.stdout.readline()
        assert line, 'manual launcher exited: ' + process.stderr.read()
        ready = json.loads(line)
        base = 'http://127.0.0.1:' + str(ready['port'])
        context = browser.new_context(viewport={'width': 1194, 'height': 834}, reduced_motion='reduce')
        context.on('page', lambda page: page.on('pageerror', lambda error: errors.append(str(error))))
        main = context.new_page()
        main.goto(base + '/control/')
        main.fill('#pin', 'test-main')
        main.click('#pair-form button')
        main.wait_for_selector('#program-preview')
        scorer = context.new_page()
        scorer.goto(base + '/scorekeeper/')
        scorer.fill('#pin', 'test-score')
        scorer.click('#pair-form button')
        scorer.wait_for_selector('#workspace')
        overlay = context.new_page()
        overlay.set_viewport_size({'width': 1920, 'height': 1080})
        overlay.goto(base + '/overlay/live.html')
        overlay.wait_for_function('''scene => document.querySelector('#canvas')?.dataset.renderedScene === scene
            && document.querySelector('#scene')?.dataset.motionPhase === 'idle' ''', arg=entry['scene'])
        assert overlay.locator('#scene').inner_text().strip(), 'empty OBS screen'
        assert main.locator('#program-preview').is_visible(), 'missing staff preview'
        if entry['id'] in {'Q05', 'Q07', 'B01', 'D03', 'D08', 'D11', 'F01', 'F09'}:
            screenshot = OUT / (entry['id'] + '-obs.png')
            overlay.screenshot(path=str(screenshot))
            report['screenshots'].append(str(screenshot))
        assert not errors, errors
        report['checks'].append({'id': entry['id'], 'scene': entry['scene'], 'status': 'pass'})
        print('PASS ' + entry['id'] + ' control / scorekeeper / OBS', flush=True)
    finally:
        if context:
            context.close()
        process.terminate()
        try:
            _, stderr = process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise AssertionError('manual launcher did not shut down')
        report['browser_errors'].extend(errors)
        assert process.returncode == 0, stderr
        if ready:
            assert not Path(ready['dataDir']).exists(), 'temporary data was not removed'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--case', action='append', help='check only these case IDs')
    args = parser.parse_args()
    entries = json.loads((ROOT / 'test/manual-saves/manifest.json').read_text())['scenarios']
    if args.case:
        selected = {key.upper() for key in args.case}
        entries = [entry for entry in entries if entry['id'] in selected]
        assert selected == {entry['id'] for entry in entries}, 'unknown case ID'
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'checks': [], 'browser_errors': [], 'screenshots': []}
    try:
        with sync_playwright() as pw:
            binary = os.environ.get('CHROME_BINARY') or shutil.which('chromium')
            browser = pw.chromium.launch(**({'executable_path': binary} if binary else {}),
                                        args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
            try:
                for entry in entries:
                    exercise(browser, entry, report)
            finally:
                browser.close()
    finally:
        (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
