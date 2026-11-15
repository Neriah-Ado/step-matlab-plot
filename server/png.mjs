/**
 * 最小 PNG 编码器（零依赖）：供 fake-matlab 测试缝生成"可被真实读取"的占位图。
 * 生产路径由 MATLAB exportgraphics 出图；此文件仅用于无 MATLAB 环境下的端到端验证。
 */
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** 生成纯色 truecolor PNG（8bit、无交错、filter 0）。 */
export function makePng(width = 320, height = 240, rgb = [226, 232, 240]) {
  const w = Math.max(1, Math.min(4096, Math.floor(width)));
  const h = Math.max(1, Math.min(4096, Math.floor(height)));
  const rowLen = w * 3 + 1;
  const raw = Buffer.alloc(rowLen * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) {
      raw[p++] = rgb[0] & 0xff;
      raw[p++] = rgb[1] & 0xff;
      raw[p++] = rgb[2] & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
