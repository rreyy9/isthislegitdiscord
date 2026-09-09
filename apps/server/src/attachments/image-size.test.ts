import { describe, expect, it } from 'vitest';
import { imageSize } from './image-size';

/* Headers built by hand. Each is the smallest thing the parser should accept,
   which is also the shape a truncated or hostile upload arrives in. */

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function gif(width: number, height: number, magic = 'GIF89a'): Buffer {
  const b = Buffer.alloc(13);
  b.write(magic, 0, 'ascii');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

function webpLossy(width: number, height: number): Buffer {
  const b = Buffer.alloc(32);
  b.write('RIFF', 0, 'ascii');
  b.write('WEBP', 8, 'ascii');
  b.write('VP8 ', 12, 'ascii');
  b.writeUInt16LE(width, 26);
  b.writeUInt16LE(height, 28);
  return b;
}

function webpLossless(width: number, height: number): Buffer {
  const b = Buffer.alloc(32);
  b.write('RIFF', 0, 'ascii');
  b.write('WEBP', 8, 'ascii');
  b.write('VP8L', 12, 'ascii');
  b.writeUInt32LE(((height - 1) << 14) | (width - 1), 21);
  return b;
}

function webpExtended(width: number, height: number): Buffer {
  const b = Buffer.alloc(32);
  b.write('RIFF', 0, 'ascii');
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

/** SOI, then any number of segments, then an SOF0 carrying the size. */
function jpeg(width: number, height: number, before: Buffer = Buffer.alloc(0)): Buffer {
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(0x0011, 2); // segment length
  sof.writeUInt8(8, 4); // sample precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), before, sof, Buffer.alloc(4)]);
}

/** A segment with a length field, of the kind the scanner must step over. */
function segment(marker: number, payloadLength: number): Buffer {
  const b = Buffer.alloc(4 + payloadLength);
  b.writeUInt16BE(0xff00 | marker, 0);
  b.writeUInt16BE(2 + payloadLength, 2);
  return b;
}

describe('imageSize', () => {
  it('reads PNG', () => {
    expect(imageSize(png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it('reads GIF in both signature versions', () => {
    expect(imageSize(gif(320, 240))).toEqual({ width: 320, height: 240 });
    expect(imageSize(gif(320, 240, 'GIF87a'))).toEqual({ width: 320, height: 240 });
  });

  it('reads all three WebP chunk types', () => {
    expect(imageSize(webpLossy(800, 600))).toEqual({ width: 800, height: 600 });
    expect(imageSize(webpLossless(800, 600))).toEqual({ width: 800, height: 600 });
    // VP8X is what an animated WebP lands on.
    expect(imageSize(webpExtended(800, 600))).toEqual({ width: 800, height: 600 });
  });

  it('reads JPEG, including past segments that come first', () => {
    expect(imageSize(jpeg(640, 480))).toEqual({ width: 640, height: 480 });
    // An APP0/JFIF header, which every camera JPEG starts with.
    expect(imageSize(jpeg(640, 480, segment(0xe0, 14)))).toEqual({
      width: 640,
      height: 480,
    });
  });

  it('does not mistake a Huffman table for a frame header', () => {
    // C4, C8 and CC sit inside the SOF0-SOF15 range without being frame
    // headers; reading a size out of one gives confident nonsense.
    expect(imageSize(jpeg(640, 480, segment(0xc4, 30)))).toEqual({
      width: 640,
      height: 480,
    });
    expect(imageSize(jpeg(640, 480, segment(0xcc, 8)))).toEqual({
      width: 640,
      height: 480,
    });
  });

  it('returns null for anything it does not recognise', () => {
    // The documented contract: the attachment is stored without dimensions,
    // which costs a reserved space in the message list and nothing else.
    expect(imageSize(Buffer.alloc(0))).toBeNull();
    expect(imageSize(Buffer.from('not an image at all, really'))).toBeNull();
    expect(imageSize(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it('returns null on a truncated header rather than reading past the end', () => {
    for (const full of [png(10, 10), gif(10, 10), webpLossy(10, 10), jpeg(10, 10)]) {
      for (let n = 1; n < full.length; n++) {
        expect(() => imageSize(full.subarray(0, n))).not.toThrow();
      }
    }
  });

  it('terminates on a malformed JPEG instead of looping for ever', () => {
    // A zero-length segment would advance the cursor by nothing. This is the
    // shape of the advisory that kept the obvious dependency out of the repo.
    const bad = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]),
      Buffer.alloc(64),
    ]);
    expect(imageSize(bad)).toBeNull();

    const allPadding = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.alloc(1024, 0xff),
    ]);
    expect(imageSize(allPadding)).toBeNull();
  });
});
