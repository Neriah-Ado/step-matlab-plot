/**
 * step-matlab-plot 单元测试：node --test server/lib.test.mjs
 * 覆盖：输入校验白名单、16 类图形代码生成、转义、错误分类、fake 缝端到端。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PLOT_TYPES, buildPlotScript, validateSpec,
  parseResultLine, classifyMatlabError, runScript, execScript, execInSession, readFigure, listFigures,
  stopSession, sessionStatus,
  assertFigureName, assertFormat, matlabStr, toNumVector, toNumMatrix, toStrVector,
  resolveDataFile, resolveOutDir, scriptPathFor,
} from './lib.mjs';

const OUT = join(mkdtempSync(join(tmpdir(), 'matlab-plot-test-')), 'figures');
process.env.MATLAB_MATE_FAKE = join(import.meta.dirname, 'fake-matlab.mjs');

// ---------- 校验 ----------
test('assertFigureName：合法名/穿越/前导横线/扩展名剥离', () => {
  assert.equal(assertFigureName('demo', 'png').value, 'demo');
  assert.equal(assertFigureName('demo.png', 'png').value, 'demo');
  assert.equal(assertFigureName('a.b-c_1', 'svg').value, 'a.b-c_1');
  assert.equal(assertFigureName('../evil', 'png').ok, false);
  assert.equal(assertFigureName('-flag', 'png').ok, false);
  assert.equal(assertFigureName('a/b', 'png').ok, false);
  assert.equal(assertFigureName('a'.repeat(200), 'png').ok, false);
  assert.equal(assertFigureName('', 'png').ok, false);
});

test('assertFormat 仅接受白名单格式', () => {
  assert.equal(assertFormat('png').value, 'png');
  assert.equal(assertFormat('SVG').value, 'svg');
  assert.equal(assertFormat('exe').ok, false);
  assert.equal(assertFormat(undefined).value, 'png');
});

test('matlabStr 单引号成倍转义', () => {
  assert.equal(matlabStr("a'b"), "'a''b'");
  assert.equal(matlabStr('x'), "'x'");
});

test('toNumVector 拒绝 NaN/Infinity/非数字与超限', () => {
  assert.deepEqual(toNumVector([1, -2.5, 0]).value, [1, -2.5, 0]);
  assert.equal(toNumVector([NaN]).ok, false);
  assert.equal(toNumVector([Infinity]).ok, false);
  assert.equal(toNumVector(['1']).ok, false);
  assert.equal(toNumVector([]).ok, false);
  assert.equal(toNumVector(new Array(200001).fill(1)).ok, false);
});

test('toNumMatrix 拒绝 ragged 与空行', () => {
  assert.deepEqual(toNumMatrix([[1, 2], [3, 4]]).value, [[1, 2], [3, 4]]);
  assert.equal(toNumMatrix([[1, 2], [3]]).ok, false);
  assert.equal(toNumMatrix([[], []]).ok, false);
});

test('toStrVector 拒绝非字符串', () => {
  assert.deepEqual(toStrVector(['a', 'b']).value, ['a', 'b']);
  assert.equal(toStrVector(['a', 1]).ok, false);
});

test('resolveDataFile：不存在/非文件/超限均拒绝', () => {
  assert.equal(resolveDataFile('no-such-file.csv').ok, false);
  const tmp = join(mkdtempSync(join(tmpdir(), 'mp-')), 'x.csv');
  writeFileSync(tmp, '1,2\n3,4\n');
  assert.equal(resolveDataFile(tmp).value, tmp);
});

test('resolveOutDir：相对路径拒绝，缺省回落', () => {
  assert.equal(resolveOutDir({ MATLAB_MATE_OUTDIR: 'rel/dir' }, '/fallback').ok, false);
  assert.equal(resolveOutDir({ MATLAB_MATE_OUTDIR: 'D:\\abs' }, '/fallback').value, 'D:\\abs');
  assert.equal(resolveOutDir({}, '/fallback').value, '/fallback');
});

// ---------- 代码生成 ----------
const CASES = [
  ['line', { type: 'line', data: { x: [1, 2, 3], y: [[1, 2, 3], [2, 4, 6]] } }, 'plot(xData, yData)'],
  ['scatter', { type: 'scatter', data: { x: [1, 2, 3], y: [2, 3, 5] } }, 'scatter(xNumeric'],
  ['bar', { type: 'bar', data: { x: ['a', 'b'], y: [3, 5] } }, 'bar(xData, yData)'],
  ['barh', { type: 'barh', data: { y: [3, 5] } }, 'barh(xData, yData)'],
  ['histogram', { type: 'histogram', data: { y: [1, 2, 2, 3], binCount: 4 } }, "histogram(yData, 'NumBins', 4)"],
  ['area', { type: 'area', data: { x: [1, 2], y: [[1, 2]] } }, 'area(xData, yData)'],
  ['pie', { type: 'pie', data: { y: [30, 50, 20], labels: ['a', 'b', 'c'] } }, "pie(yData, {'a', 'b', 'c'})"],
  ['stem', { type: 'stem', data: { x: [1, 2], y: [1, 4] } }, 'stem(xData, yData)'],
  ['stairs', { type: 'stairs', data: { y: [1, 4] } }, 'stairs(xData, yData)'],
  ['errorbar', { type: 'errorbar', data: { x: [1, 2], y: [2, 4], err: [0.5, 0.5] } }, 'errorbar(xNumeric'],
  ['loglog', { type: 'loglog', data: { x: [1, 10], y: [1, 100] } }, 'loglog(xData, yData)'],
  ['semilogx', { type: 'semilogx', data: { x: [1, 10], y: [1, 100] } }, 'semilogx(xData, yData)'],
  ['semilogy', { type: 'semilogy', data: { x: [1, 10], y: [1, 100] } }, 'semilogy(xData, yData)'],
  ['boxplot', { type: 'boxplot', data: { groups: [[1, 2, 3], [4, 5, 6, 7]] } }, 'boxplot(groupData, groupIdx)'],
  ['surf', { type: 'surf', data: { z: [[1, 2], [3, 4]], x: [0, 1], y: [0, 1] } }, 'meshgrid(xData, yNumeric)'],
  ['heatmap', { type: 'heatmap', data: { z: [[1, 2], [3, 4]], x: ['a', 'b'], y: ['c', 'd'] } }, "heatmap({'a', 'b'}, {'c', 'd'}, zData)"],
];

for (const [name, spec, expect] of CASES) {
  test(`代码生成：${name}`, () => {
    const r = buildPlotScript(spec, OUT);
    assert.equal(r.ok, true, r.reason);
    assert.match(r.value.code, new RegExp(expect.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(r.value.code, /STEPCODE_MATLAB_RESULT/);
    assert.match(r.value.code, /^% stepcode-matlab-plot/);
    assert.equal(r.value.outFile.endsWith('.png'), true);
  });
}

test('代码生成：所有注册类型都有用例', () => {
  const covered = new Set(CASES.map(([n]) => n));
  for (const t of Object.keys(PLOT_TYPES)) assert.equal(covered.has(t), true, `缺少 ${t} 用例`);
});

test('代码生成：标题/标签单引号转义进 MATLAB 字面量', () => {
  const r = buildPlotScript({ type: 'line', title: "Bob's chart", xlabel: 'x (m)', data: { x: [1], y: [1] } }, OUT);
  assert.equal(r.ok, true, r.reason);
  assert.match(r.value.code, /title\('Bob''s chart'\)/);
  assert.match(r.value.code, /xlabel\('x \(m\)'\)/);
});

test('代码生成：非法规格全部被拒', () => {
  assert.equal(buildPlotScript({ type: 'nope', data: { y: [1] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'line', data: {} }, OUT).ok, false);           // 缺 y
  assert.equal(buildPlotScript({ type: 'line', format: 'exe', data: { y: [1] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'pie', data: { y: [[1, 2]] } }, OUT).ok, false); // 嵌套 y
  assert.equal(buildPlotScript({ type: 'line', name: '../x', data: { y: [1] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'errorbar', data: { x: [1], y: [1] } }, OUT).ok, false); // 缺 err
  assert.equal(buildPlotScript({ type: 'surf', data: { x: [1] } }, OUT).ok, false);   // 缺 z
  assert.equal(buildPlotScript({ type: 'line', style: { lineWidth: 99 }, data: { y: [1] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'line', legend: 5, data: { y: [1] } }, OUT).ok, false);
});

test('代码生成：csv 数据源透传为 readmatrix', () => {
  const r = buildPlotScript({ type: 'line', data: { csv: 'C:/data/x.csv' } }, OUT);
  // 文件不存在 → 拒绝（resolveDataFile 生效）
  assert.equal(r.ok, false);
});

test('validateSpec 独立可用（dryRun 前置校验）', () => {
  const v = validateSpec({ type: 'bar', data: { y: [1] } });
  assert.equal(v.ok, true);
  assert.equal(v.value.format, 'png');
  assert.equal(v.value.name, 'figure');
});

// ---------- 回归：子代理验证发现的缺陷 ----------
test('回归：颜色字段拒绝注入载荷（引号/分号/system）', () => {
  for (const bad of ["x'); system('calc'); ('", "red'); delete('a'); %", 'a\'b', "red'", '', 'a'.repeat(30)]) {
    const r = buildPlotScript({ type: 'line', style: { color: bad }, data: { y: [1] } }, OUT);
    assert.equal(r.ok, false, `style.color 应被拒绝：${bad}`);
  }
  const r2 = buildPlotScript({ type: 'line', series: [{ color: "x'); system('calc'); ('" }], data: { y: [1] } }, OUT);
  assert.equal(r2.ok, false);
  // 合法颜色名与 RGB 仍被接受
  assert.equal(buildPlotScript({ type: 'line', style: { color: 'red' }, data: { y: [1] } }, OUT).ok, true);
  assert.equal(buildPlotScript({ type: 'line', style: { color: [0.2, 0.4, 0.8] }, data: { y: [1] } }, OUT).ok, true);
  assert.equal(buildPlotScript({ type: 'line', style: { color: [5, -1, 0.5] }, data: { y: [1] } }, OUT).ok, false);
});

test('回归：grid:false 不再吞掉 legend 指令', () => {
  const r = buildPlotScript({ type: 'line', grid: false, legend: 'none', data: { y: [1] } }, OUT);
  assert.equal(r.ok, true, r.reason);
  assert.match(r.value.code, /legend\('off'\);/);
  assert.match(r.value.code, /grid off;/);
  const r2 = buildPlotScript({ type: 'line', grid: false, legend: ['a', 'b'], data: { y: [[1, 2], [3, 4]] } }, OUT);
  assert.match(r2.value.code, /legend\(\{'a', 'b'\}\);/);
});

test('回归：形状交叉校验', () => {
  assert.equal(buildPlotScript({ type: 'line', data: { x: [1, 2, 3, 4], y: [1, 2, 3] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'errorbar', data: { x: [1, 2], y: [[1, 2]], err: [1, 2, 3] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'heatmap', data: { z: [[1, 2, 3]], x: ['a', 'b'] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'surf', data: { z: [[1, 2]], x: [1, 2, 3] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'loglog', data: { x: ['a', 'b'], y: [1, 2] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'pie', data: { y: [1, 2, 3], labels: ['a', 'b'] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'pie', data: { y: [1, -2, 3] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'boxplot', data: { groups: [[1, 2], [3, 4]], labels: ['only-one'] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'line', legend: ['a', 'b', 'c'], data: { y: [[1, 2], [3, 4]] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'histogram', data: { y: [1, 2], binCount: 0 } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'histogram', data: { y: [1, 2], binCount: 2.5 } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'line', data: { csv: 'C:/x.csv', x: [1] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'line', title: 'a'.repeat(3000), data: { y: [1] } }, OUT).ok, false);
});

test('回归：样式按图形类型分派（scatter→MarkerFaceColor，bar→FaceColor）', () => {
  const sc = buildPlotScript({ type: 'scatter', series: [{ name: 's', color: 'red' }], data: { x: [1, 2], y: [1, 2] } }, OUT);
  assert.equal(sc.ok, true, sc.reason);
  assert.match(sc.value.code, /chartHandles\(1\)\.MarkerFaceColor = 'red';/);
  assert.doesNotMatch(sc.value.code, /chartHandles\(1\)\.Color/);
  const bar = buildPlotScript({ type: 'bar', series: [{ color: 'blue' }], data: { y: [1, 2] } }, OUT);
  assert.match(bar.value.code, /chartHandles\(1\)\.FaceColor = 'blue';/);
  const area = buildPlotScript({ type: 'area', style: { color: 'cyan' }, data: { x: [1, 2], y: [[1, 2]] } }, OUT);
  assert.match(area.value.code, /set\(chartHandles, 'FaceColor', 'cyan'\)/);
  const pie = buildPlotScript({ type: 'pie', style: { color: 'red' }, data: { y: [1, 2] } }, OUT);
  assert.equal(pie.value.warnings.length > 0, true);
  assert.doesNotMatch(pie.value.code, /\.Color = |set\(chartHandles, 'Color'/);
  const hm = buildPlotScript({ type: 'heatmap', zlabel: 'z', data: { z: [[1, 2]] } }, OUT);
  assert.doesNotMatch(hm.value.code, /zlabel/);
  assert.equal(hm.value.warnings.some((w) => w.includes('zlabel')), true);
});

test('回归：boxplot 生成数据+分组向量（cell 首参已被现代 MATLAB 拒绝）', () => {
  const r = buildPlotScript({ type: 'boxplot', name: 'bp', data: { groups: [[1, 2, 3], [4, 5]] } }, OUT);
  assert.equal(r.ok, true, r.reason);
  assert.match(r.value.code, /groupData = \[1, 2, 3, 4, 5\];/);
  assert.match(r.value.code, /groupIdx = \[1, 1, 1, 2, 2\];/);
  assert.match(r.value.code, /boxplot\(groupData, groupIdx\)/);
});

test('回归：会话目标脚本不得含 exit(1)（否则杀死整个 daemon）', () => {
  const r = buildPlotScript({ type: 'line', name: 'no-exit', data: { y: [1] } }, OUT);
  assert.equal(r.ok, true, r.reason);
  assert.doesNotMatch(r.value.code, /exit\(1\)/);
  // 显式 standalone=true 才允许 exit
  const s = buildPlotScript({ type: 'line', name: 'with-exit', data: { y: [1] } }, OUT, { standalone: true });
  assert.match(s.value.code, /exit\(1\);/);
  // 预检行是多行 try/catch，不给 checkcode 留把柄
  assert.match(r.value.code, /analyzerIssueCount = numel\(checkcode\('/);
  assert.doesNotMatch(r.value.code, /try, analyzerIssueCount/);
});

test('回归：控制字符与 series 数量校验', () => {
  assert.equal(buildPlotScript({ type: 'line', title: 'bad\ntitle', data: { y: [1] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'line', xlabel: 'a\tb', data: { y: [1] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'line', series: [{ name: 'a' }, { name: 'b' }], data: { y: [[1, 2]] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'line', series: [{ name: 'a' }], data: { y: [[1, 2]] } }, OUT).ok, true);
});

test('回归：并发冷启动单飞（延迟首心跳下不起多个 daemon、不互杀）', async () => {
  process.env.FAKE_MATLAB_IDLE_MS = '120000';
  process.env.FAKE_MATLAB_SLEEP_MS = '2500'; // 模拟冷启动延迟：放大竞态窗口
  await stopSession(OUT);
  const writeOne = (name) => {
    const built = buildPlotScript({ type: 'line', name, data: { y: [1, 2] } }, OUT);
    const p = scriptPathFor(OUT, name);
    writeFileSync(p, built.value.code.replace(/%SELF_PATH%/g, p.replace(/\\/g, '/')), 'utf8');
    return p;
  };
  const paths = ['cc-a', 'cc-b', 'cc-c', 'cc-d'].map(writeOne);
  const rs = await Promise.all(paths.map((p) => execScript(p, { outDir: OUT, timeoutMs: 60000 })));
  assert.deepEqual(rs.map((r) => r.mode), ['session', 'session', 'session', 'session'], JSON.stringify(rs.map((r) => r.mode)));
  assert.deepEqual(rs.map((r) => r.result?.ok === true), [true, true, true, true]);
  await stopSession(OUT);
  delete process.env.FAKE_MATLAB_SLEEP_MS;
  delete process.env.FAKE_MATLAB_IDLE_MS;
});

test('回归：OUTDIR 注入被转义（%SELF_PATH% 不做裸拼接）', () => {
  const evilOut = `${OUT}'); system('calc`;
  const built = buildPlotScript({ type: 'line', name: 'inj-out', data: { y: [1] } }, evilOut);
  const p = scriptPathFor(evilOut, 'inj-out');
  const selfPath = p.replace(/\\/g, '/').replace(/'/g, "''");
  const code = built.value.code.replace(/%SELF_PATH%/g, selfPath);
  assert.doesNotMatch(code, /fopen\('[^']*\); system/);
  assert.match(code, /system\(''calc/);
});

test('回归：colormap 白名单 / catch 带 name / print 精确导出 / 句柄预分配', () => {
  const ok = buildPlotScript({ type: 'surf', colormap: 'parula', data: { z: [[1, 2]] } }, OUT);
  assert.equal(ok.ok, true);
  assert.match(ok.value.code, /colormap\('parula'\);/);
  assert.equal(buildPlotScript({ type: 'surf', colormap: 'nosuchmap', data: { z: [[1, 2]] } }, OUT).ok, false);
  assert.match(ok.value.code, /struct\('ok', false, 'type', 'surf', 'name', 'figure'/);
  assert.match(ok.value.code, /-dpng', '-r96'/);
  const sc = buildPlotScript({ type: 'scatter', data: { x: [1, 2], y: [[1, 2]] } }, OUT);
  assert.match(sc.value.code, /chartHandles = gobjects\(1, size\(yData, 2\)\);/);
  const st = buildPlotScript({ type: 'stem', name: 'stem-ok', data: { x: [1, 2], y: [1, 4] } }, OUT);
  assert.match(st.value.code, /chartHandles = stem\(xData, yData\);/);
});

test('回归：陈旧 sidecar 在投递前被清理（不再冒领）', async () => {
  const built = buildPlotScript({ type: 'line', name: 'stale-sidecar', data: { y: [1, 2] } }, OUT);
  const p = scriptPathFor(OUT, 'stale-sidecar');
  writeFileSync(p, built.value.code.replace(/%SELF_PATH%/g, p.replace(/\\/g, '/')), 'utf8');
  // 预置一个 name 错误的陈旧 sidecar
  writeFileSync(`${p}.result.json`, JSON.stringify({ ok: true, name: 'WRONG-NAME' }), 'utf8');
  const r = await execScript(p, { outDir: OUT, timeoutMs: 30000 });
  // 结果必须来自本次执行（name 正确），且 sidecar 已被读取清理
  assert.equal(r.result?.name, 'stale-sidecar', JSON.stringify(r.result)?.slice(0, 200));
  assert.equal(existsSync(`${p}.result.json`), false, 'sidecar 应被读取后清理');
});

test('回归：dryRun 截断字段与保留名多段检查', () => {
  const big = buildPlotScript({ type: 'line', name: 'trunc', data: { y: new Array(200000).fill(1) } }, OUT);
  assert.equal(big.ok, true);
  assert.equal(big.value.code.length > 50000, true);
  // handlePlot 的 dryRun 走 truncateCode：直接验证函数行为（经 index 导出不可达，复刻判定）
  const truncate = (code) => (code.length <= 50000 ? code : `${code.slice(0, 50000)}\n...[代码过长已截断，共 ${code.length} 字符；正式调用将完整执行]`);
  const t = truncate(big.value.code);
  assert.equal(t.length < big.value.code.length, true);
  assert.match(t, /代码过长已截断，共 \d+ 字符/);
  // 多段保留名
  assert.equal(buildPlotScript({ type: 'line', name: 'nul.a.b', data: { y: [1] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'line', name: 'aux.foo.bar', data: { y: [1] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'line', name: 'data.nul', data: { y: [1] } }, OUT).ok, true);
});

test('回归：fake 缝坏 job 快速失败（id 回填）', async () => {
  process.env.FAKE_MATLAB_IDLE_MS = '60000';
  const { writeFileSync: w, mkdirSync: mk, readFileSync: rf, existsSync: ex } = await import('node:fs');
  const queueDir = join(OUT, '.session', 'queue');
  const resultsDir = join(OUT, '.session', 'results');
  mk(queueDir, { recursive: true });
  mk(resultsDir, { recursive: true });
  // 先起一个 fake daemon 会话
  const built = buildPlotScript({ type: 'line', name: 'fake-bad-warm', data: { y: [1] } }, OUT);
  const p = scriptPathFor(OUT, 'fake-bad-warm');
  w(p, built.value.code.replace(/%SELF_PATH%/g, p.replace(/\\/g, '/')), 'utf8');
  await execScript(p, { outDir: OUT, timeoutMs: 30000 });
  // 投放坏 job
  const badId = `j${process.pid}_badjob_1`;
  w(join(queueDir, `${badId}.job`), '{ not valid json !!!', 'utf8');
  // 等 daemon 处理
  const deadline = Date.now() + 15000;
  let parsed = null;
  while (Date.now() < deadline) {
    const resFile = join(resultsDir, `${badId}.res`);
    if (ex(resFile)) {
      try { parsed = JSON.parse(rf(resFile, 'utf8')); break; } catch { /* 继续等 */ }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(parsed, '坏 job 应在 15s 内产生结果');
  assert.equal(parsed.id, badId, `id 应回填为 ${badId}，实际 ${parsed.id}`);
  assert.equal(parsed.ok, false);
  await stopSession(OUT);
  delete process.env.FAKE_MATLAB_IDLE_MS;
});

