#!/usr/bin/env node
/**
 * fake-matlab：step-matlab-plot 测试缝（对应 DOCKER_MATE_FAKE）。
 * 用法：MATLAB_MATE_FAKE=<本脚本> node server/index.mjs
 * 行为：
 *   -batch "cd(...); sessionDaemon(...)"  → 以 Node 模拟常驻 daemon（同协议：queue/results/heartbeat/stop）
 *   -batch <脚本路径> / run('...')         → 读头部注释里的 out= 路径，生成占位图并回传 RESULT 行
 *   -batch <代码>                          → 探测请求返回 canned 环境 JSON；否则回显执行标记
 *   -nodisplay ... -r                      → 同上（run('...') 形式）
 * 环境变量：
 *   FAKE_MATLAB_FAIL=1      模拟 MATLAB 执行失败
 *   FAKE_MATLAB_SLEEP_MS=N  模拟耗时（用于超时测试）
 *   FAKE_MATLAB_IDLE_MS=N   daemon 空闲退出时间（默认 5000，测试用可缩短）
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, readdirSync, statSync, renameSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makePng } from './png.mjs';

const args = process.argv.slice(2);
const flagIdx = args.findIndex((a) => a === '-batch' || a === '-r');
const payload = flagIdx >= 0 ? args[flagIdx + 1] : '';

function sleep(ms) {
  if (!ms || ms <= 0) return;
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy-wait：spawnSync 场景下可接受 */ }
}

function parseRunPath(code) {
  // 兼容两种形式：run('x.m') 与 run('x.m'); exit;
  const m = /^run\('(.+?)'\)(;\s*exit;?)?$/.exec(code.trim());
  return m ? m[1].replace(/''/g, "'") : null;
}

function emit(obj, exitCode = 0) {
  // 同步写 stdout：process.exit 不等管道 flush，异步 write 会丢输出
  writeSync(1, `STEPCODE_MATLAB_RESULT:${JSON.stringify(obj)}\n`);
  process.exit(exitCode);
}

