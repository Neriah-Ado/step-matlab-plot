# Step Matlab Plot

让 StepCode 调用本机 MATLAB 画图的插件：把结构化图表规格（spec）编译成 MATLAB 脚本、执行、导出出版级图片，并读回做视觉验证。零依赖 Node MCP（Model Context Protocol）server，协议与 `@modelcontextprotocol/sdk` 兼容。

本插件首发版即包含**持久化 MATLAB 会话**（设计借鉴 MathWorks 官方 matlab-mcp-server 的活会话模式）：一次冷启动后多作业复用，本机实测连续 3 张图从 61.5 s 降到 4.1 s（**提速 93.4%**）。
## 能力

| 工具 | 说明 |
| --- | --- |
| `matlab_env` | 探测 MATLAB 可用性、版本（release）、工具箱清单；缺失时返回安装指引 |
| `matlab_plot_types` | 列出 16 类图形及各自必需/可选数据字段（不触达 MATLAB） |
| `matlab_plot` | 按 spec 生成图表并导出；`dryRun: true` 只返回生成的 .m 代码 |
| `matlab_plot_many` | 批量绘图：多张图合并为一次 MATLAB 执行（会话内一个作业），N 张图只付一次启动成本 |
| `matlab_run` | 执行任意 MATLAB 代码；**默认 dry-run，`confirm: true` 才执行** |
| `matlab_figure_ls` | 列出输出目录图表（名称/格式/字节/时间） |
| `matlab_figure_read` | 按文件名读回图表，png/jpg/svg 以图片 content 返回 |

图形类型（16）：line、scatter、bar、barh、histogram、area、pie、stem、stairs、errorbar、loglog、semilogx、semilogy、boxplot、surf、heatmap。
导出格式：png、jpg、svg、pdf、fig。

## 前置条件

- MATLAB R2019a+（`-batch`；更早版本自动回退 `-nodisplay -nosplash -r`）。
- 运行插件 server：Node 18+；运行测试与真机验证脚本（用到 `import.meta.dirname`）：Node 20.11+。
- MATLAB 不在 PATH 时用 `MATLAB_MATE_BIN` 或 `MATLAB_MATE_ROOT` 指定。

## 安装（接入 StepCode）

本仓库是一个 StepCode 插件目录，整体放入插件目录即可被宿主识别：

```powershell
# Windows（用户级插件目录）
Copy-Item -Recurse step-matlab-plot "$env:USERPROFILE\.stepcode\plugins\"
```

```bash
# macOS / Linux
cp -r step-matlab-plot ~/.stepcode/plugins/
```

`step.plugin.json` 中的 `mcpServers` 会把 `node server/index.mjs` 注册为名为 `step-matlab-plot` 的 MCP server；`commands/` 与 `skills/` 分别注册 `/matlab-plot` 命令与 `matlab-plot` skill。无需 `npm install`（零依赖）。

## 5 分钟画出第一张图

1. 确认 MATLAB 可用：调用 `matlab_env`，应返回 `available: true` 与版本号。
2. 把 [`examples/line-demo.json`](examples/line-demo.json) 的内容作为 `spec` 传给 `matlab_plot`，先加 `dryRun: true` 审查生成的 MATLAB 代码。
3. 去掉 `dryRun` 正式出图；用 `matlab_figure_read` 读回图片做视觉检查。
4. 多张图一次画：`matlab_plot_many` 传 `{ specs: [<spec>, ...] }`（单批 ≤ 20 张）。

## 快速开始

