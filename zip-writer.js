// Minimal, dependency-free ZIP writer (STORED method, no compression) that
// writes an explicit per-entry modification date/time -- used for "Download
// all as ZIP", where each file inside the archive should show its original
// upload time, not the moment the ZIP was assembled.
//
// No compression is used deliberately: most of what HotDrop stores (JPEGs,
// PDFs, already-compressed office formats) barely compresses further anyway,
// and STORED keeps this file simple enough to fully hand-verify (see
// test/zip.js, which builds a real archive and checks it with the system
// `unzip`/`zipinfo` tools) rather than trusting an unverified DEFLATE
// implementation.
//
// Works unmodified in both the browser (loaded via <script src="zip-writer.js">)
// and Node (via module.exports, used by the test suite).

(function (root) {
  function makeCrcTable() {
    const table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  }
  const CRC_TABLE = makeCrcTable();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime(date) {
    const year = date.getFullYear();
    const dosDate = (((year - 1980) & 0x7F) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    return { dosDate: dosDate & 0xFFFF, dosTime: dosTime & 0xFFFF };
  }

  function writeUint16LE(arr, offset, value) { arr[offset] = value & 0xFF; arr[offset + 1] = (value >>> 8) & 0xFF; }
  function writeUint32LE(arr, offset, value) {
    arr[offset] = value & 0xFF;
    arr[offset + 1] = (value >>> 8) & 0xFF;
    arr[offset + 2] = (value >>> 16) & 0xFF;
    arr[offset + 3] = (value >>> 24) & 0xFF;
  }
  function utf8Bytes(str) { return new TextEncoder().encode(str); }

  // entries: [{ name: string, data: Uint8Array, date: Date }]
  // Returns a Uint8Array of the complete ZIP file.
  function buildZip(entries) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    entries.forEach(entry => {
      const nameBytes = utf8Bytes(entry.name);
      const data = entry.data;
      const crc = crc32(data);
      const { dosDate, dosTime } = dosDateTime(entry.date);
      const size = data.length;

      const local = new Uint8Array(30 + nameBytes.length);
      writeUint32LE(local, 0, 0x04034b50);
      writeUint16LE(local, 4, 20);
      writeUint16LE(local, 6, 0x0800); // bit 11: UTF-8 filename
      writeUint16LE(local, 8, 0);      // stored, no compression
      writeUint16LE(local, 10, dosTime);
      writeUint16LE(local, 12, dosDate);
      writeUint32LE(local, 14, crc);
      writeUint32LE(local, 18, size);
      writeUint32LE(local, 22, size);
      writeUint16LE(local, 26, nameBytes.length);
      writeUint16LE(local, 28, 0);
      local.set(nameBytes, 30);

      localParts.push(local, data);
      const localHeaderOffset = offset;
      offset += local.length + data.length;

      const central = new Uint8Array(46 + nameBytes.length);
      writeUint32LE(central, 0, 0x02014b50);
      writeUint16LE(central, 4, 20);
      writeUint16LE(central, 6, 20);
      writeUint16LE(central, 8, 0x0800);
      writeUint16LE(central, 10, 0);
      writeUint16LE(central, 12, dosTime);
      writeUint16LE(central, 14, dosDate);
      writeUint32LE(central, 16, crc);
      writeUint32LE(central, 20, size);
      writeUint32LE(central, 24, size);
      writeUint16LE(central, 28, nameBytes.length);
      writeUint16LE(central, 30, 0);
      writeUint16LE(central, 32, 0);
      writeUint16LE(central, 34, 0);
      writeUint16LE(central, 36, 0);
      writeUint32LE(central, 38, 0);
      writeUint32LE(central, 42, localHeaderOffset);
      central.set(nameBytes, 46);

      centralParts.push(central);
    });

    const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
    const centralOffset = offset;

    const end = new Uint8Array(22);
    writeUint32LE(end, 0, 0x06054b50);
    writeUint16LE(end, 4, 0);
    writeUint16LE(end, 6, 0);
    writeUint16LE(end, 8, entries.length);
    writeUint16LE(end, 10, entries.length);
    writeUint32LE(end, 12, centralSize);
    writeUint32LE(end, 16, centralOffset);
    writeUint16LE(end, 20, 0);

    const allParts = [...localParts, ...centralParts, end];
    const totalLen = allParts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(totalLen);
    let pos = 0;
    for (const p of allParts) { out.set(p, pos); pos += p.length; }
    return out;
  }

  // Turns a display name into something safe to use as a flat ZIP entry name:
  // strips path separators (so a crafted item name can never create nested
  // folders on extraction), trims to a sane length, and de-duplicates against
  // names already used in this archive.
  function safeZipName(rawName, usedNames) {
    let name = String(rawName || 'file').replace(/[\/\\]+/g, '-').replace(/[\x00-\x1f]/g, '').trim();
    if (!name) name = 'file';
    if (name.length > 150) name = name.slice(0, 150);
    let candidate = name;
    let n = 2;
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    while (usedNames.has(candidate)) {
      candidate = `${base} (${n})${ext}`;
      n++;
    }
    usedNames.add(candidate);
    return candidate;
  }

  const api = { buildZip, crc32, dosDateTime, safeZipName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HotDropZip = api;
})(typeof window !== 'undefined' ? window : globalThis);
