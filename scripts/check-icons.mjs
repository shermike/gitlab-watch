// Verifies an exported icon PNG by its actual pixel content rather than by its header.
// A fully transparent image passes a width/height/colour-type check perfectly, which is
// exactly the defect this script exists to catch (see README "Regenerating the icons").
//
// Usage: node scripts/check-icons.mjs icons/16.png icons/32.png icons/48.png icons/128.png
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

// The brand orange the icon is drawn in; a small tolerance absorbs export antialiasing.
const BRAND_ORANGE = [0xe2, 0x43, 0x29];
const COLOR_TOLERANCE = 8;

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Reads an 8-bit RGBA PNG's pixels, undoing the per-scanline filter (PNG spec §9, types 0-4). */
function decodePng(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path}: not a PNG`);

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks = [];

  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    }
    offset += 12 + length;
  }

  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(
      `${path}: expected 8-bit RGBA (colour type 6), got bit depth ${bitDepth}, colour type ${colorType}`,
    );
  }

  const raw = inflateSync(Buffer.concat(idatChunks));
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const pixels = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y++) {
    const filterType = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const filtered = raw[rowStart + x];
      const a = x >= bytesPerPixel ? pixels[y * stride + x - bytesPerPixel] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = y > 0 && x >= bytesPerPixel ? pixels[(y - 1) * stride + x - bytesPerPixel] : 0;
      let value;
      switch (filterType) {
        case 0:
          value = filtered;
          break;
        case 1:
          value = filtered + a;
          break;
        case 2:
          value = filtered + b;
          break;
        case 3:
          value = filtered + Math.floor((a + b) / 2);
          break;
        case 4:
          value = filtered + paeth(a, b, c);
          break;
        default:
          throw new Error(`${path}: unknown scanline filter type ${filterType} on row ${y}`);
      }
      pixels[y * stride + x] = value & 0xff;
    }
  }

  return { width, height, pixels };
}

function isBrandOrange(r, g, b) {
  return (
    Math.abs(r - BRAND_ORANGE[0]) <= COLOR_TOLERANCE &&
    Math.abs(g - BRAND_ORANGE[1]) <= COLOR_TOLERANCE &&
    Math.abs(b - BRAND_ORANGE[2]) <= COLOR_TOLERANCE
  );
}

function report(path) {
  const { width, height, pixels } = decodePng(path);
  const total = width * height;
  let opaque = 0;
  let orange = 0;
  for (let i = 0; i < total; i++) {
    const off = i * 4;
    const alpha = pixels[off + 3];
    if (alpha > 0) {
      opaque++;
      if (isBrandOrange(pixels[off], pixels[off + 1], pixels[off + 2])) orange++;
    }
  }
  console.log(`${path}  ${width}x${height}  opaque ${opaque}/${total}  orange ${orange}/${total}`);
  if (opaque === 0) {
    console.error(`${path}: every pixel is fully transparent — the export is empty.`);
    process.exitCode = 1;
  }
}

for (const path of process.argv.slice(2)) report(path);
