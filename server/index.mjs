#!/usr/bin/env node
/**
 * step-matlab-plot MCP server v1.0.0（stdio JSON-RPC，零依赖；协议与 @modelcontextprotocol/sdk 兼容）。
 * 工具：matlab_env / matlab_plot_types / matlab_plot / matlab_plot_many / matlab_run / matlab_figure_ls / matlab_figure_read。
 * 安全：matlab_run 默认 dry-run，confirm=true 才执行（G3）；图表名/路径白名单（C-05）；
 *       长输出尾截断（C5）；MATLAB 缺失给安装指引。
 * 环境变量：MATLAB_MATE_BIN / MATLAB_MATE_ROOT / MATLAB_MATE_OUTDIR / MATLAB_MATE_FAKE（测试缝）。
 */
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLOT_TYPES, buildPlotScript, validateSpec,
  INSTALL_GUIDANCE, matlabEnv, runScript, execScript, cleanupSidecars, readSidecar, classifyMatlabError,
  ensureDir, scriptPathFor, listFigures, readFigure,
  resolveOutDir, isConfirmed, MAX_CODE_CHARS, resetSessions,
} from './lib.mjs';
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(PLUGIN_DIR, 'step.plugin.json'), 'utf8')).version;
const DEFAULT_OUTDIR = join(PLUGIN_DIR, 'figures');

function outDirOrGuidance() {
  const r = resolveOutDir(process.env, DEFAULT_OUTDIR);
  if (!r.ok) return { error: 'invalid-outdir', reason: r.reason };
  return { ok: true, dir: ensureDir(r.value) };
}

// C5：长输出只保留尾部 N 行
function tailLines(text, max = 200) {
  const lines = String(text ?? '').split('\n');
  while (lines.length && lines.at(-1) === '') lines.pop();
  const slice = lines.slice(-max);
  return { truncated: lines.length > max, lines: slice };
}

// 防覆盖：已存在且未声明 overwrite 时自动追加 -2/-3…
// taken：本批次已占用的名字（批内同名也要去重，否则后写的脚本会覆盖先写的）
function uniqueBuild(spec, outDir, taken = null) {
  let attempt = spec;
  for (let i = 1; i <= 99; i++) {
    const built = buildPlotScript(attempt, outDir);
    if (!built.ok) return built;
    const clash = taken ? taken.has(built.value.name) : false;
    // overwrite 只放开"输出文件"复用；脚本路径仍须唯一（批内同名不能共享 .m）
    if ((!existsSync(built.value.outFile) && !clash) || (spec.overwrite === true && !clash)) {
      if (taken) taken.add(built.value.name);
      return built;
    }
    attempt = { ...spec, name: `${spec.name ?? 'figure'}-${i + 1}` };
  }
  return { ok: false, reason: '输出文件名冲突次数过多' };
}

const TOOLS = [
  { name: 'matlab_env', description: '探测 MATLAB 可用性/版本/工具箱清单（缺失时给安装指引）', inputSchema: { type: 'object', properties: { timeoutMs: { type: 'number' } } } },
  { name: 'matlab_plot_types', description: '列出支持的图形类型、必需/可选数据字段（不触达 MATLAB）', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'matlab_plot',
    description: '按结构化 spec 生成 MATLAB 图表并导出文件；dryRun=true 只返回生成的 .m 代码不执行',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'object' },
        dryRun: { type: 'boolean' },
      },
      required: ['spec'],
    },
  },
  {
    name: 'matlab_run',
    description: '执行任意 MATLAB 代码。默认 dry-run 只预览；confirm=true 才真正执行（危险操作，见 skill G3）',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        confirm: { type: 'boolean' },
        timeoutMs: { type: 'number' },
      },
      required: ['code'],
    },
  },
  { name: 'matlab_figure_ls', description: '列出输出目录中的图表（名称/格式/大小/时间）', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'matlab_figure_read',
    description: '按文件名读回图表（png/jpg/svg 以图片 content 返回，用于视觉验证）',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'matlab_plot_many',
    description: '批量绘图：多张图合并为一次 MATLAB 执行（会话内一个作业），N 张图只付一次启动成本；dryRun=true 只返回各图代码',
    inputSchema: {
      type: 'object',
      properties: {
        specs: { type: 'array', items: { type: 'object' } },
        dryRun: { type: 'boolean' },
      },
      required: ['specs'],
    },
  },
];

/** 写脚本并把 %SELF_PATH% 占位符替换为真实路径（供 checkcode 自检与 sidecar 使用）。
 *  路径同样做单引号成倍转义——outDir 可含引号时未转义会构成 MATLAB 注入。 */
