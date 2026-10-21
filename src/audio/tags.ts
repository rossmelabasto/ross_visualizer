// Minimal tag reader: title, artist and embedded cover from ID3v2 (MP3) and FLAC.

export interface Tags {
  title?: string;
  artist?: string;
  picture?: { mime: string; data: Uint8Array };
}

function syncsafe(b: Uint8Array, o: number) {
  return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
}

function u32(b: Uint8Array, o: number) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function decodeText(enc: number, bytes: Uint8Array): string {
  const label = enc === 0 ? 'latin1' : enc === 1 ? 'utf-16' : enc === 2 ? 'utf-16be' : 'utf-8';
  return new TextDecoder(label).decode(bytes).replace(/\0+$/, '').split('\0')[0].trim();
}

/** Index just past a NUL terminator for the given ID3 text encoding. */
function skipTerminated(b: Uint8Array, start: number, enc: number): number {
  if (enc === 1 || enc === 2) {
    for (let i = start; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i + 2;
  } else {
    for (let i = start; i < b.length; i++) if (b[i] === 0) return i + 1;
  }
  return b.length;
}

function unsync(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < data.length; i++) {
    out.push(data[i]);
    if (data[i] === 0xff && data[i + 1] === 0x00) i++;
  }
  return Uint8Array.from(out);
}

export function readId3(buf: Uint8Array): Tags | null {
  if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return null;
  const version = buf[3];
  if (version < 3 || version > 4) return null;
  const flags = buf[5];
  const size = syncsafe(buf, 6);
  let tag = buf.subarray(10, Math.min(buf.length, 10 + size));
  if (flags & 0x80 && version === 3) tag = unsync(tag);
  let pos = 0;
  if (flags & 0x40) pos = version === 4 ? syncsafe(tag, 0) : u32(tag, 0) + 4;

  const tags: Tags = {};
  while (pos + 10 <= tag.length) {
    const id = String.fromCharCode(tag[pos], tag[pos + 1], tag[pos + 2], tag[pos + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const fsize = version === 4 ? syncsafe(tag, pos + 4) : u32(tag, pos + 4);
    const body = tag.subarray(pos + 10, pos + 10 + fsize);
    pos += 10 + fsize;
    if (!body.length) continue;
    if (id === 'TIT2') tags.title = decodeText(body[0], body.subarray(1));
    else if (id === 'TPE1') tags.artist = decodeText(body[0], body.subarray(1));
    else if (id === 'APIC' && !tags.picture) {
      const enc = body[0];
      const mimeEnd = skipTerminated(body, 1, 0);
      const mime = new TextDecoder('latin1').decode(body.subarray(1, mimeEnd - 1)) || 'image/jpeg';
      const descEnd = skipTerminated(body, mimeEnd + 1, enc);
      tags.picture = { mime: mime.includes('/') ? mime : `image/${mime.toLowerCase()}`, data: body.slice(descEnd) };
    }
  }
  return tags;
}

export function readFlac(buf: Uint8Array): Tags | null {
  if (buf.length < 8 || String.fromCharCode(...buf.subarray(0, 4)) !== 'fLaC') return null;
  const tags: Tags = {};
  let pos = 4;
  while (pos + 4 <= buf.length) {
    const last = buf[pos] & 0x80;
    const type = buf[pos] & 0x7f;
    const len = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
    const block = buf.subarray(pos + 4, pos + 4 + len);
    const dv = new DataView(block.buffer, block.byteOffset, block.byteLength);
    if (type === 4) {
      let o = 4 + dv.getUint32(0, true);
      const count = dv.getUint32(o, true);
      o += 4;
      const td = new TextDecoder();
      for (let i = 0; i < count && o + 4 <= block.length; i++) {
        const l = dv.getUint32(o, true);
        const kv = td.decode(block.subarray(o + 4, o + 4 + l));
        o += 4 + l;
        const eq = kv.indexOf('=');
        const key = kv.slice(0, eq).toUpperCase();
        if (key === 'TITLE') tags.title = kv.slice(eq + 1);
        else if (key === 'ARTIST' && !tags.artist) tags.artist = kv.slice(eq + 1);
      }
    } else if (type === 6 && !tags.picture) {
      let o = 4;
      const mlen = dv.getUint32(o);
      const mime = new TextDecoder().decode(block.subarray(o + 4, o + 4 + mlen));
      o += 4 + mlen;
      o += 4 + dv.getUint32(o); // description
      o += 16; // width, height, depth, colors
      const dlen = dv.getUint32(o);
      tags.picture = { mime, data: block.slice(o + 4, o + 4 + dlen) };
    }
    pos += 4 + len;
    if (last) break;
  }
  return tags;
}

export async function readTags(file: Blob): Promise<Tags> {
  // Covers can be big; 4 MB of header is plenty in practice.
  const head = new Uint8Array(await file.slice(0, 4 * 1024 * 1024).arrayBuffer());
  try {
    return readId3(head) ?? readFlac(head) ?? {};
  } catch {
    return {};
  }
}
