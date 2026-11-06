# 人工测试存档

共 45 份独立检查点，使用合成选手和成绩。每份聚焦一个功能。

## 启动

在项目目录执行：

    npm run test:manual -- --list
    npm run test:manual -- --case Q05

不带参数时可在终端按编号选择。默认测试端口为 3001；可用 --port 3002 更换。
仅解压存档包时，也可直接运行 node scripts/manual-rehearsal.js --case Q05。
每次加载都创建独立临时测试赛事，配对用测试专用代码：主控 test-main，记分员 test-score。

- 主控：http://localhost:3001/control/
- 记分员：http://localhost:3001/scorekeeper/
- OBS 浏览器源：http://localhost:3001/overlay/live.html

OBS 测试浏览器源使用 1920×1080。需要真实摄像头的检查按项目 README 的 4:3 Webcam 坐标设置。
iPad 等设备使用启动日志中的局域网地址。按 Ctrl+C 关闭测试服务，再选择另一个存档；每次切换重新配对。
主控默认打开 Live production；通常使用大按钮逐步推进。选曲在 Song selection，裁判和赛果纠错工具在主控对应面板。
每份 JSON 都是完整赛事状态。视频、公布和抽曲检查点停在触发前，按步骤点击后才开始共享计时。
准备页的循环音乐在加载后使用新时钟。O05 将原有十分钟等待恢复为剩余约 30 秒。
要保留本轮人工输入，可在主控导出状态备份；原始检查点保持可重复加载。
存档引用项目现有曲绘、音乐和视频，测试包无需再复制这些媒体。

自动检查：npm test 验证所有存档及关键后续操作；npm run test:manual:browser 打开每份存档的三个页面。
浏览器检查需要项目 requirements-test.txt 和 Chromium；可用 --case Q05 只检查一个节点。

命令别名尚未添加时，直接运行 python3 test/manual-saves-browser.py --case Q05。

## 校验失败时

加载器兼容 Windows CRLF 换行和 UTF-8 BOM；实际内容变化仍会阻止加载。
出现 Manual-save checksum differs 时，在项目根目录重新生成整套测试存档及清单，再启动：

    node scripts/build-manual-saves.js
    node scripts/manual-rehearsal.js --case Q05

生成器只写入 test/manual-saves，不修改正式赛事 data。存档与 manifest.json 应一起更新。

## 建议优先检查

Q04、Q05、Q07、B02、D03、D08、D10、D12、D14、F04、F09。
在下方记录通过、失败和备注；真实摄像头、听感及现场 OBS 输出由操作人员核对。

## 存档索引

