#!/usr/bin/env node
/** V1.0.3 准确性修复的视觉验证：白底/分类顺序/单点 marker，读回 PNG 亲眼检查 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPlotScript, execScript, scriptPathFor, stopSession } from './lib.mjs';

const OUT = join(import.meta.dirname, '..', 'figures');
delete process.env.MATLAB_MATE_FAKE;
const writeOne = (spec, name) => {
  const built = buildPlotScript(spec, OUT);
  const p = scriptPathFor(OUT, name);
  writeFileSync(p, built.value.code.replace(/%SELF_PATH%/g, p.replace(/\\/g, '/')), 'utf8');
  return { p, outFile: built.value.outFile };
};

// 1) 白底 + 分类顺序（甲乙丙）
const bar = writeOne({ type: 'bar', name: 'vis-order', title: '分类顺序与白底验证', data: { x: ['甲', '乙', '丙'], y: [3, 5, 2] } }, 'vis-order');
await execScript(bar.p, { outDir: OUT, timeoutMs: 300000 });
// 2) 单点 marker
const single = writeOne({ type: 'line', name: 'vis-single', title: '单点 marker 验证', data: { y: [5] } }, 'vis-single');
await execScript(single.p, { outDir: OUT, timeoutMs: 300000 });
// 3) 深色背景对照（直接给出图中心像素）
console.log('已生成：vis-order.png / vis-single.png');
await stopSession(OUT);
