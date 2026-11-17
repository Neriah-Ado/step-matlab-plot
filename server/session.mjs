/**
 * step-matlab-plot 持久化 MATLAB 会话（效率核心）。
 *
 * 协议：server 写 queue/<id>.job（JSON {id, code}）
 *       → 常驻 MATLAB daemon 轮询执行，写 results/<id>.res（含 id，server 严格校验）
 *       → server 按 id 读取并删除。
 * 健康：heartbeat（daemon 循环 + 作业期间 timer 双通道刷新）；
 *       server-alive 看门狗文件（server 侧定时刷新，daemon 据此回收孤儿，防 host 强杀泄漏）。
 * 空闲：daemon 连续无作业 idleMs 后自行退出，下次调用重建。
 * 并发：同一 outDir 的启动做单飞（inflight promise）；spool 不做开服清空（避免删他人在途作业）。
 * 降级：MATLAB_MATE_SESSION=never 走一次性 -batch；会话起不来/进程死亡 → 回退一次性模式。
 * 测试缝：MATLAB_MATE_FAKE 时由 fake-matlab.mjs 以 Node 实现同一协议。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, readdirSync, renameSync, unlinkSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveMatlabBin } from './exec.mjs';

const HEARTBEAT_STALE_MS = 60000;     // 作业期间有 timer 刷新，阈值可放宽
const HEARTBEAT_LONG_STALE_MS = 300000; // 进程活着但心跳陈旧超过此值才判死（防 >60s 长作业被误杀）
const STARTUP_WAIT_MS = 150000;
const POLL_INTERVAL_MS = 20;
const RESULT_MAX_AGE_MS = 600000;     // 启动时清理 10 分钟前的孤儿结果文件（超时作业的产物）
const SCRIPT_TTL_MS = 3600000;        // 启动时清理 1 小时前的生成脚本（防 .scripts 无界增长）
const LOG_TTL_MS = 86400000;          // 启动时清理 1 天前的 daemon 日志
const DEFAULT_IDLE_MS = 300000;       // 默认空闲回收 5 min（重建成本实测 ~10s）
const SERVER_ALIVE_STALE_MS = 90000;  // daemon 侧看门狗：server-alive 超过此值即退出
const isWin = process.platform === 'win32';

function sessionDirs(outDir) {
  const base = join(outDir, '.session');
  return { base, queue: join(base, 'queue'), results: join(base, 'results'), scripts: join(base, 'scripts'), logs: join(base, 'logs') };
}

function ensureDirs(outDir) {
  const d = sessionDirs(outDir);
  for (const dir of [d.base, d.queue, d.results, d.scripts, d.logs]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  return d;
}

/** 会话 daemon（MATLAB 函数文件，随会话生成；文件名须与函数名一致）。
 *  局部变量一律 scp 前缀：run() 在调用方工作区执行脚本，daemon 的局部名
 *  会遮蔽同名 MATLAB 函数（曾因局部变量 stem 导致 stem 图 100% 失败）。 */
