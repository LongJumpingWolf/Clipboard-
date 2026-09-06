'use strict';
// Verifies the ZIP writer against REAL unzip/zipinfo (not a reimplementation
// of the format) -- integrity, per-file timestamps, unicode names, and the
// filename-sanitization/dedup logic used for "Download all as ZIP".

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { buildZip, safeZipName } = require('../zip-writer.js');

let pass = 0, fail = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
function section(t) { console.log(`\n${t}`); }

function haveUnzipTools() {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    execFileSync('zipinfo', ['-v'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function withTempZip(entries, fn) {
  const bytes = buildZip(entries);
  const file = path.join(os.tmpdir(), `hotdrop-zip-test-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  fs.writeFileSync(file, Buffer.from(bytes));
  try {
    fn(file, bytes);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

console.log('HotDrop ZIP writer — verified against real unzip/zipinfo');
console.log('='.repeat(60));

const hasTools = haveUnzipTools();
if (!hasTools) {
  console.log('\n(system unzip/zipinfo not found -- skipping byte-level verification, structural tests only)\n');
}

section('Structural correctness');
{
  test('empty entry list produces a minimal valid (empty) archive', () => {
    const bytes = buildZip([]);
    assert.strictEqual(bytes.length, 22, 'an empty archive should be exactly the 22-byte end-of-central-directory record');
    // Signature check: 0x06054b50 little-endian
    assert.strictEqual(bytes[0], 0x50);
    assert.strictEqual(bytes[1], 0x4b);
    assert.strictEqual(bytes[2], 0x05);
    assert.strictEqual(bytes[3], 0x06);
  });

  test('archive size grows with content, not fixed', () => {
    const small = buildZip([{ name: 'a.txt', data: new TextEncoder().encode('hi'), date: new Date() }]);
    const big = buildZip([{ name: 'a.txt', data: new Uint8Array(100000), date: new Date() }]);
    assert.ok(big.length > small.length);
  });
}

section('Filename safety (this is what prevents a crafted item name from doing anything weird)');
{
  test('path separators are stripped so an item name can never create nested folders', () => {
    const used = new Set();
    const name = safeZipName('../../etc/passwd', used);
    assert.ok(!name.includes('/') && !name.includes('\\'), `expected no path separators, got "${name}"`);
  });
  test('duplicate names are de-duplicated with a numeric suffix, preserving the extension', () => {
    const used = new Set();
    const a = safeZipName('photo.jpg', used);
    const b = safeZipName('photo.jpg', used);
    const c = safeZipName('photo.jpg', used);
    assert.strictEqual(a, 'photo.jpg');
    assert.strictEqual(b, 'photo (2).jpg');
    assert.strictEqual(c, 'photo (3).jpg');
  });
  test('control characters are stripped, empty names fall back to a default', () => {
    const used = new Set();
    assert.strictEqual(safeZipName('\x00\x01', used), 'file');
    assert.strictEqual(safeZipName('', used), 'file (2)');
  });
  test('extremely long names are truncated rather than breaking the header', () => {
    const used = new Set();
    const name = safeZipName('x'.repeat(500), used);
    assert.ok(name.length <= 150);
  });
}

if (hasTools) {
  section('Byte-level verification against the real unzip/zipinfo tools');

  test('a simple archive passes unzip -t (CRC/integrity check)', () => {
    withTempZip([
      { name: 'notes.txt', data: new TextEncoder().encode('hello from HotDrop\n'.repeat(50)), date: new Date('2026-08-15T10:23:00') }
    ], (file) => {
      const out = execFileSync('unzip', ['-t', file]).toString();
      assert.ok(/No errors detected/.test(out), `unzip -t reported a problem:\n${out}`);
    });
  });

  test('per-file modification date matches the upload time we set, not the build time', () => {
    const uploadDate = new Date('2026-08-15T10:23:00');
    withTempZip([
      { name: 'old-upload.txt', data: new TextEncoder().encode('content'), date: uploadDate }
    ], (file) => {
      const listing = execFileSync('unzip', ['-l', file]).toString();
      assert.ok(listing.includes('2026-08-15 10:23'), `expected the original upload date in the listing, got:\n${listing}`);
    });
  });

  test('multiple files preserve their own distinct dates independently', () => {
    withTempZip([
      { name: 'first.txt', data: new TextEncoder().encode('a'), date: new Date('2026-01-01T00:00:00') },
      { name: 'second.txt', data: new TextEncoder().encode('b'), date: new Date('2026-06-15T12:30:00') },
      { name: 'third.txt', data: new TextEncoder().encode('c'), date: new Date('2026-09-06T23:59:00') }
    ], (file) => {
      const listing = execFileSync('unzip', ['-l', file]).toString();
      assert.ok(listing.includes('2026-01-01 00:00'), 'first file date missing/wrong');
      assert.ok(listing.includes('2026-06-15 12:30'), 'second file date missing/wrong');
      assert.ok(listing.includes('2026-09-06 23:59'), 'third file date missing/wrong');
    });
  });

  test('unicode filenames survive a real extraction with correct content', () => {
    withTempZip([
      { name: 'chapter — respiratory (é).txt', data: new TextEncoder().encode('unicode name test payload'), date: new Date('2026-09-01T00:00:00') }
    ], (file) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdrop-zip-extract-'));
      try {
        execFileSync('unzip', ['-o', file, '-d', dir]);
        const files = fs.readdirSync(dir);
        assert.strictEqual(files.length, 1);
        const content = fs.readFileSync(path.join(dir, files[0]), 'utf8');
        assert.strictEqual(content, 'unicode name test payload');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test('binary content round-trips byte-for-byte through a real extraction', () => {
    const original = require('crypto').randomBytes(50000);
    withTempZip([{ name: 'random.bin', data: original, date: new Date() }], (file) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdrop-zip-extract-'));
      try {
        execFileSync('unzip', ['-o', file, '-d', dir]);
        const extracted = fs.readFileSync(path.join(dir, 'random.bin'));
        assert.ok(Buffer.compare(original, extracted) === 0, 'extracted bytes do not match the original exactly');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test('a realistic room-sized archive (20 files, ~30MB) builds correctly and passes integrity check', () => {
    const entries = [];
    for (let i = 0; i < 20; i++) {
      entries.push({
        name: `file-${i}.bin`,
        data: require('crypto').randomBytes(1.5 * 1024 * 1024),
        date: new Date(Date.now() - i * 60000)
      });
    }
    withTempZip(entries, (file, bytes) => {
      assert.ok(bytes.length > 29 * 1024 * 1024, 'expected roughly 30MB of output');
      const out = execFileSync('unzip', ['-t', file]).toString();
      assert.ok(/No errors detected/.test(out));
    });
  });
}

console.log('\n' + '='.repeat(60));
console.log(`RESULT: ${pass} passed, ${fail} failed, ${pass + fail} total`);
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f.name}\n      ${f.err.message}`));
}
process.exitCode = fail ? 1 : 0;
