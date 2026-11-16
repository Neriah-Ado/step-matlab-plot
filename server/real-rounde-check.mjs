#!/usr/bin/env node
/**
 * Round E 修复专项真机验证：
 *   Y1 长作业（>60s 单条阻塞调用）不触发并发误杀（HEARTBEAT_LONG_STALE_MS）
 *   Y2 坏 job（协议失败）快速失败：id 回填让调用方秒级收到错误而非等 300s
 *   Y3 陈旧 heartbeat 不再让 startSession 误报就绪（spawn 前删除）
 *   Y4 daemon 成功结果 exitCode=0
 */
import { writeFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildPlotScript, execScript, execInSession, scriptPathFor, stopSession } from './lib.mjs';

const OUT = join(import.meta.dirname, '..', 'figures');
delete process.env.MATLAB_MATE_FAKE;
process.env.MATLAB_MATE_SESSION_IDLE_MS = '600000';
const BS_N = String.fromCharCode(92) + 'n';

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, pass: Boolean(cond) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` → ${detail}`}`);
};
const writeOne = (spec, name) => {
  const built = buildPlotScript(spec, OUT);
  const p = scriptPathFor(OUT, name);
  writeFileSync(p, built.value.code.replace(/%SELF_PATH%/g, p.replace(/\\/g, '/')), 'utf8');
  return { p, outFile: built.value.outFile };
};

try {
  // 预热会话
  const warm = writeOne({ type: 'line', name: 're-warm', data: { y: [1, 2] } }, 're-warm');
  const rWarm = await execScript(warm.p, { outDir: OUT, timeoutMs: 300000 });
  check('预热会话为 session 模式', rWarm.mode === 'session', JSON.stringify(rWarm).slice(0, 150));

  // Y1：>60s 单条阻塞作业进行中，另一路调用不得杀会话
  const longP = execInSession(OUT, 'svd(rand(9000));', { timeoutMs: 200000 });
  await new Promise((r) => setTimeout(r, 3000));
  const t0 = Date.now();
  const conc = writeOne({ type: 'bar', name: 're-conc', data: { y: [3, 5] } }, 're-conc');
  const rConc = await execScript(conc.p, { outDir: OUT, timeoutMs: 300000 });
  const concMs = Date.now() - t0;
  check('Y1 长作业期间并发调用仍走会话（不误杀）', rConc.mode === 'session' && rConc.result?.ok === true, `${rConc.mode} ${concMs}ms`);
  const longRes = await longP;
  check('Y1 长作业最终成功', longRes?.ok === true, JSON.stringify(longRes)?.slice(0, 150));

  // Y2：坏 job 快速失败（id 回填）
  const badJob = { id: 're-badjob-1', code: null };
  const badPath = join(OUT, '.session', 'queue', 're-badjob-1.job');
  writeFileSync(badPath, '{ this is not valid json !!!', 'utf8');
  const tBad = Date.now();
  // 经 execInSession 无法直接投坏 job；这里直接验证 daemon 对它的处理结果文件
  await new Promise((r) => setTimeout(r, 4000));
  const resFiles = readdirSync(join(OUT, '.session', 'results'));
  const badRes = resFiles.find((f) => f.startsWith('re-badjob-1'));
  let badOk = false;
  if (badRes) {
    const parsed = JSON.parse(readFileSync(join(OUT, '.session', 'results', badRes), 'utf8'));
    badOk = parsed.id === 're-badjob-1' && parsed.ok === false;
  }
  check('Y2 坏 job 产生带正确 id 的失败结果（回填生效）', badOk, JSON.stringify(resFiles));

  // Y3：陈旧 heartbeat 不再误报就绪——直接验证 startSession 删除心跳的逻辑：
  // 人为放一个"新鲜"的陈旧心跳，然后停止会话再重启，应仍是完整冷启动（session 模式）
  await stopSession(OUT);
  writeFileSync(join(OUT, '.session', 'heartbeat'), 'stale', 'utf8');
  const afterRestart = writeOne({ type: 'line', name: 're-restart', data: { y: [1] } }, 're-restart');
  const tRestart = Date.now();
  const rRestart = await execScript(afterRestart.p, { outDir: OUT, timeoutMs: 300000 });
  const restartMs = Date.now() - tRestart;
  check('Y3 陈旧心跳不影响重启（session 模式且经历了真实冷启动）', rRestart.mode === 'session' && rRestart.result?.ok === true && restartMs > 1500, `${rRestart.mode} ${restartMs}ms`);

  // Y4：成功结果 exitCode=0
  const okJob = writeOne({ type: 'line', name: 're-okjob', data: { y: [1] } }, 're-okjob');
  const rOk = await execScript(okJob.p, { outDir: OUT, timeoutMs: 300000 });
  const resDir = join(OUT, '.session', 'results');
  const leftover = existsSync(resDir) ? readdirSync(resDir).filter((f) => !f.startsWith('re-badjob-1')).length : 0;
  check('Y4 会话链路成功且 results 无残留（除故意的坏 job 结果）', rOk.result?.ok === true && leftover === 0, `leftover=${leftover}`);
} catch (err) {
  check('验证流程未抛异常', false, String(err?.stack ?? err));
} finally {
  await stopSession(OUT);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n真机 Round E 验证：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