export function daemonSource() {
  return `function sessionDaemon(sessionDir, idleMs)
%STEPCODE-MATLAB-PLOT-SESSION-DAEMON v1.0.0
% 常驻作业循环：轮询 queue/*.job，执行后写 results/*.res。
% 心跳双通道：循环顶部 + 作业期间 timer；server-alive 看门狗防孤儿泄漏。
if nargin < 2 || ~isnumeric(idleMs) || ~isfinite(idleMs) || idleMs <= 0, idleMs = 600000; end
scpQueueDir = fullfile(sessionDir, 'queue');
scpResultDir = fullfile(sessionDir, 'results');
if ~isfolder(scpQueueDir), mkdir(scpQueueDir); end
if ~isfolder(scpResultDir), mkdir(scpResultDir); end
scpHbFile = fullfile(sessionDir, 'heartbeat');
scpStopFile = fullfile(sessionDir, 'stop');
scpAliveFile = fullfile(sessionDir, 'server-alive');
if exist(scpStopFile, 'file'), delete(scpStopFile); end
scpIdleLimit = idleMs / 1000;
scpLastActive = tic;
while true
  scpTouch(scpHbFile);
  if exist(scpStopFile, 'file'), break; end
  if exist(scpAliveFile, 'file')
    % 用 dir 的 datenum（MATLAB 本地时间基准）与 now 比较，避免跨系统时钟基准差异
    scpAliveInfo = dir(scpAliveFile);
    if ~isempty(scpAliveInfo)
      scpAliveAge = (now - scpAliveInfo(1).datenum) * 86400;
      if scpAliveAge > 90, break; end
    end
  end
  scpJobs = dir(fullfile(scpQueueDir, '*.job'));
  % 过滤目录：非空目录冒充 .job 会让 delete 失败→作业永不消失→daemon 忙转且合法作业饿死
  if ~isempty(scpJobs), scpJobs = scpJobs(~[scpJobs.isdir]); end
  if isempty(scpJobs)
    if toc(scpLastActive) > scpIdleLimit, break; end
    % 清理没有对应 job 的取消文件（兼容两种命名）
    scpCancels = dir(fullfile(scpQueueDir, '*.cancel'));
    for scpCi = 1:numel(scpCancels)
      scpCName = scpCancels(scpCi).name;
      if ~exist(fullfile(scpQueueDir, [scpCName(1:end-7) '.job']), 'file') && ...
         ~exist(fullfile(scpQueueDir, [scpCName(1:end-11) '.job']), 'file')
        delete(fullfile(scpQueueDir, scpCName));
      end
    end
    % 轮询退避：刚忙过用 30ms（低延迟），持续空闲用 250ms（省 CPU）
    if toc(scpLastActive) > 1, pause(0.25); else, pause(0.03); end
    continue;
  end
  [~, scpOrder] = sort([scpJobs.datenum]);
  scpOldest = scpJobs(scpOrder(1));
  scpStem = scpOldest.name(1:end-4);
  % 取消文件：客户端超时后可放弃排队中的作业。兼容 <id>.cancel 与 <id>.job.cancel 两种命名
  if exist(fullfile(scpQueueDir, [scpStem '.cancel']), 'file')
    delete(fullfile(scpQueueDir, scpOldest.name));
    delete(fullfile(scpQueueDir, [scpStem '.cancel']));
    continue;
  end
  if exist(fullfile(scpQueueDir, [scpStem '.job.cancel']), 'file')
    delete(fullfile(scpQueueDir, scpOldest.name));
    delete(fullfile(scpQueueDir, [scpStem '.job.cancel']));
    continue;
  end
  % 作业认领：取走时改名为 <id>.run。server 的 sessionDied 路径据此判断
  % 作业是否可能已执行，避免盲目重试造成双重执行。
  scpClaimed = fullfile(scpOldest.folder, [scpStem '.run']);
  try
    movefile(fullfile(scpOldest.folder, scpOldest.name), scpClaimed, 'f');
  catch
    scpClaimed = fullfile(scpOldest.folder, scpOldest.name);
  end
  scpProcessJob(scpClaimed, scpResultDir, sessionDir);
  scpLastActive = tic;
  % 作业分支也退避：避免毒化场景下的 100% 忙转
  pause(0.03);
end
end

function scpTouch(filePath)
scpFid = fopen(filePath, 'w'); fclose(scpFid);
end

function scpProcessJob(jobPath, resultDir, sessionDir)
% 作业整体容错：任何失败都写成结果文件，绝不让 daemon 崩溃
[~, scpStem] = fileparts(jobPath);
scpOut = '';
scpErr = '';
scpOk = true;
scpCode = 0;
scpId = '';
try
  scpPayload = jsondecode(fileread(jobPath));
  scpId = char(string(scpPayload.id));
catch scpErrInfo
  scpOk = false;
  scpCode = 1;
  scpErr = ['job-protocol: ' scpErrInfo.message];
  % 协议失败（坏 JSON/读不到）时用文件名 stem 回填 id：server 严格按 id 匹配，
  % 空 id 会让调用方白等整个超时；stem 即作业 id，回填后可快速失败
  if isempty(scpId), scpId = scpStem; end
end
if scpOk
  try
    % 作业期间用 timer 持续刷心跳，避免 server 误判会话已死
    scpHbTimer = timer('Period', 1, 'ExecutionMode', 'fixedSpacing', ...
      'TimerFcn', @(~, ~) scpTouch(fullfile(sessionDir, 'heartbeat')));
    start(scpHbTimer);
    try
      % clear functions：MATLAB 会缓存已解析脚本，同名脚本被改写后
      % run() 仍执行旧内容（同名重画会静默返回旧图）
      clear functions;
      scpOut = evalc(scpPayload.code);
    catch scpErrInfo
      scpOk = false;
      scpCode = 1;
      scpErr = scpErrInfo.message;
    end
    stop(scpHbTimer); delete(scpHbTimer);
  catch scpErrInfo
    scpOk = false;
    scpCode = 1;
    scpErr = ['job-protocol: ' scpErrInfo.message];
  end
end
scpResult = struct('id', scpId, 'ok', scpOk, 'output', scpOut, ...
  'exitCode', scpCode, 'error', scpErr);
scpTmp = fullfile(resultDir, [scpStem '.tmp']);
scpFid = fopen(scpTmp, 'w');
fwrite(scpFid, jsonencode(scpResult), 'char');
fclose(scpFid);
movefile(scpTmp, fullfile(resultDir, [scpStem '.res']), 'f');
try, if exist(jobPath, 'file'), delete(jobPath); end, catch, end
% 函数返回前显式清理工作区：evalc 执行的脚本变量（yData/figHandle 等）虽为局部量，
% 显式 clear 可促使 MATLAB 立即归还内存，抑制 daemon 常驻内存随作业数增长（实测 ~3.3MB/作业）
clear variables;
end
`;
}