test('回归：会话投递后死亡时重建重试一次（垂死窗口）', async () => {
  process.env.FAKE_MATLAB_IDLE_MS = '120000';
  // 先建会话
  const warm = buildPlotScript({ type: 'line', name: 'retry-warm', data: { y: [1] } }, OUT);
  const pw = scriptPathFor(OUT, 'retry-warm');
  writeFileSync(pw, warm.value.code.replace(/%SELF_PATH%/g, pw.replace(/\\/g, '/')), 'utf8');
  const rWarm = await execScript(pw, { outDir: OUT, timeoutMs: 30000 });
  assert.equal(rWarm.mode, 'session');
  // 杀掉 fake daemon：制造「投递后死亡」场景
  const st = sessionStatus(OUT);
  assert.equal(st.mode, 'session');
  try { process.kill(st.pid, 'SIGKILL'); } catch { /* 已退出则忽略 */ }
  // execScript 应重建会话并成功（而非直接回落一次性）
  const built = buildPlotScript({ type: 'line', name: 'retry-after-death', data: { y: [1, 2] } }, OUT);
  const p = scriptPathFor(OUT, 'retry-after-death');
  writeFileSync(p, built.value.code.replace(/%SELF_PATH%/g, p.replace(/\\/g, '/')), 'utf8');
  const r = await execScript(p, { outDir: OUT, timeoutMs: 30000 });
  assert.equal(r.mode, 'session', JSON.stringify(r).slice(0, 200));
  assert.equal(r.result?.ok, true);
  await stopSession(OUT);
  delete process.env.FAKE_MATLAB_IDLE_MS;
});

