---
description: 用 MATLAB 画一张图：给定数据与图形类型，生成出版级图表（png/pdf/svg/jpg/fig）并读回做视觉验证
argument-hint: [图形类型] [数据描述]
allowed-tools: ["mcp__step-matlab-plot__matlab_env", "mcp__step-matlab-plot__matlab_plot_types", "mcp__step-matlab-plot__matlab_plot", "mcp__step-matlab-plot__matlab_plot_many", "mcp__step-matlab-plot__matlab_figure_ls", "mcp__step-matlab-plot__matlab_figure_read", "mcp__step-matlab-plot__matlab_run"]
---

# /matlab-plot — MATLAB 出图命令

按以下步骤执行（详见 skill `matlab-plot`）：

1. **探测环境**：调用 `matlab_env`。若 `available: false`，把返回的安装指引原样转达用户并停止，不要尝试其他画图路径。
2. **选型**：调用 `matlab_plot_types`，结合用户数据特征选图形类型：
   - 趋势/时序 → `line`；相关性 → `scatter`；分类对比 → `bar`/`barh`；分布 → `histogram`/`boxplot`；
   - 占比 → `pie`；构成趋势 → `area`；离散 → `stem`/`stairs`；带误差 → `errorbar`；
   - 跨数量级 → `loglog`/`semilogx`/`semilogy`；二元函数 → `surf`；矩阵 → `heatmap`。
   用户未指定类型时按上表默认推荐并说明理由。
3. **组 spec**：把用户数据整理成 spec（字段速查见 skill）。数据量大（>1 万点）时建议先写入 CSV 再用 `data.csv`。
4. **预览**：首次调用 `matlab_plot` 带 `dryRun: true`，把生成的 MATLAB 代码要点告诉用户；用户无异议再正式出图（去掉 dryRun）。
5. **视觉验证**：调用 `matlab_figure_read` 读回图片**亲眼检查**（轴范围、标签、图例、中文、配色），不达标则改 spec 重画。
6. **汇报**：给出图表绝对路径、格式、字节数、规格摘要。

## 红线

- `matlab_run`（任意 MATLAB 代码）**不在本命令流程内**；用户明确要求执行自定义 MATLAB 代码时，先 dry-run 展示代码全文，用户确认后才可 `confirm: true`。
- 不修改用户既有图表：同名自动追加 `-2` 后缀；用户要求覆盖时才传 `overwrite: true`。
- 输出目录默认 `<插件>/figures`，可用 `MATLAB_MATE_OUTDIR`（绝对路径）覆盖。

## 无 MATLAB 环境

设置 `MATLAB_MATE_FAKE=<插件>/server/fake-matlab.mjs` 后走测试缝（图片为占位图），用于流程演练与 CI 验收；真机出图需去掉该变量。
