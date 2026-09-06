/**
 * Width and height straight from an image header.
 *
 * Written out rather than pulled from a package because the obvious dependency
 * (`image-size`) carries high-severity advisories — an infinite loop in its
 * ICNS parser among them — and this code's whole job is to parse bytes a user
 * uploaded. Four formats, each a fixed offset or a short scan, is a smaller
 * thing to trust than a decoder for thirty.
 *
 * Anything it does not recognise returns null, and the attachment is stored
 * without dimensions: the message list then cannot reserve space for it, which
 * is a cosmetic loss, not a failure.
 */

export interface ImageDimensions {
  width: number;
  height: number;
}

export function imageSize(buf: Buffer): ImageDimensions | null {
  return png(buf) ?? gif(buf) ?? webp(buf) ?? jpeg(buf);
}

function png(b: Buffer): ImageDimensions | null {
  // \x89PNG\r\n\x1a\n, then an IHDR chunk whose first two fields are the size.
  if (b.length < 24) return null;
  if (b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) {
    return null;
  }
  if (b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function gif(b: Buffer): ImageDimensions | null {
  if (b.length < 10) return null;
  const magic = b.toString('ascii', 0, 6);
  if (magic !== 'GIF87a' && magic !== 'GIF89a') return null;
  // Logical screen descriptor, little-endian.
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function webp(b: Buffer): ImageDimensions | null {
  if (b.length < 30) return null;
  if (b.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (b.toString('ascii', 8, 12) !== 'WEBP') return null;

  const chunk = b.toString('ascii', 12, 16);

  // Lossy: a VP8 keyframe header, 14 bytes in, each dimension 14 bits.
  if (chunk === 'VP8 ') {
    return {
      width: b.readUInt16LE(26) & 0x3fff,
      height: b.readUInt16LE(28) & 0x3fff,
    };
  }

  // Lossless: 14 bits each, packed across four bytes after the signature byte.
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }

  // Extended (animated WebP lands here): 24-bit little-endian, minus one.
  if (chunk === 'VP8X') {
    return {
      width: b.readUIntLE(24, 3) + 1,
      height: b.readUIntLE(27, 3) + 1,
    };
  }

  return null;
}

function jpeg(b: Buffer): ImageDimensions | null {
  if (b.length < 4 || b.readUInt16BE(0) !== 0xffd8) return null;

  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++; // Resynchronise rather than give up on a padded stream.
      continue;
    }
    const marker = b[i + 1];

    // SOF0-SOF15 carry the frame size. C4 (Huffman tables), C8 (JPEG
    // extensions) and CC (arithmetic coding) share the range but are not
    // frame headers.
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrameHeader) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }

    // Standalone markers carry no length payload to skip over.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end, or entropy data

    const length = b.readUInt16BE(i + 2);
    if (length < 2) return null; // malformed; refuse rather than loop forever
    i += 2 + length;
  }
  return null;
}
