/**
 * step-matlab-plot 代码生成：结构化 plot spec → MATLAB .m 脚本。
 * 纯函数、可单测；所有字符串经 matlabStr 转义，所有数字经有限性校验，
 * 用户输入永远以"数据"身份出现，不拼接进 MATLAB 语句结构。
 */
import {
  matlabStr, toNumVector, toNumMatrix, toStrVector,
  resolveDataFile, assertFormat, assertFigureName, ok, fail,
  MAX_SERIES_COUNT, countInlineNumbers, MAX_TOTAL_NUMBERS, MAX_SCRIPT_CHARS, MAX_SERIES_POINTS,
} from './validate.mjs';

export const PLOT_TYPES = {
  line:     { data: ['y'], opt: ['x'], desc: '折线图（支持多序列）' },
  scatter:  { data: ['y'], opt: ['x'], desc: '散点图' },
  bar:      { data: ['y'], opt: ['x'], desc: '柱状图' },
  barh:     { data: ['y'], opt: ['x'], desc: '水平柱状图' },
  histogram:{ data: ['y'], opt: ['binCount'], desc: '直方图' },
  area:     { data: ['y'], opt: ['x'], desc: '面积图' },
  pie:      { data: ['y'], opt: ['labels'], desc: '饼图' },
  stem:     { data: ['y'], opt: ['x'], desc: '火柴图' },
  stairs:   { data: ['y'], opt: ['x'], desc: '阶梯图' },
  errorbar: { data: ['y', 'err'], opt: ['x'], desc: '误差棒图' },
  loglog:   { data: ['y'], opt: ['x'], desc: '双对数折线' },
  semilogx: { data: ['y'], opt: ['x'], desc: 'x 对数折线' },
  semilogy: { data: ['y'], opt: ['x'], desc: 'y 对数折线' },
  boxplot:  { data: ['groups'], opt: ['labels'], desc: '箱线图（groups=数组的数组）' },
  surf:     { data: ['z'], opt: ['x', 'y'], desc: '三维曲面（z 为矩阵）' },
  heatmap:  { data: ['z'], opt: ['x', 'y'], desc: '热力图（z 为矩阵，x/y 为标签）' },
};

const fmtNum = (n) => (Object.is(n, -0) ? '0' : String(n));

/** 纯数字序列 1, 2, 3（不带括号） */
const nums = (v) => v.map(fmtNum).join(', ');

/** 行向量 [a,b,c] */
function emitRowVec(v) { return `[${nums(v)}]`; }

/** 矩阵：行=系列（或矩阵行），分号分隔 */
function emitMatrix(rows) { return `[${rows.map(nums).join('; ')}]`; }

/** 行 cellstr {'a','b'} */
function emitCellRow(v) { return `{${v.map(matlabStr).join(', ')}}`; }

/** boxplot 分组：各组长度可不同（ragged），逐组校验，返回二维数组 */
function emitGroups(groups) {
  if (!Array.isArray(groups) || groups.length === 0) return fail('data.groups 必须是非空数组的数组');
  if (groups.length > MAX_SERIES_COUNT) return fail(`data.groups 最多 ${MAX_SERIES_COUNT} 组`);
  const rows = [];
  for (let i = 0; i < groups.length; i++) {
    const r = toNumVector(groups[i], `data.groups[${i}]`);
    if (!r.ok) return r;
    rows.push(r.value);
  }
  return ok(rows);
}

/** y 的形状：{rows: 每组点数, cols: 系列数} */
function yShape(yInput) {
  if (!Array.isArray(yInput)) return ok({ rows: 0, cols: 0 });
  const isNested = Array.isArray(yInput) && Array.isArray(yInput[0]);
  if (isNested) return ok({ rows: yInput[0].length, cols: yInput.length });
  return ok({ rows: yInput.length, cols: 1 });
}

/** 归一化 y：统一为"列=系列"的矩阵字面量 */
function emitSeriesMatrix(yInput) {
  const isNested = Array.isArray(yInput) && Array.isArray(yInput[0]);
  if (isNested) {
    const m = toNumMatrix(yInput, 'data.y');
    if (!m.ok) return m;
    return ok(`${emitMatrix(m.value)}'`);
  }
  const v = toNumVector(yInput, 'data.y');
  if (!v.ok) return v;
  return ok(`${emitRowVec(v.value)}'`);
}

/** 归一化 err：与 y 同形 */
function emitErrMatrix(errInput) {
  const isNested = Array.isArray(errInput) && Array.isArray(errInput[0]);
  if (isNested) {
    const m = toNumMatrix(errInput, 'data.err');
    if (!m.ok) return m;
    return ok(`${emitMatrix(m.value)}'`);
  }
  const v = toNumVector(errInput, 'data.err');
  if (!v.ok) return v;
  return ok(`${emitRowVec(v.value)}'`);
}

