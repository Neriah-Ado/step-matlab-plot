#!/usr/bin/env node
/**
 * 真机验证脚本：绕过 MCP 层，直接用真实 MATLAB 出图。
 * 用法：node server/real-check.mjs [line|styles|boxplot|histogram|errorbar|scatter|bar|surf|heatmap]
 * 产出写入 figures/ 目录，退出码非 0 表示失败（供 CI/验收使用）。
 */
import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlotScript, runScript, listFigures, scriptPathFor } from './lib.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'figures');
const type = process.argv[2] || 'line';

const SPECS = {
  line: {
    type: 'line', name: 'real-line', title: '正弦/余弦（真机验证）', xlabel: 't (s)', ylabel: 'amplitude',
    data: { x: null, y: null },
    series: [{ name: 'sin(t)' }, { name: 'cos(t)' }],
  },
  styles: {
    type: 'line', name: 'real-styles', title: '系列样式（真机验证）', xlabel: 'x', ylabel: 'y',
    data: { x: [1, 2, 3, 4], y: [[1, 4, 9, 16], [1, 8, 27, 64]] },
    series: [
      { name: '平方', color: [0.2, 0.4, 0.8] },
      { name: '立方', color: 'red', lineStyle: '--', marker: 'o' },
    ],
    style: { lineWidth: 1.8 },
    grid: true,
  },
  boxplot: {
    type: 'boxplot', name: 'real-boxplot', title: '箱线图（真机验证）', ylabel: 'value',
    data: { groups: [[1, 2, 3, 4, 5], [2, 3, 4, 5, 6, 7, 8], [5, 6, 7]], labels: ['A 组', 'B 组', 'C 组'] },
  },
  histogram: {
    type: 'histogram', name: 'real-histogram', title: '直方图（真机验证）', xlabel: 'bin', ylabel: 'count',
    data: { y: null, binCount: 12 },
  },
  errorbar: {
    type: 'errorbar', name: 'real-errorbar', title: '误差棒（真机验证）', xlabel: 'x', ylabel: 'y ± e',
    data: { x: [1, 2, 3, 4], y: [[2.1, 3.9, 6.2, 7.8]], err: [[0.3, 0.3, 0.4, 0.4]] },
    series: [{ name: '测量值', color: 'green' }],
  },
  scatter: { type: 'scatter', name: 'real-scatter', title: '散点（真机验证）', data: { x: [1, 2, 3, 4, 5], y: [2.1, 3.9, 6.2, 7.8, 11.1] } },
  surf: { type: 'surf', name: 'real-surf', title: 'peaks 曲面（真机验证）', data: { z: null } },
  heatmap: { type: 'heatmap', name: 'real-heatmap', title: '热力图（真机验证）', data: { z: [[1, 2, 3], [4, 5, 6], [7, 8, 9]], x: ['一', '二', '三'], y: ['a', 'b', 'c'] } },
  bar: { type: 'bar', name: 'real-bar', title: '柱状图（真机验证）', data: { x: ['Q1', 'Q2', 'Q3', 'Q4'], y: [12, 19, 9, 15] } },
};

// 预生成规则数据（避免脚本里手写大数组）
function materialize(spec) {
  const s = JSON.parse(JSON.stringify(spec));
  if (s.type === 'line') {
    const n = 200;
    const x = [], y1 = [], y2 = [];
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * 2 * Math.PI;
      x.push(Number((t).toFixed(4)));
      y1.push(Number(Math.sin(t).toFixed(4)));
      y2.push(Number(Math.cos(t).toFixed(4)));
    }
    s.data = { x, y: [y1, y2] };
  }
  if (s.type === 'histogram') {
    const y = [];
    let seed = 42;
    for (let i = 0; i < 500; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      y.push(Number(((seed / 2147483648) * 10).toFixed(3)));
    }
    s.data = { y, binCount: s.data.binCount };
  }
  if (s.type === 'surf') {    const z = [];
    for (let i = 0; i < 24; i++) {
      const row = [];
      for (let j = 0; j < 24; j++) {
        const u = -3 + (6 * j) / 23;
        const v = -3 + (6 * i) / 23;
        const u2 = u * u;
        const v2 = v * v;
        const term1 = 3 * (1 - u) * (1 - u) * Math.exp(-u2 - (v + 1) * (v + 1));
        const term2 = 10 * (u / 5 - u * u2 - v * v2 * v) * Math.exp(-u2 - v2);
        const term3 = (1 / 3) * Math.exp((-(u + 1) * (u + 1)) - v2);
        row.push(Number((term1 - term2 - term3).toFixed(3)));
      }
      z.push(row);
    }
    s.data = { z };
  }
  return s;
}

const spec = materialize(SPECS[type]);
if (!spec) {
  console.error(`未知类型 ${type}；可选：${Object.keys(SPECS).join(', ')}`);
  process.exit(2);
}
const built = buildPlotScript(spec, OUT);
if (!built.ok) {
  console.error('代码生成失败：', built.reason);
  process.exit(3);
}
const scriptPath = scriptPathFor(OUT, built.value.name);
writeFileSync(scriptPath, built.value.code, 'utf8');
console.log(`[real-check] 类型=${type} 脚本=${scriptPath}`);
console.log(`[real-check] 调用真实 MATLAB（冷启动可能 30-90s）…`);

const run = runScript(scriptPath, { timeoutMs: 300000 });
console.log('[real-check] exitCode =', run.exitCode, ' timedOut =', run.timedOut);
if (run.result) console.log('[real-check] RESULT =', JSON.stringify(run.result));
if (run.stderr?.trim()) console.log('[real-check] stderr 尾部 =', run.stderr.trim().slice(-400));
const outFile = built.value.outFile;
if (existsSync(outFile)) {
  console.log(`[real-check] 出图成功：${outFile}（${statSync(outFile).size} 字节）`);
  console.log('[real-check] figures 清单 =', JSON.stringify(listFigures(OUT).figures.slice(0, 5)));
  process.exit(0);
}
console.error('[real-check] 未生成输出文件');
process.exit(4);