const sessions = new Map();   // outDir -> state
const inflight = new Map();   // outDir -> Promise（启动单飞）

function heartbeatAge(dirs) {
  try {
    return Date.now() - statSync(join(dirs.base, 'heartbeat')).mtimeMs;
  } catch {
    return Infinity;
  }
}

function procAlive(state) {
  return Boolean(state?.proc) && !state.dead && state.proc.exitCode === null;
}

/** 清理过期产物：10 分钟前的孤儿结果、1 小时前的生成脚本、1 天前的日志。
 *  不动 queue：在途作业应由新 daemon 继续执行（或被 cancel 文件跳过）。 */
function sweepStale(dirs) {
  const sweepDir = (dir, ttl, exts) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (exts && !exts.some((e) => f.endsWith(e))) continue;
      try {
        if (statSync(join(dir, f)).mtimeMs < Date.now() - ttl) unlinkSync(join(dir, f));
      } catch { /* 忽略 */ }
    }
  };
  sweepDir(dirs.results, RESULT_MAX_AGE_MS, ['.res']);
  sweepDir(dirs.scripts, SCRIPT_TTL_MS, ['.m']);
  sweepDir(dirs.logs, LOG_TTL_MS, ['.log']);
}

function stateFromProc(proc, outDir, dirs, logFile, fake) {
  const state = { proc, dirs, outDir, logFile, fake, seq: 0, dead: false };
  const append = (chunk) => {
    try { appendFileSync(logFile, String(chunk)); } catch { /* 忽略 */ }
  };
  proc.stdout?.on('data', append);
  proc.stderr?.on('data', append);
  proc.on('exit', (code) => { state.dead = true; state.exitCode = code; });
  proc.on('error', () => { state.dead = true; });
  sessions.set(outDir, state);
  return state;
}

/** 杀进程树（Windows 上 matlab.exe 只是启动器，MATLAB.exe worker 是孙进程） */
function killTree(proc) {
  if (!proc?.pid) return;
  if (isWin) {
    try {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    } catch { /* 落到信号 */ }
  }
  try { proc.kill('SIGTERM'); } catch { /* 忽略 */ }
  try { proc.kill('SIGKILL'); } catch { /* 忽略 */ }
}

