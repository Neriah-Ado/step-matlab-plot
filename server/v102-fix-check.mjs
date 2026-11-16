#!/usr/bin/env node
/** 验证 V1.0.2 两个 Medium 修复：陈旧 sidecar 假成功、dryRun 截断 */
import { writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildPlotScript, execScript, scriptPathFor } from './lib.mjs';

const OUT = join(import.meta.dirname, '..', 'figures');
delete process.env.MATLAB_MATE_FAKE;
process.env.MATLAB_MATE_SESSION = 'never';

const results = [];
const check = (n, c, d = '') => { results.push({ n, pass: Boolean(c) }); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : ` → ${d}`}`); };

// 1) dryRun 截断（经 MCP 层验证）
const bigSpec = { type: 'line', name: 'trunc-check', data: { y: new Array(200000).fill(1) } };
const { spawn } = await import('node:child_process');
const child = spawn(process.execPath, [join(import.meta.dirname, 'index.mjs')], {
  env: { ...process.env, MATLAB_MATE_OUTDIR: OUT }, stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '';
child.stdout.on('data', (d) => { buf += d.toString(); });
let id = 0;
const rpc = (method, params) => new Promise((res) => {
  const myId = ++id;
  const on = () => {
    const line = buf.split('\n').find((l) => l.includes(`"id":${myId}`) && l.trim().endsWith('}'));
    if (line) {
      child.stdout.off('data', on);
      try { res(JSON.parse(line)); } catch { /* 等下一个 chunk */ }
    }
  };
  child.stdout.on('data', on);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`);
});
await rpc('initialize', {});
const dry = await rpc('tools/call', { name: 'matlab_plot', arguments: { spec: bigSpec, dryRun: true } });
const sc = dry.result?.structuredContent ?? {};
check('dryRun 截断生效', sc.codeTruncated === true && sc.code?.length <= 50050 && sc.codeLength > 500000, JSON.stringify({ len: sc.code?.length, total: sc.codeLength, trunc: sc.codeTruncated }).slice(0, 150));

// 2) 陈旧 sidecar 不再造成假成功：预置 sidecar + 让脚本必然失败（colormap 白名单外的值在生成期被拒，
//    改用直接破坏脚本：写一个运行期报错的 .m 到脚本路径并预置 ok:true sidecar）
// 2) 陈旧 sidecar 不再造成假成功：直测 execScript（预置坏脚本 + 陈旧 ok:true sidecar）
const built = buildPlotScript({ type: 'line', name: 'stale-check2', data: { y: [1, 2] } }, OUT);
const scriptPath = scriptPathFor(OUT, 'stale-check2');
writeFileSync(scriptPath, "error('DELIBERATE_FAIL_FOR_TEST');", 'utf8');
writeFileSync(`${scriptPath}.result.json`, JSON.stringify({ ok: true, type: 'line', name: 'stale-check2', files: [built.value.outFile], bytes: 99999, analyzer: 0 }), 'utf8');
const rStale = await execScript(scriptPath, { outDir: OUT, timeoutMs: 120000 });
check('陈旧 sidecar 不再假成功', !(rStale.result?.ok === true), JSON.stringify({ mode: rStale.mode, ok: rStale.result?.ok, err: rStale.result?.error ?? rStale.matlabError })?.slice(0, 250));
child.stdin.end();
await new Promise((r) => child.on('exit', r));
rmSync(built.value.outFile, { force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\nV1.0.2 Medium 修复验证：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
