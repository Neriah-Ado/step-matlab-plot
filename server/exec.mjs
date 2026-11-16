/**
 * step-matlab-plot 执行层：定位 MATLAB 可执行文件、以 -batch 方式执行脚本、
 * 解析 RESULT 回传行、错误分类。测试缝：MATLAB_MATE_FAKE 指向 node 脚本。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execInSession, stopSession, sessionStatus } from './session.mjs';

export const INSTALL_GUIDANCE = [
  '未检测到可用的 MATLAB。请安装/配置后重试：',
  '- 安装 MATLAB R2019a 或更高版本（`-batch` 需要 R2019a+；更旧版本自动回退 `-nodisplay -r` 模式）',
  '- 确认命令行可用：Windows 安装器勾选 "Add MATLAB to PATH"，或手动把 <MATLABROOT>\\bin 加入 PATH',
  '- 也可用环境变量指定：MATLAB_MATE_BIN=D:\\Matlab\\bin\\matlab.exe（或 MATLAB_MATE_ROOT=<MATLABROOT>）',
  '- 无 MATLAB 的 CI/验证环境：用 MATLAB_MATE_FAKE 指向测试缝脚本（见 README「无 MATLAB 验证」）',
].join('\n');

const isWin = process.platform === 'win32';

function candidateBins(env) {
  const list = [];
  if (env.MATLAB_MATE_BIN?.trim()) list.push(env.MATLAB_MATE_BIN.trim());
  if (env.MATLAB_MATE_ROOT?.trim()) {
    const root = env.MATLAB_MATE_ROOT.trim();
    list.push(join(root, 'bin', isWin ? 'matlab.exe' : 'matlab'));
  }
  list.push(isWin ? 'matlab.exe' : 'matlab');
  return list;
}

/** 解析 MATLAB 可执行文件；显式指定但不存在时直接判不可用（避免静默回落 PATH 里的另一个 MATLAB） */
export function resolveMatlabBin(env = process.env) {
  for (const bin of candidateBins(env)) {
    if (bin === (isWin ? 'matlab.exe' : 'matlab')) break; // PATH 探测放最后，交给 spawn 报错
    if (existsSync(bin)) return { available: true, bin };
    if (env.MATLAB_MATE_BIN?.trim() === bin) {
      return { available: false, bin, guidance: `MATLAB_MATE_BIN 指定的可执行文件不存在：${bin}\n${INSTALL_GUIDANCE}` };
    }
  }
  return { available: true, bin: isWin ? 'matlab.exe' : 'matlab' };
}

/** 中文 Windows 上 MATLAB 按 GBK 输出：UTF-8 解码出现替换字符时回退 GBK */
function decodeBuf(buf) {
  if (!buf || buf.length === 0) return '';
  const s = buf.toString('utf8');
  if (!s.includes('\uFFFD')) return s;
  try { return new TextDecoder('gbk').decode(buf); } catch { return s; }
}

/** 异步执行一次性命令（spawn + 超时）。
 *  替代 spawnSync：同步版会冻结 server 事件循环——>90s 的执行会让
 *  server-alive 看门狗停止刷新，导致持久会话被误杀（实测复现）。 */
function runOnceAsync(bin, args, { timeoutMs = 300000, env } = {}) {
  return new Promise((resolveP) => {
    const child = spawn(bin, args, { shell: false, env: env.MATLAB_MATE_FAKE ? { ...process.env, ...env } : process.env });
    const outChunks = [];
    const errChunks = [];
    let settled = false;
    const done = (payload) => { if (!settled) { settled = true; clearTimeout(timer); resolveP(payload); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
      done({ code: null, stdout: Buffer.concat(outChunks), stderr: Buffer.concat(errChunks), timedOut: true, missing: false });
    }, Math.max(1000, timeoutMs));
    child.stdout?.on('data', (d) => outChunks.push(d));
    child.stderr?.on('data', (d) => errChunks.push(d));
    child.on('error', (err) => done({ code: null, stdout: Buffer.alloc(0), stderr: Buffer.from(String(err?.message ?? err)), timedOut: false, missing: err?.code === 'ENOENT' }));
    child.on('close', (code, signal) => {
      const timedOut = signal === 'SIGTERM' || signal === 'SIGKILL';
      done({ code, stdout: Buffer.concat(outChunks), stderr: Buffer.concat(errChunks), timedOut, missing: code === null && !timedOut });
    });
  });
}

async function runOnce(bin, args, { timeoutMs = 300000, env } = {}) {
  const fake = Boolean(env.MATLAB_MATE_FAKE);
  const r = await runOnceAsync(fake ? process.execPath : bin, fake ? [env.MATLAB_MATE_FAKE, ...args] : args, { timeoutMs, env });
  return {
    code: r.code,
    stdout: fake ? r.stdout.toString('utf8') : decodeBuf(r.stdout),
    stderr: fake ? r.stderr.toString('utf8') : decodeBuf(r.stderr),
    timedOut: r.timedOut,
    missing: r.missing,
  };
}