async function startSession(outDir, env) {
  const dirs = ensureDirs(outDir);
  sweepStale(dirs);
  const bin = resolveMatlabBin(env);
  const idleMs = Number.isFinite(Number(env.MATLAB_MATE_SESSION_IDLE_MS)) && Number(env.MATLAB_MATE_SESSION_IDLE_MS) > 0
    ? Math.floor(Number(env.MATLAB_MATE_SESSION_IDLE_MS))
    : DEFAULT_IDLE_MS;
  const logFile = join(dirs.logs, `daemon-${process.pid}.log`);

  // spawn 的 ENOENT 会触发 proc 'error' 事件，由下方赛跑逻辑秒级失败，无需额外探测
  // 先刷新 server-alive：否则上一次会话留下的陈旧文件（>90s）会让新 daemon
  // 首个循环就判定"server 已死"而自杀，静默回落一次性模式。
  // 同时删掉陈旧 heartbeat：否则残留心跳（<60s）会让 startSession 在 daemon
  // 还没起来时就误报"会话已就绪"（孤儿 daemon 也会被新 server 误领养）。
  try { writeFileSync(join(dirs.base, 'server-alive'), `${Date.now()}`); } catch { /* 忽略 */ }
  try { unlinkSync(join(dirs.base, 'heartbeat')); } catch { /* 忽略 */ }
  writeFileSync(join(dirs.scripts, 'sessionDaemon.m'), daemonSource(), 'utf8');
  try { unlinkSync(join(dirs.base, 'stop')); } catch { /* 忽略 */ }

  const stmt = `cd('${dirs.scripts.replace(/\\/g, '/').replace(/'/g, "''")}'); sessionDaemon('${dirs.base.replace(/\\/g, '/').replace(/'/g, "''")}', ${idleMs});`;
  const proc = env.MATLAB_MATE_FAKE
    ? spawn(process.execPath, [env.MATLAB_MATE_FAKE, '-batch', stmt], { stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(bin.bin, ['-batch', stmt], { stdio: ['ignore', 'pipe', 'pipe'] });
  const state = stateFromProc(proc, outDir, dirs, logFile, Boolean(env.MATLAB_MATE_FAKE));

  // 与"进程提前退出/启动错误"赛跑：MATLAB 缺失或起不来时秒级失败
  const exited = new Promise((resolveP) => {
    proc.on('exit', () => resolveP('exited'));
    proc.on('error', () => resolveP('error'));
  });
  // 慢启动保护：等待期间持续刷新 server-alive，避免 daemon 就绪前被 90s 看门狗判死
  const keepAlive = setInterval(() => {
    try { writeFileSync(join(dirs.base, 'server-alive'), `${Date.now()}`); } catch { /* 忽略 */ }
  }, 10000);
  const deadline = Date.now() + STARTUP_WAIT_MS;
  while (Date.now() < deadline) {
    if (heartbeatAge(dirs) < HEARTBEAT_STALE_MS) {
      clearInterval(keepAlive);
      startAliveWatchdog(outDir);
      return { mode: 'session', state };
    }
    const race = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 100))]);
    if (race) {
      clearInterval(keepAlive);
      killTree(proc);
      sessions.delete(outDir);
      return { mode: 'oneshot', reason: race === 'error' ? 'spawn-failed' : 'session-exited-early' };
    }
  }
  clearInterval(keepAlive);
  killTree(proc);
  sessions.delete(outDir);
  return { mode: 'oneshot', reason: 'session-start-timeout' };
}

// server-alive 看门狗：有会话期间每 10s 刷新；server 被强杀后 daemon 90s 内自行退出
const aliveTimers = new Map();
function startAliveWatchdog(outDir) {
  if (aliveTimers.has(outDir)) return;
  const dirs = sessionDirs(outDir);
  const touch = () => {
    const state = sessions.get(outDir);
    // daemon 已死（空闲自退/被杀）时顺带停掉定时器，避免空转到 server 退出
    if (state && !procAlive(state)) { stopAliveWatchdog(outDir); return; }
    try { writeFileSync(join(dirs.base, 'server-alive'), `${Date.now()}`); } catch { /* 忽略 */ }
  };
  touch();
  const timer = setInterval(touch, 10000);
  timer.unref();
  aliveTimers.set(outDir, timer);
}
function stopAliveWatchdog(outDir) {
  const timer = aliveTimers.get(outDir);
  if (timer) clearInterval(timer);
  aliveTimers.delete(outDir);
  // 不删除 server-alive：保留陈旧文件，让 daemon 的 90s 看门狗在异常路径
  // （stop 文件未生效/进程被硬杀）下仍能回收孤儿。下次起会话会由 startAliveWatchdog 覆写。
}

async function ensureSession(outDir, env) {
  // 单飞前置：有在途启动先等待，绝不能在此之间 stopSession（会杀掉刚拉起的 daemon）
  const pending = inflight.get(outDir);
  if (pending) {
    const started = await pending;
    return started.mode === 'session' ? started.state : null;
  }
  let state = sessions.get(outDir);
  // 判活：进程活着且心跳未严重陈旧 → 复用（含 >60s 长作业期间，timer 被内置调用阻断的情况）；
  // 进程已死 / 心跳陈旧超过长作业阈值 → 清理后重建
  if (state && procAlive(state) && heartbeatAge(state.dirs) < HEARTBEAT_LONG_STALE_MS) return state;
  // 单飞覆盖「清理 + 启动」整段：两路并发发现死会话时，各自 stopSession+startSession
  // 会拉起多个 daemon（实测 3 个）；把整段纳入同一个 in-flight promise 即可消除
  const p = (async () => {
    const cur = sessions.get(outDir);
    if (cur) await stopSession(outDir);
    return startSession(outDir, env);
  })().finally(() => inflight.delete(outDir));
  inflight.set(outDir, p);
  const started = await p;
  return started.mode === 'session' ? started.state : null;
}

/** 在会话中执行代码；会话不可用返回 null（调用方走一次性模式）。
 *  options.scriptPath：被执行的 .m 路径，用于投递前清理其陈旧 sidecar。 */
