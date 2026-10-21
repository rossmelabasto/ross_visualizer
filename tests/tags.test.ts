import { describe, expect, it } from 'vitest';
import { readFlac, readId3 } from '../src/audio/tags';

const enc = (s: string) => Array.from(new TextEncoder().encode(s));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => be32(n).reverse();
const syncsafe = (n: number) => [(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127];
const utf16le = (s: string) => [...s].flatMap((c) => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8]);
const PNG = [0x89, 0x50, 0x4e, 0x47, 1, 2, 3];

function frame(id: string, body: number[]) {
  return [...enc(id), ...be32(body.length), 0, 0, ...body];
}

describe('readId3', () => {
  it('reads title, artist and cover from ID3v2.3', () => {
    const frames = [
      ...frame('TIT2', [3, ...enc('Hombre Piedra')]),
      // UTF-16 with BOM, the way many taggers write it.
      ...frame('TPE1', [1, 0xff, 0xfe, ...utf16le('José Madero')]),
      ...frame('APIC', [0, ...enc('image/png'), 0, 3, ...enc('cover'), 0, ...PNG]),
    ];
    const buf = Uint8Array.from([...enc('ID3'), 3, 0, 0, ...syncsafe(frames.length), ...frames]);
    const tags = readId3(buf)!;
    expect(tags.title).toBe('Hombre Piedra');
    expect(tags.artist).toBe('José Madero');
    expect(tags.picture?.mime).toBe('image/png');
    expect(Array.from(tags.picture!.data)).toEqual(PNG);
  });

  it('ignores files without ID3', () => {
    expect(readId3(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBeNull();
  });
});

describe('readFlac', () => {
  it('reads Vorbis comments and the PICTURE block', () => {
    const vendor = enc('test');
    const comments = ['TITLE=Arrópame', 'ARTIST=José Madero'].map(enc);
    const vc = [...le32(vendor.length), ...vendor, ...le32(comments.length), ...comments.flatMap((c) => [...le32(c.length), ...c])];
    const mime = enc('image/png');
    const pic = [...be32(3), ...be32(mime.length), ...mime, ...be32(0), ...be32(1), ...be32(1), ...be32(24), ...be32(0), ...be32(PNG.length), ...PNG];
    const block = (type: number, body: number[], last = false) => [(last ? 0x80 : 0) | type, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255, ...body];
    const buf = Uint8Array.from([...enc('fLaC'), ...block(0, new Array(34).fill(0)), ...block(4, vc), ...block(6, pic, true)]);
    const tags = readFlac(buf)!;
    expect(tags.title).toBe('Arrópame');
    expect(tags.artist).toBe('José Madero');
    expect(tags.picture?.mime).toBe('image/png');
    expect(Array.from(tags.picture!.data)).toEqual(PNG);
  });
});
