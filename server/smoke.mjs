#!/usr/bin/env node
/**
 * step-matlab-plot 冒烟测试：以子进程方式拉起 MCP server，
 * 走 stdio JSON-RPC 全协议（initialize → ping → tools/list → tools/call）。
 * 用法：
 *   node server/smoke.mjs                          # 走 MATLAB_MATE_FAKE 测试缝
 *   MATLAB_MATE_BIN=matlab.exe node server/smoke.mjs   # 走真机 MATLAB（较慢，需先装 MATLAB）
 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');
const env = { ...process.env };
if (!env.MATLAB_MATE_FAKE && !env.MATLAB_MATE_BIN) {
  env.MATLAB_MATE_FAKE = SERVER.replace('index.mjs', 'fake-matlab.mjs');
  env.FAKE_MATLAB_MODE = '1';
  console.log('[smoke] 未指定 MATLAB，使用测试缝 fake-matlab');
}
if (!env.MATLAB_MATE_OUTDIR) {
  env.MATLAB_MATE_OUTDIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'figures');
}

const child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const resolver = pending.get(msg.id);
    if (resolver) {
      pending.delete(msg.id);
      resolver(msg);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    const timer = setTimeout(() => reject(new Error(`RPC 超时: ${method}`)), 120000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: Boolean(cond), detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  → ${detail}`}`);
}

try {
  const init = await rpc('initialize', {});
  check('initialize 返回 serverInfo', init.result?.serverInfo?.name === 'step-matlab-plot', JSON.stringify(init).slice(0, 200));

  const ping = await rpc('ping', {});
  check('ping', ping.result !== undefined);

  const list = await rpc('tools/list', {});
  const names = (list.result?.tools ?? []).map((t) => t.name);
  const EXPECTED = ['matlab_env', 'matlab_plot_types', 'matlab_plot', 'matlab_plot_many', 'matlab_run', 'matlab_figure_ls', 'matlab_figure_read'];
  check('tools/list 含 7 个工具', names.length === 7 && EXPECTED.every((n) => names.includes(n)), names.join(','));

  const types = await rpc('tools/call', { name: 'matlab_plot_types', arguments: {} });
  const typesJson = JSON.parse(types.result.content[0].text);
  check('matlab_plot_types 返回 16 类', Object.keys(typesJson.types).length === 16, JSON.stringify(typesJson).slice(0, 120));

  const dry = await rpc('tools/call', {
    name: 'matlab_plot',
    arguments: { spec: { type: 'line', name: 'smoke-line', title: "冒口'测试", data: { x: [1, 2, 3], y: [[1, 2, 3], [2, 4, 6]] } }, dryRun: true },
  });
  const dryJson = JSON.parse(dry.result.content[0].text);
  check('matlab_plot dryRun 不执行且返回代码', dryJson.dryRun === true && dryJson.code.includes('STEPCODE_MATLAB_RESULT'));

  const plot = await rpc('tools/call', {
    name: 'matlab_plot',
    arguments: { spec: { type: 'line', name: 'smoke-line', data: { x: [1, 2, 3], y: [[1, 2, 3], [2, 4, 6]] } } },
  });
  const plotJson = JSON.parse(plot.result.content[0].text);
  check('matlab_plot 出图', plotJson.ok === true && plotJson.bytes > 0, JSON.stringify(plotJson).slice(0, 300));

  const plot2 = await rpc('tools/call', {
    name: 'matlab_plot',
    arguments: { spec: { type: 'heatmap', name: 'smoke-heat', format: 'png', data: { z: [[1, 2], [3, 4]], x: ['a', 'b'], y: ['c', 'd'] } } },
  });
  const plot2Json = JSON.parse(plot2.result.content[0].text);
  check('matlab_plot heatmap 出图', plot2Json.ok === true, JSON.stringify(plot2Json).slice(0, 300));

  const many = await rpc('tools/call', {
    name: 'matlab_plot_many',
    arguments: {
      specs: [
        { type: 'bar', name: 'smoke-many-bar', data: { y: [3, 5, 2] } },
        { type: 'pie', name: 'smoke-many-pie', data: { y: [1, 2, 3], labels: ['a', 'b', 'c'] } },
      ],
    },
  });
  const manyJson = JSON.parse(many.result.content[0].text);
  check('matlab_plot_many 批量出图', manyJson.okCount === 2 && manyJson.total === 2, JSON.stringify(manyJson).slice(0, 300));

  const bad = await rpc('tools/call', { name: 'matlab_plot', arguments: { spec: { type: 'line', name: '../evil', data: { y: [1] } } } });
  const badJson = JSON.parse(bad.result.content[0].text);
  check('非法图表名被拒', badJson.error === 'invalid-spec', JSON.stringify(badJson).slice(0, 200));

  const proto = await rpc('tools/call', { name: 'matlab_plot', arguments: { spec: { type: 'constructor', data: { y: [1] } } } });
  const protoJson = JSON.parse(proto.result.content[0].text);
  check('原型链类型名被拒且 server 不崩溃', protoJson.error === 'invalid-spec', JSON.stringify(protoJson).slice(0, 200));

  const stillAlive = await rpc('ping', {});
  check('异常后 server 仍可服务', stillAlive.result !== undefined);

  const runDry = await rpc('tools/call', { name: 'matlab_run', arguments: { code: "disp('hi')" } });
  const runDryJson = JSON.parse(runDry.result.content[0].text);
  check('matlab_run 默认 dry-run', runDryJson.dryRun === true, JSON.stringify(runDryJson).slice(0, 200));

  const runOk = await rpc('tools/call', { name: 'matlab_run', arguments: { code: "disp('hello from matlab')", confirm: true } });
  const runOkJson = JSON.parse(runOk.result.content[0].text);
  check('matlab_run confirm 后执行', runOkJson.exitCode === 0, JSON.stringify(runOkJson).slice(0, 300));

  const ls = await rpc('tools/call', { name: 'matlab_figure_ls', arguments: {} });
  const lsJson = JSON.parse(ls.result.content[0].text);
  check('matlab_figure_ls 列出图表', lsJson.figures.length >= 2, JSON.stringify(lsJson).slice(0, 200));

  const read = await rpc('tools/call', { name: 'matlab_figure_read', arguments: { name: 'smoke-line.png' } });
  const content = read.result?.content ?? [];
  check('matlab_figure_read 返回图片 content', content.some((c) => c.type === 'image' && c.mimeType === 'image/png'), JSON.stringify(read).slice(0, 200));

  const envq = await rpc('tools/call', { name: 'matlab_env', arguments: { timeoutMs: 60000 } });
  const envJson = JSON.parse(envq.result.content[0].text);
  check('matlab_env 返回可用状态', envJson.available === true, JSON.stringify(envJson).slice(0, 200));

  const unknown = await rpc('tools/call', { name: 'no_such_tool', arguments: {} });
  check('未知工具返回 -32602', unknown.error?.code === -32602, JSON.stringify(unknown).slice(0, 200));
} catch (err) {
  check('冒烟流程未抛异常', false, String(err?.stack ?? err));
} finally {
  child.kill();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n冒烟结果：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