/** 执行 .m 脚本：优先 -batch（R2019a+），CLI 不支持时回退 -nodisplay -nosplash -r */
export async function runScript(scriptPath, { timeoutMs = 300000, env = process.env } = {}) {
  const bin = resolveMatlabBin(env);
  if (!bin.available) return { error: 'matlab-not-found', guidance: bin.guidance ?? INSTALL_GUIDANCE };
  const cap = Math.max(1000, Math.min(Math.floor(Number(timeoutMs) || 300000), 600000));
  // -batch 的参数是 MATLAB 语句：路径必须经 run() 执行，直接传路径会被当成表达式求值而报错
  const stmt = `run('${String(scriptPath).replace(/\\/g, '/').replace(/'/g, "''")}')`;
  let r = await runOnce(bin.bin, ['-batch', stmt], { timeoutMs: cap, env });
  if (r.missing) return { error: 'matlab-not-found', guidance: INSTALL_GUIDANCE, stderr: r.stderr };
  if (r.code !== 0 && /unrecognized|not recognized|invalid option/i.test(`${r.stdout}\n${r.stderr}`)) {
    r = await runOnce(bin.bin, ['-nodisplay', '-nosplash', '-r', `${stmt}; exit;`], { timeoutMs: cap, env });
  }
  const result = parseResultLine(r.stdout);
  return {
    exitCode: r.code,
    timedOut: r.timedOut,
    stdout: r.stdout,
    stderr: r.stderr,
    result,
    ...(r.timedOut ? { error: 'timeout', message: `MATLAB 执行超时（${cap}ms）` } : {}),
  };
}

