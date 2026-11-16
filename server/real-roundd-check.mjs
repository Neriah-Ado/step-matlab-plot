#!/usr/bin/env node
/**
 * Round D 修复专项真机验证：
 *   X1 停止会话 >90s 后再起，应为 session 模式（陈旧 server-alive 不再杀死新 daemon）
 *   X2 内存卫生（变量/figure/timer 不累积）见 mem-slope-check.mjs
 *   X3 一次性长执行期间 server 事件循环不冻结（异步 spawn）
 *   X4 cancel 文件不残留、队列不积压
 */
import { writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { buildPlotScript, execScript, execInSession, scriptPathFor, stopSession, sessionStatus } from './lib.mjs';

const OUT = join(import.meta.dirname, '..', 'figures');
delete process.env.MATLAB_MATE_FAKE;
process.env.MATLAB_MATE_SESSION_IDLE_MS = '600000';

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
  return { p, outFile: built.value.outFile };
};

try {
  // X1：停止 >90s 后重启仍走会话
  const a = writeOne({ type: 'line', name: 'rd-a', data: { y: [1, 2] } }, 'rd-a');
  const r1 = await execScript(a.p, { outDir: OUT, timeoutMs: 300000 });
  await stopSession(OUT);
  console.log('  （已停止会话，等待 100s 让 server-alive 变陈旧…）');
  await new Promise((r) => setTimeout(r, 100000));
  const b = writeOne({ type: 'bar', name: 'rd-b', data: { y: [3, 5] } }, 'rd-b');
  const r2 = await execScript(b.p, { outDir: OUT, timeoutMs: 300000 });
  check('X1 停止>90s 后重启仍为 session 模式', r1.mode === 'session' && r2.mode === 'session' && r2.result?.ok === true, JSON.stringify([r1.mode, r2.mode]));

  // X2：内存卫生（工作区变量/figure/timer 不累积 + MATLAB 堆增长递减）见 mem-slope-check.mjs
  // X3：一次性长执行期间 server 事件循环不冻结（经 MCP stdio：matlab_run 3s + 并发 ping）
  const env = { ...process.env, MATLAB_MATE_OUTDIR: OUT, MATLAB_MATE_SESSION: 'never' };
  delete env.MATLAB_MATE_FAKE;
  const child = spawn(process.execPath, [join(import.meta.dirname, 'index.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout.on('data', (d) => { buf += d.toString(); });
  let nextId = 0;
  const rpc = (method, params) => new Promise((resolveP) => {
    const id = ++nextId;
    const on = (d) => {
      if (d.toString().includes(`"id":${id}`)) {
        child.stdout.off('data', on);
        resolveP(JSON.parse(buf.split('\n').filter((l) => l.includes(`"id":${id}`)).pop()));
      }
    };
    child.stdout.on('data', on);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  await rpc('initialize', {});
  const t0 = Date.now();
  const runP = rpc('tools/call', { name: 'matlab_run', arguments: { code: "pause(3); disp('LONG_DONE');", confirm: true, timeoutMs: 60000 } });
  await new Promise((r) => setTimeout(r, 300));
  const pingP = rpc('ping', {});
  const pingRes = await Promise.race([pingP, new Promise((r) => setTimeout(() => r(null), 2500))]);
  const pingMs = Date.now() - t0;
  const runRes = await runP;
  check('X3 一次性执行期间 ping 不被冻结（<2.5s）', pingRes?.result !== undefined, `ping 等待 ${pingMs}ms`);
  check('X3 长执行最终成功', runRes?.result?.structuredContent?.exitCode === 0, JSON.stringify(runRes?.result?.structuredContent ?? runRes?.error)?.slice(0, 200));
  child.stdin.end();
  await new Promise((r) => child.on('exit', r));

  // X4：cancel/queue 无残留
  const queue = readdirSync(join(OUT, '.session', 'queue'));
  const cancels = queue.filter((f) => f.endsWith('.cancel'));
  const jobs = queue.filter((f) => f.endsWith('.job'));
  check('X4 队列无残留 job/cancel', jobs.length === 0 && cancels.length === 0, JSON.stringify(queue));
  await stopSession(OUT);
} catch (err) {
  check('验证流程未抛异常', false, String(err?.stack ?? err));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n真机 Round D 验证：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