/** x 轴：数值向量 / 分类标签 / 省略（默认 1:size(yData,1)） */
function emitX(spec) {
  const x = spec?.data?.x;
  if (x === undefined || x === null) return ok('xData = 1:size(yData, 1);');
  if (Array.isArray(x) && x.every((s) => typeof s === 'string')) {
    const s = toStrVector(x, 'data.x');
    if (!s.ok) return s;
    // 空串/重复标签会被双参数 categorical 运行期拒绝，生成期前置拦截给可读错误
    if (s.value.some((v) => v.trim() === '')) return fail('data.x 分类标签不能为空字符串');
    if (new Set(s.value).size !== s.value.length) return fail('data.x 分类标签不能重复（categorical 要求唯一类别名）');
    return ok(`xData = categorical(${emitCellRow(s.value)}, ${emitCellRow(s.value)});`);
  }
  const v = toNumVector(x, 'data.x');
  if (!v.ok) return v;
  return ok(`xData = ${emitRowVec(v.value)}';`);
}

/** 数据段：CSV / JSON 文件优先，否则内联 */
function emitDataSection(spec) {
  const lines = [];
  const csv = spec?.data?.csv;
  const json = spec?.data?.json;
  if (csv || json) {
    const key = csv ? 'csv' : 'json';
    const r = resolveDataFile(spec.data[key]);
    if (!r.ok) return r;
    if (csv) {
      lines.push(`fileData = readmatrix(${matlabStr(r.value)});`);
      lines.push("if isvector(fileData), yData = fileData(:).'; else yData = fileData; end");
      // 文件通道与内联同阈值：防 9.8MB JSON/200 万点绕过内联上限（实测 5.3s 成功）
      lines.push('if size(yData, 1) > ' + MAX_SERIES_POINTS + ' || numel(yData) > ' + MAX_TOTAL_NUMBERS + ", error('MATLAB:stepcode:tooManyPoints', '数据规模超过上限（点数与总量）'); end");
    } else {
      lines.push(`fileText = fileread(${matlabStr(r.value)});`);
      lines.push('jsonPayload = jsondecode(fileText);');
      // 方向修正：嵌套 [[s1],[s2]] → 点数×系列（每组成一列）；平坦数组 → 列向量。
      // 旧实现 v(:). 横向拼接：1×N 被 64 列截断后全部画在 x=1（静默失真）。
      lines.push('if iscell(jsonPayload.y)');
      lines.push("  yData = cell2mat(cellfun(@(v) double(v(:)), jsonPayload.y, 'UniformOutput', false));");
      lines.push('else');
      lines.push('  yData = double(jsonPayload.y(:));');
      lines.push('end');
      // 文件通道与内联同阈值：防 9.8MB JSON/200 万点绕过内联上限（实测 5.3s 成功）
      lines.push('if size(yData, 1) > ' + MAX_SERIES_POINTS + ' || numel(yData) > ' + MAX_TOTAL_NUMBERS + ", error('MATLAB:stepcode:tooManyPoints', '数据规模超过上限（点数与总量）'); end");
    }
    return ok(lines.join('\n'));
  }
  return ok(null);
}

const CATEGORICAL_TYPES = new Set(['scatter', 'errorbar']);
const LEGEND_TYPES = new Set(['line', 'scatter', 'bar', 'barh', 'area', 'stem', 'stairs', 'errorbar', 'loglog', 'semilogx', 'semilogy']);

function xIsCategorical(spec) {
  const x = spec?.data?.x;
  return Array.isArray(x) && x.length > 0 && x.every((s) => typeof s === 'string');
}

const PLOT_FN = { line: 'plot', area: 'area', stem: 'stem', stairs: 'stairs', loglog: 'loglog', semilogx: 'semilogx', semilogy: 'semilogy' };
const LOG_TYPES = new Set(['loglog', 'semilogx', 'semilogy']);
const NO_X_TYPES = new Set(['histogram', 'pie']);
// 图形句柄 → 可用样式属性矩阵。不支持的属性在生成期忽略并告警，
// 避免产出运行期必败的代码（Scatter 无 Color/LineStyle；Bar/Area 无 Color/Marker 等）。
const STYLE_PROPS = {
  line: { color: 'Color', lineStyle: 'LineStyle', lineWidth: 'LineWidth', marker: 'Marker', name: 'DisplayName' },
  area: { color: 'FaceColor', lineStyle: 'LineStyle', lineWidth: 'LineWidth', name: 'DisplayName' },
  stem: { color: 'Color', lineStyle: 'LineStyle', lineWidth: 'LineWidth', marker: 'Marker', name: 'DisplayName' },
  stairs: { color: 'Color', lineStyle: 'LineStyle', lineWidth: 'LineWidth', marker: 'Marker', name: 'DisplayName' },
  errorbar: { color: 'Color', lineStyle: 'LineStyle', lineWidth: 'LineWidth', marker: 'Marker', name: 'DisplayName' },
  loglog: { color: 'Color', lineStyle: 'LineStyle', lineWidth: 'LineWidth', marker: 'Marker', name: 'DisplayName' },
  semilogx: { color: 'Color', lineStyle: 'LineStyle', lineWidth: 'LineWidth', marker: 'Marker', name: 'DisplayName' },
  semilogy: { color: 'Color', lineStyle: 'LineStyle', lineWidth: 'LineWidth', marker: 'Marker', name: 'DisplayName' },
  scatter: { color: 'MarkerFaceColor', lineWidth: 'LineWidth', marker: 'Marker', name: 'DisplayName' },
  bar: { color: 'FaceColor', lineWidth: 'LineWidth', name: 'DisplayName' },
  barh: { color: 'FaceColor', lineWidth: 'LineWidth', name: 'DisplayName' },
  histogram: { color: 'FaceColor', lineWidth: 'LineWidth', name: 'DisplayName' },
};