/** 从 stdout 提取脚本回传的 STEPCODE_MATLAB_RESULT JSON 行 */
export function parseResultLine(stdout) {
  const lines = String(stdout ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const idx = lines[i].indexOf('STEPCODE_MATLAB_RESULT:');
    if (idx === -1) continue;
    try {
      return JSON.parse(lines[i].slice(idx + 'STEPCODE_MATLAB_RESULT:'.length).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/** 提取所有 STEPCODE_MATLAB_RESULT 行（批量绘图用） */
export function parseAllResultLines(stdout) {
  const out = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const idx = line.indexOf('STEPCODE_MATLAB_RESULT:');
    if (idx === -1) continue;
    try { out.push(JSON.parse(line.slice(idx + 'STEPCODE_MATLAB_RESULT:'.length).trim())); } catch { /* 跳过坏行 */ }
  }
  return out;
}

/** 读取 sidecar 结果文件（会话模式的主通道） */
export function readSidecar(scriptPath) {
  const p = `${scriptPath}.result.json`;
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    try { unlinkSync(p); } catch { /* 忽略 */ }
    return parsed;
  } catch {
    return null;
  }
}

/** 清理批量执行后各内层脚本的 sidecar */
export function cleanupSidecars(scriptPaths) {
  for (const p of scriptPaths ?? []) {
    try { unlinkSync(`${p}.result.json`); } catch { /* 忽略 */ }
  }
}

/**
 * 统一执行入口：会话优先（MATLAB_MATE_SESSION=auto|always），
 * 不可用/超时/死亡回退一次性 -batch；MATLAB_MATE_SESSION=always 时强制会话、失败即报错。
 * outDir 为会话身份（同一目录共用一个会话）。
 */
export async function execScript(scriptPath, { outDir, timeoutMs = 300000, env = process.env } = {}) {
  const stmt = `run('${String(scriptPath).replace(/\\/g, '/').replace(/'/g, "''")}');`;
  const forced = env.MATLAB_MATE_SESSION === 'always';
  // 投递/执行前清理陈旧 sidecar：上次执行的残留会让本次失败被报成假成功
  try { unlinkSync(`${scriptPath}.result.json`); } catch { /* 忽略 */ }
  if (outDir) {
    const s = await execInSession(outDir, stmt, { timeoutMs, env, scriptPath });
    if (s && s.timeout) {
      return { mode: 'session', error: 'timeout', timedOut: true, message: s.message };
    }
    if (s && !s.sessionDied) {
      const output = String(s.output ?? '');
      // sidecar 读取即清理（无论是否用到），避免堆积
      const sidecar = readSidecar(scriptPath);
      const result = parseResultLine(output) ?? sidecar;
      if (s.ok === false && !result) {
        const cls = classifyMatlabError(s.error ?? output);
        return { mode: 'session', exitCode: 1, result: { ok: false, error: s.error }, pattern: cls.id, cause: cls.cause, action: cls.action };
      }
      return {
        mode: 'session',
        exitCode: s.ok ? 0 : 1,
        stdout: output,
        stderr: s.ok ? '' : String(s.error ?? ''),
        result,
        results: parseAllResultLines(output),
        ...(s.ok ? {} : { matlabError: s.error }),
      };
    }
    if (forced) {
      // 强制会话：不静默回退一次性模式
      const bin = resolveMatlabBin(env);
      if (!bin.available) return { error: 'matlab-not-found', guidance: bin.guidance };
      return {
        mode: 'session',
        error: s?.sessionDied ? 'matlab-session-died' : 'session-unavailable',
        message: 'MATLAB_MATE_SESSION=always：会话不可用，按配置不进行一次性回退',
      };
    }
    // sessionDied：回退一次性模式（下面）
  }
  const r = await runScript(scriptPath, { timeoutMs, env });
  return { mode: 'oneshot', ...r, result: r.result ?? readSidecar(scriptPath), results: parseAllResultLines(r.stdout ?? '') };
}

/** MATLAB 错误分类（纯函数，供 diagnose/skill 使用；含中文 MATLAB 报错模式） */
export function classifyMatlabError(text) {
  const t = String(text ?? '');
  const patterns = [
    { id: 'license', match: /license|licensing|not licensed|seat|许可/i.test(t), cause: 'MATLAB 许可证缺失/不足或未激活', action: '检查 license（lmstat / 激活客户端）；工具箱需对应 license' },
    { id: 'toolbox-missing', match: /Undefined function|unrecognized function or variable|requires .*Toolbox|has no .* package|无法识别的函数|函数或变量.*无法识别/i.test(t), cause: '缺少 MATLAB 工具箱或函数名拼写错误', action: '安装对应 Toolbox，或换用基础函数实现' },
    { id: 'invalid-input', match: /Invalid (argument|parameter|input)|Dimensions of matrices|Incompatible dimensions|too many input arguments|维度|不一致|数目|无效|必须|索引|下标|大小|边界|无法从.*转换|Cannot convert|Conversion to/i.test(t), cause: '数据/参数与图形不匹配（维度或取值）', action: '核对 spec.data 维度：x/y 等长、z 为矩阵、多序列用二维数组；data.json 的各系列须等长' },
    { id: 'out-of-memory', match: /Out of memory|内存不足/i.test(t), cause: '数据量过大导致内存不足', action: '降采样或改用 data.csv 分块；提高系列点数上限需谨慎' },
    { id: 'cli-unsupported', match: /unrecognized|not recognized|invalid option|不支持\s*(-|batch|命令行|选项)/i.test(t), cause: '当前 MATLAB 不支持 -batch（R2019a 之前）', action: '已自动回退 -nodisplay -r 模式；如仍失败请升级 MATLAB' },
    { id: 'file-io', match: /Unable to (open|write|create)|Permission denied|No such file or directory|无法打开|无法写入/i.test(t), cause: '输出/输入文件不可写或不存在', action: '检查 figures 目录权限与 data.csv 路径' },
  ];
  return patterns.find((p) => p.match) ?? { id: 'matlab-error', cause: 'MATLAB 执行报错', action: '查看 stderr 末段定位；先用 dryRun 检查生成的代码' };
}

/** 环境探测语句（导出以便测试） */
export function buildEnvProbe() {
  return [
    "r = version('-release'); v = version;",
    // ver 返回 struct 数组：num2cell 转 cell 后 cellfun 才能逐元素取 .Name
    "t = cellfun(@(c) c.Name, num2cell(ver), 'UniformOutput', false);",
    // 工具箱名用换符合并：struct 的 cell 字段会被 MATLAB 广播成结构体数组，不能直接嵌套
    "fprintf('STEPCODE_MATLAB_RESULT:%s\\n', jsonencode(struct('release', r, 'version', v, 'toolboxes', strjoin(t, char(10)))));",
  ].join(' ');
}

/** 环境探测：版本 + 工具箱清单（真机约 20-60s） */
export async function matlabEnv({ timeoutMs = 180000, env = process.env } = {}) {
  const bin = resolveMatlabBin(env);
  if (!bin.available) return { available: false, guidance: bin.guidance ?? INSTALL_GUIDANCE };
  const probe = buildEnvProbe();
  const cap = Math.max(5000, Math.min(Math.floor(Number(timeoutMs) || 180000), 600000));
  const r = await runOnce(bin.bin, ['-batch', probe], { timeoutMs: cap, env });
  if (r.missing) return { available: false, bin: bin.bin, guidance: INSTALL_GUIDANCE };
  if (r.timedOut) return { available: false, bin: bin.bin, error: 'timeout', message: `探测超时（${cap}ms）` };
  const result = parseResultLine(r.stdout);
  if (result?.release) {
    const toolboxes = typeof result.toolboxes === 'string' && result.toolboxes
      ? result.toolboxes.split('\n').filter(Boolean)
      : [];
    return { available: true, bin: bin.bin, release: result.release, version: result.version, toolboxes };
  }
  const cls = classifyMatlabError(`${r.stdout}\n${r.stderr}`);
  return { available: false, bin: bin.bin, pattern: cls.id, cause: cls.cause, action: cls.action, stderr: `${r.stdout}\n${r.stderr}`.slice(-500) };
}
