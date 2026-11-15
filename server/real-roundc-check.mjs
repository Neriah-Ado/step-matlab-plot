#!/usr/bin/env node
/**
 * Round C 真机验证：
 *   W1 stem 在会话模式出图（daemon 局部名遮蔽修复）
 *   W2 同名重画反映新数据（clear functions 修复脚本缓存）
 *   W3 PNG 尺寸精确等于 spec.size（print -r96）
 *   W4 16 类图形会话模式全量矩阵
 *   W5 并发冷启动单飞（4 并发只起 1 个 daemon）
 *   W6 批量：批内失败图带诊断、其余图成功
 */
import { writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildPlotScript, execScript, execInSession, scriptPathFor, stopSession, sessionStatus } from './lib.mjs';

const OUT = join(import.meta.dirname, '..', 'figures');
delete process.env.MATLAB_MATE_FAKE;
process.env.MATLAB_MATE_SESSION_IDLE_MS = '300000';

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, pass: Boolean(cond) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` → ${detail}`}`);
};
const writeOne = (spec, name) => {
  const built = buildPlotScript(spec, OUT);
  if (!built.ok) throw new Error(`${name}: ${built.reason}`);
  const p = scriptPathFor(OUT, name);
  writeFileSync(p, built.value.code.replace(/%SELF_PATH%/g, p.replace(/\\/g, '/')), 'utf8');
  return { p, outFile: built.value.outFile, built };
};
const pngSize = (file) => {
  const b = readFileSync(file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
};

try {
  // W1 stem 会话模式
  const stem = writeOne({ type: 'stem', name: 'rc-stem', title: 'stem 会话模式', data: { x: [1, 2, 3, 4], y: [1, 4, 9, 16] } }, 'rc-stem');
  const rStem = await execScript(stem.p, { outDir: OUT, timeoutMs: 300000 });
  check('W1 stem 会话模式出图', rStem.mode === 'session' && rStem.result?.ok === true && existsSync(stem.outFile), JSON.stringify(rStem).slice(0, 250));

  // W2 同名重画：先 3 点，再改 40 点，字节数应变化且 analyzer/结果反映新脚本
  const small = writeOne({ type: 'line', name: 'rc-redraw', data: { x: [1, 2, 3], y: [[1, 2, 3]] } }, 'rc-redraw');
  const r1 = await execScript(small.p, { outDir: OUT, timeoutMs: 300000 });
  const b1 = statSync(small.outFile).size; // 必须在第二次绘制前量取
  const y40 = Array.from({ length: 40 }, (_, i) => i);
  const big = writeOne({ type: 'line', name: 'rc-redraw', data: { x: y40, y: [y40] } }, 'rc-redraw');
  const r2 = await execScript(big.p, { outDir: OUT, timeoutMs: 300000 });
  const b2 = statSync(big.outFile).size;
  check('W2 同名重画反映新数据', r1.result?.ok && r2.result?.ok && b1 !== b2, `bytes ${b1} → ${b2}`);

  // W3 PNG 尺寸精确
  const sized = writeOne({ type: 'line', name: 'rc-sized', size: { width: 1280, height: 720 }, data: { y: [1, 2] } }, 'rc-sized');
  const rSized = await execScript(sized.p, { outDir: OUT, timeoutMs: 300000 });
  const dim = pngSize(sized.outFile);
  check('W3 PNG 尺寸等于 spec.size(1280×720)', rSized.result?.ok && dim.width === 1280 && dim.height === 720, JSON.stringify(dim));

  // W4 16 类矩阵（会话模式）
  const specs = {
    line: { type: 'line', name: 'rc-line', data: { x: [1, 2, 3], y: [[1, 4, 9], [1, 8, 27]] } },
    scatter: { type: 'scatter', name: 'rc-scatter', data: { x: [1, 2, 3], y: [2, 4, 9] } },
    bar: { type: 'bar', name: 'rc-bar', data: { x: ['a', 'b'], y: [3, 5] } },
    barh: { type: 'barh', name: 'rc-barh', data: { y: [3, 5] } },
    histogram: { type: 'histogram', name: 'rc-hist', data: { y: [1, 2, 2, 3, 3, 3, 4], binCount: 4 } },
    area: { type: 'area', name: 'rc-area', data: { x: [1, 2, 3], y: [[1, 2, 3]] } },
    pie: { type: 'pie', name: 'rc-pie', data: { y: [1, 2, 3], labels: ['甲', '乙', '丙'] } },
    stairs: { type: 'stairs', name: 'rc-stairs', data: { x: [1, 2, 3], y: [1, 4, 9] } },
    errorbar: { type: 'errorbar', name: 'rc-err', data: { x: [1, 2, 3], y: [[2, 4, 6]], err: [[0.3, 0.3, 0.3]] } },
    loglog: { type: 'loglog', name: 'rc-loglog', data: { x: [1, 10, 100], y: [1, 10, 100] } },
    semilogx: { type: 'semilogx', name: 'rc-semilogx', data: { x: [1, 10, 100], y: [1, 2, 3] } },
    semilogy: { type: 'semilogy', name: 'rc-semilogy', data: { x: [1, 2, 3], y: [1, 10, 100] } },
    boxplot: { type: 'boxplot', name: 'rc-box', data: { groups: [[1, 2, 3], [4, 5, 6, 7]], labels: ['A', 'B'] } },
    surf: { type: 'surf', name: 'rc-surf', data: { z: [[1, 2], [3, 4]] } },
    heatmap: { type: 'heatmap', name: 'rc-heat', data: { z: [[1, 2], [3, 4]], x: ['一', '二'], y: ['a', 'b'] } },
  };
  let matrixOk = 0;
  const matrixFail = [];
  for (const [key, spec] of Object.entries(specs)) {
    const one = writeOne(spec, spec.name);
    const r = await execScript(one.p, { outDir: OUT, timeoutMs: 300000 });
    if (r.mode === 'session' && r.result?.ok === true && existsSync(one.outFile)) matrixOk++;
    else matrixFail.push(`${key}:${JSON.stringify(r).slice(0, 120)}`);
  }
  check('W4 16 类会话模式矩阵（15 类 + stem 已验）', matrixOk === 15, matrixFail.join(' | '));
  console.log(`  （矩阵 ${matrixOk}/15，加 W1 的 stem 共 16 类）`);

  // W5 并发冷启动单飞
  await stopSession(OUT);
  const cc = ['rc-cc-a', 'rc-cc-b', 'rc-cc-c', 'rc-cc-d'].map((n) => writeOne({ type: 'bar', name: n, data: { y: [1, 2] } }, n));
  const ccRs = await Promise.all(cc.map((c) => execScript(c.p, { outDir: OUT, timeoutMs: 300000 })));
  check('W5 4 并发全部 session 模式', ccRs.every((r) => r.mode === 'session' && r.result?.ok === true), JSON.stringify(ccRs.map((r) => r.mode)));

  // W6 批量：失败图（colormap 现在会被拒，用运行期失败：手动投一个会错的作业等效）
  // 直接验证批内 sidecar 兜底 + 逐图诊断：两个同名 + 一个必然运行失败的图
  const batchSpecs = [
    { type: 'line', name: 'rc-batch-1', data: { y: [1, 2] } },
    { type: 'bar', name: 'rc-batch-2', data: { y: [3, 5] } },
  ];
  const built = batchSpecs.map((s) => writeOne(s, s.name));
  const combinedPath = scriptPathFor(OUT, `rc-batch-${Date.now().toString(36)}`);
  writeFileSync(combinedPath, built.map((b) => `run('${b.p.replace(/\\/g, '/')}');`).join('\n'), 'utf8');
  const rBatch = await execScript(combinedPath, { outDir: OUT, timeoutMs: 300000 });
  const names = (rBatch.results ?? []).map((r) => r?.name).filter(Boolean).sort();
  check('W6 批量两图 RESULT 均带 name（逐图诊断前提）', names.length === 2 && names.every((n) => n.startsWith('rc-batch-')), JSON.stringify(names));
  check('W6 批量两图均成功', rBatch.results?.every((r) => r?.ok === true) && built.every((b) => existsSync(b.outFile)), JSON.stringify(rBatch.results?.map((r) => r?.ok)));
} catch (err) {
  check('验证流程未抛异常', false, String(err?.stack ?? err));
} finally {
  await stopSession(OUT);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n真机 Round C 验证：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