| 编号 | 功能 | JSON | 人工结果 |
| --- | --- | --- | --- |
| Q01 | 预选赛准备与开赛倒计时 | [Q01-ready-countdown.json](Q01-ready-countdown.json) | 待检查 |
| Q02 | Challenge 三曲录分 | [Q02-challenge-entry.json](Q02-challenge-entry.json) | 待检查 |
| Q03 | 预选三曲统计结果 | [Q03-challenge-results.json](Q03-challenge-results.json) | 待检查 |
| Q04 | 非晋级线同分 | [Q04-harmless-tie.json](Q04-harmless-tie.json) | 待检查 |
| Q05 | 第四第五名同分 | [Q05-cutoff-tie.json](Q05-cutoff-tie.json) | 待检查 |
| Q06 | 三人同分争夺晋级位 | [Q06-three-way-cutoff.json](Q06-three-way-cutoff.json) | 待检查 |
| Q07 | Round 1 加赛曲公布 | [Q07-round-one-tiebreak-reveal.json](Q07-round-one-tiebreak-reveal.json) | 待检查 |
| Q08 | 预选加赛判定录入 | [Q08-tiebreak-score-entry.json](Q08-tiebreak-score-entry.json) | 待检查 |
| Q09 | 加赛后确认晋级名单 | [Q09-confirmed-qualifiers.json](Q09-confirmed-qualifiers.json) | 待检查 |
| Q10 | 复活轮加赛曲公布 | [Q10-revival-tiebreak-reveal.json](Q10-revival-tiebreak-reveal.json) | 待检查 |
| Q11 | Plan B 排名循环与重入 | [Q11-ranking-pagination.json](Q11-ranking-pagination.json) | 待检查 |
| B01 | 中场休息看板 | [B01-intermission-poster.json](B01-intermission-poster.json) | 待检查 |
| B02 | 中场 Arcaea 视频 | [B02-arcaea-trailer.json](B02-arcaea-trailer.json) | 待检查 |
| D01 | 双淘汰赛签表 | [D01-seeded-bracket.json](D01-seeded-bracket.json) | 待检查 |
| D02 | BAN 曲卡片与难度 | [D02-ban-cards.json](D02-ban-cards.json) | 待检查 |
| D03 | 滚动抽曲与两首预览 | [D03-rolling-draw.json](D03-rolling-draw.json) | 待检查 |
| D04 | 下一首准备预览循环 | [D04-upcoming-song-loop.json](D04-upcoming-song-loop.json) | 待检查 |
| D05 | 双淘汰 webcam 与倒计时 | [D05-webcam-countdown.json](D05-webcam-countdown.json) | 待检查 |
| D06 | 单曲结果统计中 | [D06-processing.json](D06-processing.json) | 待检查 |
| D07 | 双淘汰单曲成绩 | [D07-single-song-results.json](D07-single-song-results.json) | 待检查 |
| D08 | 两曲总分与胜败分流 | [D08-round-advancement.json](D08-round-advancement.json) | 待检查 |
| D09 | 败者组淘汰 | [D09-second-loss-elimination.json](D09-second-loss-elimination.json) | 待检查 |
| D10 | 总分同分与补录 ACC | [D10-tied-total-missing-acc.json](D10-tied-total-missing-acc.json) | 待检查 |
| D11 | 公布平均 ACC | [D11-reveal-average-acc.json](D11-reveal-average-acc.json) | 待检查 |
| D12 | ACC 最终判定 | [D12-acc-verdict.json](D12-acc-verdict.json) | 待检查 |
| D13 | 平均 ACC 仍然相同 | [D13-equal-acc-tiebreak.json](D13-equal-acc-tiebreak.json) | 待检查 |
| D14 | 双淘汰加赛曲公布 | [D14-tiebreak-reveal.json](D14-tiebreak-reveal.json) | 待检查 |
| D15 | 双淘汰加赛判定录入 | [D15-tiebreak-score-entry.json](D15-tiebreak-score-entry.json) | 待检查 |
| D16 | 加赛确认后整轮赛果 | [D16-tiebreak-confirmation.json](D16-tiebreak-confirmation.json) | 待检查 |
| F01 | 决赛前两曲依次公布 | [F01-fixed-song-announcement.json](F01-fixed-song-announcement.json) | 待检查 |
| F02 | 决赛前两首中途总成绩 | [F02-provisional-two-totals.json](F02-provisional-two-totals.json) | 待检查 |
| F03 | 最后一首保密准备 | [F03-concealed-final-song.json](F03-concealed-final-song.json) | 待检查 |
| F04 | 新版 Ending Song Video | [F04-final-version-pv.json](F04-final-version-pv.json) | 待检查 |
| F05 | 最后一首净化效果 | [F05-purification-effects.json](F05-purification-effects.json) | 待检查 |
| F06 | 决赛第三首录分 | [F06-third-song-entry.json](F06-third-song-entry.json) | 待检查 |
| F07 | 决赛整轮三曲赛果 | [F07-three-song-result.json](F07-three-song-result.json) | 待检查 |
| F08 | 决赛三曲平均 ACC | [F08-three-song-average-acc.json](F08-three-song-average-acc.json) | 待检查 |
| F09 | 总排名与无序名次组 | [F09-final-standings.json](F09-final-standings.json) | 待检查 |
| O01 | 取消资格与自动判负 | [O01-disqualification.json](O01-disqualification.json) | 待检查 |
| O02 | 重开赛果与下游清除 | [O02-result-correction.json](O02-result-correction.json) | 待检查 |
| O03 | 主控与记分员并发草稿 | [O03-two-device-conflict.json](O03-two-device-conflict.json) | 待检查 |
| O04 | Webcam 来源人工核对 | [O04-obs-source-check.json](O04-obs-source-check.json) | 待检查 |
| O05 | 缺席等待即将届满 | [O05-absence-deadline.json](O05-absence-deadline.json) | 待检查 |
| O06 | 裁判授权单曲重赛 | [O06-rematch-authorization.json](O06-rematch-authorization.json) | 待检查 |
| O07 | 开赛前空缺与三人抽签 | [O07-vacancy-lottery.json](O07-vacancy-lottery.json) | 待检查 |

## 预选赛

### Q01 · 预选赛准备与开赛倒计时

