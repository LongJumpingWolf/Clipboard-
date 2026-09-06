'use strict';
// Zero-dependency test harness: mocks Upstash's REST protocol in-memory (by stubbing
// global.fetch) and fake Vercel req/res objects, then requires the REAL api/*.js
// handlers unmodified. This exercises the actual shipped code, not a reimplementation.

const store = { hashes: Object.create(null), strings: Object.create(null), ttls: Object.create(null) };

function resetStore() {
  for (const k of Object.keys(store.hashes)) delete store.hashes[k];
  for (const k of Object.keys(store.strings)) delete store.strings[k];
  for (const k of Object.keys(store.ttls)) delete store.ttls[k];
}

function execCommand(cmd) {
  const [op, ...args] = cmd;
  switch (String(op).toUpperCase()) {
    case 'HSET': {
      const [key, field, val] = args;
      store.hashes[key] = store.hashes[key] || Object.create(null);
      store.hashes[key][field] = val;
      return 1;
    }
    case 'HGET': {
      const [key, field] = args;
      const h = store.hashes[key];
      return h && field in h ? h[field] : null;
    }
    case 'HDEL': {
      const [key, ...fields] = args;
      const h = store.hashes[key];
      if (!h) return 0;
      let n = 0;
      fields.forEach((f) => { if (f in h) { delete h[f]; n++; } });
      return n;
    }
    case 'HGETALL': {
      const [key] = args;
      const h = store.hashes[key] || {};
      const arr = [];
      Object.entries(h).forEach(([k, v]) => { arr.push(k, v); });
      return arr;
    }
    case 'EXPIRE': {
      const [key, secs] = args;
      store.ttls[key] = Date.now() + Number(secs) * 1000;
      return 1;
    }
    case 'TTL': {
      const [key] = args;
      const exists = store.hashes[key] !== undefined || store.strings[key] !== undefined;
      if (!exists) return -2;
      const exp = store.ttls[key];
      if (exp === undefined) return -1;
      const rem = Math.round((exp - Date.now()) / 1000);
      return rem > 0 ? rem : -2;
    }
    case 'EXISTS': {
      let n = 0;
      args.forEach((k) => { if (store.strings[k] !== undefined) n++; });
      return n;
    }
    case 'GET': {
      const [key] = args;
      return store.strings[key] !== undefined ? store.strings[key] : null;
    }
    case 'INCR': {
      const [key] = args;
      const current = Number(store.strings[key] || 0);
      const next = current + 1;
      store.strings[key] = String(next);
      return next;
    }
    case 'SET': {
      const [key, val, ...rest] = args;
      store.strings[key] = val;
      const exIdx = rest.findIndex((x) => String(x).toUpperCase() === 'EX');
      if (exIdx !== -1) store.ttls[key] = Date.now() + Number(rest[exIdx + 1]) * 1000;
      return 'OK';
    }
    case 'DEL': {
      let n = 0;
      args.forEach((k) => {
        if (store.hashes[k] !== undefined) { delete store.hashes[k]; n++; }
        if (store.strings[k] !== undefined) { delete store.strings[k]; n++; }
      });
      return n;
    }
    default:
      throw new Error(`Mock Redis: unhandled command ${op}`);
  }
}

function installFetchStub() {
  global.fetch = async (url, opts) => {
    const isPipeline = String(url).endsWith('/pipeline');
    const body = JSON.parse(opts.body);
    if (isPipeline) {
      const results = body.map((cmd) => {
        try { return { result: execCommand(cmd) }; }
        catch (e) { return { error: e.message }; }
      });
      return { ok: true, status: 200, json: async () => results };
    }
    try {
      const result = execCommand(body);
      return { ok: true, status: 200, json: async () => ({ result }) };
    } catch (e) {
      return { ok: true, status: 200, json: async () => ({ error: e.message }) };
    }
  };
}

process.env.UPSTASH_REDIS_REST_URL = 'https://fake-redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
installFetchStub();

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    ended: false,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; this.ended = true; return this; },
    send(data) { this.body = data; this.ended = true; return this; },
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
    end(data) { if (data !== undefined) this.body = data; this.ended = true; }
  };
  return res;
}

function makeJsonReq({ method, query, body, headers }) {
  return { method, query: query || {}, body: body !== undefined ? body : null, headers: headers || {} };
}

// A minimal EventEmitter-like stream so api/share-target.js's readRawBody(req) works unmodified.
function makeStreamReq({ method, headers, bodyBuffer }) {
  const listeners = { data: [], end: [], error: [] };
  const req = {
    method,
    headers: headers || {},
    query: {},
    on(evt, fn) { listeners[evt] = listeners[evt] || []; listeners[evt].push(fn); return req; },
    destroy() {}
  };
  setImmediate(() => {
    if (bodyBuffer && bodyBuffer.length) {
      const CH = 64 * 1024;
      for (let i = 0; i < bodyBuffer.length; i += CH) {
        listeners.data.forEach((fn) => fn(bodyBuffer.slice(i, i + CH)));
      }
    }
    listeners.end.forEach((fn) => fn());
  });
  return req;
}

module.exports = { store, resetStore, makeRes, makeJsonReq, makeStreamReq };
