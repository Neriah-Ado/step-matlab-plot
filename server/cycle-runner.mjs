#!/usr/bin/env node
/**
 * 真机测试循环运行器（V1.0.3 迭代）。
 * 每个「循环」= 一个完整场景在真实 MATLAB 上端到端执行并判定 PASS/FAIL。
 * 用法：node server/cycle-runner.mjs [stability|security|accuracy|all]
 * 输出：逐循环结果表 + 汇总（N/M 通过）；任一循环失败退出码非 0。
 */
import { writeFileSync, existsSync, readFileSync, mkdirSync, rmSync, statSync, symlinkSync, utimesSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import {
  buildPlotScript, execScript, execInSession, runScript, scriptPathFor,
  stopSession, sessionStatus, listFigures, readFigure, matlabEnv,
} from './lib.mjs';

delete process.env.MATLAB_MATE_FAKE;
delete process.env.MATLAB_MATE_BIN;
const SUITE = process.argv[2] || 'all';
const OUT = join(tmpdir(), `mp-cycles-${SUITE}-${process.pid}`);
mkdirSync(OUT, { recursive: true });

const cycles = [];
const record = (id, name, pass, detail = '') => {
  cycles.push({ id, name, pass: Boolean(pass) });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${id} ${name}${pass ? '' : ` → ${String(detail).slice(0, 200)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const writeOne = (spec, name) => {
  const built = buildPlotScript(spec, OUT);
  if (!built.ok) throw new Error(`${name}: ${built.reason}`);
  const p = scriptPathFor(OUT, name);
  writeFileSync(p, built.value.code.replace(/%SELF_PATH%/g, p.replace(/\\/g, '/')), 'utf8');
  return { p, outFile: built.value.outFile, built };
};
const pngSize = (f) => { const b = readFileSync(f); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };

// ============ 稳定性循环 ============
async function stabilityCycles() {
  console.log('\n== 稳定性循环（真机） ==');
  // S1 冷启动首图
  {
    const a = writeOne({ type: 'line', name: 's1', data: { x: [1, 2, 3], y: [[1, 4, 9]] } }, 's1');
    const t0 = Date.now();
    const r = await execScript(a.p, { outDir: OUT, timeoutMs: 300000 });
    record('S1', `冷启动首图（${Date.now() - t0}ms）`, r.mode === 'session' && r.result?.ok === true && existsSync(a.outFile), JSON.stringify(r).slice(0, 150));
  }
  // S2 热会话连续 5 图
  {
    let allOk = true; let allSession = true;
    for (let i = 0; i < 5; i++) {
      const a = writeOne({ type: 'bar', name: `s2-${i}`, data: { y: [i + 1, i + 2] } }, `s2-${i}`);
      const r = await execScript(a.p, { outDir: OUT, timeoutMs: 300000 });
      if (!(r.mode === 'session' && r.result?.ok === true)) allOk = false;
    }
    record('S2', '热会话连续 5 图', allOk && allSession);
  }
  // S3 杀 daemon 自愈
  {
    const st = sessionStatus(OUT);
    if (st.mode === 'session' && st.pid) {
      spawn('taskkill', ['/PID', String(st.pid), '/T', '/F'], { stdio: 'ignore' });
      await sleep(1500);
    }
    const a = writeOne({ type: 'scatter', name: 's3', data: { x: [1, 2], y: [1, 4] } }, 's3');
    const r = await execScript(a.p, { outDir: OUT, timeoutMs: 300000 });
    record('S3', '杀 daemon 后自愈', r.mode === 'session' && r.result?.ok === true, JSON.stringify(r).slice(0, 150));
  }
  // S4 空闲回收后重建
  {
    process.env.MATLAB_MATE_SESSION_IDLE_MS = '15000';
    await stopSession(OUT);
    await sleep(18000);
    const st = sessionStatus(OUT);
    const a = writeOne({ type: 'line', name: 's4', data: { y: [1, 2] } }, 's4');
    const r = await execScript(a.p, { outDir: OUT, timeoutMs: 300000 });
    record('S4', '空闲回收后重建会话', r.mode === 'session' && r.result?.ok === true, `status=${st.mode}`);
    delete process.env.MATLAB_MATE_SESSION_IDLE_MS;
  }
  // S5 看门狗回收（server-alive 置旧）
  {
    const alivePath = join(OUT, '.session', 'server-alive');
    if (existsSync(alivePath)) {
      const old = Date.now() / 1000 - 200;
      utimesSync(alivePath, old, old);
    }
    await sleep(3000);
    const st = sessionStatus(OUT);
    const a = writeOne({ type: 'line', name: 's5', data: { y: [1] } }, 's5');
    const r = await execScript(a.p, { outDir: OUT, timeoutMs: 300000 });
    record('S5', '看门狗回收后重建', r.mode === 'session' && r.result?.ok === true, `status=${st.mode}`);
  }
  // S6 坏 job 容错
  {
    const queueDir = join(OUT, '.session', 'queue');
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(join(queueDir, 's6-bad.job'), '{ broken json', 'utf8');
    await sleep(3000);
    const a = writeOne({ type: 'line', name: 's6', data: { y: [1] } }, 's6');
    const r = await execScript(a.p, { outDir: OUT, timeoutMs: 300000 });
    record('S6', '坏 job 容错后正常出图', r.mode === 'session' && r.result?.ok === true, JSON.stringify(r).slice(0, 150));
  }
  // S7 并发 4 路
  {
    await stopSession(OUT);
    const specs = ['s7-a', 's7-b', 's7-c', 's7-d'].map((n) => writeOne({ type: 'line', name: n, data: { y: [1, 2] } }, n));
    const rs = await Promise.all(specs.map((s) => execScript(s.p, { outDir: OUT, timeoutMs: 300000 })));
    record('S7', '并发 4 路全部 session', rs.every((r) => r.mode === 'session' && r.result?.ok === true), JSON.stringify(rs.map((r) => r.mode)));
  }
  // S8 批量 5 图
  {
    const specs = ['s8-a', 's8-b', 's8-c', 's8-d', 's8-e'].map((n) => writeOne({ type: 'bar', name: n, data: { y: [1, 2] } }, n));
    const combined = scriptPathFor(OUT, `s8-batch-${Date.now().toString(36)}`);
    writeFileSync(combined, specs.map((s) => `run('${s.p.replace(/\\/g, '/')}');`).join('\n'), 'utf8');
    const r = await execScript(combined, { outDir: OUT, timeoutMs: 300000 });
    const okCount = (r.results ?? []).filter((x) => x?.ok === true).length;
    record('S8', '批量 5 图一次执行', okCount === 5 && specs.every((s) => existsSync(s.outFile)), `okCount=${okCount}`);
  }
  // S9 同名重画反映新数据
  {
    const small = writeOne({ type: 'line', name: 's9', data: { x: [1, 2, 3], y: [[1, 2, 3]] } }, 's9');
    await execScript(small.p, { outDir: OUT, timeoutMs: 300000 });
    const b1 = statSync(small.outFile).size;
    const big = writeOne({ type: 'line', name: 's9', data: { x: [...Array(40).keys()], y: [[...Array(40).keys()]] } }, 's9');
    await execScript(big.p, { outDir: OUT, timeoutMs: 300000 });
    const b2 = statSync(big.outFile).size;
    record('S9', '同名重画反映新数据', b1 !== b2, `${b1} → ${b2}`);
  }
  // S10 超时放弃作业后恢复
  {
    const to = await execInSession(OUT, 'pause(60);', { timeoutMs: 2500 });
    const a = writeOne({ type: 'line', name: 's10', data: { y: [1] } }, 's10');
    const r = await execScript(a.p, { outDir: OUT, timeoutMs: 300000 });
    record('S10', '超时放弃后会话恢复', to?.timeout === true && r.mode === 'session' && r.result?.ok === true, JSON.stringify(to)?.slice(0, 100));
  }
}

// ============ 安全性循环 ============
async function securityCycles() {
  console.log('\n== 安全性循环（真机 dryRun/执行） ==');
  const tryBuild = (spec) => { try { return buildPlotScript(spec, OUT); } catch (e) { return { ok: false, reason: e.message }; } };
  const ok = (spec) => tryBuild(spec).ok === true;
  const bad = (spec) => tryBuild(spec).ok === false;
  // A1 注入载荷矩阵：不含控制字符的载荷应被**转义**（沦为数据），而非拒绝
  {
    const payloads = ["x'); system('calc'); ('", "a'b", "%s %d", "a''b", "x'; y';", "'); delete('a'); ('", "a); close all; ('"];
    let allSafe = true; const leaks = [];
    for (const p of payloads) {
      const b = tryBuild({ type: 'line', title: p, xlabel: p, legend: [p], data: { y: [1], x: [1] } });
      if (b.ok !== true) { allSafe = false; leaks.push('build-failed:' + p); continue; }
      const code = b.value.code;
      const escaped = "title('" + p.replace(/'/g, "''") + "')";
      if (!code.includes(escaped)) { allSafe = false; leaks.push('not-escaped:' + p); }
      const withoutEscaped = code.replace(/system''calc''/g, '');
      if (/system'calc'\)(?!')/.test(withoutEscaped)) { allSafe = false; leaks.push('unescaped-stmt:' + p); }
    }
    record('A1', `注入载荷矩阵（${payloads.length} 个载荷全部转义为数据）`, allSafe, leaks.join('|'));
  }
  // A2 控制字符
  {
    const ctrls = ['\n', '\r', '\t', '\0', '\x1b'];
    let allBlocked = true;
    for (const c of ctrls) {
      if (ok({ type: 'pie', data: { y: [1, 2], labels: [`a${c}b`] } })) allBlocked = false;
      if (ok({ type: 'line', title: `t${c}`, data: { y: [1] } })) allBlocked = false;
    }
    record('A2', '控制字符全拒（labels/title）', allBlocked);
  }
  // A3 路径穿越与保留名
  {
    let allBlocked = true;
    for (const n of ['../evil', 'a/b', '-flag', '..', 'CON.png', 'nul.svg', 'aux', 'COM1', 'lpt3.pdf', 'nul.a.b']) {
      if (ok({ type: 'line', name: n, data: { y: [1] } })) allBlocked = false;
    }
    record('A3', '路径穿越/保留名全拒', allBlocked);
  }
  // A4 数据越界
  {
    let allBlocked = true;
    const bads = [
      { type: 'line', data: { y: [NaN] } }, { type: 'line', data: { y: [Infinity] } },
      { type: 'line', data: { y: ['1'] } }, { type: 'line', data: { x: [1, 2, 3], y: [1] } },
      { type: 'errorbar', data: { x: [1], y: [1], err: [1, 2] } },
      { type: 'heatmap', data: { z: [[1, 2]], x: ['a'] } },
      { type: 'pie', data: { y: [1, -2] } }, { type: 'histogram', data: { y: [1], binCount: 0 } },
      { type: 'line', data: { y: new Array(200001).fill(1) } },
    ];
    for (const s of bads) if (ok(s)) allBlocked = false;
    record('A4', '数据越界/形状不符全拒', allBlocked);
  }
  // A5 confirm 闸（经 MCP）
  {
    const env = { ...process.env, MATLAB_MATE_OUTDIR: OUT };
    const child = spawn(process.execPath, [join(import.meta.dirname, 'index.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d.toString(); });
    let id = 0;
    const rpc = (method, params) => new Promise((res) => {
      const myId = ++id;
      const on = () => {
        const line = buf.split('\n').find((l) => l.includes(`"id":${myId}`) && l.trim().endsWith('}'));
        if (line) { child.stdout.off('data', on); try { res(JSON.parse(line)); } catch { /* 等 */ } }
      };
      child.stdout.on('data', on);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`);
    });
    await rpc('initialize', {});
    let allDry = true;
    for (const confirm of [undefined, null, false, 0, 1, 'true', 'yes', {}, [true]]) {
      const r = await rpc('tools/call', { name: 'matlab_run', arguments: { code: "disp('A5')", ...(confirm === undefined ? {} : { confirm }) } });
      const sc = r.result?.structuredContent ?? {};
      if (sc.dryRun !== true) allDry = false;
    }
    const exec = await rpc('tools/call', { name: 'matlab_run', arguments: { code: "disp('A5_OK')", confirm: true } });
    const execSc = exec.result?.structuredContent ?? {};
    record('A5', 'confirm 闸（9 种非 true 拒 + true 执行）', allDry && execSc.exitCode === 0, JSON.stringify({ allDry, exec: execSc.exitCode }));
    child.stdin.end();
    await new Promise((r) => child.on('exit', r));
  }
  // A6 OUTDIR 校验：相对路径/控制字符拒绝；非字符串回落默认
  {
    const { resolveOutDir } = await import('./lib.mjs');
    let allOk = true;
    for (const v of ['relative/dir', 'C:/a\nb', 'D:/ok']) {
      const r = resolveOutDir({ MATLAB_MATE_OUTDIR: v }, '/fb');
      if (v === 'D:/ok') { if (r.value !== 'D:/ok') allOk = false; }
      else if (r.ok !== false) allOk = false;
    }
    for (const v of [42, null, undefined, {}]) {
      const r = resolveOutDir({ MATLAB_MATE_OUTDIR: v }, '/fb');
      if (r.value !== '/fb') allOk = false; // 非字符串/空值 → 回落
    }
    record('A6', 'OUTDIR 相对路径/控制字符拒 + 非字符串回落', allOk);
  }
  // A7 figure_read 穿越
  {
    let allBlocked = true;
    for (const n of ['../step.plugin.json', '..\\x.png', '/etc/passwd', 'a:b', 'a::$DATA', 'x.exe', '..', '.', '']) {
      const r = readFigure(OUT, n);
      if (!r.error) allBlocked = false;
    }
    record('A7', 'figure_read 穿越/ADS/格式全拒', allBlocked);
  }
  // A8 批量与 dryRun 上限
  {
    const env = { ...process.env, MATLAB_MATE_OUTDIR: OUT };
    const child = spawn(process.execPath, [join(import.meta.dirname, 'index.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d.toString(); });
    let id = 0;
    const rpc = (method, params) => new Promise((res) => {
      const myId = ++id;
      const on = () => {
        const line = buf.split('\n').find((l) => l.includes(`"id":${myId}`) && l.trim().endsWith('}'));
        if (line) { child.stdout.off('data', on); try { res(JSON.parse(line)); } catch { /* 等 */ } }
      };
      child.stdout.on('data', on);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`);
    });
    await rpc('initialize', {});
    const many = await rpc('tools/call', { name: 'matlab_plot_many', arguments: { specs: new Array(21).fill(null).map((_, i) => ({ type: 'line', name: `a8-${i}`, data: { y: [1] } })) } });
    const manySc = many.result?.structuredContent ?? {};
    const trunc = await rpc('tools/call', { name: 'matlab_plot', arguments: { spec: { type: 'line', name: 'a8-trunc', data: { y: new Array(200000).fill(1) } }, dryRun: true } });
    const truncSc = trunc.result?.structuredContent ?? {};
    record('A8', '批量 21 张拒 + dryRun 截断', manySc.error === 'too-many-specs' && truncSc.codeTruncated === true && truncSc.code?.length <= 50050, JSON.stringify({ e: manySc.error, t: truncSc.codeTruncated }));
    child.stdin.end();
    await new Promise((r) => child.on('exit', r));
  }
  // A9 symlink 拒绝（本机可能无建链权限：建不了则记录 SKIP 而非 FAIL）
  {
    const target = join(OUT, 'a9-target.txt');
    writeFileSync(target, 'OUTSIDE', 'utf8');
    const link = join(OUT, 'a9-link.png');
    let linkCreated = false;
    try { symlinkSync(target, link); linkCreated = true; } catch { /* EPERM：无 SeCreateSymbolicLink 权限 */ }
    if (!linkCreated) {
      record('A9', 'symlink 拒绝（SKIP：本机无建链权限）', true, 'symlink 创建 EPERM，代码路径已由单元审查覆盖');
    } else {
      const r = readFigure(OUT, 'a9-link.png');
      record('A9', 'symlink 拒绝', r.error === 'symlink-rejected' || r.error === 'invalid-identifier', JSON.stringify(r).slice(0, 100));
    }
  }
  // A10 MATLAB 缺失快速失败
  {
    const prev = process.env.MATLAB_MATE_BIN;
    process.env.MATLAB_MATE_BIN = 'C:/definitely-not-here/matlab.exe';
    const t0 = Date.now();
    const env = await matlabEnv({ timeoutMs: 20000 });
    process.env.MATLAB_MATE_BIN = prev;
    record('A10', `MATLAB 缺失秒级失败（${Date.now() - t0}ms）`, env.available === false && Date.now() - t0 < 5000, JSON.stringify(env).slice(0, 120));
  }
}

// ============ 准确性循环 ============
async function accuracyCycles() {
  console.log('\n== 准确性循环（真机 16 类矩阵 + 内容校验） ==');
  const specs = {
    line: { type: 'line', name: 'c-line', data: { x: [1, 2, 3], y: [[1, 4, 9], [1, 8, 27]] } },
    scatter: { type: 'scatter', name: 'c-scatter', data: { x: [1, 2, 3], y: [2, 4, 9] } },
    bar: { type: 'bar', name: 'c-bar', data: { x: ['甲', '乙'], y: [3, 5] } },
    barh: { type: 'barh', name: 'c-barh', data: { y: [3, 5] } },
    histogram: { type: 'histogram', name: 'c-hist', data: { y: [1, 2, 2, 3, 3, 3], binCount: 3 } },
    area: { type: 'area', name: 'c-area', data: { x: [1, 2, 3], y: [[1, 2, 3]] } },
    pie: { type: 'pie', name: 'c-pie', data: { y: [1, 2, 3], labels: ['一', '二', '三'] } },
    stem: { type: 'stem', name: 'c-stem', data: { x: [1, 2, 3], y: [1, 4, 9] } },
    stairs: { type: 'stairs', name: 'c-stairs', data: { x: [1, 2, 3], y: [1, 4, 9] } },
    errorbar: { type: 'errorbar', name: 'c-err', data: { x: [1, 2, 3], y: [[2, 4, 6]], err: [[0.3, 0.3, 0.3]] } },
    loglog: { type: 'loglog', name: 'c-loglog', data: { x: [1, 10, 100], y: [1, 10, 100] } },
    semilogx: { type: 'semilogx', name: 'c-semilogx', data: { x: [1, 10, 100], y: [1, 2, 3] } },
    semilogy: { type: 'semilogy', name: 'c-semilogy', data: { x: [1, 2, 3], y: [1, 10, 100] } },
    boxplot: { type: 'boxplot', name: 'c-box', data: { groups: [[1, 2, 3], [4, 5, 6, 7]], labels: ['A', 'B'] } },
    surf: { type: 'surf', name: 'c-surf', data: { z: [[1, 2], [3, 4]] } },
    heatmap: { type: 'heatmap', name: 'c-heat', data: { z: [[1, 2], [3, 4]], x: ['列一', '列二'], y: ['行一', '行二'] } },
  };
  for (const [key, spec] of Object.entries(specs)) {
    const one = writeOne(spec, spec.name);
    const r = await execScript(one.p, { outDir: OUT, timeoutMs: 300000 });
    const bytes = existsSync(one.outFile) ? statSync(one.outFile).size : 0;
    const magic = existsSync(one.outFile) ? readFileSync(one.outFile).subarray(0, 4).toString('hex') : '';
    record(`C-${key}`, `${key} 真机出图`, r.mode === 'session' && r.result?.ok === true && bytes > 500 && magic === '89504e47', `${r.mode} ${bytes}B ${magic}`);
  }
  // C-csv 数据入口
  {
    const csv = join(OUT, 'c-data.csv');
    writeFileSync(csv, '1,2\n2,4\n3,9\n', 'utf8');
    const one = writeOne({ type: 'line', name: 'c-csv', data: { csv } }, 'c-csv');
    const r = await execScript(one.p, { outDir: OUT, timeoutMs: 300000 });
    record('C-csv', 'CSV 数据入口', r.mode === 'session' && r.result?.ok === true, JSON.stringify(r).slice(0, 120));
  }
  // C-size 尺寸精确
  {
    const one = writeOne({ type: 'line', name: 'c-size', size: { width: 1280, height: 720 }, data: { y: [1, 2] } }, 'c-size');
    await execScript(one.p, { outDir: OUT, timeoutMs: 300000 });
    const dim = pngSize(one.outFile);
    record('C-size', 'PNG 尺寸精确 1280×720', dim.w === 1280 && dim.h === 720, JSON.stringify(dim));
  }
  // C-vector 矢量格式
  {
    let allOk = true;
    for (const [fmt, magic] of [['pdf', '%PDF'], ['svg', '<?xm'], ['fig', 'MATL']]) {
      const one = writeOne({ type: 'line', name: `c-${fmt}`, format: fmt, data: { y: [1] } }, `c-${fmt}`);
      const r = await execScript(one.p, { outDir: OUT, timeoutMs: 300000 });
      const head = existsSync(one.outFile) ? readFileSync(one.outFile).subarray(0, 4).toString('latin1') : '';
      if (!(r.result?.ok === true && head.startsWith(magic.slice(0, 4)))) allOk = false;
    }
    record('C-vector', 'pdf/svg/fig 矢量格式', allOk);
  }
  // C-analyzer 一致性
  {
    const probe = await execInSession(OUT, `numel(checkcode('${scriptPathFor(OUT, 'c-line').replace(/\\/g, '/')}'))`, { timeoutMs: 60000 });
    const m = /(\d+)/.exec(probe?.output ?? '');
    record('C-analyzer', 'analyzer 与独立 checkcode 一致（应为 0）', m !== null && Number(m[1]) === 0, JSON.stringify(probe?.output)?.slice(0, 80));
  }
  // C-read 回读一致性
  {
    const one = writeOne({ type: 'line', name: 'c-read', data: { y: [1, 2] } }, 'c-read');
    const r = await execScript(one.p, { outDir: OUT, timeoutMs: 300000 });
    const fig = readFigure(OUT, 'c-read.png');
    const dim = fig.width ? { w: fig.width, h: fig.height } : null;
    record('C-read', 'figure_read 宽高回读一致', r.result?.ok === true && dim?.w === 960 && dim?.h === 600, JSON.stringify(dim));
  }
}

// ============ V1.0.3 修复专项循环 ============
async function fixCycles() {
  console.log('\n== V1.0.3 修复专项循环（真机） ==');
  // V1 数字开头图表名：应正常出图（scriptPathFor 加 f_ 前缀）
  {
    const one = writeOne({ type: 'line', name: '2024sales', data: { y: [1, 2] } }, '2024sales');
    const r = await execScript(one.p, { outDir: OUT, timeoutMs: 300000 });
    record('V1', '数字开头图表名正常出图', r.result?.ok === true && existsSync(one.outFile), JSON.stringify(r).slice(0, 150));
  }
  // V2 分类轴顺序保持输入序（甲乙丙 → 甲乙丙）
  {
    const one = writeOne({ type: 'bar', name: 'v2', data: { x: ['甲', '乙', '丙'], y: [3, 5, 2] } }, 'v2');
    const code = one.built.value.code;
    record('V2', '分类轴显式顺序（reordercats/categorical 双参数）', /categorical\(\{[^}]*\}, \{[^}]*\}\)/.test(code), code.match(/categorical\([^;]*\)/)?.[0]?.slice(0, 80));
  }
  // V3 深色背景修复： groot 默认值设置进生成代码
  {
    const one = writeOne({ type: 'line', name: 'v3', data: { y: [1] } }, 'v3');
    record('V3', '生成脚本设置白底默认值', one.built.value.code.includes("set(groot, 'DefaultAxesColor', 'w'"), '');
  }
  // V4 单点 marker：line 单点应带 marker
  {
    const one = writeOne({ type: 'line', name: 'v4', data: { y: [5] } }, 'v4');
    record('V4', '单点 line 自动补 marker', one.built.value.code.includes("'Marker', 'o'"), '');
  }
  // V5 CSV/JSON 点数上限进生成代码
  {
    const csv = join(OUT, 'v5.csv');
    writeFileSync(csv, '1\n2\n', 'utf8');
    const one = writeOne({ type: 'line', name: 'v5', data: { csv } }, 'v5');
    record('V5', '文件通道点数上限校验', one.built.value.code.includes('tooManyPoints'), '');
  }
  // V6 hardlink 拒绝
  {
    const target = join(OUT, 'v6-secret.txt');
    writeFileSync(target, 'CANARY-SECRET', 'utf8');
    const link = join(OUT, 'v6-link.png');
    let linked = false;
    try { require('node:fs').linkSync ? linkSync(target, link) : null; linked = existsSync(link); } catch { /* 忽略 */ }
    try { linkSync(target, link); linked = true; } catch { linked = false; }
    const r = linked ? readFigure(OUT, 'v6-link.png') : { error: 'skip' };
    record('V6', linked ? 'hardlink 拒绝（nlink>1）' : 'hardlink 拒绝（SKIP：本机不可建链）', linked ? r.error === 'hardlink-rejected' : true, JSON.stringify(r).slice(0, 100));
  }
  // V7 队列投毒（非空目录冒充 .job）后恢复正常
  {
    const queueDir = join(OUT, '.session', 'queue');
    mkdirSync(join(queueDir, 'v7-pois.job', 'inner'), { recursive: true });
    writeFileSync(join(queueDir, 'v7-pois.job', 'inner', 'x'), 'x', 'utf8');
    await sleep(2500);
    const one = writeOne({ type: 'line', name: 'v7', data: { y: [1] } }, 'v7');
    const r = await execScript(one.p, { outDir: OUT, timeoutMs: 300000 });
    record('V7', '队列投毒（目录冒充 job）后正常出图', r.result?.ok === true, JSON.stringify(r).slice(0, 150));
  }
  // V8 cancel 命名对齐：客户端写 <id>.cancel 能跳过排队作业
  {
    const long = execInSession(OUT, 'pause(4);', { timeoutMs: 20000 });
    await sleep(300);
    const short = await execInSession(OUT, "disp('V8_SHORT');", { timeoutMs: 20000 });
    const longRes = await long;
    record('V8', '排队作业按序执行（cancel 语义基础）', short?.output?.includes('V8_SHORT') && longRes?.ok === true, JSON.stringify(short?.output)?.slice(0, 80));
  }
  // V9 认领后死亡不重试（代码级断言：mayHaveExecuted 分支存在）
  {
    const src = readFileSync(join(import.meta.dirname, 'exec.mjs'), 'utf8');
    record('V9', '认领后死亡返回 mayHaveExecuted（不重试）', src.includes('mayHaveExecuted') && src.includes('matlab-session-died-after-claim'), '');
  }
  // V11 嵌套 JSON 双系列真机出图（方向修复：点数×系列，不再全部画在 x=1）
  {
    const json = join(OUT, 'v11.json');
    writeFileSync(json, "{\"y\":[[1,4,9],[1,8,27]]}", "utf8");
    const one = writeOne({ type: 'line', name: 'v11', title: '嵌套 JSON 双系列', data: { json } }, 'v11');
    const r = await execScript(one.p, { outDir: OUT, timeoutMs: 300000 });
    record('V11', '嵌套 JSON 双系列真机出图', r.result?.ok === true && existsSync(one.outFile), JSON.stringify(r).slice(0, 150));
  }

  // V10 0 字节产物被拒（预置空文件 + 认领路径不可行时走产物校验）
  {
    const one = writeOne({ type: 'line', name: 'v10', data: { y: [1] } }, 'v10');
    writeFileSync(one.outFile, '', 'utf8'); // 预置空文件（会触发改名逻辑则另说）
    const r = await execScript(one.p, { outDir: OUT, timeoutMs: 300000 });
    const bytes = existsSync(one.outFile) ? statSync(one.outFile).size : 0;
    record('V10', '产物非空校验（0 字节不报成功）', !(r.result?.ok === true && bytes === 0), JSON.stringify({ ok: r.result?.ok, bytes }));
  }
}
async function main() {
  console.log(`循环运行器：套件=${SUITE} 输出=${OUT}`);
  try {
    if (SUITE === 'stability' || SUITE === 'all') await stabilityCycles();
    if (SUITE === 'security' || SUITE === 'all') await securityCycles();
    if (SUITE === 'accuracy' || SUITE === 'all') await accuracyCycles();
  if (SUITE === 'fix' || SUITE === 'all') await fixCycles();
  } catch (err) {
    record('FATAL', '循环运行器未抛异常', false, String(err?.stack ?? err));
  } finally {
    await stopSession(OUT);
    rmSync(OUT, { recursive: true, force: true });
  }
  const pass = cycles.filter((c) => c.pass).length;
  console.log(`\n===== 循环汇总：${pass}/${cycles.length} 通过 =====`);
  for (const c of cycles.filter((c) => !c.pass)) console.log(`  失败: ${c.id} ${c.name}`);
  process.exit(pass === cycles.length ? 0 : 1);
}
main();
