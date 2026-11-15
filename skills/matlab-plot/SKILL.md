---
name: matlab-plot
description: MATLAB 画图方法论：结构化规格生成出版级图表、任意代码执行的安全闸、常见报错归因与导出格式选择。涉及 MATLAB 绘图、数据可视化、figures 目录管理时使用。
---

# matlab-plot — MATLAB 画图方法论

工具：MCP server `step-matlab-plot`（matlab_env / matlab_plot_types / matlab_plot / matlab_plot_many / matlab_run / matlab_figure_ls / matlab_figure_read）。

## 危险操作确认（G3 红线）

<!-- DANGEROUS-OPS-START -->
```json
{
  "dangerous": ["matlab_run", "system(", "delete(", "eval("],
  "rule": "matlab_run 默认 dry-run 只预览代码；confirm: true 才执行。任意 MATLAB 代码等同本机代码执行，执行前必须人工审阅代码全文",
  "context": "matlab_plot 非 dryRun 时会落盘并执行由 spec 编译出的 MATLAB 脚本（spec 全数据化、无用户代码注入面）；调试/批量场景才用 matlab_run，且不得在循环里批量 confirm"
}
```
<!-- DANGEROUS-OPS-END -->

## 标准流程（规格 → 出图 → 视觉验证）

1. `matlab_env` 确认 MATLAB 可用（版本/工具箱）；不可用时按返回的 guidance 安装或配置 `MATLAB_MATE_BIN`。
2. `matlab_plot_types` 查看 16 类图形与各自必需/可选字段，选型：
   - 趋势/时序 → line；相关性 → scatter；分类对比 → bar/barh；分布 → histogram/boxplot；
   - 占比 → pie；构成趋势 → area；离散信号 → stem/stairs；带误差 → errorbar；
   - 跨数量级 → loglog/semilogx/semilogy（仅数值 x）；二元函数 → surf；矩阵/混淆矩阵 → heatmap。
3. `matlab_plot` 传 spec（先 `dryRun: true` 审查生成的 .m 代码），成功后返回文件路径与字节数；结果里的 `warnings` 会列出被忽略的样式属性。多张图用 `matlab_plot_many`：`{ specs: [<spec>, ...], dryRun }`，单批 ≤ 20 张，批内同名自动追加 `-2`。
4. `matlab_figure_read` 读回图片**亲眼检查**：坐标轴范围、标签、图例、中文是否乱码、配色；不达标就改 spec 重画（同名会自动追加 `-2` 避免覆盖，或显式 `overwrite: true`）。
5. 汇报：图表文件路径 + 规格摘要 + 视觉检查结论。

## spec 速查

```jsonc
{
  "type": "line",                 // 16 类之一，见 matlab_plot_types
  "name": "figure",               // 图表名（白名单字符；自动防覆盖）
  "format": "png",                // png|jpg|svg|pdf|fig
  "data": {
    "x": [1, 2, 3],               // 可选；字符串数组=分类轴（log 族不支持）；缺省 1:n
    "y": [[1, 2, 3], [2, 4, 6]],  // 必需；一维=单系列，二维=多系列（行=系列）；长度须与 x 一致
    "err": [0.1, 0.1, 0.1],       // errorbar 必需；形状须与 y 一致
    "z": [[1, 2], [3, 4]],        // surf/heatmap 必需（矩阵）
    "groups": [[1, 2], [3, 4, 5]],  // boxplot 必需（各组长度可不同）
    "labels": ["A", "B"],         // pie/boxplot 可选标签；数量须与 y 长度/分组数一致
    "csv": "data/x.csv",          // 或 data.json；与内联数据二选一（此模式下不支持内联 x/err）
    "binCount": 20                // histogram 可选（正整数，编译为 NumBins）
  },
  "title": "标题", "xlabel": "x", "ylabel": "y", "zlabel": "z",  // zlabel 仅 surf 生效
  "legend": "auto",               // auto|none|字符串数组（数量须与系列数一致）
  "grid": true, "colormap": "parula", "colorbar": true,
  "series": [{ "name": "sin(t)", "color": [0.2, 0.4, 0.8], "lineStyle": "--" }],
  "style": { "lineWidth": 1.6, "markerSize": 36 },
  "size": { "width": 960, "height": 600 },
  "overwrite": false
}
```

