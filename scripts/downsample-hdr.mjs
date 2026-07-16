/**
 * Downsample a Radiance RGBE (.hdr) equirect by an integer factor, in linear
 * space. Dependency-free — used by build-mobile-assets.sh for the mobile IBL.
 *
 *   node scripts/downsample-hdr.mjs <in.hdr> <out.hdr> [factor=2]
 *
 * Output uses new-style RLE scanline headers with literal dumps, which
 * three.js RGBELoader (and every other Radiance reader) accepts.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [, , inPath, outPath, factorArg] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: node scripts/downsample-hdr.mjs <in.hdr> <out.hdr> [factor]');
  process.exit(1);
}
const factor = Number(factorArg ?? 2);

const buf = readFileSync(inPath);
let pos = 0;

function readLine() {
  const end = buf.indexOf(0x0a, pos);
  if (end === -1) throw new Error('unterminated header');
  const line = buf.toString('ascii', pos, end);
  pos = end + 1;
  return line;
}

const magic = readLine();
if (!magic.startsWith('#?')) throw new Error(`not a Radiance file: ${magic}`);
let exposureLine = null;
for (let line = readLine(); line !== ''; line = readLine()) {
  if (line.startsWith('EXPOSURE=')) exposureLine = line;
}
const res = readLine().match(/^-Y (\d+) \+X (\d+)$/);
if (!res) throw new Error('unsupported orientation (need "-Y h +X w")');
const height = Number(res[1]);
const width = Number(res[2]);

// ── Decode to linear floats ──
const pixels = new Float32Array(width * height * 3);
const planes = new Uint8Array(4 * width);

for (let y = 0; y < height; y++) {
  if (buf[pos] === 2 && buf[pos + 1] === 2 && ((buf[pos + 2] << 8) | buf[pos + 3]) === width) {
    pos += 4;
    for (let c = 0; c < 4; c++) {
      let x = 0;
      while (x < width) {
        let count = buf[pos++];
        if (count > 128) {
          count -= 128;
          planes.fill(buf[pos++], c * width + x, c * width + x + count);
        } else {
          for (let i = 0; i < count; i++) planes[c * width + x + i] = buf[pos++];
        }
        x += count;
      }
    }
  } else {
    // Flat (non-RLE) scanline: 4 bytes per pixel
    for (let x = 0; x < width; x++) {
      planes[x] = buf[pos];
      planes[width + x] = buf[pos + 1];
      planes[2 * width + x] = buf[pos + 2];
      planes[3 * width + x] = buf[pos + 3];
      pos += 4;
    }
  }
  for (let x = 0; x < width; x++) {
    const e = planes[3 * width + x];
    const idx = (y * width + x) * 3;
    // Matches three.js RGBELoader: c * 2^(e-128) / 256
    const f = e === 0 ? 0 : Math.pow(2, e - 136);
    pixels[idx] = planes[x] * f;
    pixels[idx + 1] = planes[width + x] * f;
    pixels[idx + 2] = planes[2 * width + x] * f;
  }
}

// ── Box-filter downsample ──
const w2 = Math.floor(width / factor);
const h2 = Math.floor(height / factor);
const small = new Float32Array(w2 * h2 * 3);
for (let y = 0; y < h2; y++) {
  for (let x = 0; x < w2; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let dy = 0; dy < factor; dy++) {
      for (let dx = 0; dx < factor; dx++) {
        const idx = ((y * factor + dy) * width + (x * factor + dx)) * 3;
        r += pixels[idx];
        g += pixels[idx + 1];
        b += pixels[idx + 2];
      }
    }
    const n = factor * factor;
    const o = (y * w2 + x) * 3;
    small[o] = r / n;
    small[o + 1] = g / n;
    small[o + 2] = b / n;
  }
}

// ── Encode RGBE ──
const header = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n${exposureLine ? exposureLine + '\n' : ''}\n-Y ${h2} +X ${w2}\n`;
const out = [Buffer.from(header, 'ascii')];
const line = new Uint8Array(4 * w2);

for (let y = 0; y < h2; y++) {
  for (let x = 0; x < w2; x++) {
    const o = (y * w2 + x) * 3;
    const r = small[o];
    const g = small[o + 1];
    const b = small[o + 2];
    const v = Math.max(r, g, b);
    if (v < 1e-32) {
      line[x] = line[w2 + x] = line[2 * w2 + x] = line[3 * w2 + x] = 0;
      continue;
    }
    const e = Math.floor(Math.log2(v)) + 1;
    const s = 256 / Math.pow(2, e);
    line[x] = Math.min(255, Math.floor(r * s));
    line[w2 + x] = Math.min(255, Math.floor(g * s));
    line[2 * w2 + x] = Math.min(255, Math.floor(b * s));
    line[3 * w2 + x] = e + 128;
  }
  const chunks = [Buffer.from([2, 2, (w2 >> 8) & 0xff, w2 & 0xff])];
  for (let c = 0; c < 4; c++) {
    for (let x = 0; x < w2; x += 128) {
      const len = Math.min(128, w2 - x);
      chunks.push(Buffer.from([len]), Buffer.from(line.subarray(c * w2 + x, c * w2 + x + len)));
    }
  }
  out.push(Buffer.concat(chunks));
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, Buffer.concat(out));
const inKb = (buf.length / 1024).toFixed(0);
const outBuf = Buffer.concat(out);
console.log(`${inPath} ${width}x${height} (${inKb} KB) → ${outPath} ${w2}x${h2} (${(outBuf.length / 1024).toFixed(0)} KB)`);
