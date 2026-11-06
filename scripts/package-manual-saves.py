#!/usr/bin/env python3
"""Package the manual checkpoints and launcher for an existing project checkout."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SAVES = ROOT / 'test/manual-saves'


def normalized_text(file):
    return file.read_bytes().decode('utf-8-sig').replace('\r\n', '\n').encode('utf-8')


START = '''# 开始人工测试

这是现有 ACAHKU Phigros 项目的测试存档包。将 scripts/ 和 test/ 合并到项目根目录，沿用项目内的依赖、曲绘、音乐和已整合的两段视频。

在项目根目录运行（Node.js 24.22.1 或更高的 24.x 版本）：

    node scripts/manual-rehearsal.js --list
    node scripts/manual-rehearsal.js --case Q05

不带参数可按编号选择；--port 3002 可更换默认的 3001 端口。

- 主控：http://localhost:3001/control/，测试配对码 test-main
- 记分员：http://localhost:3001/scorekeeper/，测试配对码 test-score
- 主持人：http://localhost:3001/host/，测试配对码 test-host
- OBS 测试源：http://localhost:3001/overlay/live.html，1920×1080

每次运行创建独立临时测试赛事。按 Ctrl+C 结束后重新加载即可回到原始检查点；需要保留本轮人工录入时先在主控导出备份。

完整操作步骤、预期结果和人工勾选表在 [test/manual-saves/README.md](test/manual-saves/README.md)。建议先检查 Q05（晋级线同分）、B02（中场视频）、D08（胜败分流）、D11（平均 ACC）和 F04（新版决赛 PV）。

存档使用合成选手与成绩；视频、抽曲和公布环节停在触发前，点击操作后才开始计时。

加载器兼容 Windows 换行和 UTF-8 BOM。若提示 Manual-save checksum differs，运行 node scripts/build-manual-saves.js 重新生成整套测试存档及清单，再次加载；这只写入 test/manual-saves。
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'test-results/manual-saves/acahku-manual-test-saves.zip')
    args = parser.parse_args()
    catalog = json.loads(normalized_text(SAVES / 'manifest.json'))
    files = [SAVES / 'README.md', SAVES / 'manifest.json']
    assert catalog['scenarioCount'] == len(catalog['scenarios'])
    for entry in catalog['scenarios']:
        assert re.fullmatch(r'[QBDFO]\d{2}-[a-z0-9-]+\.json', entry['file'])
        file = SAVES / entry['file']
        assert hashlib.sha256(normalized_text(file)).hexdigest() == entry['sha256'], file.name
        files.append(file)
    files.extend(ROOT / 'scripts' / name for name in
                 ['manual-rehearsal.js', 'manual-save-loader.js', 'build-manual-saves.js'])
    files.extend(ROOT / 'test' / name for name in ['manual-saves.test.js', 'manual-saves-browser.py'])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(files):
            archive.writestr(file.relative_to(ROOT).as_posix(), normalized_text(file))
        archive.writestr('开始测试.md', START)
    with zipfile.ZipFile(args.output) as archive:
        assert archive.testzip() is None
        assert len(archive.namelist()) == len(files) + 1
    print(f"Packaged {catalog['scenarioCount']} checkpoints: {args.output} ({args.output.stat().st_size:,} bytes)")


if __name__ == '__main__':
    main()
