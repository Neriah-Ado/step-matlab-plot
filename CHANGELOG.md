# CHANGELOG

本插件遵循语义化版本。所有破坏性变更在 major 中说明。

## [1.0.3] - 2026-11-17

> 92 个真机测试循环（稳定性/安全性/结果准确性）+ 9 个子代理三轮交叉验证后的问题修复版。

### Fixed

**结果准确性（数据保真）**

- **分类轴顺序被静默重排**：`categorical({...})` 默认按码点升序，「甲乙丙」渲染成「丙乙甲」——影响 bar/barh/scatter/errorbar 的有序语义。改为双参数 `categorical(values, values)` 显式指定顺序；空串/重复标签生成期前置拒绝（原运行期硬报错）。
- **导出图绘图区近黑背景**：R2026a 无头环境 `FactoryAxesColor` 为 #121212（尽管 `axes.Color` 读作白色）。生成脚本显式 `set(groot, 'DefaultAxesColor', 'w', ...)` 白底黑字（实测验证：16 类全部白底）。
- **单点 line 图为空白**：`plot` 单点不成线且无 marker。单点数据（含多系列各 1 点）自动补 `'Marker', 'o'`。
- **data.json 通道方向错误且无上限**：旧实现 `v(:).'` 横向拼接，1×N 被 64 列截断后全部画在 x=1（30 万点静默失真且报成功）。改为点数×系列方向（嵌套每组成一列、平坦转列向量），并补点数/总量上限（与内联同阈值）。

**会话稳定性**

- **重试的静默双重执行**：`sessionDied` 后盲目重投，而 daemon 可能已取走作业并执行——副作用作业实测计数器=2。新增作业认领标记（daemon 取走时 `<id>.job`→`<id>.run`）；`mayHaveExecuted` 时绝不重跑也不回退一次性（两者都会重跑同一脚本），返回可区分的 `matlab-session-died-after-claim` 错误。
- **看门狗垂死窗口**：daemon 触发看门狗后 MATLAB 退出需 ~4.6s，期间 server 认为会话健康。认领标记 + 未认领才重试的语义彻底覆盖该窗口（含 `always` 模式）。
- **队列投毒致 daemon 忙转与作业饿死**：非空目录冒充 `*.job` 时 delete 失败→作业永不消失→100% CPU 忙转。daemon 过滤 `isdir`、作业分支加退避、坏作业删除包 try/catch。
- **`.run` 认领标记泄漏**：会话死亡分支只删 `<id>.job`（已被改名）。补充删除 `<id>.run`。
- **cancel 协议命名错配**：客户端写 `<id>.job.cancel` 而 daemon 检查 `<id>.cancel`——「缓解队头阻塞」实际是死代码。客户端改为 `<id>.cancel`，daemon 兼容两种命名。

**安全**

- **hardlink 绕过 symlink 防护**：`mklink /H`（无需管理员）可让输出目录内名字指向目录外文件，经 `matlab_figure_read` 完整泄漏。`readFigure` 拒绝 `nlink > 1` 并增加位图魔数嗅探（扩展名可伪造）；`fig` 格式补魔数校验。
- **0 字节假成功**：双 daemon 竞争可产出 0 字节文件却报 `ok:true`。`matlab_plot`/`matlab_plot_many` 汇报前校验产物非空且魔数与格式相符（`invalid-output`）。
- **data.json 无点数上限**（见上）：9.8MB/200 万点 JSON 曾绕过内联上限。
- **数字开头图表名运行期必败**：`scriptPathFor` 生成的 `.m` 以数字开头时 `run()` 当乘法表达式求值（`2024sales`→报错）。加 `f_` 前缀。

### Added

- `server/cycle-runner.mjs`：真机循环测试运行器，51 个循环（稳定性 10 / 安全性 10 / 准确性 21 / 修复专项 10），每循环一个完整场景执行与判定。
- `server/visual-check.mjs`：修复的视觉验证脚本。

### Verification

- `node --test server/lib.test.mjs`：68/68 通过（新增 JSON 方向/上限、多系列单点 marker、分类标签预检、groot 白底、mayHaveExecuted 语义等回归）。
- `node server/smoke.mjs`：17/17 通过。
- 真机循环：stability 10/10、security 10/10、accuracy 21/21、fix 10/10（合计 51）。
- 真机视觉确认：分类顺序（甲乙丙→柱高 3/5/2）、白底、单点 marker。
- 9 个子代理三轮交叉验证（稳定性/安全性/准确性）发现的问题全部修复并回归。

### Known limitations

- **位图尺寸 ±1px**：`print -r96` 取整导致部分宽度 +1（如 100→101、103→104）；默认 960×600 与 1280×720 实测精确。
- **SVG 中文转路径**：含中文的 SVG 无可提取 `<text>`（文字全部转为 path）；需要可搜索/复制文本请用 PDF。
- **20 万浮点内联受限**：`MAX_SCRIPT_CHARS=2MB` 使 20 万长小数（约 3.8MB 脚本）被拒；20 万整数可用，或改用 data.csv。
- **groot 默认值进程级**：白底黑字设置对同一会话内 `matlab_run` 的用户代码同样生效（需要深色图的用户自行 `set(groot, ...)`）。
- `matlab_run` 为任意代码执行，确认闸是唯一边界；请受信环境使用。
- Windows 信号 kill 不执行 JS 清理，孤儿 daemon 由 90 s 看门狗回收。
- 单 outDir 的 daemon 严格串行：客户端超时只取消**排队中**的作业，已在执行的作业会跑完。
- 同一输出目录同一时刻只应一个 server 实例使用会话模式；`figures/.session/` 属本地信任边界。

---

## 预发布历史（内部迭代）

### [1.0.2] - 2026-11-16

会话判活（陈旧 server-alive/heartbeat、长作业阈值、代际保护、慢启动保护、单飞扩展）、作业协议（坏 job id 回填、cancel 文件）、假成功防护（sidecar 清理 + 产物新鲜度）、校验与安全（控制字符、保留名、`$&`、错误分类、TOCTOU）、资源治理（异步一次性执行、uniqueBuild 探测优先、批量聚合上限、dryRun 截断、图片手工序列化、轮询退避、clear variables、spool TTL、空闲回收 5min）。

### [1.0.1] - 2026-11-15（内部号）

`matlab_env` 探测、histogram `NumBins`、boxplot 数据+分组向量、样式属性矩阵、形状交叉校验、颜色注入、中文报错分类。

### [1.0.0] - 2026-11-16

首次公开发布：MCP server 7 工具、16 类图形、持久化 MATLAB 会话（真机提速 93.4%）、批量绘图、checkcode 预检、产物自验证、完整安全体系。
