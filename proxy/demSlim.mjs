/**
 * Slimmer elevation tiles for the hillshade layer.
 *
 * The Terrarium tiles the map reads encode height as R*256 + G + B/256 metres.
 * The blue channel carries 1/256 m of detail, which the hillshade cannot show
 * but which makes the PNG nearly incompressible. Rounding it to a quarter of a
 * metre keeps the shading identical to the eye and shrinks each tile several
 * times over.
 */
import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

/** Undo PNG row filters in place; returns the raw pixel rows. */
function unfilter(data, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const type = data[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = data[src + x];
      const left = x >= bpp ? out[dst + x - bpp] : 0;
      const up = y > 0 ? out[dst - stride + x] : 0;
      const upLeft = y > 0 && x >= bpp ? out[dst - stride + x - bpp] : 0;
      let value;
      switch (type) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + ((left + up) >> 1);
          break;
        case 4:
          value = raw + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`Unknown PNG filter ${type}`);
      }
      out[dst + x] = value & 0xff;
    }
  }
  return out;
}

/** Filter each row with whichever of the five filters leaves the smallest residue. */
function refilter(pixels, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc((stride + 1) * height);
  const candidates = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = pixels[row + x];
      const left = x >= bpp ? pixels[row + x - bpp] : 0;
      const up = y > 0 ? pixels[row - stride + x] : 0;
      const upLeft = y > 0 && x >= bpp ? pixels[row - stride + x - bpp] : 0;
      candidates[0][x] = value;
      candidates[1][x] = (value - left) & 0xff;
      candidates[2][x] = (value - up) & 0xff;
      candidates[3][x] = (value - ((left + up) >> 1)) & 0xff;
      candidates[4][x] = (value - paeth(left, up, upLeft)) & 0xff;
    }
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f += 1) {
      let score = 0;
      for (let x = 0; x < stride; x += 1) {
        const v = candidates[f][x];
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    out[y * (stride + 1)] = best;
    candidates[best].copy(out, y * (stride + 1) + 1);
  }
  return out;
}

/** Decode a plain 8-bit RGB(A), non-interlaced PNG; null for anything else. */
export function decodePng(input) {
  if (input.length < 33 || !input.subarray(0, 8).equals(SIGNATURE)) {
    return null;
  }
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset + 8 <= input.length) {
    const length = input.readUInt32BE(offset);
    const type = input.toString('ascii', offset + 4, offset + 8);
    const body = input.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = body;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    } else if (type === 'PLTE' || type === 'tRNS') {
      return null;
    }
    offset += 12 + length;
  }
  if (!header || idat.length === 0) {
    return null;
  }
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const depth = header[8];
  const colorType = header[9];
  const interlace = header[12];
  if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    return null;
  }
  const bpp = colorType === 2 ? 3 : 4;
  const pixels = unfilter(zlib.inflateSync(Buffer.concat(idat)), width, height, bpp);
  return { header, width, height, bpp, pixels };
}

/**
 * Round a Terrarium tile's height to `1 / 2^keepBits` metres (default a quarter metre).
 * Returns the original buffer untouched when the PNG is not the plain 8-bit RGB(A)
 * kind, or when the result is not smaller.
 */
export function slimTerrariumPng(input, { keepBits = 2 } = {}) {
  try {
    const png = decodePng(input);
    if (!png) {
      return input;
    }
    const { header, width, height, bpp, pixels } = png;
    const mask = (0xff << (8 - keepBits)) & 0xff;
    for (let i = 2; i < pixels.length; i += bpp) {
      pixels[i] &= mask; // blue = the fractional metre
    }
    const packed = zlib.deflateSync(refilter(pixels, width, height, bpp), { level: 9 });
    const out = Buffer.concat([
      SIGNATURE,
      chunk('IHDR', header),
      chunk('IDAT', packed),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    return out.length < input.length ? out : input;
  } catch {
    return input;
  }
}
