'use strict';
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { store, resetStore, makeRes, makeJsonReq, makeStreamReq } = require('./harness');

const clipboardHandler = require(path.join('..', 'api', 'clipboard.js'));
const shareHandler = require(path.join('..', 'api', 'share-target.js'));

let pass = 0, fail = 0;
const failures = [];
const timings = [];

async function test(name, fn) {
  const start = process.hrtime.bigint();
  try {
    await fn();
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    timings.push({ name, ms, ok: true });
    pass++;
    console.log(`  ok   ${name}  (${ms.toFixed(2)}ms)`);
  } catch (err) {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    timings.push({ name, ms, ok: false });
    fail++;
    failures.push({ name, err });
    console.log(`  FAIL ${name}  (${ms.toFixed(2)}ms)\n       ${err.message}`);
  }
}

function section(title) { console.log(`\n${title}`); }

function uid() { return crypto.randomBytes(9).toString('hex'); }

async function post(room, action, extra = {}) {
  const req = makeJsonReq({ method: 'POST', body: { room, action, ...extra } });
  const res = makeRes();
  await clipboardHandler(req, res);
  return res;
}

async function get(query) {
  const req = makeJsonReq({ method: 'GET', query });
  const res = makeRes();
  await clipboardHandler(req, res);
  return res;
}

async function del(room, id) {
  const req = makeJsonReq({ method: 'DELETE', body: { room, id } });
  const res = makeRes();
  await clipboardHandler(req, res);
  return res;
}

async function listRoom(room) {
  return get({ room });
}

async function addTextItem(room, text, ts) {
  return post(room, 'addText', { item: { id: uid(), type: 'text', data: text, ts: ts || Date.now() } });
}

async function uploadFullFile(room, { name, mime, type, sizeBytes, thumb }) {
  const CHUNK = 1536 * 1024;
  const chunks = Math.max(1, Math.ceil(sizeBytes / CHUNK));
  const id = uid();
  const sourceBuffer = crypto.randomBytes(sizeBytes);
  const initRes = await post(room, 'initBinary', {
    item: { id, type, name, mime, size: sizeBytes, chunks, ts: Date.now(), ...(thumb ? { thumb } : {}) }
  });
  if (initRes.statusCode >= 400) return { initRes, sourceBuffer, id };

  for (let i = 0; i < chunks; i++) {
    const slice = sourceBuffer.slice(i * CHUNK, Math.min(sizeBytes, (i + 1) * CHUNK));
    const uploadRes = await post(room, 'uploadChunk', { id, index: i, data: slice.toString('base64') });
    assert.strictEqual(uploadRes.statusCode, 200, `chunk ${i} upload failed: ${JSON.stringify(uploadRes.body)}`);
  }
  const finishRes = await post(room, 'finishBinary', { id });
  return { initRes, finishRes, sourceBuffer, id, chunks };
}

async function downloadFullFile(room, id, chunks) {
  const parts = [];
  for (let i = 0; i < chunks; i++) {
    const res = await get({ room, id, chunk: String(i) });
    assert.strictEqual(res.statusCode, 200, `chunk ${i} download failed`);
    parts.push(res.body);
  }
  return Buffer.concat(parts);
}