加载：`npm run test:manual -- --case Q01`

1. 打开 OBS 测试源，核对三位选手及 4:3 窗口。
2. 进入比赛画面，按「開始倒計時 · 3 2 1 START」。

预期：

- [ ] 三位选手各占一路 webcam。
- [ ] 完整显示 3、2、1、START 后返回比赛；刷新来源不从头重播。

结果 / 备注：____________________

### Q02 · Challenge 三曲录分

加载：`npm run test:manual -- --case Q02`

1. 用记分员页面录入一名选手的三首分数、P/G/B/M 和官方总分。
2. 先留空一项尝试保存，再补齐保存。

预期：

- [ ] 缺项不能作为完整成绩保存；0 是合法数值。
- [ ] 保存后主控与记分员显示同一套 16 项数据。

结果 / 备注：____________________

### Q03 · 预选三曲统计结果

加载：`npm run test:manual -- --case Q03`

1. 检查当前三名选手的三首歌曲成绩、判定及官方总分。
2. 进入当前排名。

预期：

- [ ] 分数和官方总分都已预填，可直接核对。
- [ ] 切入当前排名从第一页开始；Round 1 尚未确认时只显示本轮。

结果 / 备注：____________________

### Q04 · 非晋级线同分

加载：`npm run test:manual -- --case Q04`

1. 观察前两名同分。
2. 核对本轮，继续复活轮。

预期：

- [ ] 同分双方都在晋级区，不要求加赛。
- [ ] 比赛可以正常推进，前四名仍有绿色标记。

结果 / 备注：____________________

### Q05 · 第四第五名同分

加载：`npm run test:manual -- --case Q05`

1. 查看当前排名的晋级线。
2. 按主要操作按钮准备加赛。

预期：

- [ ] 第四、第五名为黄色，未提前判定谁晋级。
- [ ] 本轮确认受阻，随后只安排这两位选手加赛。

结果 / 备注：____________________

### Q06 · 三人同分争夺晋级位

加载：`npm run test:manual -- --case Q06`

1. 检查第四到第六名的同分标记。
2. 准备晋级加赛。

预期：

- [ ] 全部三位相关选手都被标记，不遗漏第三人。
- [ ] 加赛准备名单包含这三人。

结果 / 备注：____________________

### Q07 · Round 1 加赛曲公布

加载：`npm run test:manual -- --case Q07`

1. 先观察准备页和记分员页面。
2. 按「公布加賽曲目」，听完预览后返回准备页。

预期：

- [ ] 公布前只显示两位选手，曲目保密且记分员锁定。
- [ ] 公布 Aleph-0、IN 16、曲绘和中英文标题，并播放一次预览。

结果 / 备注：____________________

### Q08 · 预选加赛判定录入

加载：`npm run test:manual -- --case Q08`

1. 在主控和记分员页面分别检查加赛录分表。
2. 为两人填写分数和 Perfect、Good、Bad、Miss 后保存。

预期：

- [ ] 两端都有四类判定字段，只显示本场加赛选手。
- [ ] 保存后统计结果与输入一致。

结果 / 备注：____________________

### Q09 · 加赛后确认晋级名单

加载：`npm run test:manual -- --case Q09`

1. 核对加赛成绩：右侧选手分数较高。
2. 确认加赛，再查看晋级名单。

预期：

- [ ] 加赛胜者进入前四，绿色标记恢复。
- [ ] 没有黄色未决晋级线；可以确认本轮。

结果 / 备注：____________________

### Q10 · 复活轮加赛曲公布

加载：`npm run test:manual -- --case Q10`

1. 按「公布加賽曲目」。
2. 检查难度、曲绘、标题和乐曲片段。

预期：

- [ ] 公布 ぱぴぷぴぷぴぱ、IN 15。
- [ ] 展示的是复活轮加赛，不沿用 Aleph-0。

结果 / 备注：____________________

### Q11 · Plan B 排名循环与重入

加载：`npm run test:manual -- --case Q11`

1. 停留排名页至少 12 秒。
2. 离开排名页，再切回来。

预期：

- [ ] 每组 12 人，按 8 人一页循环。
- [ ] 每次进入都从第一页开始，分数更新不把页码强制重置。

结果 / 备注：____________________

## 中场休息

### B01 · 中场休息看板

加载：`npm run test:manual -- --case B01`

1. 查看休息画面。
2. 核对左侧文字和右侧主视觉。

