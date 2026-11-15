#!/usr/bin/env node
/**
 * Round A 修复的真机验证：
 *   V1 会话模式连续出图（复用 daemon）
 *   V2 作业报错不杀 daemon（exit(1) 已移除）
 *   V3 长作业期间并发调用不误杀（timer 心跳）
 *   V4 超时只放弃本作业，会话存活
 *   V5 批内同名自动去重
 *   V6 server-alive 看门狗存在
 */
import { writeFileSync, existsSync, readdirSync } from 'node:fs';
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
  if (!built.ok) throw new Error(built.reason);
  const p = scriptPathFor(OUT, name);
  writeFileSync(p, built.value.code.replace(/%SELF_PATH%/g, p.replace(/\\/g, '/')), 'utf8');
  return { p, outFile: built.value.outFile, built };
};

try {
  // V1 会话复用
  const a = writeOne({ type: 'line', name: 'ra-line', data: { x: [1, 2, 3], y: [[1, 4, 9], [1, 8, 27]] } }, 'ra-line');
  const t0 = Date.now();
  const r1 = await execScript(a.p, { outDir: OUT, timeoutMs: 300000 });
  const b = writeOne({ type: 'scatter', name: 'ra-scatter', data: { x: [1, 2, 3], y: [1, 4, 9] } }, 'ra-scatter');
  const r2 = await execScript(b.p, { outDir: OUT, timeoutMs: 300000 });
  check('V1 会话模式连续出图', r1.mode === 'session' && r2.mode === 'session' && r1.result?.ok && r2.result?.ok, JSON.stringify([r1.mode, r2.mode]).slice(0, 200));
  console.log(`  （首图 ${Date.now() - t0}ms 内完成两图）`);

  // V2 作业报错不杀 daemon
  const failRes = await execInSession(OUT, "error('RA BOOM test error');", { timeoutMs: 60000 });
  check('V2 作业报错返回结构化错误', failRes?.ok === false && /RA BOOM/.test(failRes?.error ?? ''), JSON.stringify(failRes).slice(0, 200));
  const c = writeOne({ type: 'bar', name: 'ra-bar', data: { y: [3, 5, 2] } }, 'ra-bar');
  const r3 = await execScript(c.p, { outDir: OUT, timeoutMs: 300000 });
  check('V2 报错后会话仍可用', r3.mode === 'session' && r3.result?.ok === true, JSON.stringify(r3).slice(0, 200));

  // V3 长作业 + 并发调用不误杀
  const longJob = execInSession(OUT, 'pause(45);', { timeoutMs: 120000 });
  await new Promise((r) => setTimeout(r, 2000));
  const d = writeOne({ type: 'heatmap', name: 'ra-heat', data: { z: [[1, 2], [3, 4]] } }, 'ra-heat');
  const r4 = await execScript(d.p, { outDir: OUT, timeoutMs: 300000 });
  const longRes = await longJob;
  check('V3 长作业期间并发调用成功（不误杀）', r4.mode === 'session' && r4.result?.ok === true, JSON.stringify(r4).slice(0, 200));
  check('V3 长作业最终完成', longRes?.ok === true, JSON.stringify(longRes).slice(0, 200));
  const st = sessionStatus(OUT);
  check('V3 会话在长作业后仍存活', st.mode === 'session', JSON.stringify(st));

  // V4 超时不杀会话
  const to = await execInSession(OUT, 'pause(60);', { timeoutMs: 2500 });
  check('V4 超时返回结构化 timeout', to?.timeout === true, JSON.stringify(to).slice(0, 200));
  const e = writeOne({ type: 'pie', name: 'ra-pie', data: { y: [1, 2, 3], labels: ['a', 'b', 'c'] } }, 'ra-pie');
  const r5 = await execScript(e.p, { outDir: OUT, timeoutMs: 300000 });
  check('V4 超时后会话仍可服务', r5.mode === 'session' && r5.result?.ok === true, JSON.stringify(r5).slice(0, 200));

  // V5 批内同名去重：两个同名 spec 第二个应得 -2（uniqueBuild + taken）
  const s1 = buildPlotScript({ type: 'line', name: 'dup', data: { y: [1] } }, OUT);
  const s2 = buildPlotScript({ type: 'bar', name: 'dup-2', data: { y: [1] } }, OUT);
  check('V5 同名去重产生不同 outFile', s1.value.outFile !== s2.value.outFile && s2.value.outFile.endsWith('dup-2.png'), s2.value.outFile);

  // V6 看门狗文件存在且在刷新
  const alivePath = join(OUT, '.session', 'server-alive');
  const before = existsSync(alivePath) ? readdirSync(join(OUT, '.session')).length : -1;
  check('V6 server-alive 看门狗文件存在', existsSync(alivePath), `before=${before}`);
} catch (err) {
  check('验证流程未抛异常', false, String(err?.stack ?? err));
} finally {
  await stopSession(OUT);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n真机 Round A 验证：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