/** daemon 模式：与 session.mjs 的 MATLAB daemon 同协议 */
function runDaemon(sessionDir, idleMsArg) {
  const queueDir = join(sessionDir, 'queue');
  const resultDir = join(sessionDir, 'results');
  mkdirSync(queueDir, { recursive: true });
  mkdirSync(resultDir, { recursive: true });
  const heartbeatFile = join(sessionDir, 'heartbeat');
  const stopFile = join(sessionDir, 'stop');
  if (existsSync(stopFile)) unlinkSync(stopFile);
  const idleMs = Number.isFinite(Number(idleMsArg)) && Number(idleMsArg) > 0
    ? Number(idleMsArg)
    : Number(process.env.FAKE_MATLAB_IDLE_MS || 5000);
  let lastActive = Date.now();
  const touch = () => writeFileSync(heartbeatFile, `${Date.now()}`);
  touch();
  const timer = setInterval(() => {
    touch();
    if (existsSync(stopFile)) {
      clearInterval(timer);
      try { unlinkSync(stopFile); } catch { /* 忽略 */ }
      process.exit(0);
    }
    let jobs = [];
    try { jobs = readdirSync(queueDir).filter((f) => f.endsWith('.job')); } catch { /* 忽略 */ }
    if (jobs.length === 0) {
      if (Date.now() - lastActive > idleMs) { clearInterval(timer); process.exit(0); }
      return;
    }
    const jobName = jobs.sort((a, b) => statSync(join(queueDir, a)).mtimeMs - statSync(join(queueDir, b)).mtimeMs)[0];
    const jobPath = join(queueDir, jobName);
    let job = {};
    let jobParseError = null;
    try { job = JSON.parse(readFileSync(jobPath, 'utf8')); } catch (err) { jobParseError = err; }
    // 与真机 daemon 契约一致：坏 job 用文件名 stem 回填 id，让调用方快速失败
    const jobId = job.id ?? jobName.replace(/\.job$/, '');
    sleep(Number(process.env.FAKE_MATLAB_SLEEP_MS || 0));
    const stem = jobName.replace(/\.job$/, '');
    if (process.env.FAKE_MATLAB_FAIL === '1') {
      writeResult(resultDir, stem, { id: jobId, ok: false, output: '', exitCode: 1, error: 'fake failure: 模拟 MATLAB 执行报错' });
      try { unlinkSync(jobPath); } catch { /* 忽略 */ }
      lastActive = Date.now();
      return;
    }
    // 坏 job（JSON 解析失败）：与真机 daemon 一样快速失败并回填 id
    if (jobParseError) {
      writeResult(resultDir, stem, { id: jobId, ok: false, output: '', exitCode: 1, error: `fake failure: job-protocol: ${jobParseError.message}` });
      try { unlinkSync(jobPath); } catch { /* 忽略 */ }
      lastActive = Date.now();
      return;
    }
    // 真实执行 job.code 里的 run('...')：逐脚本生成占位图与 RESULT 行（嵌套 run 递归展开）
    const outputLines = [];
    const expandRuns = (code, depth = 0) => {
      const paths = [];
      for (const m of String(code).matchAll(/run\('(.+?)'\)/g)) {
        const p = m[1];
        if (!existsSync(p)) {
          outputLines.push(`STEPCODE_MATLAB_RESULT:${JSON.stringify({ ok: false, error: `fake: 脚本不存在 ${p}`, identifier: 'MATLAB:fakeMissingScript' })}`);
          continue;
        }
        const content = readFileSync(p, 'utf8');
        if (depth < 3 && /run\('/.test(content)) paths.push(...expandRuns(content, depth + 1));
        else paths.push(p);
      }
      return paths;
    };
    for (const scriptPath of expandRuns(job.code)) {
      const header = readFileSync(scriptPath, 'utf8').split('\n')[0];
      const outM = /\bout=(\S+)/.exec(header);
      const fmtM = /\bfmt=(\S+)/.exec(header);
      const nameM = /\bname=(\S+)/.exec(header);
      const out = outM ? outM[1] : null;
      const fmt = fmtM ? fmtM[1] : 'png';
      if (out) {
        mkdirSync(dirname(out), { recursive: true });
        if (fmt === 'png' || fmt === 'jpg') writeFileSync(out, makePng(320, 240, [70, 130, 180]));
        else if (fmt === 'svg') writeFileSync(out, `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#4682b4"/></svg>`);
        else if (fmt === 'pdf') writeFileSync(out, '%PDF-1.4\n% fake-matlab placeholder\n%%EOF\n');
        else writeFileSync(out, `fake-matlab fig placeholder for ${nameM ? nameM[1] : 'figure'}`);
        // sidecar（与真实生成脚本契约一致）
        writeFileSync(`${scriptPath}.result.json`, JSON.stringify({ ok: true, type: 'fake', name: nameM ? nameM[1] : null, files: [out], bytes: statSync(out).size, analyzer: 0 }));
      }
      outputLines.push(`STEPCODE_MATLAB_RESULT:${JSON.stringify({ ok: true, type: 'fake', name: nameM ? nameM[1] : null, files: out ? [out] : [], bytes: out ? statSync(out).size : 0, analyzer: 0 })}`);
    }
    writeResult(resultDir, stem, { id: job.id, ok: true, output: `${outputLines.join('\n')}\n`, exitCode: 0, error: '' });
    try { unlinkSync(jobPath); } catch { /* 忽略 */ }
    lastActive = Date.now();
  }, 25);
  timer.unref();
  // 主循环保活
  setInterval(() => touch(), 25);
}

/** 与 MATLAB daemon 一致：tmp + rename 原子写结果 */
function writeResult(resultDir, stem, payload) {
  const tmp = join(resultDir, `${stem}.tmp`);
  const final = join(resultDir, `${stem}.res`);
  writeFileSync(tmp, JSON.stringify(payload), 'utf8');
  renameSync(tmp, final);
}

sleep(Number(process.env.FAKE_MATLAB_SLEEP_MS || 0));

const daemonM = /sessionDaemon\('([^']+)'(?:,\s*(\d+))?/.exec(payload ?? '');
if (daemonM) {
  runDaemon(daemonM[1].replace(/''/g, "'"), daemonM[2] ? Number(daemonM[2]) : undefined);
} else {
  oneShot(payload);
}

function oneShot(payload) {
  const scriptPath = payload.endsWith('.m') && existsSync(payload) ? payload : parseRunPath(payload ?? '');

  if (scriptPath && existsSync(scriptPath)) {
    if (process.env.FAKE_MATLAB_FAIL === '1') {
      emit({ ok: false, error: 'fake failure: 模拟 MATLAB 执行报错', identifier: 'MATLAB:fakeFail' }, 1);
    }
    const header = readFileSync(scriptPath, 'utf8').split('\n')[0];
    const outM = /\bout=(\S+)/.exec(header);
    const fmtM = /\bfmt=(\S+)/.exec(header);
    const nameM = /\bname=(\S+)/.exec(header);
    const out = outM ? outM[1] : null;
    const fmt = fmtM ? fmtM[1] : 'png';
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      if (fmt === 'png' || fmt === 'jpg') writeFileSync(out, makePng(320, 240, [70, 130, 180]));
      else if (fmt === 'svg') writeFileSync(out, `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#4682b4"/></svg>`);
      else if (fmt === 'pdf') writeFileSync(out, '%PDF-1.4\n% fake-matlab placeholder\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
      else writeFileSync(out, `fake-matlab fig placeholder for ${nameM ? nameM[1] : 'figure'}`);
    }
    emit({ ok: true, type: 'fake', name: nameM ? nameM[1] : null, files: out ? [out] : [] });
  }

  if (/STEPCODE_MATLAB_RESULT/.test(payload ?? '')) {
    // 与真实 MATLAB 契约一致：toolboxes 为换符合并的字符串（jsonencode 会转义为 \n）
    emit({ release: 'R2023b', version: '9.15.0.2100247', toolboxes: ['MATLAB', 'Statistics and Machine Learning Toolbox', 'Curve Fitting Toolbox'].join('\n') });
  }

  process.stdout.write(`[fake-matlab] executed: ${String(payload).slice(0, 200)}\n`);
}
