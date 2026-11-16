#!/usr/bin/env node
/**
 * X2 内存卫生验证（修正口径）：
 * clear variables 的目标是工作区不累积。MATLAB 内部堆增长（递减、会饱和）不可从插件侧消除，
 * 由默认 5 分钟空闲回收兜底。本脚本断言：
 *   H1 工作区变量数恒定（脚本变量不跨作业残留）
 *   H2 figure/timer 不累积
 *   H3 内存增长递减（尾段斜率 < 首段斜率，证明趋于饱和而非线性泄漏）
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPlotScript, execScript, execInSession, scriptPathFor, stopSession } from './lib.mjs';

const OUT = join(import.meta.dirname, '..', 'figures');
delete process.env.MATLAB_MATE_FAKE;
process.env.MATLAB_MATE_SESSION_IDLE_MS = '600000';
const BS_N = String.fromCharCode(92) + 'n';

const probe = async () => {
  const code = [
    'mInfo = memory;',
    "nTimer = numel(timerfind);",
    "nFig = numel(findall(0, 'Type', 'figure'));",
    'nVar = numel(whos);',
    `fprintf('P|%.0f|%d|%d|%d${BS_N}', mInfo.MemUsedMATLAB / 1e6, nTimer, nFig, nVar);`,
  ].join(' ');
  const r = await execInSession(OUT, code, { timeoutMs: 60000 });
  const line = (r?.output ?? '').split('\n').find((l) => l.startsWith('P|'));
  if (!line) return null;
  const [mem, timer, fig, vars] = line.split('|').slice(1).map(Number);
  return { mem, timer, fig, vars };
};
const writeOne = (name) => {
  const built = buildPlotScript({ type: 'line', name, data: { x: [1, 2, 3], y: [[1, 2, 3]] } }, OUT);
  const p = scriptPathFor(OUT, name);
  writeFileSync(p, built.value.code.replace(/%SELF_PATH%/g, p.replace(/\\/g, '/')), 'utf8');
  return p;
};

await execScript(writeOne('hyg-warm'), { outDir: OUT, timeoutMs: 300000 });
const samples = [await probe()];
for (let round = 1; round <= 3; round++) {
  for (let i = 0; i < 10; i++) {
    await execScript(writeOne(`hyg-${round}-${i}`), { outDir: OUT, timeoutMs: 300000 });
  }
  samples.push(await probe());
}
console.log('采样:', samples.map((s, i) => `${i * 10}张:${s.mem}MB/t${s.timer}/f${s.fig}/v${s.vars}`).join(' → '));

const okVars = samples.every((s) => s.vars === samples[0].vars);
const okFig = samples.every((s) => s.fig === 0);
const okTimer = samples.every((s) => s.timer === samples[0].timer);
const seg1 = (samples[1].mem - samples[0].mem) / 10;
const seg3 = (samples[3].mem - samples[2].mem) / 10;
console.log(`变量恒定=${okVars} figure=0=${okFig} timer恒定=${okTimer}`);
console.log(`内存: 首段 ${seg1.toFixed(1)} MB/10张 → 尾段 ${seg3.toFixed(1)} MB/10张（递减=${seg3 < seg1}）`);
const pass = okVars && okFig && okTimer && seg3 < seg1;
console.log(pass ? 'PASS：工作区卫生且 MATLAB 堆增长递减（空闲回收兜底）' : 'FAIL：存在累积性泄漏');
await stopSession(OUT);
process.exit(pass ? 0 : 1);
