/**
 * step-matlab-plot 图表管理：输出目录、清单、读回（图片 content）。
 * 文件名白名单 + 扩展名白名单 + 读取体量上限，杜绝路径穿越。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { FILE_NAME_RE, PLOT_FORMATS, MAX_FIGURE_READ_BYTES } from './validate.mjs';

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function scriptDir(outDir) { return ensureDir(join(outDir, '.scripts')); }

/**
 * 脚本落盘路径：MATLAB run() 会把文件名 stem 当语句求值，
 * 因此 stem 必须是合法 MATLAB 标识符（real-line.m 会被解析成 real-line 表达式而报错）。
 * 非标识符字符替换为 _，并追加 name 的短哈希防撞名。
 */
export function scriptPathFor(outDir, name) {
  const raw = String(name ?? 'script');
  const base = raw.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'script';
  const hash = createHash('sha1').update(raw).digest('hex').slice(0, 6);
  return join(scriptDir(outDir), `${base}_${hash}.m`);
}

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  fig: 'application/x-matlab-fig',
};

export function mimeFor(format) { return MIME[format] ?? 'application/octet-stream'; }

/** 列出输出目录图表（按修改时间倒序，上限 200） */
export function listFigures(outDir) {
  if (!existsSync(outDir)) return { figures: [], outDir };
  const files = readdirSync(outDir, { withFileTypes: true })
    .filter((d) => d.isFile() && !d.isSymbolicLink())
    .map((d) => d.name)
    .filter((n) => {
      const ext = n.includes('.') ? n.split('.').pop().toLowerCase() : '';
      return PLOT_FORMATS.includes(ext);
    })
    .map((n) => {
      const ext = n.split('.').pop().toLowerCase();
      const st = statSync(join(outDir, n));
      return { name: n, format: ext, bytes: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 200);
  return { figures: files, outDir };
}

/** 读回图表文件：白名单校验 → base64 data + mime */
export function readFigure(outDir, name) {
  if (typeof name !== 'string' || !FILE_NAME_RE.test(name.trim())) {
    return { error: 'invalid-identifier', reason: '图表文件名不合法（仅允许 [A-Za-z0-9][A-Za-z0-9_.-]，无路径分隔符）' };
  }
  const file = name.trim();
  const ext = file.includes('.') ? file.split('.').pop().toLowerCase() : '';
  if (!PLOT_FORMATS.includes(ext)) {
    return { error: 'unsupported-format', reason: `仅支持读取 ${PLOT_FORMATS.join('/')} 图表` };
  }
  const abs = join(outDir, file);
  if (!existsSync(abs)) return { error: 'not-found', reason: `图表不存在：${file}` };
  // TOCTOU 防护：lstat→stat→read 全链 try/catch，任一环节文件消失/被换链都不抛
  let lst;
  let st;
  try {
    lst = lstatSync(abs);
    // 符号链接可指向输出目录外的任意文件，拒绝
    if (lst.isSymbolicLink()) return { error: 'symlink-rejected', reason: '拒绝读取符号链接（可指向目录外文件）' };
    st = statSync(abs);
  } catch {
    return { error: 'not-found', reason: `图表不存在或已变化：${file}` };
  }
  if (!st.isFile()) return { error: 'not-a-file', reason: `不是普通文件：${file}` };
  if (st.size > MAX_FIGURE_READ_BYTES) {
    return { error: 'too-large', reason: `图表超过 ${MAX_FIGURE_READ_BYTES / 1048576}MB，请先压缩` };
  }
  const buf = readFileSync(abs);
  const result = { file, format: ext, mimeType: mimeFor(ext), bytes: st.size, data: buf.toString('base64') };
  if (ext === 'png') {
    const dim = pngSize(buf);
    if (dim) result.width = dim.width, result.height = dim.height;
  }
  return result;
}

/** 解析 PNG IHDR 宽高（零依赖，供视觉验证核对 spec.size） */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
