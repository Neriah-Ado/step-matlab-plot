# CHANGELOG

本插件遵循语义化版本。所有破坏性变更在 major 中说明。

## [1.0.0] - 2026-11-16 — 首次公开发布

> 功能等价于内部版本 2.0.1；内部迭代记录见文末「预发布历史」。

### Added

- **MCP server 7 工具**（`server/index.mjs`，零依赖 Node）：`matlab_env` / `matlab_plot_types` / `matlab_plot` / `matlab_plot_many` / `matlab_run` / `matlab_figure_ls` / `matlab_figure_read`。
- **持久化 MATLAB 会话**（`server/session.mjs` + 生成的 `sessionDaemon.m`）：一次冷启动后经文件队列（queue/results）多作业复用；heartbeat 双通道（循环 + 作业期间 timer）、`server-alive` 看门狗（server 被强杀后 90 s 回收孤儿 daemon）、空闲回收（`MATLAB_MATE_SESSION_IDLE_MS`，默认 10 min）、优雅降级到一次性 `-batch`。真机基准：连续 3 图 **4.1 s vs 61.5 s（提速 93.4%）**。
- **批量绘图** `matlab_plot_many`：多张图合并为一次 MATLAB 执行（会话内一个作业），N 张图只付一次启动成本；逐图结果、`analyzer` 信息与诊断。
- **16 类图形**：line、scatter、bar、barh、histogram、area、pie、stem、stairs、errorbar、loglog、semilogx、semilogy、boxplot、surf、heatmap；导出 png/jpg（`print -r96` 精确像素）、svg/pdf（矢量）、fig。
- **Code Analyzer 执行前预检**：生成的 .m 先过 `checkcode` 自检，问题计数随 RESULT 的 `analyzer` 字段返回。
- **产物自验证**：导出后校验文件存在与非空（`dir().bytes` 回写进 RESULT `bytes`）；sidecar 结果文件（`<script>.result.json`）作为会话模式主结果通道；`matlab_figure_read` 解析 PNG IHDR 宽高。
- **数据入口**：内联数组、多系列（行=系列）、分类轴（字符串 x）、`data.csv`（readmatrix）、`data.json`（jsondecode）。
- **安全**：`matlab_run` dry-run→confirm 闸（G3）；图表名/文件名/数据路径白名单（C-05）；spec 全数据化（字符串转义、颜色白名单 + RGB 0-1、colormap 白名单）；形状前置校验（x/y、err、surf 轴长、heatmap/pie 标签数、legend/series 数量）；控制字符拒绝；体量与超时上限；输出尾部截断。
- **会话隔离**：生成的绘图脚本不含 `exit()`（失败经 RESULT 行与 sidecar 回传，单图失败不杀 daemon）；作业整体容错（坏 job 文件只产生错误结果）；结果按 id 严格匹配；daemon 局部变量 `scp` 前缀防遮蔽（`stem` 曾因此 100% 失败）；`clear functions` 防 MATLAB 脚本缓存导致同名重画返回旧图。
- **编码规范对齐**（matlab/rules）：生成代码变量 lowerCamelCase 且 ≤32 字符，避开与 MATLAB path 函数重名。
- 中文 Windows GBK 输出回退解码；测试缝 `MATLAB_MATE_FAKE`（含 daemon 协议 Node 实现）；skill `matlab-plot`、命令 `/matlab-plot`、`docs/OPTIMIZATION.md`。

### Verification

- `node --test server/lib.test.mjs`：56/56 通过。
- `node server/smoke.mjs`（fake 缝，全协议）：17/17 通过。
- 真机 MATLAB（R2026a Update 5）：
  - 16 类图形会话模式矩阵全部出图（`real-roundc-check.mjs` 7/7）；
  - 同名重画反映新数据、PNG 尺寸精确等于 `spec.size`、4 并发单飞单 daemon、批量逐图带 name；
  - 会话性能基准 93.4% 提速；`matlab_env` 返回 116 个工具箱；`data.csv` 入口通过；
  - server EOF 退出 470 ms 内完成且 daemon 经 stop 文件优雅退出。

### Known limitations

- 本机 R2026a 无头（`-batch`）环境下标准 axes 图形背景渲染为深色（属性已设为白，属该版本 MATLAB 行为；heatmap/pie 不受影响）。
- Windows 上以信号（SIGTERM/TerminateProcess）杀死 server 时 JS 清理不执行，孤儿 daemon 由 90 s 看门狗回收；stdin EOF 则可完整清理。
- `-batch` 不可用（R2019a 之前）时的 `-nodisplay -r` 回退在 Windows MATLAB 上可能不执行 `-r` 语句。
- 同一输出目录同一时刻只应有一个 server 实例使用会话模式；多实例并发请为每个实例设置不同 `MATLAB_MATE_OUTDIR`。
- `matlab_run` 为任意代码执行，确认闸是唯一边界；请受信环境使用。

---

## 预发布历史（内部迭代，未单独发布）

### [2.0.1] - 2026-11-15

Fixed（第二轮 5 子代理验证发现）：

- **高危**：daemon 局部变量 `stem` 遮蔽 MATLAB `stem` 函数导致该类型会话模式 100% 失败——全部局部量改 `scp` 前缀。
- **高危**：MATLAB 脚本缓存使同名重画静默返回旧图——daemon 执行前 `clear functions`。
- **高危**：并发冷启动时 `ensureSession` 顺序错误会杀掉在途 daemon——`inflight` 检查前置。
- **高危**：`MATLAB_MATE_OUTDIR` 未转义进入生成的 .m（`%SELF_PATH%` 裸拼接）——成倍转义。
- **高**：批量失败图 RESULT 缺 `name` 导致逐图诊断丢失——catch 分支补 `type/name` + sidecar 逐图兜底。
- **中**：PNG 尺寸随内容漂移——位图改 `print -r96` 精确导出。
- **中**：`overwrite:true` 批内同名共享脚本路径导致静默丢图——taken 集合对 overwrite 同样生效。
- **中**：`MATLAB_MATE_SESSION=always` 未真正强制——实现失败即报错。
- **中**：优雅退出路径 `process.exit(0)` 抢先导致 `taskkill` 不执行——异步等待清理。
- **低**：colormap 白名单、句柄预分配（analyzer 噪声）、`MATLAB_MATE_BIN` 拼写错误静默回落 PATH、`figure_read` 拒绝符号链接、PNG IHDR 宽高回读、错误分类补中文索引/维度模式、生成脚本体量上限 2 MB、daemon 日志落盘。

### [2.0.0] - 2026-11-15

Added：持久化 MATLAB 会话、`matlab_plot_many`、checkcode 预检、产物自验证、编码规范对齐、fake 缝 daemon 协议模拟、`docs/OPTIMIZATION.md`。

### [1.0.1] - 2026-11-15

Fixed：颜色字段注入（白名单 + RGB 0-1）、histogram `NumBins`、boxplot 数据+分组向量、样式属性矩阵、`matlab_env` 探测（num2cell + 换符合并）、形状交叉校验、legend/grid else-if 链、中文报错分类。

### [1.0.0] - 2026-11-15

Added：MCP server（6 工具）、16 类图形代码生成、5 种导出格式、CSV/JSON 数据入口、G3/C-05/C5 安全体系、测试缝、skill 与命令。