// ---------- V1.0.3 修复回归 ----------
test('V1.0.3：JSON 数据通道方向与上限', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-json-'));
  writeFileSync(join(dir, 'flat.json'), '{"y":[1,2,3]}', 'utf8');
  writeFileSync(join(dir, 'nested.json'), '{"y":[[1,2,3],[4,5,6]]}', 'utf8');
  for (const f of ['flat.json', 'nested.json']) {
    const r = buildPlotScript({ type: 'line', name: 'j', data: { json: join(dir, f) } }, dir);
    assert.equal(r.ok, true, r.reason);
    assert.match(r.value.code, /iscell\(jsonPayload\.y\)/);
    assert.match(r.value.code, /cell2mat\(cellfun/);
    assert.match(r.value.code, /tooManyPoints/);
    assert.doesNotMatch(r.value.code, /v\(:\)\.'/);
  }
});

test('V1.0.3：单点 marker 覆盖多系列', () => {
  const single = buildPlotScript({ type: 'line', name: 'm1', data: { y: [5] } }, OUT);
  assert.match(single.value.code, /plot\(xData, yData, 'Marker', 'o'\)/);
  const multi = buildPlotScript({ type: 'line', name: 'm2', data: { y: [[5], [3]] } }, OUT);
  assert.match(multi.value.code, /plot\(xData, yData, 'Marker', 'o'\)/, '多系列各 1 点也应补 marker');
  const two = buildPlotScript({ type: 'line', name: 'm3', data: { y: [1, 2] } }, OUT);
  assert.doesNotMatch(two.value.code, /Marker/);
});

test('V1.0.3：分类标签空串/重复生成期拒绝', () => {
  assert.equal(buildPlotScript({ type: 'bar', data: { x: ['', 'b'], y: [1, 2] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'bar', data: { x: ['a', 'a', 'b'], y: [1, 2, 3] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'bar', data: { x: ['a', 'b'], y: [1, 2] } }, OUT).ok, true);
});

test('V1.0.3：groot 白底默认值', () => {
  const r = buildPlotScript({ type: 'line', name: 'g', data: { y: [1] } }, OUT);
  assert.match(r.value.code, /set\(groot, 'DefaultAxesColor', 'w'/);
});

test('V1.0.3：exec 不再对 mayHaveExecuted 静默重跑', () => {
  const src = readFileSync(join(import.meta.dirname, 'exec.mjs'), 'utf8');
  assert.match(src, /matlab-session-died-after-claim/);
  assert.match(src, /可能已执行；按配置不重试不回退/);
});
test('回归：控制字符标准对齐（toStrVector 与 validateText 一致）', () => {
  assert.equal(buildPlotScript({ type: 'pie', data: { y: [1, 2], labels: ['a\nb'] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'line', legend: ['a\rb'], data: { y: [1] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'line', data: { x: ['a\tb', 'c'], y: [1, 2] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'heatmap', data: { z: [[1]], x: ['a b'] } }, OUT).ok, false);
  // 合法标签不受影响
  assert.equal(buildPlotScript({ type: 'pie', data: { y: [1, 2], labels: ['甲', '乙'] } }, OUT).ok, true);
});

test('回归：Windows 保留设备名与 OUTDIR 校验', () => {
  for (const bad of ['CON', 'con.png', 'NUL', 'aux.svg', 'COM1', 'lpt3.pdf']) {
    assert.equal(buildPlotScript({ type: 'line', name: bad, data: { y: [1] } }, OUT).ok, false, `name=${bad} 应被拒`);
  }
  assert.equal(buildPlotScript({ type: 'line', name: 'console', data: { y: [1] } }, OUT).ok, true);
  assert.equal(resolveOutDir({ MATLAB_MATE_OUTDIR: 'C:/a\nb' }, '/fb').ok, false);
  assert.equal(resolveOutDir({ MATLAB_MATE_OUTDIR: 42 }, '/fb').value, '/fb'); // 非字符串回落
  assert.equal(resolveOutDir({ MATLAB_MATE_OUTDIR: 'D:/ok' }, '/fb').value, 'D:/ok');
});

test('回归：writeScript 的替换串语义（$& 不被吞）', () => {
  const evilOut = `${OUT}$&`;
  const built = buildPlotScript({ type: 'line', name: 'dollar', data: { y: [1] } }, evilOut);
  const p = scriptPathFor(evilOut, 'dollar');
  const selfPath = p.replace(/\\/g, '/').replace(/'/g, "''");
  const code = built.value.code.replace(/%SELF_PATH%/g, () => selfPath);
  assert.match(code, new RegExp(`checkcode\\('${selfPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\)`));
});

test('回归：会话超时不杀会话（放弃本作业，后续调用仍走会话）', async () => {
  process.env.FAKE_MATLAB_IDLE_MS = '120000';
  process.env.FAKE_MATLAB_SLEEP_MS = '2500';
  const first = await execInSession(OUT, "disp('slow');", { timeoutMs: 400 });
  assert.equal(first?.timeout, true, JSON.stringify(first));
  delete process.env.FAKE_MATLAB_SLEEP_MS;
  // 会话应仍存活：下一个作业正常完成且仍是 session 模式
  const built = buildPlotScript({ type: 'line', name: 'after-timeout', data: { y: [1, 2] } }, OUT);
  const p = scriptPathFor(OUT, 'after-timeout');
  writeFileSync(p, built.value.code.replace(/%SELF_PATH%/g, p.replace(/\\/g, '/')), 'utf8');
  const r = await execScript(p, { outDir: OUT, timeoutMs: 30000 });
  assert.equal(r.mode, 'session', JSON.stringify(r).slice(0, 300));
  assert.equal(r.result?.ok, true);
  await stopSession(OUT);
  delete process.env.FAKE_MATLAB_IDLE_MS;
});

test('回归：结果 id 不匹配时不被冒领（防伪造/串话）', async () => {
  process.env.FAKE_MATLAB_IDLE_MS = '120000';
  const built = buildPlotScript({ type: 'line', name: 'idcheck', data: { y: [1, 2] } }, OUT);
  const p = scriptPathFor(OUT, 'idcheck');
  writeFileSync(p, built.value.code.replace(/%SELF_PATH%/g, p.replace(/\\/g, '/')), 'utf8');
  // 预投一个伪造结果（id 与 server 将生成的完全不同）
  const resultsDir = join(OUT, '.session', 'results');
  mkdirSync(resultsDir, { recursive: true });
  const forged = join(resultsDir, `j${process.pid}_forged_0.res`);
  writeFileSync(forged, JSON.stringify({ id: 'SPOOFED-ID', ok: true, output: '', exitCode: 0, error: '' }), 'utf8');
  const r = await execScript(p, { outDir: OUT, timeoutMs: 30000 });
  assert.equal(r.result?.name, 'idcheck', JSON.stringify(r.result));
  // 伪造文件应原样保留（未被消费）
  assert.equal(existsSync(forged), true);
  await stopSession(OUT);
});

test('回归：原型链属性名不能冒充图形类型', () => {
  for (const bad of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf']) {
    const r = buildPlotScript({ type: bad, data: { y: [1] } }, OUT);
    assert.equal(r.ok, false, `type=${bad} 应被拒`);
    assert.match(r.reason, /不支持的图形类型/);
  }
});

test('回归：数值字段拒绝可强转的非数字', () => {
  assert.equal(buildPlotScript({ type: 'line', style: { lineWidth: '5' }, data: { y: [1] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'line', style: { lineWidth: [5] }, data: { y: [1] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'scatter', style: { markerSize: '36' }, data: { y: [1] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'line', size: { width: '960' }, data: { y: [1] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'line', series: [{ lineWidth: true }], data: { y: [1] } }, OUT).ok, false);
});

test('回归：内联数字总量与字符串单项上限', () => {
  assert.equal(buildPlotScript({ type: 'line', data: { y: [new Array(200001).fill(1), new Array(200001).fill(2), new Array(100001).fill(3)] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'pie', data: { y: [1, 2], labels: ['a'.repeat(501)] } }, OUT).ok, false);
  assert.equal(buildPlotScript({ type: 'line', legend: ['a'.repeat(501)], data: { y: [1] } }, OUT).ok, false);
});

test('回归：csv 数据入口端到端（真实临时文件）', async () => {
  const csvPath = join(mkdtempSync(join(tmpdir(), 'mp-csv-')), 'data.csv');
  writeFileSync(csvPath, '1,2\n2,4\n3,9\n');
  const built = buildPlotScript({ type: 'line', name: 'csv-line', data: { csv: csvPath } }, OUT);
  assert.equal(built.ok, true, built.reason);
  assert.match(built.value.code, /readmatrix\(/);
  const scriptPath = scriptPathFor(OUT, 'csv-line');
  writeFileSync(scriptPath, built.value.code, 'utf8');
  const run = await runScript(scriptPath, {});
  assert.equal(run.result?.ok, true, JSON.stringify(run));
  assert.equal(existsSync(built.value.outFile), true);
  const fig = readFigure(OUT, 'csv-line.png');
  assert.equal(fig.mimeType, 'image/png');
});

// ---------- exec 纯函数 ----------
test('parseResultLine 提取末行 JSON', () => {
  assert.deepEqual(parseResultLine('noise\nSTEPCODE_MATLAB_RESULT:{"ok":true}'), { ok: true });
  assert.equal(parseResultLine('nothing'), null);
  assert.equal(parseResultLine('STEPCODE_MATLAB_RESULT:{bad json'), null);
});

test('classifyMatlabError 覆盖六大类', () => {
  assert.equal(classifyMatlabError('License checkout failed').id, 'license');
  assert.equal(classifyMatlabError('Undefined function foo').id, 'toolbox-missing');
  assert.equal(classifyMatlabError("函数或变量 'z' 无法识别").id, 'toolbox-missing');
  assert.equal(classifyMatlabError('Dimensions of matrices being concatenated').id, 'invalid-input');
  assert.equal(classifyMatlabError('输入参数的数目不足').id, 'invalid-input');
  assert.equal(classifyMatlabError('Out of memory').id, 'out-of-memory');
  assert.equal(classifyMatlabError('unrecognized option -batch').id, 'cli-unsupported');
  assert.equal(classifyMatlabError('Unable to open file').id, 'file-io');
  assert.equal(classifyMatlabError('boom').id, 'matlab-error');
});

// ---------- fake 缝端到端 ----------
test('fake 缝：line 图生成→落盘→读回', async () => {
  const built = buildPlotScript({ type: 'line', name: 'unit-line', data: { x: [1, 2, 3], y: [[1, 2, 3]] } }, OUT);
  assert.equal(built.ok, true, built.reason);
  const scriptPath = scriptPathFor(OUT, 'unit-line');
  writeFileSync(scriptPath, built.value.code, 'utf8');
  const run = await runScript(scriptPath, {});
  assert.equal(run.result?.ok, true, JSON.stringify(run));
  assert.equal(existsSync(built.value.outFile), true);
  const fig = readFigure(OUT, 'unit-line.png');
  assert.equal(fig.error, undefined);
  assert.equal(fig.mimeType, 'image/png');
  assert.ok(fig.data.length > 100);
});

test('fake 缝：surf svg 导出', async () => {
  const built = buildPlotScript({ type: 'surf', name: 'unit-surf', format: 'svg', data: { z: [[1, 2], [3, 4]] } }, OUT);
  assert.equal(built.ok, true, built.reason);
  const scriptPath = scriptPathFor(OUT, 'unit-surf');
  writeFileSync(scriptPath, built.value.code, 'utf8');
  await runScript(scriptPath, {});
  assert.equal(existsSync(built.value.outFile), true);
  const fig = readFigure(OUT, 'unit-surf.svg');
  assert.equal(fig.mimeType, 'image/svg+xml');
});

test('fake 缝：FAKE_MATLAB_FAIL 时返回结构化错误', async () => {
  process.env.FAKE_MATLAB_FAIL = '1';
  const built = buildPlotScript({ type: 'line', name: 'unit-fail', data: { y: [1] } }, OUT);
  const scriptPath = scriptPathFor(OUT, 'unit-fail');
  writeFileSync(scriptPath, built.value.code, 'utf8');
  const run = await runScript(scriptPath, {});
  delete process.env.FAKE_MATLAB_FAIL;
  assert.equal(run.exitCode, 1);
  assert.equal(run.result?.ok, false);
});

test('fake 缝：超时被捕获', async () => {
  process.env.FAKE_MATLAB_SLEEP_MS = '3000';
  const built = buildPlotScript({ type: 'line', name: 'unit-slow', data: { y: [1] } }, OUT);
  const scriptPath = scriptPathFor(OUT, 'unit-slow');
  writeFileSync(scriptPath, built.value.code, 'utf8');
  const run = await runScript(scriptPath, { timeoutMs: 500 });
  delete process.env.FAKE_MATLAB_SLEEP_MS;
  assert.equal(run.timedOut, true);
  assert.equal(run.error, 'timeout');
});

test('figures：列清单 + 非法名拒绝', () => {
  const ls = listFigures(OUT);
  assert.ok(ls.figures.some((f) => f.name === 'unit-line.png'));
  assert.equal(readFigure(OUT, '../secret.png').error, 'invalid-identifier');
  assert.equal(readFigure(OUT, 'missing.png').error, 'not-found');
  assert.equal(readFigure(OUT, 'unit-line.exe').error, 'unsupported-format');
});

test('fake 缝：matlab_env 探测', async () => {
  const { matlabEnv } = await import('./lib.mjs');
  const env = await matlabEnv({ timeoutMs: 10000 });
  assert.equal(env.available, true);
  assert.equal(env.release, 'R2023b');
  assert.ok(env.toolboxes.includes('MATLAB'));
});

// ---------- 持久化会话 ----------
test('会话：execScript 走会话模式、跨调用复用、sidecar 清理', async () => {
  process.env.FAKE_MATLAB_IDLE_MS = '120000';
  const writeOne = (spec, name) => {
    const built = buildPlotScript(spec, OUT);
    assert.equal(built.ok, true, built.reason);
    const p = scriptPathFor(OUT, name);
    writeFileSync(p, built.value.code.replace(/%SELF_PATH%/g, p.replace(/\\/g, '/')), 'utf8');
    return { p, outFile: built.value.outFile };
  };
  const a = writeOne({ type: 'line', name: 'sess-line', data: { x: [1, 2, 3], y: [[1, 2, 3]] } }, 'sess-line');
  const r1 = await execScript(a.p, { outDir: OUT, timeoutMs: 30000 });
  assert.equal(r1.mode, 'session', JSON.stringify(r1).slice(0, 300));
  assert.equal(r1.result?.ok, true, JSON.stringify(r1).slice(0, 300));
  assert.equal(existsSync(a.outFile), true);

  const b = writeOne({ type: 'bar', name: 'sess-bar', data: { y: [1, 2, 3] } }, 'sess-bar');
  const r2 = await execScript(b.p, { outDir: OUT, timeoutMs: 30000 });
  assert.equal(r2.mode, 'session');
  assert.equal(r2.result?.ok, true);
  assert.equal(existsSync(b.outFile), true);

  const st = sessionStatus(OUT);
  assert.equal(st.mode, 'session');
  assert.equal(existsSync(`${a.p}.result.json`), false, 'sidecar 应被读取后清理');
  await stopSession(OUT);
  assert.equal(sessionStatus(OUT).mode, 'none');
  delete process.env.FAKE_MATLAB_IDLE_MS;
});

test('会话：MATLAB_MATE_SESSION=never 时走一次性模式', async () => {
  const prev = process.env.MATLAB_MATE_SESSION;
  process.env.MATLAB_MATE_SESSION = 'never';
  const built = buildPlotScript({ type: 'line', name: 'oneshot-line', data: { y: [1, 2] } }, OUT);
  const p = scriptPathFor(OUT, 'oneshot-line');
  writeFileSync(p, built.value.code.replace(/%SELF_PATH%/g, p.replace(/\\/g, '/')), 'utf8');
  const r = await execScript(p, { outDir: OUT, timeoutMs: 30000 });
  assert.equal(r.mode, 'oneshot', JSON.stringify(r).slice(0, 300));
  assert.equal(r.result?.ok, true);
  process.env.MATLAB_MATE_SESSION = prev;
});

test('会话：批量合并执行返回逐图结果', async () => {
  process.env.FAKE_MATLAB_IDLE_MS = '120000';
  const writeOne = (spec, name) => {
    const built = buildPlotScript(spec, OUT);
    const p = scriptPathFor(OUT, name);
    writeFileSync(p, built.value.code.replace(/%SELF_PATH%/g, p.replace(/\\/g, '/')), 'utf8');
    return { p, outFile: built.value.outFile, name };
  };
  const a = writeOne({ type: 'line', name: 'batch-a', data: { y: [1, 2] } }, 'batch-a');
  const b = writeOne({ type: 'pie', name: 'batch-b', data: { y: [1, 2, 3] } }, 'batch-b');
  const combinedPath = scriptPathFor(OUT, `batch-test-${Date.now().toString(36)}`);
  writeFileSync(combinedPath, [a.p, b.p].map((p) => `run('${p.replace(/\\/g, '/')}');`).join('\n'), 'utf8');
  const r = await execScript(combinedPath, { outDir: OUT, timeoutMs: 30000 });
  assert.equal(r.mode, 'session');
  const names = (r.results ?? []).map((x) => x?.name).sort();
  assert.deepEqual(names, ['batch-a', 'batch-b']);
  assert.equal(existsSync(a.outFile), true);
  assert.equal(existsSync(b.outFile), true);
  await stopSession(OUT);
  delete process.env.FAKE_MATLAB_IDLE_MS;
});
