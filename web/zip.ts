/**
 * zip.ts — minimal ZIP (STORE, no compression) writer.
 *
 * Audio files are already compressed, so wrapping them uncompressed is fast
 * and the archive is barely larger than the sum of the tracks. This powers
 * "Save all to Files (.zip)": one tap bundles every downloaded track into a
 * single .zip that the iPhone Files app can unzip natively.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a ZIP archive Blob from a list of named file Blobs. */
export async function buildZip(files: { name: string; data: Blob }[]): Promise<Blob> {
  const encoder = new TextEncoder();
  const parts: Blob[] = [];
  const central: Blob[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = encoder.encode(f.name);
    const data = new Uint8Array(await f.data.arrayBuffer());
    const crc = crc32(data);
    const size = data.length;

    // Local file header (30 bytes) + name + data.
    const lfh = new Uint8Array(30);
    const dv = new DataView(lfh.buffer);
    dv.setUint32(0, 0x04034b50, true); // local file header signature
    dv.setUint16(4, 20, true); // version needed to extract
    dv.setUint16(6, 0x0800, true); // general purpose flag: UTF-8 names
    dv.setUint16(8, 0, true); // compression method: store
    dv.setUint16(10, 0, true); // mod time
    dv.setUint16(12, 0x21, true); // mod date
    dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true); // compressed size
    dv.setUint32(22, size, true); // uncompressed size
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true); // extra field length
    parts.push(new Blob([lfh, nameBytes, data]));

    // Central directory entry (46 bytes) + name.
    const cd = new Uint8Array(46);
    const cdv = new DataView(cd.buffer);
    cdv.setUint32(0, 0x02014b50, true); // central directory signature
    cdv.setUint16(4, 20, true); // version made by
    cdv.setUint16(6, 20, true); // version needed to extract
    cdv.setUint16(8, 0x0800, true); // UTF-8 names
    cdv.setUint16(10, 0, true); // method: store
    cdv.setUint16(12, 0, true); // mod time
    cdv.setUint16(14, 0x21, true); // mod date
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, size, true); // compressed size
    cdv.setUint32(24, size, true); // uncompressed size
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true); // extra len
    cdv.setUint16(32, 0, true); // comment len
    cdv.setUint16(34, 0, true); // disk number
    cdv.setUint16(36, 0, true); // internal attrs
    cdv.setUint32(38, 0, true); // external attrs
    cdv.setUint32(42, offset, true); // local header offset
    central.push(new Blob([cd, nameBytes]));

    offset += 30 + nameBytes.length + size;
  }

  // End of central directory record (22 bytes).
  let centralSize = 0;
  for (const part of central) centralSize += part.size;
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true); // EOCD signature
  edv.setUint16(8, files.length, true); // entries on this disk
  edv.setUint16(10, files.length, true); // total entries
  edv.setUint32(12, centralSize, true); // central directory size
  edv.setUint32(16, offset, true); // central directory offset
  edv.setUint16(20, 0, true); // comment length

  parts.push(new Blob(central), new Blob([eocd]));
  return new Blob(parts, { type: "application/zip" });
}