```bash
# 1) 单元测试（68 项：校验/代码生成/错误分类/会话/fake 缝/V1.0.3 修复回归）
node --test server/lib.test.mjs

# 2) 冒烟测试（stdio JSON-RPC 全协议，自动走 fake 缝）
node server/smoke.mjs

# 3) 真机出图（line|styles|scatter|bar|surf|heatmap|boxplot|histogram|errorbar）
node server/real-check.mjs line

# 4) 真机会话性能基准（会话 vs 一次性对照）
node server/real-session-check.mjs

# 5) 迭代轮真机验证（stem 会话/同名重画/尺寸/16 类矩阵/并发单飞/批量）
node server/real-roundc-check.mjs

# 6) server 退出清理验证（EOF 后 daemon 优雅退出）
node server/exit-cleanup-check.mjs

# 7) 修复专项验证（重启回落/内存卫生/事件循环/队列残留）
node server/real-roundd-check.mjs && node server/mem-slope-check.mjs

# 8) 稳健性专项验证（长作业不误杀/坏 job 快速失败/陈旧心跳/结果卫生）
node server/real-rounde-check.mjs

# 9) V1.0.2 修复专项（dryRun 截断/陈旧 sidecar 假成功防护）
node server/v102-fix-check.mjs

# 10) V1.0.3 真机循环套件（稳定 10 + 安全 10 + 准确 21 + 修复专项 10）
node server/cycle-runner.mjs all

# 11) V1.0.3 修复视觉验证（分类顺序/白底/单点 marker）
node server/visual-check.mjs
```

产物写入 `figures/`（脚本在 `figures/.scripts/`，会话 spool 在 `figures/.session/`）。

## 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `MATLAB_MATE_BIN` | PATH 探测 | 指定 matlab 可执行文件（如 `D:\Matlab\bin\matlab.exe`） |
| `MATLAB_MATE_ROOT` | — | 指定 MATLAB 安装根目录（自动拼 `bin/matlab`） |
| `MATLAB_MATE_OUTDIR` | `<插件>/figures` | 输出目录，**必须绝对路径** |
| `MATLAB_MATE_SESSION` | `auto` | `auto`=会话优先、失败回退一次性；`always`=强制会话（不可用即报错，不回退）；`never`=一次性模式（旧行为） |
| `MATLAB_MATE_SESSION_IDLE_MS` | `300000`（5 min） | 会话空闲回收时间（daemon 连续无作业自动退出；重建成本实测 ~10s） |
| `MATLAB_MATE_FAKE` | — | 测试缝：指向 `server/fake-matlab.mjs`，无 MATLAB 也能端到端验证（含 daemon 协议模拟） |
| `FAKE_MATLAB_FAIL` | — | 配合测试缝模拟执行失败（=1） |
| `FAKE_MATLAB_SLEEP_MS` | — | 配合测试缝模拟耗时，用于超时测试 |
| `FAKE_MATLAB_IDLE_MS` | `5000`（5 s） | 测试缝 daemon 空闲退出时间（真机由 `MATLAB_MATE_SESSION_IDLE_MS` 决定） |

## 无 MATLAB 验证（CI/验收）

```powershell
# PowerShell
$env:MATLAB_MATE_FAKE = (Join-Path $PWD 'server/fake-matlab.mjs'); node server/smoke.mjs
```

```bash
# bash
MATLAB_MATE_FAKE=$PWD/server/fake-matlab.mjs node server/smoke.mjs
```

测试缝会按脚本头部注释生成占位图（PNG 由内置编码器实时生成，可被真实读取），因此 `matlab_figure_read` 的图片回路在无 MATLAB 环境同样可验证；`MATLAB_MATE_FAKE` 下 fake-matlab 还会以 Node 实现同一 daemon 协议（queue/results/heartbeat/stop），会话模式可全链路演练。

## 安全设计