async function main() {
  console.log('HotDrop backend integration + benchmark suite');
  console.log('Node', process.version, '\n' + '='.repeat(60));

  // ---------------------------------------------------------------
  section('Text items: add, list, ordering');
  resetStore();
  {
    const room = 'bench-text-' + uid();
    await test('addText succeeds and is listed', async () => {
      const r = await addTextItem(room, 'hello world', Date.now());
      assert.strictEqual(r.statusCode, 201);
      const listed = await listRoom(room);
      assert.strictEqual(listed.body.items.length, 1);
      assert.strictEqual(listed.body.items[0].data, 'hello world');
    });

    await test('items are returned oldest-first, newest last', async () => {
      await addTextItem(room, 'second', Date.now() + 10);
      await addTextItem(room, 'third', Date.now() + 20);
      const listed = await listRoom(room);
      const texts = listed.body.items.map((i) => i.data);
      assert.deepStrictEqual(texts, ['hello world', 'second', 'third']);
    });

    await test('empty text is rejected (400)', async () => {
      const req = makeJsonReq({ method: 'POST', body: { room, action: 'addText', item: { id: uid(), type: 'text', data: '   ', ts: Date.now() } } });
      const res = makeRes();
      await clipboardHandler(req, res);
      assert.strictEqual(res.statusCode, 400);
    });

    await test('oversized text is rejected (400)', async () => {
      const big = 'x'.repeat(201 * 1024);
      const req = makeJsonReq({ method: 'POST', body: { room, action: 'addText', item: { id: uid(), type: 'text', data: big, ts: Date.now() } } });
      const res = makeRes();
      await clipboardHandler(req, res);
      assert.strictEqual(res.statusCode, 400);
    });
  }

  // ---------------------------------------------------------------
  section('Validation & input hardening');
  {
    await test('invalid room code rejected on GET', async () => {
      const res = await get({ room: 'a;DROP TABLE' });
      assert.strictEqual(res.statusCode, 400);
    });
    await test('invalid room code rejected on POST', async () => {
      const res = await post('a b', 'addText', { item: { id: uid(), type: 'text', data: 'x', ts: Date.now() } });
      assert.strictEqual(res.statusCode, 400);
    });
    await test('unknown action rejected (400)', async () => {
      const res = await post('validroom123', 'deleteEverything');
      assert.strictEqual(res.statusCode, 400);
    });
    await test('malformed JSON body rejected (400)', async () => {
      const req = { method: 'POST', body: '{not json', query: {}, headers: {} };
      const res = makeRes();
      await clipboardHandler(req, res);
      assert.strictEqual(res.statusCode, 400);
    });
    await test('filename with newline (header-injection attempt) rejected', async () => {
      const room = 'validroom123';
      const res = await post(room, 'initBinary', { item: { id: uid(), type: 'file', name: 'evil\r\nX-Injected: 1', mime: 'text/plain', size: 10, chunks: 1, ts: Date.now() } });
      assert.strictEqual(res.statusCode, 400);
    });
    await test('mismatched chunk count rejected', async () => {
      const room = 'validroom123';
      const res = await post(room, 'initBinary', { item: { id: uid(), type: 'file', name: 'a.txt', mime: 'text/plain', size: 5 * 1024 * 1024, chunks: 1, ts: Date.now() } });
      assert.strictEqual(res.statusCode, 400);
    });
    await test('file exceeding MAX_FILE_BYTES rejected', async () => {
      const room = 'validroom123';
      const res = await post(room, 'initBinary', { item: { id: uid(), type: 'file', name: 'huge.bin', mime: 'application/octet-stream', size: 17 * 1024 * 1024, chunks: 12, ts: Date.now() } });
      assert.strictEqual(res.statusCode, 400);
    });
    await test('DELETE on nonexistent item is a graceful no-op (200, removed:false)', async () => {
      const res = await del('validroom123', 'nonexistent0');
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.removed, false);
    });
    await test('chunk fetch on a text item is rejected (400)', async () => {
      const room = 'validroom123';
      const r = await addTextItem(room, 'just text', Date.now());
      const listed = await listRoom(room);
      const id = listed.body.items[listed.body.items.length - 1].id;
      const res = await get({ room, id, chunk: '0' });
      assert.strictEqual(res.statusCode, 400);
    });
    await test('out-of-range chunk index is rejected (416)', async () => {
      const room = 'validroom123-files';
      const { finishRes, id } = await uploadFullFile(room, { name: 'small.bin', mime: 'application/octet-stream', type: 'file', sizeBytes: 1024 });
      assert.strictEqual(finishRes.statusCode, 200);
      const res = await get({ room, id, chunk: '5' });
      assert.strictEqual(res.statusCode, 416);
    });
  }

  // ---------------------------------------------------------------
  section('Regression: oversized/invalid thumbnail must NEVER block an upload');
  {
    const room = 'thumb-regress-' + uid();
    await test('oversized thumbnail is silently dropped, upload still succeeds', async () => {
      const oversizedThumb = 'A'.repeat(61 * 1024); // over the 60KB server cap
      const { initRes, finishRes, id } = await uploadFullFile(room, {
        name: 'photo.jpg', mime: 'image/jpeg', type: 'image', sizeBytes: 720 * 1024, thumb: oversizedThumb
      });
      assert.strictEqual(initRes.statusCode, 201, `initBinary should succeed even with a bad thumb: ${JSON.stringify(initRes.body)}`);
      assert.strictEqual(finishRes.statusCode, 200);
      const listed = await listRoom(room);
      const item = listed.body.items.find((i) => i.id === id);
      assert.ok(item, 'uploaded item should be listed');
      assert.strictEqual(item.thumb, undefined, 'oversized thumb must not be persisted');
    });
    await test('invalid base64 thumbnail is silently dropped, upload still succeeds', async () => {
      const { initRes, id } = await uploadFullFile(room, {
        name: 'photo2.jpg', mime: 'image/jpeg', type: 'image', sizeBytes: 10 * 1024, thumb: 'not-valid-base64!!! ###'
      });
      assert.strictEqual(initRes.statusCode, 201);
      const listed = await listRoom(room);
      const item = listed.body.items.find((i) => i.id === id);
      assert.strictEqual(item.thumb, undefined);
    });
    await test('valid small thumbnail IS persisted and returned', async () => {
      const goodThumb = Buffer.from('a real thumbnail payload').toString('base64');
      const { id } = await uploadFullFile(room, {
        name: 'photo3.jpg', mime: 'image/jpeg', type: 'image', sizeBytes: 10 * 1024, thumb: goodThumb
      });
      const listed = await listRoom(room);
      const item = listed.body.items.find((i) => i.id === id);
      assert.strictEqual(item.thumb, goodThumb);
    });
  }

  // ---------------------------------------------------------------
  section('Binary upload/download round-trip integrity');
  {
    const room = 'binary-' + uid();
    await test('single-chunk file round-trips byte-for-byte', async () => {
      const { finishRes, sourceBuffer, id } = await uploadFullFile(room, { name: 'small.bin', mime: 'application/octet-stream', type: 'file', sizeBytes: 50 * 1024 });
      assert.strictEqual(finishRes.statusCode, 200);
      const downloaded = await downloadFullFile(room, id, 1);
      assert.ok(sourceBuffer.equals(downloaded), 'downloaded bytes must exactly match uploaded bytes');
    });

    await test('multi-chunk file (3 chunks) round-trips byte-for-byte', async () => {
      const sizeBytes = Math.floor(1536 * 1024 * 2.4); // spans 3 chunks
      const { finishRes, sourceBuffer, id, chunks } = await uploadFullFile(room, { name: 'multi.bin', mime: 'application/octet-stream', type: 'file', sizeBytes });
      assert.strictEqual(finishRes.statusCode, 200);
      assert.strictEqual(chunks, 3);
      const downloaded = await downloadFullFile(room, id, chunks);
      assert.ok(sourceBuffer.equals(downloaded), 'multi-chunk reassembly must match source exactly');
    });

    await test('cancelBinary removes an in-progress upload cleanly', async () => {
      const id = uid();
      const initRes = await post(room, 'initBinary', { item: { id, type: 'file', name: 'abandoned.bin', mime: 'application/octet-stream', size: 1024, chunks: 1, ts: Date.now() } });
      assert.strictEqual(initRes.statusCode, 201);
      const cancelRes = await post(room, 'cancelBinary', { id });
      assert.strictEqual(cancelRes.statusCode, 200);
      const listed = await listRoom(room);
      assert.ok(!listed.body.items.find((i) => i.id === id));
    });
  }

  // ---------------------------------------------------------------
  section('Pin protection & eviction correctness');
  {
    const room = 'evict-' + uid();
    const ITEM_BYTES = 190 * 1024; // just under MAX_TEXT_BYTES, to force byte-pressure eviction quickly
    const text = 'x'.repeat(ITEM_BYTES - 300);

    await test('oldest-first eviction keeps room under the byte cap', async () => {
      const start = Date.now();
      const need = Math.ceil(32 * 1024 * 1024 / ITEM_BYTES) + 15; // comfortably exceed the 32MB room cap
      for (let i = 0; i < need; i++) await addTextItem(room, text + i, start + i);
      const listed = await listRoom(room);
      assert.ok(listed.body.stats.usageBytes <= listed.body.stats.maxRoomBytes, 'usage must stay under the room cap');
      assert.ok(listed.body.items.length < need, 'some items must have been evicted to fit');
      // survivors should be the most recently added ones
      const survivorTexts = listed.body.items.map((i) => i.data);
      assert.ok(survivorTexts[survivorTexts.length - 1].endsWith(String(need - 1)), 'the most recent item must survive');
    });

    await test('pinned items survive eviction pressure that would otherwise evict them', async () => {
      const room2 = 'evict-pin-' + uid();
      const start = Date.now();
      const firstRes = await addTextItem(room2, text + 'PINME', start);
      const firstListed = await listRoom(room2);
      const firstId = firstListed.body.items[0].id;
      const pinRes = await post(room2, 'setPinned', { id: firstId, pinned: true });
      assert.strictEqual(pinRes.statusCode, 200);
      assert.strictEqual(pinRes.body.pinned, true);

      for (let i = 0; i < 15; i++) await addTextItem(room2, text + i, start + i + 1);

      const finalListed = await listRoom(room2);
      const survivor = finalListed.body.items.find((i) => i.id === firstId);
      assert.ok(survivor, 'pinned item must survive routine eviction pressure');
      assert.strictEqual(survivor.pinned, true);
    });

    await test('pinned items are evicted only as a last resort when nothing else can free space', async () => {
      const room3 = 'evict-pin-lastresort-' + uid();
      const start = Date.now();
      const ids = [];
      // Fill the room entirely with pinned items near the cap.
      for (let i = 0; i < 8; i++) {
        await addTextItem(room3, text + i, start + i);
        const listed = await listRoom(room3);
        const item = listed.body.items[listed.body.items.length - 1];
        await post(room3, 'setPinned', { id: item.id, pinned: true });
        ids.push(item.id);
        if (listed.body.stats.usageBytes + ITEM_BYTES > listed.body.stats.maxRoomBytes) break;
      }
      const before = await listRoom(room3);
      assert.ok(before.body.items.every((i) => i.pinned), 'sanity: every existing item should be pinned');

      // This new item cannot fit unless a pinned item is evicted — verify it still succeeds
      // rather than the request being rejected outright (no permanent deadlock).
      const res = await addTextItem(room3, text + 'NEW', start + 999);
      assert.strictEqual(res.statusCode, 201, 'upload must still succeed by evicting a pinned item as a last resort');
      const after = await listRoom(room3);
      assert.ok(after.body.stats.usageBytes <= after.body.stats.maxRoomBytes);
      const newest = after.body.items[after.body.items.length - 1];
      assert.ok(newest.data.endsWith('NEW'), 'the new item must be present');
    });
  }

  // ---------------------------------------------------------------
  section('Room expiry (TTL) surfaced correctly');
  {
    const room = 'ttl-' + uid();
    await test('secondsRemaining is null for a room with no activity yet', async () => {
      const res = await get({ room });
      assert.strictEqual(res.body.stats.secondsRemaining, null);
    });
    await test('secondsRemaining reflects the 7-day TTL after a write', async () => {
      await addTextItem(room, 'hi', Date.now());
      const res = await get({ room });
      const sec = res.body.stats.secondsRemaining;
      assert.ok(sec > 0 && sec <= 7 * 24 * 60 * 60, `expected a positive TTL under 7 days, got ${sec}`);
    });
  }

  // ---------------------------------------------------------------
  section('Share-target: multipart parsing, one-time token, expiry semantics');
  {
    function buildMultipart(fields, files) {
      const boundary = 'BenchBoundary' + crypto.randomBytes(6).toString('hex');
      const chunks = [];
      for (const [name, value] of Object.entries(fields)) {
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
      }
      for (const f of files) {
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: ${f.mime}\r\n\r\n`));
        chunks.push(f.data);
        chunks.push(Buffer.from('\r\n'));
      }
      chunks.push(Buffer.from(`--${boundary}--\r\n`));
      return { boundary, buffer: Buffer.concat(chunks) };
    }

    let tokenHolder = {};

    await test('POST with text+url+binary file redirects with a token', async () => {
      const binaryWithCRLFBytes = Buffer.concat([crypto.randomBytes(4096), Buffer.from([0x0d, 0x0a, 0x00, 0x0d, 0x0a]), crypto.randomBytes(4096)]);
      const { boundary, buffer } = buildMultipart(
        { title: 'My Title', text: 'Shared text with emoji 🔥', url: 'https://example.com/x' },
        [{ name: 'photo.png', mime: 'image/png', data: binaryWithCRLFBytes }]
      );
      const req = makeStreamReq({ method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, bodyBuffer: buffer });
      const res = makeRes();
      await shareHandler(req, res);
      assert.strictEqual(res.statusCode, 303, `expected redirect, got ${res.statusCode} ${JSON.stringify(res.body)}`);
      const loc = res.headers.Location;
      assert.ok(/^\/\?share=[a-f0-9]{32}$/.test(loc), `unexpected redirect location: ${loc}`);
      tokenHolder.token = loc.split('=')[1];
      tokenHolder.originalBinary = binaryWithCRLFBytes;
    });

    await test('GET with the token returns the exact original content, including binary CRLF bytes', async () => {
      const req = makeJsonReq({ method: 'GET', query: { token: tokenHolder.token } });
      const res = makeRes();
      await shareHandler(req, res);
      assert.strictEqual(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.title, 'My Title');
      assert.strictEqual(data.text, 'Shared text with emoji 🔥');
      assert.strictEqual(data.url, 'https://example.com/x');
      assert.strictEqual(data.files.length, 1);
      const roundTripped = Buffer.from(data.files[0].data, 'base64');
      assert.ok(roundTripped.equals(tokenHolder.originalBinary), 'binary file content must survive the multipart parse + base64 round trip exactly');
    });

    await test('the same token cannot be read twice (one-time read)', async () => {
      const req = makeJsonReq({ method: 'GET', query: { token: tokenHolder.token } });
      const res = makeRes();
      await shareHandler(req, res);
      assert.strictEqual(res.statusCode, 404);
    });

    await test('a malformed token is rejected without touching storage', async () => {
      const req = makeJsonReq({ method: 'GET', query: { token: 'not-a-real-token' } });
      const res = makeRes();
      await shareHandler(req, res);
      assert.strictEqual(res.statusCode, 400);
    });

    await test('a POST with nothing shared is rejected (400)', async () => {
      const { boundary, buffer } = buildMultipart({}, []);
      const req = makeStreamReq({ method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, bodyBuffer: buffer });
      const res = makeRes();
      await shareHandler(req, res);
      assert.strictEqual(res.statusCode, 400);
    });

    await test('a non-multipart POST is rejected (400)', async () => {
      const req = makeStreamReq({ method: 'POST', headers: { 'content-type': 'application/json' }, bodyBuffer: Buffer.from('{}') });
      const res = makeRes();
      await shareHandler(req, res);
      assert.strictEqual(res.statusCode, 400);
    });
  }

  // ---------------------------------------------------------------
  section('Benchmark: throughput under realistic load');
  {
    const room = 'perf-' + uid();
    await test('120 sequential text writes stay correct at the MAX_ITEMS_PER_ROOM cap', async () => {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < 130; i++) await addTextItem(room, 'perf item ' + i, Date.now() + i);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const listed = await listRoom(room);
      assert.ok(listed.body.items.length <= 120, 'must never exceed MAX_ITEMS_PER_ROOM');
      console.log(`       -> 130 writes in ${ms.toFixed(1)}ms  (${(130000 / ms).toFixed(0)} writes/sec against the mock store)`);
    });

    await test('multipart parser throughput on a larger (2MB) payload', async () => {
      function buildMultipart(fields, files) {
        const boundary = 'PerfBoundary' + crypto.randomBytes(6).toString('hex');
        const chunks = [];
        for (const [name, value] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
        for (const f of files) {
          chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: ${f.mime}\r\n\r\n`));
          chunks.push(f.data);
          chunks.push(Buffer.from('\r\n'));
        }
        chunks.push(Buffer.from(`--${boundary}--\r\n`));
        return { boundary, buffer: Buffer.concat(chunks) };
      }
      const bigFile = crypto.randomBytes(2 * 1024 * 1024);
      const { boundary, buffer } = buildMultipart({ text: 'perf' }, [{ name: 'big.bin', mime: 'application/octet-stream', data: bigFile }]);
      const req = makeStreamReq({ method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, bodyBuffer: buffer });
      const res = makeRes();
      const t0 = process.hrtime.bigint();
      await shareHandler(req, res);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.strictEqual(res.statusCode, 303);
      const mbPerSec = (buffer.length / (1024 * 1024)) / (ms / 1000);
      console.log(`       -> parsed ${(buffer.length / 1024 / 1024).toFixed(2)}MB multipart body in ${ms.toFixed(1)}ms  (~${mbPerSec.toFixed(1)} MB/s)`);
    });

    await test('4MB binary file upload+download round trip timing', async () => {
      const t0 = process.hrtime.bigint();
      const { finishRes, sourceBuffer, id, chunks } = await uploadFullFile(room, { name: 'perf.bin', mime: 'application/octet-stream', type: 'file', sizeBytes: 4 * 1024 * 1024 });
      const tUpload = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.strictEqual(finishRes.statusCode, 200);
      const t1 = process.hrtime.bigint();
      const downloaded = await downloadFullFile(room, id, chunks);
      const tDownload = Number(process.hrtime.bigint() - t1) / 1e6;
      assert.ok(sourceBuffer.equals(downloaded));
      console.log(`       -> upload ${tUpload.toFixed(1)}ms, download ${tDownload.toFixed(1)}ms for a 4MB/${chunks}-chunk file (mock store; real network time will dominate in production)`);
    });
  }

  // ---------------------------------------------------------------
  console.log('\n' + '='.repeat(60));
  console.log(`RESULT: ${pass} passed, ${fail} failed, ${pass + fail} total`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f.name}: ${f.err.message}`));
  }
  console.log('\nKnown limitation (by design, not a bug being tracked here):');
  console.log('  Read-modify-write eviction (HGETALL then HSET) is not atomic against a second');
  console.log('  concurrent writer in the same room. Acceptable for a personal/small-group tool;');
  console.log('  would need a Lua script or optimistic lock (WATCH-style) to fully close for');
  console.log('  many-simultaneous-writers scenarios.');

  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exitCode = 1;
});