export async function execInSession(outDir, code, { timeoutMs = 300000, env = process.env, scriptPath } = {}) {
  const mode = env.MATLAB_MATE_SESSION ?? 'auto';
  if (mode === 'never') return null;

  const state = await ensureSession(outDir, env);
  if (!state) return null;
  const dirs = state.dirs;
  const id = `j${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const jobPath = join(dirs.queue, `${id}.job`);
  const resPath = join(dirs.results, `${id}.res`);
  const tmpPath = `${jobPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify({ id, code }), 'utf8');
  renameSync(tmpPath, jobPath);
  // 投递前删掉本脚本的陈旧 sidecar：上次执行的残留结果会被本次冒领
  // （预置 sidecar 曾让失败作业被报成 ok:true 的假成功）
  try { unlinkSync(`${scriptPath}.result.json`); } catch { /* 忽略 */ }
  const cap = Math.max(1000, Math.min(Number(timeoutMs) || 300000, 600000));
  const deadline = Date.now() + cap;
  while (Date.now() < deadline) {
    if (existsSync(resPath)) {
      let parsed = null;
      try { parsed = JSON.parse(readFileSync(resPath, 'utf8')); } catch { parsed = null; }
      if (parsed && parsed.id === id) {
        try { unlinkSync(resPath); } catch { /* 忽略 */ }
        return parsed;
      }
      // 不是本作业的结果（投毒/串话）：保留文件不动，继续等
    }
    if (!procAlive(state)) {
      // 认领标记在（<id>.run）→ 作业已被 daemon 取走，可能已执行：
      // 不删不改不重试，返回可区分错误让调用方决策（防双重执行）
      const claimed = existsSync(join(dirs.queue, id + '.run'));
      try { unlinkSync(jobPath); } catch { /* 已被取走 */ }
      // 认领标记（<id>.run）在原 daemon 死后无人回收：此处安全删除，防泄漏
      if (claimed) { try { unlinkSync(join(dirs.queue, id + '.run')); } catch { /* 忽略 */ } }
      // 代际保护：仅当 Map 里仍是自己这一代才清理——否则 12ms 前刚由别的
      // 调用拉起的新 daemon 会被连带杀掉（两路都回落一次性，双倍冷启动）
      if (sessions.get(outDir) === state) await stopSession(outDir);
      return claimed
        ? { sessionDied: true, mayHaveExecuted: true, error: 'matlab-session-died-after-claim' }
        : { sessionDied: true, error: 'matlab-session-died' };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  // 超时：只放弃本次作业（删 job + 写 cancel 让 daemon 跳过排队中的它），
  // 不杀共享会话——daemon 若已在执行则会跑完写结果，无人领取由 sweep 清理
  try { unlinkSync(jobPath); } catch { /* 已被取走 */ }
  try { writeFileSync(join(dirs.queue, id + '.cancel'), 'cancel', 'utf8'); } catch { /* 忽略 */ }
  return { timeout: true, error: 'timeout', message: `会话作业超时（${cap}ms）`, jobPath };
}

/** 停止会话（stop 文件 + 杀进程树） */
export async function stopSession(outDir) {
  const state = sessions.get(outDir);
  stopAliveWatchdog(outDir);
  if (!state) return;
  sessions.delete(outDir);
  try { writeFileSync(join(state.dirs.base, 'stop'), 'stop', 'utf8'); } catch { /* 忽略 */ }
  await new Promise((r) => setTimeout(r, 150));
  killTree(state.proc);
}

export function sessionStatus(outDir) {
  const state = sessions.get(outDir);
  if (!state) return { mode: 'none' };
  return { mode: procAlive(state) ? 'session' : 'dead', outDir, heartbeatAgeMs: heartbeatAge(state.dirs), pid: state.proc?.pid ?? null };
}

/** 测试辅助：清空会话状态与 spool */
export async function resetSessions() {
  for (const outDir of [...sessions.keys()]) await stopSession(outDir);
  sessions.clear();
}

/** 同步停止全部会话（供 process 'exit' 句柄使用：async 句柄里 await 之后不执行） */
export function stopAllSessionsSync() {
  for (const outDir of [...sessions.keys()]) {
    stopAliveWatchdog(outDir);
    const state = sessions.get(outDir);
    try { writeFileSync(join(sessionDirs(outDir).base, 'stop'), 'stop', 'utf8'); } catch { /* 忽略 */ }
    killTree(state?.proc);
  }
  sessions.clear();
}