- **G3 危险操作闸**：`matlab_run` 默认 dry-run 只预览代码，`confirm: true` 才触达 MATLAB；任意 MATLAB 代码等同本机代码执行。`matlab_run` 有意不走持久会话（一次性 `-batch`），避免任意代码污染常驻会话状态。
- **会话隔离**：生成的绘图脚本不含 `exit()`（失败经 RESULT 行与 sidecar 文件回传），单图失败不会杀死常驻 daemon；作业整体容错（坏 job 文件只产生带 id 的错误结果，调用方快速失败而非白等超时）；结果按 id 严格匹配，防串话/错 id 投毒；`server-alive` 看门狗在 server 被强杀后 90 s 内回收孤儿 daemon；停止时杀进程树（`taskkill /T /F`）。
- **信任边界**：`figures/.session/`（queue/results/scripts）属于**本地信任边界**——对该目录有写权限者等同获得本机代码执行（会话 daemon 会执行其中的 job 代码，与 G3 确认后的 `matlab_run` 同级）。spool 应置于受信用户目录；多用户或不受信进程可写的输出目录不要启用会话模式（设 `MATLAB_MATE_SESSION=never`）。同 id 预放的伪造结果不在防护范围（属上述信任边界）。
- **资源治理**：作业后 `clear variables` 保持工作区卫生（实测变量数恒定、figure/timer 不累积）；daemon 轮询退避（忙时 30 ms / 空闲 250 ms，空转 CPU 从 7.6% 降到约 2%）；启动时清理 10 分钟前的孤儿结果、1 小时前的生成脚本、1 天前的日志；客户端超时可取消排队中的作业（cancel 文件）。
- **事件循环**：一次性执行（`matlab_run`/回退路径）走异步 spawn，不再冻结 server——长执行期间 `ping` 等工具仍可响应，也不会饿死 `server-alive` 看门狗。
- **C-05 白名单**：图表名/文件名仅允许 `[A-Za-z0-9][A-Za-z0-9_.-]{0,127}`，拒绝路径分隔符、`..`、前导 `-`；数据文件必须存在且 ≤ 64 MB。
- **spec 全数据化**：用户输入只作为数据进入 MATLAB——字符串经单引号成倍转义，颜色名走字母白名单、RGB 校验 0-1，数字经有限性校验；没有任何用户字符串可拼接进 MATLAB 语句结构。
- **形状前置校验**：x/y 长度、err 形状、surf 轴长、heatmap 标签数、pie 标签数与负值、binCount 正整数、log 族拒绝分类轴——在生成期 fail-fast，不产出运行期必败的代码。
- **样式属性矩阵**：按图形类型分派句柄属性（如 scatter 的 color→`MarkerFaceColor`、bar 的 color→`FaceColor`），不支持的属性忽略并在结果 `warnings` 中告警。
- **体量与超时**：单系列 ≤ 20 万点、内联数字总量 ≤ 50 万、代码 ≤ 20 万字符（matlab_run）、文本字段（title/xlabel/ylabel/zlabel/colormap/series.name）≤ 2000 字符、图例/标签单项 ≤ 500 字符、执行超时默认 300 s（上限 600 s）、stdout/stderr 只回传尾部 200 行（matlab_plot 的 no-output 分支 50 行）、图表读回 ≤ 25 MB。
- **脚本标识符化**：落盘脚本名自动转为合法 MATLAB 标识符 + 短哈希（`run()` 会把 stem 当语句求值，`real-line.m` 会引发 `real - line` 解析错误）。
- **GBK 回退**：中文 Windows 上 MATLAB 输出按 GBK 编码，UTF-8 解码出现替换字符时自动回退解码。

## 目录结构