function writeScript(scriptPath, code) {
  const selfPath = scriptPath.replace(/\\/g, '/').replace(/'/g, "''");
  writeFileSync(scriptPath, code.replace(/%SELF_PATH%/g, selfPath), 'utf8');
}

async function handlePlot(args) {
  const out = outDirOrGuidance();
  if (out.error) return out;
  const built = uniqueBuild(args?.spec, out.dir);
  if (!built.ok) return { error: 'invalid-spec', reason: built.reason };
  const { code, outFile, name, format, type } = built.value;
  if (args?.dryRun === true) {
    return { dryRun: true, type, name, format, outFile, code, warnings: built.value.warnings ?? [] };
  }
  const scriptPath = scriptPathFor(out.dir, name);
  writeScript(scriptPath, code);
  const run = await execScript(scriptPath, { outDir: out.dir });
  if (run.error === 'matlab-not-found') return { error: 'matlab-not-found', guidance: run.guidance };
  if (run.timedOut) return { error: 'timeout', name, format, outFile, message: run.message, script: scriptPath };
  const res = run.result;
  if (res && res.ok === false) {
    const cls = classifyMatlabError(res.error ?? '');
    return { error: 'matlab-error', name, format, outFile, mode: run.mode, pattern: cls.id, cause: cls.cause, action: cls.action, matlabError: res.error, analyzer: res.analyzer ?? null, script: scriptPath };
  }
  if (!existsSync(outFile)) {
    const cls = classifyMatlabError(`${run.stdout}\n${run.stderr}`);
    return { error: 'no-output', name, format, outFile, mode: run.mode, pattern: cls.id, cause: cls.cause, action: cls.action, stderr: tailLines(run.stderr, 50).lines, script: scriptPath };
  }
  const st = statSync(outFile);
  return { ok: true, type, name, format, file: outFile, bytes: st.size, mode: run.mode, analyzer: res?.analyzer ?? null, warnings: built.value.warnings ?? [], script: scriptPath };
}

function handleRun(args) {
  const out = outDirOrGuidance();
  if (out.error) return out;
  const code = typeof args?.code === 'string' ? args.code : '';
  if (!code.trim()) return { error: 'missing-arg: code' };
  if (code.length > MAX_CODE_CHARS) return { error: 'code-too-large', reason: `代码超过 ${MAX_CODE_CHARS} 字符上限` };
  // G3：默认 dry-run，confirm=true 才触达 MATLAB
  if (!isConfirmed(args?.confirm)) {
    return { dryRun: true, code, message: 'dry-run：以上 MATLAB 代码不会被执行。确认无误后以 confirm=true 重新调用（任意 MATLAB 代码等同本机代码执行，请先人工审阅）。' };
  }
  const scriptPath = scriptPathFor(out.dir, `run-${Date.now().toString(36)}`);
  writeFileSync(scriptPath, code, 'utf8');
  const run = runScript(scriptPath, { timeoutMs: args?.timeoutMs });
  if (run.error === 'matlab-not-found') return { error: 'matlab-not-found', guidance: run.guidance };
  if (run.timedOut) return { error: 'timeout', script: scriptPath, message: run.message };
  const stdout = tailLines(run.stdout, 200);
  const stderr = tailLines(run.stderr, 200);
  const payload = { exitCode: run.exitCode, script: scriptPath, stdout: stdout.lines, stdoutTruncated: stdout.truncated, stderr: stderr.lines, stderrTruncated: stderr.truncated };
  if (run.exitCode !== 0) {
    const cls = classifyMatlabError(`${run.stdout}\n${run.stderr}`);
    return { ...payload, error: 'matlab-error', pattern: cls.id, cause: cls.cause, action: cls.action };
  }
  return payload;
}

/** 批量绘图：多张图合并为一次 MATLAB 执行（会话内一个作业 / 一次性一个 -batch） */
async function handlePlotMany(args) {
  const out = outDirOrGuidance();
  if (out.error) return out;
  const specs = args?.specs;
  if (!Array.isArray(specs) || specs.length === 0) return { error: 'missing-arg: specs' };
  if (specs.length > 20) return { error: 'too-many-specs', reason: '单批最多 20 张图' };
  const built = [];
  const taken = new Set();
  for (let i = 0; i < specs.length; i++) {
    const b = uniqueBuild(specs[i], out.dir, taken);
    if (!b.ok) return { error: 'invalid-spec', index: i, reason: b.reason };
    built.push(b.value);
  }
  if (args?.dryRun === true) {
    return { dryRun: true, figures: built.map((b) => ({ name: b.name, type: b.type, format: b.format, outFile: b.outFile, code: b.code, warnings: b.warnings ?? [] })) };
  }
  // 逐图写脚本（%SELF_PATH% 已替换），再合并为一次执行
  const scriptPaths = built.map((b) => {
    const p = scriptPathFor(out.dir, b.name);
    writeScript(p, b.code);
    return p;
  });
  const combinedPath = scriptPathFor(out.dir, `batch-${Date.now().toString(36)}`);
  const combined = scriptPaths
    .map((p) => `run('${p.replace(/\\/g, '/').replace(/'/g, "''")}');`)
    .join('\n');
  writeScript(combinedPath, combined);
  const run = await execScript(combinedPath, { outDir: out.dir });
  if (run.error === 'matlab-not-found') return { error: 'matlab-not-found', guidance: run.guidance };
  if (run.timedOut) return { error: 'timeout', message: run.message, script: combinedPath };

  // 逐图 sidecar 兜底：RESULT 行丢失时（如 daemon 输出缓冲）仍能拿到每图结果
  const sidecarResults = new Map();
  for (const p of scriptPaths) {
    const sc = readSidecar(p);
    if (sc?.name) sidecarResults.set(sc.name, sc);
  }
  cleanupSidecars(scriptPaths);
  const jobError = run.result?.error ?? run.matlabError ?? null;
  const figures = [];
  for (const b of built) {
    const res = (run.results ?? []).find((r) => r && r.name === b.name) ?? sidecarResults.get(b.name) ?? null;
    if (res && res.ok === false) {
      const cls = classifyMatlabError(res.error ?? '');
      figures.push({ name: b.name, type: b.type, error: 'matlab-error', pattern: cls.id, cause: cls.cause, action: cls.action, matlabError: res.error });
      continue;
    }
    if (!existsSync(b.outFile)) {
      // 无逐图 RESULT：用作业级错误回填诊断，避免只给裸 no-output
      const cls = jobError ? classifyMatlabError(jobError) : null;
      figures.push({
        name: b.name, type: b.type, error: 'no-output', outFile: b.outFile,
        ...(cls ? { pattern: cls.id, cause: cls.cause, action: cls.action, matlabError: jobError } : {}),
      });
      continue;
    }
    figures.push({ name: b.name, type: b.type, ok: true, file: b.outFile, bytes: statSync(b.outFile).size, analyzer: res?.analyzer ?? null, warnings: b.warnings ?? [] });
  }
  return { mode: run.mode, figures, okCount: figures.filter((f) => f.ok).length, total: figures.length };
}

async function handleCall(name, args) {
  switch (name) {
    case 'matlab_env':
      return matlabEnv({ timeoutMs: args?.timeoutMs });
    case 'matlab_plot_types': {
      const types = {};
      for (const [k, v] of Object.entries(PLOT_TYPES)) types[k] = { desc: v.desc, required: v.data, optional: v.opt };
      return { types, formats: ['png', 'pdf', 'svg', 'jpg', 'fig'] };
    }
    case 'matlab_plot':
      return handlePlot(args);
    case 'matlab_plot_many':
      return handlePlotMany(args);
    case 'matlab_run':
      return handleRun(args);
    case 'matlab_figure_ls': {
      const out = outDirOrGuidance();
      if (out.error) return out;
      return listFigures(out.dir);
    }
    case 'matlab_figure_read': {
      const out = outDirOrGuidance();
      if (out.error) return out;
      const fig = readFigure(out.dir, args?.name);
      if (fig.error) return fig;
      if (fig.format === 'png' || fig.format === 'jpg' || fig.format === 'svg') {
        return { image: { file: fig.file, mimeType: fig.mimeType, data: fig.data, bytes: fig.bytes, width: fig.width ?? null, height: fig.height ?? null }, text: `图表 ${fig.file}（${fig.bytes} 字节${fig.width ? `，${fig.width}×${fig.height}` : ''}）` };
      }
      return { file: fig.file, format: fig.format, bytes: fig.bytes, note: `${fig.format} 为非位图格式，请用系统程序打开：${fig.file}` };
    }
    default:
      return null;
  }
}

const rl = createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

// server 退出时清理会话 daemon，避免残留 MATLAB 进程。
// 注意：resetSessions 是异步的（stop 文件 + taskkill 进程树），必须等它完成再退出，
// 否则 process.exit(0) 会抢先、taskkill 永不执行（孤儿只能靠 90s 看门狗兜底）。
const gracefulShutdown = () => {
  resetSessions().then(() => process.exit(0)).catch(() => process.exit(0));
  // 兜底：清理超过 5s 仍没结束也强制退出
  setTimeout(() => process.exit(0), 5000).unref();
};
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, gracefulShutdown);
}
process.on('exit', () => { resetSessions(); });
// stdin EOF（host 关闭管道）时主动退出：会话 daemon 的管道句会拉住事件循环
rl.on('close', gracefulShutdown);

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const { id, method, params } = req;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'step-matlab-plot', version: VERSION } } });
    return;
  }
  if (method?.startsWith('notifications/')) return;
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    let result;
    try {
      result = await handleCall(params?.name, params?.arguments);
    } catch (err) {
      // 防御性兜底：任何未预期异常都不能打垮 server 进程
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: 'internal-error', message: String(err?.message ?? err) }) }], isError: true } });
      return;
    }
    if (result === null) {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
      return;
    }
    if (result?.error === 'matlab-not-found') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result.guidance ?? INSTALL_GUIDANCE }], isError: true } });
      return;
    }
    if (result?.image) {
      send({ jsonrpc: '2.0', id, result: {
        content: [
          { type: 'image', data: result.image.data, mimeType: result.image.mimeType },
          { type: 'text', text: result.text },
        ],
        structuredContent: {
          file: result.image.file, format: result.image.mimeType, bytes: result.image.bytes,
          ...(result.image.width ? { width: result.image.width } : {}),
          ...(result.image.height ? { height: result.image.height } : {}),
        },
      } });
      return;
    }
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result } });
    return;
  }
  send({ jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `Method not found: ${method}` } });
});
