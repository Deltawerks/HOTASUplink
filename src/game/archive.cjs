'use strict';

const fs = require('node:fs/promises');
const zlib = require('node:zlib');

const MAX_ASSET = 32 * 1024 * 1024;
const CHUNK = 2 * 1024 * 1024;

async function readAt(file, offset, size) {
  const buffer = Buffer.allocUnsafe(size);
  let filled = 0;
  while (filled < size) {
    const { bytesRead } = await file.read(buffer, filled, size - filled, offset + filled);
    if (!bytesRead) throw new Error('Unexpected end of Data.p4k');
    filled += bytesRead;
  }
  return buffer;
}

function uint64(bytes, offset) {
  const value = Number(bytes.readBigUInt64LE(offset));
  if (!Number.isSafeInteger(value)) throw new Error('Invalid ZIP64 offset');
  return value;
}

async function directory(file, fileSize) {
  const tail = await readAt(file, Math.max(0, fileSize - 66000), Math.min(66000, fileSize));
  const i = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
  if (i < 0 || i + 22 > tail.length) throw new Error('Missing P4K directory');
  const start = tail.readUInt32LE(i + 16);
  const size = tail.readUInt32LE(i + 12);
  if (start !== 0xffffffff && size !== 0xffffffff) return { start, size };
  if (i < 20 || tail.readUInt32LE(i - 20) !== 0x07064b50) throw new Error('Missing ZIP64 locator');
  const end = await readAt(file, uint64(tail, i - 12), 56);
  if (end.readUInt32LE(0) !== 0x06064b50) throw new Error('Invalid ZIP64 directory');
  return { start: uint64(end, 48), size: uint64(end, 40) };
}

function entryInfo(header, extra) {
  const fields = [header.readUInt32LE(24), header.readUInt32LE(20), header.readUInt32LE(42)];
  if (fields.includes(0xffffffff)) {
    let i = 0;
    while (i + 4 <= extra.length && extra.readUInt16LE(i) !== 1) i += 4 + extra.readUInt16LE(i + 2);
    if (i + 4 > extra.length) throw new Error('Missing ZIP64 entry metadata');
    const data = extra.subarray(i + 4, i + 4 + extra.readUInt16LE(i + 2));
    let cursor = 0;
    for (let k = 0; k < fields.length; k++) {
      if (fields[k] !== 0xffffffff) continue;
      fields[k] = uint64(data, cursor);
      cursor += 8;
    }
  }
  return { size: fields[0], compressed: fields[1], offset: fields[2], method: header.readUInt16LE(10) };
}

async function readAsset(file, entry) {
  if (entry.size > MAX_ASSET || entry.compressed > MAX_ASSET) throw new Error('Game data entry exceeds size limit');
  const header = await readAt(file, entry.offset, 30);
  if (header.readUInt32LE(0) !== 0x04034b50) throw new Error('Invalid P4K asset header');
  const payload = await readAt(file, entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28), entry.compressed);
  let result;
  const limits = { maxOutputLength: MAX_ASSET };
  if (entry.method === 0) result = payload;
  else if (entry.method === 8) result = zlib.inflateRawSync(payload, limits);
  else if ((entry.method === 100 || entry.method === 93) && zlib.zstdDecompressSync) result = zlib.zstdDecompressSync(payload, limits);
  else throw new Error('Unsupported P4K compression method ' + entry.method + ' in this runtime');
  if (result.length !== entry.size) throw new Error('P4K asset length mismatch');
  return result;
}

// Walk only the central directory in bounded chunks, then seek to the requested entries.
async function readGameAssets(archivePath, names) {
  const file = await fs.open(archivePath, 'r');
  try {
    const fileSize = (await file.stat()).size;
    const { start, size } = await directory(file, fileSize);
    if (start + size > fileSize) throw new Error('P4K directory exceeds file');
    const needed = new Set(names.map(name => name.toLowerCase().replaceAll('\\', '/')));
    const lengths = new Set([...needed].map(name => name.length));
    const result = new Map();
    let carry = Buffer.alloc(0);
    for (let pos = start; pos < start + size && needed.size;) {
      const next = await readAt(file, pos, Math.min(CHUNK, start + size - pos));
      pos += next.length;
      const bytes = carry.length ? Buffer.concat([carry, next]) : next;
      let i = 0;
      while (i + 46 <= bytes.length && needed.size) {
        if (bytes.readUInt32LE(i) !== 0x02014b50) throw new Error('Invalid P4K directory entry');
        const filenameSize = bytes.readUInt16LE(i + 28);
        const nameEnd = i + 46 + filenameSize;
        const extraEnd = nameEnd + bytes.readUInt16LE(i + 30);
        const end = extraEnd + bytes.readUInt16LE(i + 32);
        if (end > bytes.length) break;
        if (lengths.has(filenameSize)) {
          const name = bytes.toString('utf8', i + 46, nameEnd).toLowerCase().replaceAll('\\', '/');
          if (needed.delete(name)) {
            const entry = entryInfo(bytes.subarray(i, i + 46), bytes.subarray(nameEnd, extraEnd));
            result.set(name, await readAsset(file, entry));
          }
        }
        i = end;
      }
      carry = bytes.subarray(i);
    }
    return result;
  } finally {
    await file.close();
  }
}

module.exports = { readGameAssets };
