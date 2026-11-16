# CHANGELOG

本插件遵循语义化版本。所有破坏性变更在 major 中说明。

## [1.0.2] - 2026-11-16

> 1.0.1 为内部迭代号，未单独发布；本版包含其全部修复。1.0.0 → 1.0.2 之间经 15 个子代理三轮交叉验证（效率/稳定性/安全性），本版修复其中发现的问题。

### Fixed

**会话判活与生命周期**

- 陈旧 `server-alive` 会让新 daemon 首循环即自杀（停止会话 >90 s 后再起静默回落一次性模式）：`startSession` 现在 spawn 前刷新 `server-alive`。
- 陈旧 `heartbeat` 让 `startSession` 在 daemon 未起来时误报"会话已就绪"（孤儿 daemon 也会被新 server 误领养）：spawn 前删除 heartbeat。
- 单条重量级 MATLAB 内置调用阻断 timer 心跳刷新，>60 s 长作业被并发调用误判死会话并杀掉：新增 `HEARTBEAT_LONG_STALE_MS=300000`，进程活着且心跳未严重陈旧即复用。
- `sessionDied` 清理可能杀掉 12 ms 前刚由别的调用拉起的新 daemon：清理前做代际比对（`sessions.get(outDir) === state`）。
- 慢启动（>90 s）会被看门狗判死刑：启动等待期持续刷新 `server-alive`。
- 并发发现死会话时各自 `stopSession + startSession` 拉起多个 daemon：单飞范围扩展到「清理 + 启动」整段。

**作业协议**

- 坏 job（非法 JSON/读取失败）的结果 id 为空，调用方白等满超时：daemon 用文件名 stem 回填 id，秒级失败；fake 缝同步实现。
- 协议解析与作业执行分离容错，解析失败不再执行作业。
- daemon 结果 `exitCode` 恒为 1：成功路径置 0。
- 客户端超时写 `.cancel` 文件，daemon 跳过排队中的作业，缓解队头阻塞；孤儿 cancel 在队列空闲时清理。

**假成功与产物校验**

- 陈旧 sidecar 让失败作业被报成 `ok:true`（预置 `<script>.result.json` 即可）：投递前删除本脚本的 sidecar。
- 预置同名输出文件可在异常协议路径下伪造"成功"：成功后要求文件 mtime 不早于作业开始时刻，否则报 `stale-output`。

**校验与安全**

- `toStrVector`（legend/labels/分类 x/heatmap 标签）不校验控制字符，与 `validateText` 标准不一致（真机 DoS）：统一拒绝控制字符。
- 图表名放行 Windows 保留设备名（`CON.png`/`nul.a.b`）：生成期拒绝（含多段点名首段）。
- `writeScript` 用字符串作 `%SELF_PATH%` 替换串，路径含 `$&`/`$'` 时被特殊语义吞掉：改函数替换。
- `classifyMatlabError` 的裸"不支持"把中文业务错误误判为 `-batch` 不受支持：收紧语境。
- `MATLAB_MATE_OUTDIR` 不校验控制字符、非字符串 env 抛异常：统一拒绝与回落。
- `readFigure` 存在 lstat→stat→read 的 TOCTOU：全链 try/catch。
- `resolveMatlabBin` 的专属错误指引被 exec 层丢弃：透传 `bin.guidance`。

**资源治理与效率**

- 一次性执行（`matlab_run`/回退路径）用 `spawnSync` 冻结 server 事件循环，>90 s 会饿死 `server-alive` 看门狗误杀持久会话：改异步 spawn。
- `uniqueBuild` 同名冲突时最多 99 次全量重建（20 万点最坏 ~1.6 s）：探测优先，只构建一次（实测 53 ms）。
- `uniqueBuild` 99 个候选全占用时静默覆盖：显式报错。
- 批量绘图无代码聚合上限（20×1.9 MB → 40 MB 落盘）：新增 8 MB 聚合上限并边生成边判定。
- `matlab_plot` 的 dryRun 不截断（回传 2 MB 代码）：与 `matlab_plot_many` 一致截断到 50k 字符并返回 `codeTruncated`/`codeLength`。
- 图片响应 `JSON.stringify` 对 35 MB base64 串整份复制：手工序列化（隔离实测 370 MB → 115 MB 峰值）。
- daemon 33 Hz 空转轮询占 ~7.6% 单核：退避（忙 30 ms / 空闲 250 ms），实测空闲 ~1%。
- daemon 常驻内存随作业数增长：作业后 `clear variables`（工作区变量/figure/timer 实测恒定）。
- spool 无清理：启动时清理 10 分钟前的孤儿结果、1 小时前的生成脚本、1 天前的日志。
- 空闲回收默认 10 min → 5 min（重建成本实测 ~10 s）。

### Added

- `mem-slope-check.mjs`：daemon 内存卫生验证（变量/figure/timer 恒定 + 堆增长递减）。
- `real-roundd-check.mjs` / `real-rounde-check.mjs`：修复专项真机验证（重启回落/事件循环/长作业不误杀/坏 job 快速失败/陈旧心跳）。
- 文档：README 与 OPTIMIZATION.md 增补**信任边界**声明（`figures/.session/` 有写权限等同本机代码执行，多用户目录应设 `MATLAB_MATE_SESSION=never`）；修正"防伪造"过度声明为"防串话/错 id 投毒"。

### Verification

- `node --test server/lib.test.mjs`：62/62 通过（新增 dryRun 截断、多段保留名、fake 坏 job 回填、sidecar 投递前清理等回归）。
- `node server/smoke.mjs`：17/17 通过。
- 真机 MATLAB R2026a：16 类会话矩阵 7/7；修复专项 X 4/4、Y 6/6；内存卫生 PASS（首段 14 MB/10 张 → 尾段 3 MB/10 张，递减饱和）；异常矩阵 9/9；生命周期 4/4；长作业不误杀；基准加速比 83-97%。

### Known limitations

- `matlab_run` 为任意代码执行，确认闸是唯一边界；请受信环境使用。
- Windows 信号 kill 不执行 JS 清理，孤儿 daemon 由 90 s 看门狗回收。
- 单 outDir 的 daemon 严格串行：客户端超时只取消**排队中**的作业，已在执行的作业会跑完（队头阻塞上限为单作业超时）。
- daemon 常驻内存有 MATLAB 内部堆增长（递减趋稳），由 5 分钟空闲回收兜底。
- 同一输出目录同一时刻只应一个 server 实例使用会话模式。

---

## 预发布历史（内部迭代）

### [1.0.1] - 2026-11-15（内部号，未单独发布）

Fixed：`matlab_env` 探测（num2cell + 换符合并）、histogram `NumBins`、boxplot 数据+分组向量、样式属性矩阵、形状交叉校验、legend/grid else-if 链、中文报错分类、颜色字段注入、`MATLAB_MATE_BIN` 拼写错误静默回落、批量失败图诊断、`always` 模式语义、优雅退出竞态。

### [1.0.0] - 2026-11-16

首次公开发布：MCP server 7 工具、16 类图形、持久化 MATLAB 会话（真机提速 93.4%）、批量绘图、checkcode 预检、产物自验证、完整安全体系、测试缝、skill 与命令。