```text
step-matlab-plot/
├── plugin.yaml              # 插件元数据与版本计划
├── step.plugin.json         # 清单（注册 mcpServers/commands/skills）
├── server/
│   ├── index.mjs            # MCP stdio server
│   ├── lib.mjs              # barrel 导出
│   ├── codegen.mjs          # spec → .m 代码生成（纯函数）
│   ├── exec.mjs             # MATLAB 调用/会话执行/错误分类
│   ├── session.mjs          # 持久化 MATLAB 会话守护
│   ├── figures.mjs          # 图表目录管理/读回
│   ├── validate.mjs         # 输入校验与白名单
│   ├── png.mjs              # 最小 PNG 编码器（测试缝用）
│   ├── fake-matlab.mjs      # 测试缝（含 daemon 协议模拟）
│   ├── lib.test.mjs         # 单元测试
│   ├── smoke.mjs            # 端到端冒烟
│   ├── real-check.mjs       # 真机出图验证
│   ├── real-session-check.mjs # 真机会话性能基准
│   ├── real-round-check.mjs  # 迭代轮真机验证（V1-V6）
│   ├── real-roundc-check.mjs # 迭代轮真机验证（W1-W6）
│   ├── real-roundd-check.mjs # 修复专项真机验证（X1/X3/X4）
│   ├── real-rounde-check.mjs # 稳健性专项真机验证（Y1-Y4）
│   ├── v102-fix-check.mjs   # V1.0.2 修复专项验证
│   ├── cycle-runner.mjs     # V1.0.3 真机循环测试运行器（51 循环）
│   ├── visual-check.mjs     # V1.0.3 修复视觉验证
│   ├── mem-slope-check.mjs   # daemon 内存卫生验证
│   └── exit-cleanup-check.mjs # server 退出清理验证
├── docs/
│   └── OPTIMIZATION.md      # 优化设计（效率/稳定性/准确性）
├── skills/matlab-plot/SKILL.md
├── commands/matlab-plot.md
├── examples/                # spec 示例（line-demo.json / surf-demo.json）
└── figures/                 # 输出目录（含 .scripts/ 与 .session/）
```

## 许可

MIT（见 [LICENSE](LICENSE)）。设计参考了 MathWorks 官方开源项目（matlab-mcp-server、matlab-agentic-toolkit、matlab/rules），MATLAB 为 MathWorks 注册商标，本插件与 MathWorks 无关联。

## 验收状态

- 单元测试 68/68 通过；冒烟 17/17 通过（fake 缝，含会话协议与批量绘图）。
- 真机 MATLAB（R2026a Update 5，`D:\Matlab`）：
  - 9 组 spec 出图成功（line/styles/scatter/bar/surf/heatmap/boxplot/histogram/errorbar），`matlab_figure_read` 视觉检查通过；
  - 会话模式连续 3 图 4.1 s vs 一次性模式 61.5 s，**提速 93.4%**；
  - `matlab_env` 返回 116 个工具箱；`data.csv` 入口真机验证通过。

## 已知限制

- 本机 R2026a 无头（`-batch`）环境下 `exportgraphics` 对标准 axes 背景渲染为深色（属性已设为白，属该版本 MATLAB 的渲染行为；heatmap/pie 等无标准 axes 的图形不受影响）。
- `-batch` 不可用（R2019a 之前）时的 `-nodisplay -r` 回退在 Windows MATLAB 上可能不执行 `-r` 语句；该路径仅影响不被支持的旧版本。
- 会话 daemon 以文件队列（queue/results）通信，同一输出目录同一时刻只应有一个 server 实例使用会话模式；多实例并发请为每个实例设置不同 `MATLAB_MATE_OUTDIR`。
- 单 outDir 的 daemon 严格串行执行：客户端超时只放弃等待并取消**排队中**的作业，已在执行的作业会跑完（队头阻塞上限为单作业超时，默认 300 s）。
- 位图尺寸可能与 spec.size 差 ±1px（print -r96 取整）；默认 960×600 与 1280×720 实测精确。
- 含中文的 SVG 会将文字转为路径（无可提取文本）；需要可搜索/复制文本请导出 PDF。
- 20 万长小数内联会被 2MB 脚本上限拒绝（20 万整数可用，或改用 data.csv）。
- 白底黑字为进程级默认：同一会话内 matlab_run 的用户代码同样继承，需要深色图请自行 set(groot, ...)。
- daemon 常驻内存随作业数有 MATLAB 内部堆增长（实测递减趋稳：首段约 14 MB/10 张 → 尾段约 3 MB/10 张；工作区变量/figure/timer 不累积），由默认 5 分钟空闲回收兜底。
