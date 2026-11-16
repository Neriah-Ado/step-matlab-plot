/**
 * step-matlab-plot 输入校验与白名单（对应 docker-mate 的 C-05 思路）。
 * 所有进入 MATLAB 命令行的数据必须先过本模块：数字有限性、字符串转义、
 * 文件名/路径白名单、体量上限。杜绝把用户输入变成 argv 选项或 MATLAB 注入点。
 */
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
// Windows 保留设备名（大小写不敏感，带任意扩展名均保留）
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export const PLOT_FORMATS = ['png', 'pdf', 'svg', 'jpg', 'fig'];
export const MAX_SERIES_POINTS = 200000;   // 单系列点数上限，超出引导用 CSV/降采样
export const MAX_SERIES_COUNT = 64;
export const MAX_TOTAL_NUMBERS = 500000;   // 全部内联数字总量上限（防巨型 .m）
export const MAX_STR_ITEM = 500;           // 单个字符串字段（图例/标签）长度上限
export const MAX_CSV_BYTES = 64 * 1024 * 1024;
export const MAX_CODE_CHARS = 200000;
export const MAX_SCRIPT_CHARS = 2000000;  // 生成脚本体量上限（防超大 .m）
export const MAX_FIGURE_READ_BYTES = 25 * 1024 * 1024;

export function ok(value) { return { ok: true, value }; }
export function fail(reason) { return { ok: false, reason }; }

/** 图表文件名：白名单字符、拒绝路径分隔/穿越/前导 '-'；自动剥离同格式扩展名避免 demo.png.png */
export function assertFigureName(name, format) {
  let value = typeof name === 'string' ? name.trim() : '';
  const suffix = `.${format}`;
  if (value.toLowerCase().endsWith(suffix)) value = value.slice(0, -suffix.length);
  if (!FILE_NAME_RE.test(value)) {
    return fail('图表名仅允许 [A-Za-z0-9][A-Za-z0-9_.-]{0,127}，不能以 - 开头、不能含路径分隔符或 ..');
  }
  // Windows 保留设备名对任意扩展名有效（aux.svg 也是 AUX 设备），剥掉扩展名再查；
  // 多段点名（nul.a.b）取首段一并检查
  const stem = value.replace(/\.[^.]*$/, '');
  if (WIN_RESERVED.test(stem) || WIN_RESERVED.test(stem.split('.')[0])) {
    return fail(`图表名不能使用 Windows 保留设备名：${value}`);
  }
  return ok(value);
}

export function assertFormat(format) {
  const value = typeof format === 'string' ? format.trim().toLowerCase() : 'png';
  if (!PLOT_FORMATS.includes(value)) {
    return fail(`导出格式仅支持 ${PLOT_FORMATS.join('/')}`);
  }
  return ok(value);
}

/** MATLAB 字符串字面量：单引号成倍转义（MATLAB 唯一特殊字符） */
export function matlabStr(s) {
  return `'${String(s ?? '').replace(/'/g, "''")}'`;
}

function isPlainArray(v) { return Array.isArray(v); }

/** 数值数组：拒绝 NaN/Infinity/非数字，限制点数 */
export function toNumVector(v, what = 'data') {
  if (!isPlainArray(v) || v.length === 0) return fail(`${what} 必须是非空数字数组`);
  if (v.length > MAX_SERIES_POINTS) {
    return fail(`${what} 单系列最多 ${MAX_SERIES_POINTS} 点（当前 ${v.length}）；请改用 data.csv 或降采样`);
  }
  const out = [];
  for (let i = 0; i < v.length; i++) {
    const n = v[i];
    if (typeof n !== 'number' || !Number.isFinite(n)) return fail(`${what}[${i}] 不是有限数字：${JSON.stringify(n)}`);
    out.push(n);
  }
  return ok(out);
}

/** 二维数值矩阵（行=系列或行=矩阵行，依图形而定）：统一校验 */
export function toNumMatrix(v, what = 'data') {
  if (!isPlainArray(v) || v.length === 0) return fail(`${what} 必须是非空数组`);
  if (v.length > MAX_SERIES_COUNT) return fail(`${what} 最多 ${MAX_SERIES_COUNT} 行/系列`);
  const rows = [];
  const cols = v[0].length;
  for (let i = 0; i < v.length; i++) {
    const r = toNumVector(v[i], `${what}[${i}]`);
    if (!r.ok) return r;
    if (r.value.length !== cols) return fail(`${what} 各行长度必须一致（第 ${i} 行 ${r.value.length} ≠ ${cols}）`);
    if (cols > MAX_SERIES_POINTS) return fail(`${what} 单行最多 ${MAX_SERIES_POINTS} 点`);
    rows.push(r.value);
  }
  return ok(rows);
}

/** 字符串数组（标签/图例）：与 validateText 同一套控制字符标准 */
export function toStrVector(v, what = 'labels') {
  if (!isPlainArray(v) || v.length === 0) return fail(`${what} 必须是非空字符串数组`);
  if (v.length > 4096) return fail(`${what} 最多 4096 项`);
  for (let i = 0; i < v.length; i++) {
    if (typeof v[i] !== 'string') return fail(`${what}[${i}] 必须是字符串`);
    if (v[i].length > MAX_STR_ITEM) return fail(`${what}[${i}] 超过 ${MAX_STR_ITEM} 字符上限`);
    if (HAS_CONTROL_CHARS(v[i])) return fail(`${what}[${i}] 含有控制字符（换行/制表符等）`);
  }
  return ok(v);
}

/** 递归统计 spec.data 中的内联数字总量（防 64 系列 × 20 万点的巨型脚本） */
export function countInlineNumbers(v) {
  if (typeof v === 'number') return 1;
  if (Array.isArray(v)) return v.reduce((s, x) => s + countInlineNumbers(x), 0);
  return 0;
}

/** CSV 数据文件：必须存在、是普通文件、体量受限；返回绝对路径 */
export function resolveDataFile(p, cwd = process.cwd()) {
  if (typeof p !== 'string' || !p.trim()) return fail('data.csv 必须是非空路径字符串');
  if (/[\r\n\t\u0000-\u001f]/.test(p)) return fail('路径含有控制字符（换行/制表符等）');
  if (p.includes('\0')) return fail('路径含有非法字符');
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  if (!existsSync(abs)) return fail(`数据文件不存在：${abs}`);
  let st;
  try { st = statSync(abs); } catch { return fail(`无法读取数据文件：${abs}`); }
  if (!st.isFile()) return fail(`数据路径不是普通文件：${abs}`);
  if (st.size > MAX_CSV_BYTES) return fail(`数据文件超过 ${MAX_CSV_BYTES / 1048576}MB 上限`);
  return ok(abs);
}

const HAS_CONTROL_CHARS = (s) => /[\r\n\t\u0000-\u001f]/.test(s);

/** 输出目录：MATLAB_MATE_OUTDIR 必须为绝对路径且无控制字符，否则回落插件内 figures/ */
export function resolveOutDir(env = process.env, fallback) {
  const raw = env.MATLAB_MATE_OUTDIR;
  if (typeof raw === 'string' && raw.trim()) {
    if (HAS_CONTROL_CHARS(raw)) return fail('MATLAB_MATE_OUTDIR 含有控制字符');
    if (!isAbsolute(raw.trim())) return fail('MATLAB_MATE_OUTDIR 必须是绝对路径');
    return ok(raw.trim());
  }
  return ok(fallback);
}

/** 布尔确认闸：仅接受 true */
export function isConfirmed(v) { return v === true; }