/** 各图形类型 → 绘图语句（x/y/z/err 变量已在数据段就绪） */
function buildPlotSection(type, spec) {
  const L = [];
  const cat = xIsCategorical(spec);
  switch (type) {
    case 'line': {
      // 单点数据不成线：补 marker 否则图为空白（实测 1 点出图无数据痕迹）
      const shape = yShape(spec?.data?.y);
      const single = shape.ok && shape.value.rows === 1; // 单点数据（含多系列各 1 点）不成线，补 marker
      L.push(single ? `chartHandles = plot(xData, yData, 'Marker', 'o');` : `chartHandles = plot(xData, yData);`);
      break;
    }
    case 'area':
    case 'stem':
    case 'stairs':
    case 'loglog':
    case 'semilogx':
    case 'semilogy':
      L.push(`chartHandles = ${PLOT_FN[type]}(xData, yData);`);
      break;
    case 'scatter': {
      L.push('hold on;');
      if (cat) L.push('xNumeric = double(xData);', 'xticks(1:numel(categories(xData)));', 'xticklabels(categories(xData));');
      else L.push('xNumeric = xData;');
      L.push('chartHandles = gobjects(1, size(yData, 2));');
      L.push('for seriesIdx = 1:size(yData, 2)', `  chartHandles(seriesIdx) = scatter(xNumeric, yData(:, seriesIdx), markerSize, 'filled');`, 'end', 'hold off;');
      break;
    }
    case 'bar':
    case 'barh':
      L.push(`chartHandles = ${type}(xData, yData);`);
      break;
    case 'histogram': {
      const n = spec?.data?.binCount;
      if (n !== undefined) {
        if (!Number.isInteger(n) || n < 1 || n > 10000) return fail('data.binCount 必须是 1-10000 的整数');
        L.push(`chartHandles = histogram(yData, 'NumBins', ${n});`);
      } else {
        L.push('chartHandles = histogram(yData);');
      }
      break;
    }
    case 'pie': {
      // yData 已转置为列向量，pie 直接接收
      const labels = spec?.data?.labels;
      if (labels !== undefined) {
        const s = toStrVector(labels, 'data.labels');
        if (!s.ok) return s;
        L.push(`chartHandles = pie(yData, ${emitCellRow(s.value)});`);
      } else {
        L.push('chartHandles = pie(yData);');
      }
      break;
    }
    case 'errorbar': {
      if (cat) L.push('xNumeric = double(xData);', 'xticks(1:numel(categories(xData)));', 'xticklabels(categories(xData));');
      else L.push('xNumeric = xData;');
      L.push('chartHandles = gobjects(1, size(yData, 2));');
      L.push('hold on;', 'for seriesIdx = 1:size(yData, 2)', '  chartHandles(seriesIdx) = errorbar(xNumeric, yData(:, seriesIdx), errData(:, seriesIdx), \'o-\');', 'end', 'hold off;');
      break;
    }
    case 'boxplot': {
      // boxplot(groupData, groupIdx)：数据 + 分组下标向量（cell 首参已被现代 MATLAB 拒绝）
      const labels = spec?.data?.labels;
      if (labels !== undefined) {
        const s = toStrVector(labels, 'data.labels');
        if (!s.ok) return s;
        L.push(`chartHandles = boxplot(groupData, groupIdx, 'Labels', ${emitCellRow(s.value)});`);
      } else {
        L.push('chartHandles = boxplot(groupData, groupIdx);');
      }
      break;
    }
    case 'surf':
      L.push('[gridX, gridY] = meshgrid(xData, yNumeric);', 'chartHandles = surf(gridX, gridY, zData);');
      break;
    case 'heatmap': {
      const xl = spec?.data?.x;
      const yl = spec?.data?.y;
      if (xl !== undefined || yl !== undefined) {
        const sx = xl !== undefined ? toStrVector(xl, 'data.x') : ok(null);
        if (!sx.ok) return sx;
        const sy = yl !== undefined ? toStrVector(yl, 'data.y') : ok(null);
        if (!sy.ok) return sy;
        const xArg = sx.value ? emitCellRow(sx.value) : '1:size(zData, 2)';
        const yArg = sy.value ? emitCellRow(sy.value) : '1:size(zData, 1)';
        L.push(`chartHandles = heatmap(${xArg}, ${yArg}, zData);`);
      } else {
        L.push('chartHandles = heatmap(zData);');
      }
      break;
    }
    default:
      return fail(`不支持的图形类型：${type}`);
  }
  return ok(L.join('\n'));
}

