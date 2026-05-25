import { deflateSync, inflateSync } from "node:zlib";

type RgbaImage = {
  width: number;
  height: number;
  data: Uint8Array;
};

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function decodePngRgba(input: Uint8Array): RgbaImage {
  if (input.length < 8 || input[0] !== PNG_SIGNATURE[0] || input[1] !== PNG_SIGNATURE[1]) {
    throw new Error("Invalid PNG input");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatParts: Uint8Array[] = [];

  while (offset + 8 <= input.length) {
    const length = readU32(input, offset);
    const type = String.fromCharCode(input[offset + 4], input[offset + 5], input[offset + 6], input[offset + 7]);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > input.length) break;

    if (type === "IHDR") {
      width = readU32(input, dataStart);
      height = readU32(input, dataStart + 4);
      bitDepth = input[dataStart + 8];
      colorType = input[dataStart + 9];
      const interlace = input[dataStart + 12];
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
        throw new Error("Unsupported PNG format for letterbox");
      }
    } else if (type === "IDAT") {
      idatParts.push(input.slice(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }

    offset = dataEnd + 4;
  }

  if (!width || !height || idatParts.length === 0) {
    throw new Error("PNG missing IHDR or IDAT");
  }

  const compressed = concatBytes(idatParts);
  const filtered = inflateSync(compressed);
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const stride = width * bytesPerPixel;
  const rgba = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  let src = 0;

  for (let y = 0; y < height; y++) {
    const filter = filtered[src++];
    const scan = filtered.subarray(src, src + stride);
    src += stride;
    const recon = new Uint8Array(stride);

    for (let i = 0; i < stride; i++) {
      const left = i >= bytesPerPixel ? recon[i - bytesPerPixel] : 0;
      const up = prev[i];
      const upLeft = i >= bytesPerPixel ? prev[i - bytesPerPixel] : 0;
      let value = scan[i];

      switch (filter) {
        case 0:
          value = scan[i];
          break;
        case 1:
          value = (scan[i] + left) & 0xff;
          break;
        case 2:
          value = (scan[i] + up) & 0xff;
          break;
        case 3:
          value = (scan[i] + Math.floor((left + up) / 2)) & 0xff;
          break;
        case 4:
          value = (scan[i] + paethPredictor(left, up, upLeft)) & 0xff;
          break;
        default:
          throw new Error(`Unsupported PNG filter ${filter}`);
      }
      recon[i] = value;
    }

    prev.set(recon);
    const rowOffset = y * width * 4;
    if (colorType === 6) {
      rgba.set(recon, rowOffset);
    } else {
      for (let x = 0; x < width; x++) {
        const i = x * 3;
        const o = rowOffset + x * 4;
        rgba[o] = recon[i];
        rgba[o + 1] = recon[i + 1];
        rgba[o + 2] = recon[i + 2];
        rgba[o + 3] = 255;
      }
    }
  }

  return { width, height, data: rgba };
}

export function encodePngRgba(image: RgbaImage): Uint8Array {
  const { width, height, data } = image;
  if (data.length !== width * height * 4) {
    throw new Error("RGBA buffer size mismatch");
  }

  const stride = width * 4 + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), rowStart + 1);
  }

  const compressed = deflateSync(raw);
  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width);
  writeU32(ihdr, 4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return concatBytes([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

export function letterboxPng(
  fittedPng: Uint8Array,
  targetWidth: number,
  targetHeight: number,
  background: { r: number; g: number; b: number } = { r: 255, g: 255, b: 255 }
): Uint8Array {
  const fitted = decodePngRgba(fittedPng);
  const canvas = new Uint8Array(targetWidth * targetHeight * 4);

  for (let i = 0; i < targetWidth * targetHeight; i++) {
    const o = i * 4;
    canvas[o] = background.r;
    canvas[o + 1] = background.g;
    canvas[o + 2] = background.b;
    canvas[o + 3] = 255;
  }

  const offsetX = Math.floor((targetWidth - fitted.width) / 2);
  const offsetY = Math.floor((targetHeight - fitted.height) / 2);

  for (let y = 0; y < fitted.height; y++) {
    for (let x = 0; x < fitted.width; x++) {
      const src = (y * fitted.width + x) * 4;
      const dst = ((offsetY + y) * targetWidth + (offsetX + x)) * 4;
      const alpha = fitted.data[src + 3] / 255;
      if (alpha <= 0) continue;
      if (alpha >= 1) {
        canvas[dst] = fitted.data[src];
        canvas[dst + 1] = fitted.data[src + 1];
        canvas[dst + 2] = fitted.data[src + 2];
        canvas[dst + 3] = 255;
        continue;
      }
      canvas[dst] = Math.round(fitted.data[src] * alpha + background.r * (1 - alpha));
      canvas[dst + 1] = Math.round(fitted.data[src + 1] * alpha + background.g * (1 - alpha));
      canvas[dst + 2] = Math.round(fitted.data[src + 2] * alpha + background.b * (1 - alpha));
      canvas[dst + 3] = 255;
    }
  }

  return encodePngRgba({ width: targetWidth, height: targetHeight, data: canvas });
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  writeU32(out, 0, data.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  writeU32(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function readU32(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0
  );
}

function writeU32(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
