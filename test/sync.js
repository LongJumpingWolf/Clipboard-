'use strict';
// Worst-case frontend sync tests. Loads the REAL index.html in jsdom with a
// controllable fake network, so we can deliberately create the nasty timing
// situations that a polling + tab-switching app is prone to, and assert the
// UI never ends up showing wrong data.
//
// The scenarios here are the ones that actually cause "my file disappeared"
// style bugs in real apps: out-of-order responses, responses arriving after
// the user moved on, and slow requests overlapping fast ones.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0, fail = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
function section(t) { console.log(`\n${t}`); }

// ---------------------------------------------------------------------------
// Fake network: every request is held open until the test explicitly resolves
// it, which is what lets us force precise out-of-order timing.
// ---------------------------------------------------------------------------
function makeHarness() {
  const pending = [];
  const state = { rooms: {} };

  function roomPayload(code) {
    const r = state.rooms[code] || { items: [] };
    return {
      items: r.items,
      stats: {
        itemCount: r.items.length,
        usageBytes: r.items.length * 1000,
        maxRoomBytes: 32 * 1024 * 1024,
        maxItems: 120,
        maxFileBytes: 16 * 1024 * 1024,
        chunkBytes: 1536 * 1024,
        ttlSeconds: 604800,
        secondsRemaining: 604800,
        monthlyRequests: 42,
        monthlyRequestBudget: 500000
      }
    };
  }

  function fetchImpl(url, opts) {
    const u = String(url);
    // Non-API assets (fonts etc) resolve instantly and empty.
    if (!u.includes('/api/clipboard')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
    }
    const roomMatch = /room=([^&]+)/.exec(u);
    const roomCode = roomMatch ? decodeURIComponent(roomMatch[1]) : null;
    let resolveFn;
    const p = new Promise((resolve) => { resolveFn = resolve; });
    const entry = {
      url: u,
      room: roomCode,
      method: (opts && opts.method) || 'GET',
      resolve: (overridePayload) => {
        const payload = overridePayload !== undefined ? overridePayload : roomPayload(roomCode);
        resolveFn({
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => payload,
          text: async () => JSON.stringify(payload)
        });
      },
      reject: (message) => {
        resolveFn({
          ok: false,
          status: 500,
          headers: { get: () => 'application/json' },
          json: async () => ({ error: message || 'boom' }),
          text: async () => JSON.stringify({ error: message || 'boom' })
        });
      }
    };
    pending.push(entry);
    return p;
  }

  return { pending, state, fetchImpl, roomPayload };
}

function makeItem(id, ts, data) {
  return { id, type: 'text', ts, size: 100, storedBytes: 1000, data, pinned: false };
}

async function bootDom() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const harness = makeHarness();
  const virtualConsole = new VirtualConsole(); // swallow page console noise

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://hotdrop.test/',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.fetch = harness.fetchImpl;
      window.QRCode = function () { this.clear = () => {}; };
      window.QRCode.CorrectLevel = { M: 0 };
      // jsdom has no real clipboard; stub enough that handlers don't throw.
      Object.defineProperty(window.navigator, 'clipboard', {
        value: { writeText: async () => {}, read: async () => [], write: async () => {} },
        configurable: true
      });
      window.URL.createObjectURL = () => 'blob:fake';
      window.URL.revokeObjectURL = () => {};
    }
  });

  await new Promise((r) => setTimeout(r, 60)); // let inline scripts run
  return { dom, window: dom.window, harness };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function feedTexts(window) {
  return [...window.document.querySelectorAll('#items .textBody')].map((n) => n.textContent);
}
function activeTabName(window) {
  const el = window.document.querySelector('.roomTab.active .tabName');
  return el ? el.textContent : null;
}
function tabNames(window) {
  return [...window.document.querySelectorAll('.roomTab .tabName')].map((n) => n.textContent);
}