## 样式属性支持矩阵

不同图形的句柄属性不同，生成期按矩阵分派；不支持的属性**忽略并在 `warnings` 告警**（不会报错）。`style.markerSize` 仅对 scatter 生效，用于其他图形会告警忽略：

| 图形族 | color 映射 | lineStyle | marker | lineWidth |
| --- | --- | --- | --- | --- |
| line/stem/stairs/errorbar/loglog/semilogx/semilogy | `Color` | ✅ | ✅ | ✅ |
| scatter | `MarkerFaceColor` | ❌ | ✅ | ✅ |
| bar/barh | `FaceColor` | ❌ | ❌ | ✅ |
| area | `FaceColor` | ✅ | ❌ | ✅ |
| histogram | `FaceColor` | ❌ | ❌ | ✅ |
| pie/boxplot/surf/heatmap | 整族不支持系列样式 | ❌ | ❌ | ❌ |

颜色：颜色名仅允许字母（red/blue/none…）或 `[r,g,b]`（0-1）——白名单是为堵住注入面，不是随意限制。

## 报错归因（与 classifyMatlabError 一致，含中文 MATLAB 报错）

| 症状 | 归因 | 处置 |
| --- | --- | --- |
| License checkout failed / 未许可 | 许可证缺失或未激活 | 激活 MATLAB；工具箱需对应 license |
| Undefined function 'xxx' / 无法识别 | 缺工具箱或函数名错误 | 安装 Toolbox 或换基础函数 |
| 矩阵维度不一致 / 参数无效 / 数目不足 | spec 数据维度不匹配 | x/y 等长；多系列用二维数组；surf 的 z 是矩阵 |
| Out of memory / 内存不足 | 数据量超限 | 降采样或走 data.csv（单系列上限 20 万点） |
| 无法打开/写入文件 | 输出目录或输入路径问题 | 检查 figures 目录权限与 data.csv 路径 |
| unrecognized option -batch / 不支持 | MATLAB 早于 R2019a | 已自动回退 `-nodisplay -r`；仍失败则升级 |

## 环境与输出

- 输出目录：`MATLAB_MATE_OUTDIR`（须绝对路径）覆盖，默认 `<插件目录>/figures`；脚本存于 `figures/.scripts/`，会话 spool 在 `figures/.session/`。
- **持久化会话**（默认 auto）：首个调用冷启动 MATLAB 常驻 daemon，其后作业经文件队列复用；连续多图用 `matlab_plot_many` 合并为一次执行。真机基准：3 图 4.1 s vs 一次性 61.5 s。需要旧行为时设 `MATLAB_MATE_SESSION=never`。
- 无 MATLAB 环境（CI/验收）：设 `MATLAB_MATE_FAKE=<插件目录>/server/fake-matlab.mjs` 走测试缝（含 daemon 协议模拟），端到端仍可验证（图片为占位图）。
- 中文 Windows 上 MATLAB 按 GBK 输出，exec 层已做 UTF-8→GBK 回退解码；图表内中文由 MATLAB 字体决定，缺字形时改用英文标签。
- 超时：默认 300 s（冷启动 20-90 s，会话模式下仅首次），`timeoutMs` 最大 600 s；长输出只回传尾部 200 行。
- **结果字段**：`mode`（session/oneshot）、`analyzer`（Code Analyzer 问题计数，执行前预检）、`bytes`（产物字节数）、`warnings`（被忽略的样式属性）。

## 与视觉验证闭环

`matlab_figure_read` 对 png/jpg/svg 返回图片 content——画完必须读回检查，再交付；不要仅凭退出码 0 判定图表可用。
