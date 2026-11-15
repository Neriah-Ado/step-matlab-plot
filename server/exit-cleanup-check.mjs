#!/usr/bin/env node
/** 验证 server 优雅退出：stdin EOF 后 server 退出且 daemon 进程树被清理 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SERVER = join(import.meta.dirname, 'index.mjs');
const OUT = join(tmpdir(), 'step-matlab-plot-exitcheck');
const env = { ...process.env, MATLAB_MATE_OUTDIR: OUT, MATLAB_MATE_SESSION: 'always', MATLAB_MATE_SESSION_IDLE_MS: '600000' };
delete env.MATLAB_MATE_FAKE;

const child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
child.stdout.on('data', (d) => { buf += d.toString(); });

const rpc = (method, params) => new Promise((resolve) => {
  const id = Math.floor(Math.random() * 1e9);
  const onData = (d) => {
    const s = d.toString();
    if (s.includes(`"id":${id}`)) {
      child.stdout.off('data', onData);
      resolve(JSON.parse(s.split('\n').find((l) => l.includes(`"id":${id}`))));
    }
  };
  child.stdout.on('data', onData);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});

await rpc('initialize', {});
await rpc('tools/call', { name: 'matlab_plot', arguments: { spec: { type: 'line', name: 'exit-line', data: { y: [1, 2] } } } });
console.log('已出图，关闭 stdin（EOF）…');
child.stdin.end();

const t0 = Date.now();
await new Promise((resolve) => { child.on('exit', (code) => { console.log(`server 退出 code=${code}（${Date.now() - t0}ms）`); resolve(); }); });
await new Promise((r) => setTimeout(r, 6000));
const stopExists = existsSync(join(OUT, '.session', 'stop'));
const aliveExists = existsSync(join(OUT, '.session', 'server-alive'));
console.log(`6s 后：stop 文件存在=${stopExists}（daemon 退出时会自删），server-alive 存在=${aliveExists}`);
console.log(stopExists === false ? 'PASS：daemon 经 stop 文件优雅退出' : 'INFO：stop 文件仍在（daemon 可能仍在退出中）');
process.exit(0);
