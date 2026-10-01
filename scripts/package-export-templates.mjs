import { readFile, writeFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { packWorkbook } from '../src/reporting.js';

// Repackage the Artifact Tool-authored templates as STORE ZIP archives, so the
// static client needs no third-party decompressor to fill the data area.
for (const kind of ['financial', 'audit']) {
  const path = `public/export-templates/${kind}.xlsx`;
  const bytes = await readFile(path); const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = new Map(); let p = 0;
  while (p + 30 <= bytes.length && view.getUint32(p, true) === 0x04034b50) {
    const method = view.getUint16(p + 8, true), length = view.getUint32(p + 18, true), nameLength = view.getUint16(p + 26, true), extra = view.getUint16(p + 28, true);
    if (view.getUint16(p + 6, true) & 8) throw new Error('Unexpected streaming ZIP template');
    const name = new TextDecoder().decode(bytes.subarray(p + 30, p + 30 + nameLength)); const start = p + 30 + nameLength + extra;
    const payload = bytes.subarray(start, start + length);
    files.set(name, method === 8 ? new Uint8Array(inflateRawSync(payload)) : method === 0 ? payload : (() => { throw new Error('Unsupported ZIP method'); })());
    p = start + length;
  }
  await writeFile(path, packWorkbook(files));
}
