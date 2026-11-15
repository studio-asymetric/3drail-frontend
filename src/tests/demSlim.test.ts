// @ts-nocheck -- exercises a Node-only proxy module (zlib, Buffer); the app's tsconfig has no node types
import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import { decodePng, slimTerrariumPng } from '../../proxy/demSlim.mjs';

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let k = 0; k < 8; k += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** A Terrarium-style tile: smooth height in R/G, noisy fraction in B, unfiltered rows. */
function terrariumTile(size: number): { png: Buffer; pixels: Buffer } {
  const pixels = Buffer.alloc(size * size * 3);
  let seed = 7;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const metres = 300 + x * 0.5 + y * 0.25;
      const at = (y * size + x) * 3;
      pixels[at] = 128 + Math.floor((metres + 32768 - 32768) / 256);
      pixels[at + 1] = Math.floor(metres) % 256;
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      pixels[at + 2] = seed & 0xff;
    }
  }
  const rows = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    pixels.copy(rows, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return { png, pixels };
}

describe('slimTerrariumPng', () => {
  it('rounds the fractional metre, keeps the whole metres, and shrinks the file', () => {
    const { png, pixels } = terrariumTile(64);
    const slim = slimTerrariumPng(png, { keepBits: 2 });
    expect(slim.length).toBeLessThan(png.length * 0.85);
    const decoded = decodePng(slim)!;
    expect(decoded.width).toBe(64);
    let worst = 0;
    for (let i = 0; i < pixels.length; i += 3) {
      expect(decoded.pixels[i]).toBe(pixels[i]);
      expect(decoded.pixels[i + 1]).toBe(pixels[i + 1]);
      worst = Math.max(worst, pixels[i + 2] - decoded.pixels[i + 2]);
      expect(decoded.pixels[i + 2] & 0x3f).toBe(0);
    }
    expect(worst / 256).toBeLessThan(0.25); // under a quarter metre
  });

  it('leaves anything it cannot read alone', () => {
    const junk = Buffer.from('not a png at all, just text that is long enough to pass the size check.');
    expect(slimTerrariumPng(junk)).toBe(junk);
  });
});