async function main() {
  console.log('HotDrop frontend sync — worst-case scenario suite');
  console.log('='.repeat(62));

  // -------------------------------------------------------------------
  section('Baseline: a room loads and renders');
  {
    const { window, harness } = await bootDom();
    await test('joining a room renders its items', async () => {
      harness.state.rooms['room-alpha'] = { items: [makeItem('a1', 1000, 'alpha one')] };
      window.document.getElementById('codeInput').value = 'room-alpha';
      window.document.getElementById('joinBtn').click();
      await tick();
      const req = harness.pending.find((p) => p.room === 'room-alpha');
      assert.ok(req, 'expected a request for room-alpha');
      req.resolve();
      await tick();
      assert.deepStrictEqual(feedTexts(window), ['alpha one']);
    });
    window.close();
  }

  // -------------------------------------------------------------------
  section('THE CRITICAL ONE: stale response must not overwrite a newer room');
  {
    const { window, harness } = await bootDom();
    await test('a slow response for room A, arriving AFTER switching to room B, is discarded', async () => {
      harness.state.rooms['room-alpha'] = { items: [makeItem('a1', 1000, 'ALPHA DATA')] };
      harness.state.rooms['room-beta'] = { items: [makeItem('b1', 2000, 'BETA DATA')] };

      // Join A, but do NOT resolve its request yet -- it's "slow".
      window.document.getElementById('codeInput').value = 'room-alpha';
      window.document.getElementById('joinBtn').click();
      await tick();
      const slowAlphaReq = harness.pending.find((p) => p.room === 'room-alpha');
      assert.ok(slowAlphaReq, 'expected an in-flight request for room-alpha');

      // While A is still in flight, switch to B and let B resolve.
      window.document.getElementById('codeInput').value = 'room-beta';
      window.document.getElementById('joinBtn').click();
      await tick();
      const betaReq = harness.pending.find((p) => p.room === 'room-beta');
      assert.ok(betaReq, 'expected a request for room-beta');
      betaReq.resolve();
      await tick();
      assert.deepStrictEqual(feedTexts(window), ['BETA DATA'], 'beta should be showing before the late alpha lands');

      // NOW the stale alpha response finally arrives. It must be ignored.
      slowAlphaReq.resolve();
      await tick();
      assert.deepStrictEqual(feedTexts(window), ['BETA DATA'],
        'stale room-alpha response overwrote the newer room-beta view -- this is the data-disappearing bug');
    });
    window.close();
  }

  // -------------------------------------------------------------------
  section('Out-of-order responses within the SAME room');
  {
    const { window, harness } = await bootDom();
    await test('an older in-flight response landing after a newer one does not revert the feed', async () => {
      harness.state.rooms['room-gamma'] = { items: [makeItem('g1', 1000, 'first')] };
      window.document.getElementById('codeInput').value = 'room-gamma';
      window.document.getElementById('joinBtn').click();
      await tick();

      const firstReq = harness.pending.find((p) => p.room === 'room-gamma');
      firstReq.resolve();
      await tick();
      assert.deepStrictEqual(feedTexts(window), ['first']);

      // Force two overlapping refreshes; resolve the SECOND one first (newer
      // data), then the first one (older data) afterwards.
      harness.pending.length = 0;
      window.document.getElementById('refreshBtn').click();
      await tick(10);
      const reqOld = harness.pending.find((p) => p.room === 'room-gamma');
      harness.pending.length = 0;
      window.document.getElementById('refreshBtn').click();
      await tick(10);
      const reqNew = harness.pending.find((p) => p.room === 'room-gamma');

      const newerPayload = {
        items: [makeItem('g1', 1000, 'first'), makeItem('g2', 3000, 'second')],
        stats: harness.roomPayload('room-gamma').stats
      };
      const olderPayload = { items: [makeItem('g1', 1000, 'first')], stats: harness.roomPayload('room-gamma').stats };

      if (reqNew) reqNew.resolve(newerPayload);
      await tick();
      if (reqOld) reqOld.resolve(olderPayload);
      await tick();

      const texts = feedTexts(window);
      assert.ok(texts.includes('second'),
        `the newer item vanished after an older response landed late (got: ${JSON.stringify(texts)})`);
    });
    window.close();
  }

  // -------------------------------------------------------------------
  section('Tab switching: sleep behaviour and state isolation');
  {
    const { window, harness } = await bootDom();

    await test('opening a second room creates a second tab and both persist', async () => {
      harness.state.rooms['tab-one'] = { items: [makeItem('t1', 1000, 'one data')] };
      harness.state.rooms['tab-two'] = { items: [makeItem('t2', 2000, 'two data')] };

      window.document.getElementById('codeInput').value = 'tab-one';
      window.document.getElementById('joinBtn').click();
      await tick();
      harness.pending.find((p) => p.room === 'tab-one').resolve();
      await tick();

      // "+" opens the join screen without closing the existing tab
      window.document.querySelector('.tabAdd').click();
      await tick();
      window.document.getElementById('codeInput').value = 'tab-two';
      window.document.getElementById('joinBtn').click();
      await tick();
      harness.pending.find((p) => p.room === 'tab-two').resolve();
      await tick();

      assert.deepStrictEqual(tabNames(window), ['tab-one', 'tab-two']);
      assert.strictEqual(activeTabName(window), 'tab-two');
    });

    await test('background tab makes ZERO requests while inactive (full sleep)', async () => {
      harness.pending.length = 0;
      await tick(120); // let any timers that might fire, fire
      const backgroundRequests = harness.pending.filter((p) => p.room === 'tab-one');
      assert.strictEqual(backgroundRequests.length, 0,
        `sleeping tab made ${backgroundRequests.length} request(s) -- it must make none`);
    });

    await test('switching back to a sleeping tab refreshes it immediately', async () => {
      harness.pending.length = 0;
      const oneTab = [...window.document.querySelectorAll('.roomTab')].find(
        (t) => t.querySelector('.tabName').textContent === 'tab-one'
      );
      oneTab.click();
      await tick();
      const req = harness.pending.find((p) => p.room === 'tab-one');
      assert.ok(req, 'switching to a sleeping tab should trigger an immediate refresh');
      req.resolve();
      await tick();
      assert.strictEqual(activeTabName(window), 'tab-one');
      assert.deepStrictEqual(feedTexts(window), ['one data'], 'should show its OWN data, not the other room\'s');
    });

    await test('feed does not leak items between tabs during the switch', async () => {
      harness.pending.length = 0;
      const twoTab = [...window.document.querySelectorAll('.roomTab')].find(
        (t) => t.querySelector('.tabName').textContent === 'tab-two'
      );
      twoTab.click();
      await tick(5);
      // Before the response lands, the old room's items must already be cleared
      // rather than sitting there looking like they belong to the new room.
      const midSwitch = feedTexts(window);
      assert.ok(!midSwitch.includes('one data'),
        `previous room's items were still on screen while switching (got: ${JSON.stringify(midSwitch)})`);
      const req = harness.pending.find((p) => p.room === 'tab-two');
      if (req) req.resolve();
      await tick();
      assert.deepStrictEqual(feedTexts(window), ['two data']);
    });

    await test('closing the active tab falls back to another open tab', async () => {
      harness.pending.length = 0;
      const activeClose = window.document.querySelector('.roomTab.active .tabClose');
      activeClose.click();
      await tick();
      const req = harness.pending.find((p) => p.room === 'tab-one');
      if (req) req.resolve();
      await tick();
      assert.deepStrictEqual(tabNames(window), ['tab-one']);
      assert.strictEqual(activeTabName(window), 'tab-one');
    });

    await test('closing the last tab returns to the join screen cleanly', async () => {
      window.document.querySelector('.roomTab.active .tabClose').click();
      await tick();
      assert.strictEqual(window.document.getElementById('joinPanel').classList.contains('hidden'), false);
      assert.strictEqual(window.document.getElementById('board').classList.contains('hidden'), true);
    });

    window.close();
  }

  // -------------------------------------------------------------------
  section('Failure handling must not corrupt state');
  {
    const { window, harness } = await bootDom();
    await test('a failed request leaves the previous good data intact', async () => {
      harness.state.rooms['fail-room'] = { items: [makeItem('f1', 1000, 'good data')] };
      window.document.getElementById('codeInput').value = 'fail-room';
      window.document.getElementById('joinBtn').click();
      await tick();
      harness.pending.find((p) => p.room === 'fail-room').resolve();
      await tick();
      assert.deepStrictEqual(feedTexts(window), ['good data']);

      harness.pending.length = 0;
      window.document.getElementById('refreshBtn').click();
      await tick(10);
      const req = harness.pending.find((p) => p.room === 'fail-room');
      if (req) req.reject('server exploded');
      await tick();
      assert.deepStrictEqual(feedTexts(window), ['good data'],
        'a failed refresh wiped the feed -- it should leave the last good data alone');
    });

    await test('a failed request does not permanently stick the busy indicator', async () => {
      // If the busy counter leaks, syncing would freeze forever. Do several
      // failing refreshes then a successful one and confirm it still renders.
      for (let i = 0; i < 3; i++) {
        harness.pending.length = 0;
        window.document.getElementById('refreshBtn').click();
        await tick(10);
        const r = harness.pending.find((p) => p.room === 'fail-room');
        if (r) r.reject('nope');
        await tick(10);
      }
      harness.state.rooms['fail-room'] = { items: [makeItem('f2', 5000, 'recovered')] };
      harness.pending.length = 0;
      window.document.getElementById('refreshBtn').click();
      await tick(10);
      const ok = harness.pending.find((p) => p.room === 'fail-room');
      assert.ok(ok, 'app stopped issuing requests after repeated failures -- busy counter likely stuck');
      ok.resolve();
      await tick();
      assert.deepStrictEqual(feedTexts(window), ['recovered']);
    });
    window.close();
  }

  // -------------------------------------------------------------------
  section('Rapid switching stress');
  {
    const { window, harness } = await bootDom();
    await test('rapidly switching between 3 rooms ends on the correct room with correct data', async () => {
      const rooms = ['rapid-a', 'rapid-b', 'rapid-c'];
      rooms.forEach((r, i) => { harness.state.rooms[r] = { items: [makeItem(`${r}-1`, 1000 + i, `${r} payload`)] }; });

      for (const r of rooms) {
        window.document.getElementById('codeInput').value = r;
        window.document.getElementById('joinBtn').click();
        await tick(5);
        if (window.document.querySelector('.tabAdd')) {
          // after the first room, use + to add subsequent ones
        }
        const req = harness.pending.find((p) => p.room === r);
        if (req) req.resolve();
        await tick(5);
        if (r !== rooms[rooms.length - 1] && window.document.querySelector('.tabAdd')) {
          window.document.querySelector('.tabAdd').click();
          await tick(5);
        }
      }

      // Now hammer the tabs without waiting for responses in between.
      const held = [];
      for (let round = 0; round < 6; round++) {
        const tabs = [...window.document.querySelectorAll('.roomTab')];
        const target = tabs[round % tabs.length];
        if (!target) continue;
        target.click();
        await tick(3);
        const req = harness.pending[harness.pending.length - 1];
        if (req) held.push(req);
      }

      // Resolve every held request in a deliberately scrambled order.
      held.sort(() => 0.5 - Math.random()).forEach((r) => r.resolve());
      await tick(60);

      const finalActive = activeTabName(window);
      assert.ok(finalActive, 'expected some tab to be active after rapid switching');
      const texts = feedTexts(window);
      // Whatever tab ended active, the feed must match THAT room, not another.
      const expected = `${finalActive} payload`;
      assert.ok(texts.length === 0 || texts.includes(expected),
        `active tab is "${finalActive}" but feed shows ${JSON.stringify(texts)} -- mismatched room data after scrambled responses`);
    });
    window.close();
  }

  console.log('\n' + '='.repeat(62));
  console.log(`RESULT: ${pass} passed, ${fail} failed, ${pass + fail} total`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f.name}\n      ${f.err.message}`));
  }
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => { console.error('Runner crashed:', e); process.exitCode = 1; });
