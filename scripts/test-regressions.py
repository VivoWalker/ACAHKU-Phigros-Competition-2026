#!/usr/bin/env python3
"""Run the focused Python or browser regressions with isolated report folders.

Install requirements-test.txt first. Browser tests also need Chromium:
    python3 -m playwright install --with-deps chromium

CHROME_BINARY can select an existing browser. BROADCAST_TEST_OUTPUT overrides
the report root; each test receives its own subdirectory. All test servers use
temporary event data and fixture pairing codes.
"""
from __future__ import annotations

import argparse
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
SUITES = {
    "python": ["song-preview-preparation", "display-assets-build"],
    "browser-smoke": [
        "browser-smoke",
        "challenge-qualifier-browser",
        "control-reconnect-browser",
        "draft-recovery-browser",
    ],
}


def browser_binary() -> str:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        bundled = Path(playwright.chromium.executable_path)
        selected = os.environ.get("CHROME_BINARY") or (
            str(bundled) if bundled.is_file() else
            shutil.which("chromium") or shutil.which("google-chrome")
        )
        if not selected:
            raise RuntimeError("Chromium is missing. Run: python3 -m playwright install --with-deps chromium")
        executable = Path(selected).expanduser().resolve()
        if not executable.is_file():
            raise RuntimeError(f"CHROME_BINARY does not name a browser file: {executable}")
        # Fail once with a useful message if a system browser or shared library
        # is unavailable, instead of failing in the first fixture's setup.
        browser = playwright.chromium.launch(executable_path=str(executable), args=["--no-sandbox"])
        browser.close()
        return str(executable)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", choices=SUITES, default="browser-smoke")
    parser.add_argument("--list", action="store_true", help="list the suite without starting tests")
    parser.add_argument("--only", action="append", metavar="TEST", help="run one listed test stem; may be repeated")
    args = parser.parse_args()
    selected = SUITES[args.suite]
    if args.only:
        unknown = set(args.only).difference(selected)
        if unknown:
            parser.error("tests outside this suite: " + ", ".join(sorted(unknown)))
        selected = [name for name in selected if name in args.only]
    if args.list:
        for name in selected:
            print(f"test/{name}.py")
        return 0

    modules = ["PIL", "numpy"] if args.suite == "python" else ["PIL", "playwright"]
    missing = [name for name in modules if importlib.util.find_spec(name) is None]
    if missing:
        parser.error("missing test dependencies: " + ", ".join(missing) +
                     ". Run: python3 -m pip install -r requirements-test.txt")
    for name in selected:
        if not (ROOT / "test" / f"{name}.py").is_file():
            parser.error(f"missing regression: test/{name}.py")

    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    if args.suite == "browser-smoke":
        try:
            env["CHROME_BINARY"] = browser_binary()
        except Exception as failure:
            print(f"Browser setup failed: {failure}", file=sys.stderr)
            return 2
        print(f"Browser: {env['CHROME_BINARY']}", flush=True)
    output = Path(env.get("BROADCAST_TEST_OUTPUT", ROOT / "test-results" / args.suite)).resolve()
    for index, name in enumerate(selected, 1):
        report_dir = output / name
        report_dir.mkdir(parents=True, exist_ok=True)
        env["BROADCAST_TEST_OUTPUT"] = str(report_dir)
        print(f"[{index}/{len(selected)}] Running test/{name}.py", flush=True)
        result = subprocess.run([sys.executable, str(ROOT / "test" / f"{name}.py")], cwd=ROOT, env=env)
        if result.returncode:
            print(f"FAILED test/{name}.py (exit {result.returncode}); reports: {report_dir}", file=sys.stderr)
            return result.returncode if result.returncode > 0 else 1
    print(f"PASS: {len(selected)} {args.suite} regressions; reports: {output}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