预期：

- [ ] 左侧显示繁体中文及英文休息标题，右侧为主视觉。
- [ ] 进入休息页不自动播放预告。

结果 / 备注：____________________

### B02 · 中场 Arcaea 视频

加载：`npm run test:manual -- --case B02`

1. 切到「Arcaea 預告」标签，按「播放預告」。
2. 调节全局音量、静音，刷新一个 OBS 测试源，再等待播放完成。

预期：

- [ ] Arcaea 预告只播放一次；工作人员预览静音。
- [ ] 刷新按同一时钟继续；播完自动返回休息画面，主控同步更新。

结果 / 备注：____________________

## 双淘汰赛

### D01 · 双淘汰赛签表

加载：`npm run test:manual -- --case D01`

1. 查看 24 人预选产生的八人签表。
2. 选择 W1，进入准备。

预期：

- [ ] 八个晋级席位和种子有对应选手。
- [ ] 待定上游场次不能提前比赛。

结果 / 备注：____________________

### D02 · BAN 曲卡片与难度

加载：`npm run test:manual -- --case D02`

1. 给左侧选手 BAN 一首候选曲。
2. 核对整块变红、难度等级和 BAN 标记。

预期：

- [ ] 六首候选都可辨认曲名与难度。
- [ ] BAN 标记不覆盖等级，被禁曲面板明显变红。

结果 / 备注：____________________

### D03 · 滚动抽曲与两首预览

加载：`npm run test:manual -- --case D03`

1. OBS 测试源准备好后按「Draw 2 match songs」。
2. 观察整段高亮抽选和音乐预览。

预期：

- [ ] 四首滚动高亮 → 第一首公布及预览 → 剩三首滚动 → 第二首公布及预览。
- [ ] 选曲音效跟随全局音量，已 BAN 曲不会被抽中；刷新不重抽。

结果 / 备注：____________________

### D04 · 下一首准备预览循环

加载：`npm run test:manual -- --case D04`

1. 听准备页正在循环的乐曲片段。
2. 切换到第二首准备，再进入比赛。

预期：

- [ ] 只循环下一首要比赛的歌曲。
- [ ] 进入比赛或统计中后停止片段，音量与其他界面一致。

结果 / 备注：____________________

### D05 · 双淘汰 webcam 与倒计时

加载：`npm run test:manual -- --case D05`

1. 核对左右选手各一路 4:3 webcam。
2. 开始倒计时，并在倒数期间刷新一个来源。

预期：

- [ ] 主画布 1920×1080，视频窗口各为 872×654。
- [ ] 姓名、总分及曲目不遮挡视频；所有来源显示同一倒数。

结果 / 备注：____________________

### D06 · 单曲结果统计中

加载：`npm run test:manual -- --case D06`

1. 查看统计中画面。
2. 按主要操作按钮显示本曲统计。

预期：

- [ ] 左边是「統計中」及英文，右边为主视觉。
- [ ] 统计中与单曲结果是两个独立步骤。

结果 / 备注：____________________

### D07 · 双淘汰单曲成绩

加载：`npm run test:manual -- --case D07`

1. 核对双方当前单曲的分数和 P/G/B/M。
2. 按主要操作按钮准备下一首。

预期：

- [ ] 本页只对应第一首，而非两曲总和。
- [ ] 下一步切到第二首准备，歌曲标题同步。

结果 / 备注：____________________

### D08 · 两曲总分与胜败分流

加载：`npm run test:manual -- --case D08`

1. 查看已确认的 W1 整轮赛果。
2. 打开 Bracket，核对胜者与败者下一场。

预期：

- [ ] 显示两首歌、难度、各自分数和总分。
- [ ] 胜者为绿色，败者转入败者组；整轮结果不显示总 P/G/B/M。

结果 / 备注：____________________

### D09 · 败者组淘汰

加载：`npm run test:manual -- --case D09`

1. 查看 L1 结果和下一场流向。
2. 确认落败选手的显示状态。

预期：

- [ ] 第二次失利者标为淘汰，使用红色。
- [ ] 胜者继续败者组；淘汰者不再进入后续对阵。

结果 / 备注：____________________

### D10 · 总分同分与补录 ACC

加载：`npm run test:manual -- --case D10`

1. 观察整轮总分相同的中性结果页。
2. 通过「補錄各曲 ACC」补齐双方两首 ACC。

预期：

