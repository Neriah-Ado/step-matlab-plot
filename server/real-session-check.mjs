#!/usr/bin/env node
/**
 * 真机会话验证 + 性能基准：
 *   1. 会话模式连续 3 张图（首次含冷启动，其后应亚秒级）
 *   2. 同一批图的一次性模式（对照基线）
 *   3. matlab_plot_many 批量一次执行
 * 用法：node server/real-session-check.mjs
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPlotScript, execScript, scriptPathFor, stopSession, sessionStatus } from './lib.mjs';

const OUT = join(import.meta.dirname, '..', 'figures');
delete process.env.MATLAB_MATE_FAKE;

const SPECS = [
  { type: 'line', name: 'perf-line', title: '会话性能验证 line', data: { x: [1, 2, 3, 4], y: [[1, 4, 9, 16], [1, 8, 27, 64]] } },
  { type: 'scatter', name: 'perf-scatter', title: '会话性能验证 scatter', data: { x: [1, 2, 3, 4], y: [2.1, 3.9, 6.2, 7.8] } },
  { type: 'heatmap', name: 'perf-heatmap', title: '会话性能验证 heatmap', data: { z: [[1, 2, 3], [4, 5, 6], [7, 8, 9]] } },
];

function writeOne(spec) {
  const built = buildPlotScript(spec, OUT);
  if (!built.ok) throw new Error(`生成失败: ${built.reason}`);
  const p = scriptPathFor(OUT, built.value.name);
  writeFileSync(p, built.value.code.replace(/%SELF_PATH%/g, p.replace(/\\/g, '/')), 'utf8');
  return { p, outFile: built.value.outFile };
}

// ---- 1. 会话模式 ----
console.log('=== 会话模式（持久化） ===');
const t0 = Date.now();
const paths = SPECS.map(writeOne);
let sessionTotal = 0;
for (const { p, outFile } of paths) {
  const t = Date.now();
  const r = await execScript(p, { outDir: OUT, timeoutMs: 300000 });
  const dt = Date.now() - t;
  sessionTotal += dt;
  const ok = r.result?.ok === true;
  console.log(`  ${outFile.split('/').pop()}: mode=${r.mode} ok=${ok} ${dt}ms analyzer=${r.result?.analyzer ?? 'n/a'}`);
  if (!ok) console.log('    RESULT:', JSON.stringify(r.result ?? r).slice(0, 300));
}
console.log(`  会话模式总计: ${sessionTotal}ms（含首次冷启动）`);
await stopSession(OUT);

// ---- 2. 一次性模式（基线：强制 never） ----
console.log('=== 一次性模式（基线） ===');
process.env.MATLAB_MATE_SESSION = 'never';
let oneshotTotal = 0;
for (const { p, outFile } of paths) {
  const t = Date.now();
  const r = await execScript(p, { outDir: OUT, timeoutMs: 300000 });
  const dt = Date.now() - t;
  oneshotTotal += dt;
  console.log(`  ${outFile.split('/').pop()}: mode=${r.mode} ok=${r.result?.ok === true} ${dt}ms`);
}
console.log(`  一次性模式总计: ${oneshotTotal}ms`);

const speedup = oneshotTotal > 0 ? ((1 - sessionTotal / oneshotTotal) * 100).toFixed(1) : 'n/a';
console.log(`\n=== 结论 ===\n  会话 ${sessionTotal}ms vs 一次性 ${oneshotTotal}ms → 提速 ${speedup}%`);
console.log(`  会话状态: ${JSON.stringify(sessionStatus(OUT))}`);
process.exit(0);
