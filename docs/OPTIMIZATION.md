# 优化设计：效率 / 稳定性 / 准确性

参考实现（2026-11-15 调研）：

| 来源 | 借鉴点 |
| --- | --- |
| [matlab/matlab-mcp-server](https://github.com/matlab/matlab-mcp-server)（Go，1.8k★） | 持久化 MATLAB 会话（new/auto/existing 模式）；`check_matlab_code` 用 Code Analyzer 做执行前静态预检；`evaluate_matlab_code` 在活会话内求值；安全立场：人工审阅 + human-in-the-loop |
| [matlab/matlab-agentic-toolkit](https://github.com/matlab/matlab-agentic-toolkit)（1.3k★） | skills-catalog 结构；coding guidelines 作为 resource 随取随用 |
| [matlab/rules](https://github.com/matlab/rules) | MATLAB Coding Standards：lowerCamelCase、≤32 字符变量名、避免与 path 上函数重名、Name-Value 参数用 UpperCamelCase |

## 1. 效率：持久化 MATLAB 会话

现状（优化前）：每次 `matlab_plot` 冷启动 MATLAB（本机实测 15-90 s），画图耗时被启动开销支配。

实现（`server/session.mjs` + 生成的 `sessionDaemon.m`）：

- **守护进程**：`matlab -batch "cd(...); sessionDaemon(...)"` 常驻；daemon 轮询 `<outDir>/.session/queue/*.job`，执行后写 `<outDir>/.session/results/<id>.res` 并删除 job。
- **作业协议**：job = `{id, code}`；result = `{id, ok, output, exitCode, error}`，server 严格按 `id` 匹配（防串话/伪造冒领）。
- **健康检查**：heartbeat 双通道——daemon 循环顶部刷新 + 作业期间 MATLAB `timer` 每秒刷新（长作业不会被误判为死会话）。
- **孤儿回收**：`server-alive` 看门狗——server 侧每 10 s 刷新、daemon 侧 90 s 无更新即退出（host 强杀 server 时 JS 清理不执行，靠它兜底）；daemon 侧用 `dir().datenum` 与 `now` 比较，避免跨系统时钟基准差异（UTC+8 下 JS 时间戳会恒定差 8 小时）。
- **空闲回收**：daemon 连续 `MATLAB_MATE_SESSION_IDLE_MS`（默认 10 min）无作业自动退出；下次调用重建。
- **单飞**：同一 outDir 的并发冷启动共享一个在途启动 promise，绝不重复拉起、绝不互杀。
- **脚本缓存**：daemon 执行每个作业前 `clear functions`——MATLAB 会缓存已解析脚本，同名脚本被改写后 `run()` 仍执行旧内容（同名重画会静默返回旧图）。
- **防遮蔽**：daemon 全部局部变量 `scp` 前缀——`run()` 在调用方工作区执行脚本，daemon 的局部名会遮蔽同名 MATLAB 函数（曾因局部变量 `stem` 导致 stem 图 100% 失败）。
- **优雅降级**：`MATLAB_MATE_SESSION=never` 或会话不可用（老版本 MATLAB、spawn 失败、进程死亡）→ 回退一次性 `-batch`；`always` 则强制会话、失败即报错。
- **批量绘图**：`matlab_plot_many` 多张图合并为一次 MATLAB 执行（会话内一个作业 / 一次性一个 `-batch`），N 张图只付一次启动成本。
- 进程树清理：Windows 上 `matlab.exe` 只是启动器，`MATLAB.exe` worker 是孙进程，停止时用 `taskkill /PID /T /F` 杀整棵树。

实测收益（本机 R2026a）：连续 3 张图从 61.5 s 降到 4.1 s（**提速 93.4%**）。

## 2. 准确性：执行前静态预检 + 产物自验证

- **checkcode 预检**：生成的 .m 在导出前先过 MATLAB Code Analyzer（`checkcode(自身路径)`），问题计数与首条信息进入 RESULT `analyzer` 字段；会话模式下几乎零成本（同进程）。
- **产物自验证**：导出后在 MATLAB 内验证文件存在与非空（`dir().bytes` 回写进 RESULT `bytes`）；位图用 `print -r96` 按 figure 像素尺寸精确导出（`exportgraphics` 在无头环境下按内容区域导出、尺寸会漂移）；`matlab_figure_read` 解析 PNG IHDR 回读宽高。
- **sidecar 结果通道**：`<script>.result.json` 与 stdout RESULT 行双写，会话模式（evalc 捕获不确定）以此为主通道，读后即删。
- **编码规范对齐**（matlab/rules）：生成代码变量 lowerCamelCase 且 ≤32 字符；避开与 MATLAB path 函数重名的变量。
- **视觉闭环保留**：`matlab_figure_read` 仍是最终人工验证手段。

## 3. 稳定性

- **作业容错**：daemon 的 `processJob` 整体 try/catch，坏 job 文件只产生错误结果，不会杀死 daemon。
- **无 exit**：生成的绘图脚本不含 `exit()`（错误经 RESULT 行与 sidecar 回传），单图失败不会杀死常驻会话。
- **超时分层**：会话作业超时只放弃本作业（删自己的 job 文件），不杀共享会话；一次性模式超时保持结构化 `timeout` 错误。
- **退出清理**：stdin EOF / SIGINT / SIGTERM 时异步完成清理（stop 文件 + taskkill 树）再退出；`process.exit` 不再抢先。
- **错误分类**：中英文双语模式表（含中文 Windows 的 GBK 报错），延续至 v1.0.1。
- **fake 缝**：以 Node 实现同一 daemon 协议（queue/results/heartbeat/stop/嵌套 run 展开/失败与耗时注入），无 MATLAB 环境可全链路演练。

## 4. 兼容与开关

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `MATLAB_MATE_SESSION` | `auto` | `auto`=会话优先失败回退；`always`=强制会话（不回退）；`never`=一次性模式（旧行为） |
| `MATLAB_MATE_SESSION_IDLE_MS` | `600000` | 会话空闲回收时间（daemon 连续无作业自动退出） |
| `MATLAB_MATE_BIN` / `MATLAB_MATE_ROOT` | PATH 探测 | 指定 MATLAB；显式指定但不存在时直接报错，不静默回落 |
| `MATLAB_MATE_OUTDIR` | `<插件>/figures` | 输出目录，必须绝对路径 |
| `MATLAB_MATE_FAKE` | — | 测试缝（含 daemon 协议模拟） |

## 5. 验收口径（均已在真机 R2026a 实测）

- 效率：连续 3 图 4.1 s vs 一次性 61.5 s（提速 ≥50% 达标，实测 93.4%）。
- 稳定性：杀 daemon 自愈、坏 job 容错、超时不杀会话、并发 4 路单飞单 daemon、同名重画反映新数据、EOF 退出 470 ms 内完成且 daemon 优雅退出。
- 准确性：16 类图形会话模式矩阵全部出图；PNG 尺寸精确等于 `spec.size`；`analyzer` 与独立 checkcode 一致且能抓真实缺陷；位图字节数与 RESULT `bytes` 零偏差。