- [ ] 没有提前显示胜者。
- [ ] ACC 缺失时不能跳过比较直接宣布胜负。

结果 / 备注：____________________

### D11 · 公布平均 ACC

加载：`npm run test:manual -- --case D11`

1. 先核对相同的两曲总分，再按「公布平均 ACC」。
2. 查看两首 ACC 和四位小数的平均值。

预期：

- [ ] 平均值由两首 ACC 算出。
- [ ] 公布平均值时双方仍保持中性，胜者尚未发布。

结果 / 备注：____________________

### D12 · ACC 最终判定

加载：`npm run test:manual -- --case D12`

1. 核对左侧平均 ACC 较高。
2. 按「公布最終判定」并确认裁判核对。

预期：

- [ ] 确认之后才显示绿色胜者和晋级流向。
- [ ] Bracket 按 ACC 判定结果推进。

结果 / 备注：____________________

### D13 · 平均 ACC 仍然相同

加载：`npm run test:manual -- --case D13`

1. 查看双方相同的平均 ACC。
2. 按「平均 ACC 相同 · 準備加賽」。

预期：

- [ ] 明确提示需要加赛，没有虚构胜者。
- [ ] 进入只显示两位选手、暂不公布加赛曲的准备页。

结果 / 备注：____________________

### D14 · 双淘汰加赛曲公布

加载：`npm run test:manual -- --case D14`

1. 先查看准备页与记分员锁定状态。
2. 按「公布加賽曲目」，听预览，再回准备页。

预期：

- [ ] 公布前曲目保密；公布页有中英文大标题、曲绘、歌名、难度与等级。
- [ ] 返回准备页后保留歌名和难度。

结果 / 备注：____________________

### D15 · 双淘汰加赛判定录入

加载：`npm run test:manual -- --case D15`

1. 打开主控与记分员，填写双方加赛分数和 P/G/B/M。
2. 保存后进入本曲统计。

预期：

- [ ] 两端都有四类判定输入。
- [ ] 当前仅有这一首加赛，不会误写基础两曲成绩。

结果 / 备注：____________________

### D16 · 加赛确认后整轮赛果

加载：`npm run test:manual -- --case D16`

1. 核对右侧选手赢得加赛。
2. 确认加赛并确认整轮赛果。

预期：

- [ ] 确认后右侧选手晋级。
- [ ] 基础两曲仍是同分；判定依据标为加赛，不篡改原始成绩。

结果 / 备注：____________________

## 总决赛与总排名

### F01 · 决赛前两曲依次公布

加载：`npm run test:manual -- --case F01`

1. 准备 OBS 测试源，按「公布決賽第一首」。
2. 观察两首固定曲依次公布与预览。

预期：

- [ ] Cthugha 与 Petrichor 使用同一时钟依次公布。
- [ ] 当前比赛歌曲与公布流程不会互相覆盖。

结果 / 备注：____________________

### F02 · 决赛前两首中途总成绩

加载：`npm run test:manual -- --case F02`

1. 核对双方前两首分数与小计。
2. 进入最后一首的神秘准备。

预期：

- [ ] 这里只是中途成绩，没有宣布冠军。
- [ ] 第三首仍须比赛并计入最终总分。

结果 / 备注：____________________

### F03 · 最后一首保密准备

加载：`npm run test:manual -- --case F03`

1. 查看 OBS 和记分员页面。
2. 检查第三首信息与输入权限。

预期：

- [ ] OBS 使用神秘曲等待表现。
- [ ] 公布前记分员看不到歌曲真实标题，第三首录分被锁定。

结果 / 备注：____________________

### F04 · 新版 Ending Song Video

加载：`npm run test:manual -- --case F04`

1. 准备好 OBS 测试源，按「播放公布視頻」。
2. 完整播放，期间检查音量、静音和工作人员预览。

预期：

- [ ] 播放新版 1080p/24fps PV，按 88.512 秒计时，画面只显示视频。
- [ ] Logo、标题、错误侵入和连接提示都不会盖住视频。
- [ ] 播完自动回到准备页并公布 What do you want more than a Happy ending? / AT 17。

结果 / 备注：____________________

### F05 · 最后一首净化效果

加载：`npm run test:manual -- --case F05`

1. 检查公布后的歌曲与难度。
2. 按顺序尝试三阶段净化，再恢复普通效果。

预期：

- [ ] 红色侵入效果逐步清除，文字抖动逐步减弱。
- [ ] 最终阶段清除附加效果；视频与信息层位置保持正确。