const LINE_STYLES = new Set(['-', '--', ':', '-.', 'none']);
const MARKERS = new Set(['o', '+', '*', '.', 'x', 's', 'd', '^', 'v', '>', '<', 'p', 'h', 'none']);
// 颜色名白名单：仅字母（覆盖 red/none/r/k 等），从根上杜绝引号/括号注入 MATLAB 语句
const COLOR_NAME_RE = /^[A-Za-z]{1,24}$/;
const MAX_TEXT_LEN = 2000;

/** 颜色：名字符串走白名单；[r,g,b] 校验 0-1；返回 MATLAB 字面量（先拷贝后发射，避免双读） */
function validateColor(v, what) {
  if (typeof v === 'string') {
    if (!COLOR_NAME_RE.test(v)) return fail(`${what} 颜色名仅允许字母（如 red/blue/none），或改用 [r,g,b]（0-1）`);
    return ok(`'${v}'`);
  }
  if (Array.isArray(v) && v.length === 3 && v.every((c) => typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1)) {
    const copy = v.map((c) => Number(c));
    return ok(`[${copy.map(fmtNum).join(' ')}]`);
  }
  return fail(`${what} 须为颜色名（字母）或 [r,g,b]（各分量 0-1）`);
}

const COLORMAPS = new Set([
  'parula', 'jet', 'hsv', 'hot', 'cool', 'spring', 'summer', 'autumn', 'winter',
  'gray', 'bone', 'copper', 'pink', 'lines', 'colorcube', 'prism', 'flag',
  'white', 'turbo', 'sky', 'abyss', 'seed3', 'default',
]);

function validateText(v, what) {
  if (typeof v !== 'string') return fail(`${what} 必须是字符串`);
  if (v.length > MAX_TEXT_LEN) return fail(`${what} 超过 ${MAX_TEXT_LEN} 字符上限`);
  // 控制字符会生成无法解析的 MATLAB 字符串字面量
  if (/[\r\n\t\u0000-\u001f]/.test(v)) return fail(`${what} 含有控制字符（换行/制表符等）`);
  return ok(v);
}

function validateStyle(spec) {
  const style = spec?.style;
  if (style === undefined || style === null) return ok(null);
  if (typeof style !== 'object' || Array.isArray(style)) return fail('style 必须是对象');
  const out = {};
  if (style.lineWidth !== undefined) {
    if (typeof style.lineWidth !== 'number') return fail('style.lineWidth 必须是数字');
    const n = style.lineWidth;
    if (!Number.isFinite(n) || n < 0.1 || n > 20) return fail('style.lineWidth 须在 0.1-20');
    out.lineWidth = Number(n.toFixed(6));
  }
  if (style.markerSize !== undefined) {
    if (typeof style.markerSize !== 'number') return fail('style.markerSize 必须是数字');
    const n = style.markerSize;
    if (!Number.isFinite(n) || n < 1 || n > 200) return fail('style.markerSize 须在 1-200');
    out.markerSize = Math.floor(n);
  }
  if (style.color !== undefined) {
    const c = validateColor(style.color, 'style.color');
    if (!c.ok) return c;
    out.color = c.value;
  }
  if (style.lineStyle !== undefined) {
    if (!LINE_STYLES.has(style.lineStyle)) return fail(`style.lineStyle 仅支持 ${[...LINE_STYLES].join(' ')}`);
    out.lineStyle = `'${style.lineStyle}'`;
  }
  if (style.marker !== undefined) {
    if (!MARKERS.has(style.marker)) return fail(`style.marker 仅支持 ${[...MARKERS].join(' ')}`);
    out.marker = `'${style.marker}'`;
  }
  return ok(out);
}