结果 / 备注：____________________

### F06 · 决赛第三首录分

加载：`npm run test:manual -- --case F06`

1. 在记分员页面录入第三首分数及判定。
2. 主控检查三首累计，再核对整轮赛果。

预期：

- [ ] 第三首已经解锁，可正常录分。
- [ ] 三首全部完成前不能确认最终胜者。

结果 / 备注：____________________

### F07 · 决赛整轮三曲赛果

加载：`npm run test:manual -- --case F07`

1. 核对三首分数及总和。
2. 进入赛事总排名。

预期：

- [ ] 三首成绩一起决定冠军。
- [ ] 结果页包含三首歌曲与难度，没有总 P/G/B/M 行。

结果 / 备注：____________________

### F08 · 决赛三曲平均 ACC

加载：`npm run test:manual -- --case F08`

1. 公布双方平均 ACC。
2. 核对三首都计入平均，再发布最终判定。

预期：

- [ ] 总分相同，先展示同分再展示 ACC。
- [ ] 平均值使用三首，不会只算前两首。

结果 / 备注：____________________

### F09 · 总排名与无序名次组

加载：`npm run test:manual -- --case F09`

1. 核对冠军、亚军、季军。
2. 等待第九名以后名单翻页，离开后再返回。

预期：

- [ ] 前三名分别显示；第四至第八名没有内部排序。
- [ ] 第九名至最后一名也不排序，16 人名单按页循环，重入从第一页开始。

结果 / 备注：____________________

## 裁判与多端协作

### O01 · 取消资格与自动判负

加载：`npm run test:manual -- --case O01`

1. 本场已记录一首成绩；在「裁判工具」选择左侧选手，填写决定记录并取消资格。
2. 查看本场结果和 Bracket。

预期：

- [ ] 当前对手获得判负胜利。
- [ ] 被取消资格者不再进入后续有效对阵，已记录成绩仍可核对。

结果 / 备注：____________________

### O02 · 重开赛果与下游清除

加载：`npm run test:manual -- --case O02`

1. 在赛果纠错工具选择 W1 并查看影响。
2. 核对受影响场次、填写理由并确认重开。

预期：

- [ ] 先展示影响清单；重新打开后根场成绩保留为待核对数据。
- [ ] 相关下游赛果被清除，总排名撤回；无关支线保留。

结果 / 备注：____________________

### O03 · 主控与记分员并发草稿

加载：`npm run test:manual -- --case O03`

1. 主控和记分员同时打开，主控改左侧第一首分数但暂不保存。
2. 记分员改同一分数并保存，再回主控查看草稿。

预期：

- [ ] 主控未保存内容仍在。
- [ ] 同一字段冲突需要明确核对，不静默覆盖另一端的新成绩。

结果 / 备注：____________________

### O04 · Webcam 来源人工核对

加载：`npm run test:manual -- --case O04`

1. 将三路来源名称改成实际 OBS 名称，保存并人工核对。
2. 切换本批选手，再检查确认状态。

预期：

- [ ] 单画面填写 Webcam 来源，手元输入隐藏。
- [ ] 选手或来源变化后，原人工确认失效。

结果 / 备注：____________________

### O05 · 缺席等待即将届满

加载：`npm run test:manual -- --case O05`

1. 打开「裁判工具」，观察剩余约 30 秒的等待。
2. 等待届满，核对是否仍需人工决定。

预期：

- [ ] 届满仅提示等待结束。
- [ ] 系统不会自动取消选手资格；人工核对后才能决定。

结果 / 备注：____________________

### O06 · 裁判授权单曲重赛

加载：`npm run test:manual -- --case O06`

1. 为当前一位选手第一首填写游戏错误理由，并核对录像和同意项。
2. 授权后查看该选手官方 Challenge 总分。

预期：

- [ ] 重赛额度被记录，不能重复授权同一曲。
- [ ] 该选手本轮总分撤回等待重录，其他选手成绩保留。

结果 / 备注：____________________

### O07 · 开赛前空缺与三人抽签

加载：`npm run test:manual -- --case O07`

1. 查看 W1/W2 四人分区中仅余三人的提示。
2. 记录现场轮空抽签，核对并清除该分区尚未开赛的选曲。

预期：

- [ ] 不能跳过抽签直接判轮空。
- [ ] 抽签后仅一人轮空晋级，另两人重配；不存在虚构败者。

结果 / 备注：____________________