function validateSeries(spec) {
  const series = spec?.series;
  if (series === undefined || series === null) return ok(null);
  if (!Array.isArray(series) || series.length > 64) return fail('series 必须是长度 ≤64 的数组');
  const out = [];
  for (let i = 0; i < series.length; i++) {
    const s = series[i] ?? {};
    if (typeof s !== 'object' || Array.isArray(s)) return fail(`series[${i}] 必须是对象`);
    const item = {};
    if (s.name !== undefined) {
      const t = validateText(s.name, `series[${i}].name`);
      if (!t.ok) return t;
      item.name = matlabStr(t.value);
    }
    if (s.color !== undefined) {
      const c = validateColor(s.color, `series[${i}].color`);
      if (!c.ok) return c;
      item.color = c.value;
    }
    if (s.lineStyle !== undefined) {
      if (!LINE_STYLES.has(s.lineStyle)) return fail(`series[${i}].lineStyle 非法`);
      item.lineStyle = `'${s.lineStyle}'`;
    }
    if (s.marker !== undefined) {
      if (!MARKERS.has(s.marker)) return fail(`series[${i}].marker 非法`);
      item.marker = `'${s.marker}'`;
    }
    if (s.lineWidth !== undefined) {
      if (typeof s.lineWidth !== 'number') return fail(`series[${i}].lineWidth 必须是数字`);
      const n = s.lineWidth;
      if (!Number.isFinite(n) || n < 0.1 || n > 20) return fail(`series[${i}].lineWidth 须在 0.1-20`);
      item.lineWidth = String(Number(n.toFixed(6)));
    }
    out.push(item);
  }
  return ok(out);
}

export function validateSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return fail('spec 必须是对象');
  const type = spec.type;
  if (typeof type !== 'string' || !Object.hasOwn(PLOT_TYPES, type)) {
    return fail(`不支持的图形类型：${JSON.stringify(type)}；可选：${Object.keys(PLOT_TYPES).join(', ')}`);
  }
  const fmt = assertFormat(spec.format ?? 'png');
  if (!fmt.ok) return fmt;
  const name = assertFigureName(spec.name ?? 'figure', fmt.value);
  if (!name.ok) return name;
  const data = spec.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail('spec.data 必须是对象');
  const fromFile = data.csv !== undefined || data.json !== undefined;
  for (const key of PLOT_TYPES[type].data) {
    if (data[key] === undefined || data[key] === null) {
      // csv/json 模式下 y 来自文件，其余必需字段仍须内联提供
      if (fromFile && key === 'y') continue;
      return fail(`图形 ${type} 需要 data.${key}`);
    }
  }
  if ((type === 'pie' || type === 'histogram') && Array.isArray(data.y) && Array.isArray(data.y[0])) {
    return fail(`${type} 仅支持一维 data.y`);
  }
  if (data.csv !== undefined && data.json !== undefined) return fail('data.csv 与 data.json 只能二选一');
  if ((data.csv !== undefined || data.json !== undefined) && (data.x !== undefined || data.err !== undefined)) {
    return fail('data.csv/json 模式下 y 来自文件，不支持内联 data.x/data.err');
  }
  const totalNumbers = countInlineNumbers(data.y) + countInlineNumbers(data.err) + countInlineNumbers(data.z) + countInlineNumbers(data.groups);
  if (totalNumbers > MAX_TOTAL_NUMBERS) {
    return fail(`内联数字总量 ${totalNumbers} 超过上限 ${MAX_TOTAL_NUMBERS}；请改用 data.csv 或减少数据量`);
  }
  const style = validateStyle(spec);
  if (!style.ok) return style;
  const series = validateSeries(spec);
  if (!series.ok) return series;
  // series 数量与内联 y 的系列数交叉校验（避免运行期属性赋值爆炸）
  if (Array.isArray(series.value) && Array.isArray(data.y) && data.y.length > 0 && !data.csv && !data.json) {
    const sc = yShape(data.y);
    if (sc.ok && sc.value.cols !== series.value.length) {
      return fail(`series 数量（${series.value.length}）须与 data.y 系列数（${sc.value.cols}）一致`);
    }
  }
  if (spec.legend !== undefined) {
    if (spec.legend === 'auto' || spec.legend === 'none') { /* ok */ }
    else if (Array.isArray(spec.legend) && spec.legend.every((s) => typeof s === 'string')) { /* ok */ }
    else return fail("legend 仅支持 'auto' | 'none' | 字符串数组");
  }
  if (spec.size !== undefined) {
    const s = spec.size;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return fail('size 必须是对象 {width,height}');
    for (const k of ['width', 'height']) {
      if (s[k] !== undefined) {
        if (typeof s[k] !== 'number') return fail(`size.${k} 必须是数字`);
        if (!Number.isFinite(s[k]) || s[k] < 100 || s[k] > 8000) return fail(`size.${k} 须在 100-8000 像素`);
      }
    }
  }
  return ok({ type, format: fmt.value, name: name.value, style: style.value, series: series.value });
}

/** 组装完整 .m 脚本。options.standalone=true 时面向一次性 -batch（失败 exit(1)） */
export function buildPlotScript(spec, outDir, options = {}) {
  const v = validateSpec(spec);
  if (!v.ok) return v;
  const { type, format, name, style, series } = v.value;
  const data = spec.data;
  const L = [];

  // ---- 数据段 ----
  const fromFile = emitDataSection(spec);
  if (!fromFile.ok) return fromFile;
  if (fromFile.value) {
    L.push(fromFile.value);
    // 文件数据为 点数×系列 矩阵：系列数（列）截到 64，点数（行）不动
    L.push('yData = yData(:, 1:min(end, 64));');
    if (!NO_X_TYPES.has(type)) L.push('xData = 1:size(yData, 1);');
  } else {
    switch (type) {
      case 'boxplot': {
        const g = emitGroups(data.groups);
        if (!g.ok) return g;
        // boxplot(groupData, groupIdx)：拼接数据 + 分组下标向量（cell 首参已被现代 MATLAB 拒绝）
        const flat = [];
        const gidx = [];
        g.value.forEach((grp, i) => {
          for (const val of grp) { flat.push(val); gidx.push(i + 1); }
        });
        L.push(`groupData = ${emitRowVec(flat)};`);
        L.push(`groupIdx = ${emitRowVec(gidx)};`);
        if (data.labels !== undefined) {
          const s = toStrVector(data.labels, 'data.labels');
          if (!s.ok) return s;
          if (s.value.length !== g.value.length) return fail(`data.labels 数量（${s.value.length}）须与分组数（${g.value.length}）一致`);
        }
        break;
      }
      case 'surf':
      case 'heatmap': {
        const z = toNumMatrix(data.z, 'data.z');
        if (!z.ok) return z;
        const zRows = z.value.length;
        const zCols = z.value[0].length;
        if (type === 'heatmap') {
          // heatmap：x/y 为标签数组，数量须与 z 的列/行数一致
          if (data.x !== undefined) {
            const sx = toStrVector(data.x, 'data.x');
            if (!sx.ok) return sx;
            if (sx.value.length !== zCols) return fail(`heatmap 的 data.x 标签数（${sx.value.length}）须等于 z 的列数（${zCols}）`);
          }
          if (data.y !== undefined) {
            const sy = toStrVector(data.y, 'data.y');
            if (!sy.ok) return sy;
            if (sy.value.length !== zRows) return fail(`heatmap 的 data.y 标签数（${sy.value.length}）须等于 z 的行数（${zRows}）`);
          }
        }
        L.push(`zData = ${emitMatrix(z.value)};`);
        if (type === 'surf') {
          // surf：x/y 为数值轴向量（须在 z 之后，长度须与 z 维度一致）
          if (data.x !== undefined) {
            const sx = toNumVector(data.x, 'data.x');
            if (!sx.ok) return sx;
            if (sx.value.length !== zCols) return fail(`surf 的 data.x 长度（${sx.value.length}）须等于 z 的列数（${zCols}）`);
            L.push(`xData = ${emitRowVec(sx.value)};`);
          } else {
            L.push('xData = 1:size(zData, 2);');
          }
          if (data.y !== undefined) {
            const sy = toNumVector(data.y, 'data.y');
            if (!sy.ok) return sy;
            if (sy.value.length !== zRows) return fail(`surf 的 data.y 长度（${sy.value.length}）须等于 z 的行数（${zRows}）`);
            L.push(`yNumeric = ${emitRowVec(sy.value)};`);
          } else {
            L.push('yNumeric = 1:size(zData, 1);');
          }
        }
        break;
      }
      default: {
        const ym = emitSeriesMatrix(data.y);
        if (!ym.ok) return ym;
        const shape = yShape(data.y);
        if (!shape.ok) return shape;
        const { rows: yRows, cols: yCols } = shape.value;
        L.push(`yData = ${ym.value};`);
        if (type === 'errorbar') {
          const em = emitErrMatrix(data.err);
          if (!em.ok) return em;
          const es = yShape(data.err);
          if (!es.ok) return es;
          if (es.value.rows !== yRows || es.value.cols !== yCols) {
            return fail(`data.err 形状须与 data.y 一致（y ${yRows}×${yCols}，err ${es.value.rows}×${es.value.cols}）`);
          }
          L.push(`errData = ${em.value};`);
        }
        // x 与 y 的形状交叉校验；log 族不接受分类轴
        const x = data.x;
        if (x !== undefined && x !== null) {
          const xLen = Array.isArray(x) ? x.length : -1;
          const isCat = Array.isArray(x) && x.every((s) => typeof s === 'string');
          if (xLen !== yRows) return fail(`data.x 长度（${xLen}）须与 data.y 每系列点数（${yRows}）一致`);
          if (isCat && LOG_TYPES.has(type)) return fail(`${type} 不支持分类 x 轴，data.x 必须为数值向量`);
        }
        // pie：标签数量与负值校验
        if (type === 'pie') {
          const flatY = Array.isArray(data.y) && Array.isArray(data.y[0]) ? data.y[0] : data.y;
          if (flatY.some((n) => n < 0)) return fail('pie 不接受负值');
          if (data.labels !== undefined) {
            const s = toStrVector(data.labels, 'data.labels');
            if (!s.ok) return s;
            if (s.value.length !== yRows) return fail(`pie 的 data.labels 数量（${s.value.length}）须与 data.y 长度（${yRows}）一致`);
          }
        }
        const xr = emitX(spec);
        if (!xr.ok) return xr;
        // histogram/pie 不使用 x 轴变量，发射会是无用且误导的代码
        if (!NO_X_TYPES.has(type)) L.push(xr.value);
        break;
      }
    }
  }

  // ---- 画布 ----
  const size = spec.size ?? {};
  const W = Math.floor(Number(size.width ?? 960));
  const H = Math.floor(Number(size.height ?? 600));
  // 显式设置 groot 默认值：R2026a 无头环境 FactoryAxesColor 为深色（#121212），
  // 尽管 axes.Color 读作白色，导出图绘图区仍近黑——「出版级」图需白底黑字
  L.push("set(groot, 'DefaultAxesColor', 'w', 'DefaultAxesXColor', 'k', 'DefaultAxesYColor', 'k', 'DefaultAxesZColor', 'k', 'DefaultAxesGridColor', [0.8 0.8 0.8]);");
  L.push(`figHandle = figure('Visible', 'off', 'Color', 'w', 'Units', 'pixels', 'Position', [0 0 ${W} ${H}]);`);

  // ---- 绘图段 ----
  if (type === 'scatter') L.push(`markerSize = ${style?.markerSize ?? 36};`);
  const plot = buildPlotSection(type, spec);
  if (!plot.ok) return plot;
  L.push(plot.value);

  // ---- 系列样式（按图形类型分派属性；不支持的属性忽略并告警） ----
  const props = STYLE_PROPS[type] ?? null;
  const styleLines = [];
  const warnings = [];
  const applyProp = (target, key, val) => {
    if (!props || props[key] === undefined) {
      const w = `${type} 不支持 ${key} 样式属性，已忽略`;
      if (!warnings.includes(w)) warnings.push(w);
      return;
    }
    // 全局样式作用于句柄数组，必须用 set()；单系列句柄 chartHandles(i) 可用点赋值
    styleLines.push(target === 'figStyle' ? `set(chartHandles, '${props[key]}', ${val});` : `${target}.${props[key]} = ${val};`);
  };
  if (props) {
    if (style?.lineWidth) applyProp('figStyle', 'lineWidth', style.lineWidth);
    if (style?.color) applyProp('figStyle', 'color', style.color);
    if (style?.lineStyle) applyProp('figStyle', 'lineStyle', style.lineStyle);
    if (style?.marker) applyProp('figStyle', 'marker', style.marker);
  } else if (style?.color || style?.lineStyle || style?.marker || series) {
    warnings.push(`${type} 不支持系列样式（style/series 颜色与线型），已忽略`);
  }
  if (type !== 'scatter' && style?.markerSize !== undefined) {
    warnings.push('style.markerSize 仅对 scatter 生效，已忽略');
  }
  if (series) {
    series.forEach((s, i) => {
      const idx = `chartHandles(${i + 1})`;
      for (const [k, v] of Object.entries(s)) {
        if (v === undefined) continue;
        applyProp(idx, k, v);
      }
    });
  }
  if (styleLines.length) L.push(styleLines.join('\n'));

  // ---- 装饰 ----
  const deco = [];
  const textFields = [['title', 'title'], ['xlabel', 'xlabel'], ['ylabel', 'ylabel']];
  if (type === 'surf') textFields.push(['zlabel', 'zlabel']);
  else if (spec.zlabel !== undefined) warnings.push('zlabel 仅对 surf 生效，已忽略');
  for (const [key, fn] of textFields) {
    if (spec[key] !== undefined) {
      const t = validateText(spec[key], key);
      if (!t.ok) return t;
      deco.push(`${fn}(${matlabStr(t.value)});`);
    }
  }
  if (spec.colormap !== undefined) {
    const t = validateText(spec.colormap, 'colormap');
    if (!t.ok) return t;
    if (!COLORMAPS.has(t.value.toLowerCase())) {
      return fail(`colormap 仅支持：${[...COLORMAPS].join(', ')}`);
    }
    deco.push(`colormap(${matlabStr(t.value)});`);
  }
  if (spec.colorbar === true) deco.push('colorbar;');
  if (spec.grid === true || (spec.grid === undefined && type !== 'pie')) deco.push('grid on;');
  if (spec.grid === false) deco.push('grid off;');
  // 注意：legend 各分支必须是独立 if——曾因 else-if 挂在 grid 判断上，
  // 导致 grid:false 时 legend 指令被静默丢弃。
  if (spec.legend === 'none') {
    deco.push("legend('off');");
  } else if (Array.isArray(spec.legend)) {
    const s = toStrVector(spec.legend, 'legend');
    if (!s.ok) return s;
    if (Array.isArray(data.y) && data.y.length > 0) {
      const sc = yShape(data.y);
      if (sc.ok && sc.value.cols !== s.value.length) {
        return fail(`legend 数量（${s.value.length}）须与系列数（${sc.value.cols}）一致`);
      }
    }
    deco.push(`legend(${emitCellRow(s.value)});`);
  } else if (LEGEND_TYPES.has(type) && (spec.legend === 'auto' || series?.some((s) => s.name))) {
    deco.push("legend('show');");
  }
  if (deco.length) L.push(deco.join('\n'));

  // ---- 导出与结果回传 ----
  const outFile = `${outDir.replace(/\\/g, '/')}/${name}.${format}`;
  // 位图用 print -r96：按 figure 像素尺寸精确导出（exportgraphics 在无头环境下
  // 按内容区域导出且叠加 Resolution，尺寸会漂移）；矢量格式仍用 exportgraphics。
  if (format === 'fig') L.push(`savefig(figHandle, ${matlabStr(outFile)});`);
  else if (format === 'png') L.push(`print(figHandle, ${matlabStr(outFile)}, '-dpng', '-r96');`);
  else if (format === 'jpg') L.push(`print(figHandle, ${matlabStr(outFile)}, '-djpeg', '-r96');`);
  else L.push(`exportgraphics(figHandle, ${matlabStr(outFile)});`);
  L.push('close(figHandle);');
  // 产物自验证：文件存在且非空；位图尺寸经 dir 元数据回读
  L.push(`fileInfo = dir(${matlabStr(outFile)});`);
  L.push("if isempty(fileInfo), error('MATLAB:stepcode:noOutput', '导出未生成文件'); end");
  L.push(`resultStruct = struct('ok', true, 'type', ${matlabStr(type)}, 'name', ${matlabStr(name)}, ...`);
  L.push(`  'files', {{${matlabStr(outFile)}}}, 'bytes', fileInfo(1).bytes, 'analyzer', analyzerIssueCount);`);
  // sidecar：结果同时落盘，会话模式下不依赖 stdout 捕获（evalc 缓冲不确定性）
  L.push("sidecarFid = fopen('%SELF_PATH%.result.json', 'w');");
  L.push('fwrite(sidecarFid, jsonencode(resultStruct), \'char\'); fclose(sidecarFid);');
  L.push("fprintf('STEPCODE_MATLAB_RESULT:%s\\n', jsonencode(resultStruct));");
  const body = L.join('\n');

  // standalone=true 时才 exit(1)（一次性 -batch 需要非零退出码）；
  // 默认（含会话 daemon 内执行）不 exit——错误由 RESULT 行承载，
  // exit(1) 会直接杀死整个常驻 MATLAB 会话。
  // 失败分支也带 type/name：批量执行时逐图结果按 name 匹配，否则诊断会丢
  const failResult = `struct('ok', false, 'type', ${matlabStr(type)}, 'name', ${matlabStr(name)}, 'error', errInfo.message, 'identifier', errInfo.identifier)`;
  const catchBlock = options.standalone === true
    ? [
        'catch errInfo',
        `  resultStruct = ${failResult};`,
        "  sidecarFid = fopen('%SELF_PATH%.result.json', 'w');",
        "  fwrite(sidecarFid, jsonencode(resultStruct), 'char'); fclose(sidecarFid);",
        "  fprintf('STEPCODE_MATLAB_RESULT:%s\\n', jsonencode(resultStruct));",
        '  exit(1);',
      ]
    : [
        'catch errInfo',
        `  resultStruct = ${failResult};`,
        "  sidecarFid = fopen('%SELF_PATH%.result.json', 'w');",
        "  fwrite(sidecarFid, jsonencode(resultStruct), 'char'); fclose(sidecarFid);",
        "  fprintf('STEPCODE_MATLAB_RESULT:%s\\n', jsonencode(resultStruct));",
      ];

  const code = [
    `% stepcode-matlab-plot v1.0.0 type=${type} name=${name} fmt=${format} out=${outFile}`,
    'try',
    // Code Analyzer 执行前预检（借鉴官方 check_matlab_code）：自检本脚本，问题计数随 RESULT 返回
    'analyzerIssueCount = -1;',
    'try',
    "  analyzerIssueCount = numel(checkcode('%SELF_PATH%'));",
    'catch',
    'end',
    body,
    ...catchBlock,
    'end',
  ].join('\n');
  if (code.length > MAX_SCRIPT_CHARS) {
    return fail(`生成的 MATLAB 脚本超过 ${MAX_SCRIPT_CHARS} 字符上限（${code.length}）；请减少数据量或改用 data.csv`);
  }
  return ok({ code, outFile, name, format, type, warnings });
}
