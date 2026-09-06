// Handles the PWA "Share to HotDrop" entry point.
//
// Flow: the OS share sheet POSTs multipart/form-data here -> we stash the shared
// title/text/url/files in Redis under a short-lived, one-time-read token -> redirect
// the browser to `/?share=<token>` -> index.html fetches that token once, offers to
// send the content into a room, then the token is gone.
//
// No multipart-parsing dependency is used on purpose, to keep this project at zero
// npm dependencies; the parser below is a small, buffer-safe implementation good
// enough for the handful of fields/files a share sheet actually sends.

const crypto = require('crypto');

const SHARE_TTL_SECONDS = 10 * 60; // long enough to pick a room, short enough to not linger
const MAX_SHARE_BYTES = 12 * 1024 * 1024; // total across all shared files

function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error('Redis is not configured. Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel.');
  }
  return { url: url.replace(/\/$/, ''), token };
}

async function redisCommand(command) {
  const { url, token } = redisConfig();
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  let payload;
  try { payload = await response.json(); }
  catch (_) { throw new Error(`Redis returned HTTP ${response.status}`); }
  if (!response.ok || payload.error) throw new Error(payload.error || `Redis returned HTTP ${response.status}`);
  return payload.result;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_SHARE_BYTES + 2 * 1024 * 1024) { req.destroy(); reject(new Error('Shared content is too large.')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Minimal multipart/form-data parser. Splits on the boundary at the byte level (not
// string level) so binary file contents can never be mistaken for a boundary marker.
function parseMultipart(buffer, boundary) {
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const parts = [];
  let cursor = buffer.indexOf(boundaryBuf);
  if (cursor === -1) return parts;
  cursor += boundaryBuf.length;

  while (true) {
    if (buffer.slice(cursor, cursor + 2).toString('binary') === '--') break; // terminal boundary
    const next = buffer.indexOf(boundaryBuf, cursor);
    if (next === -1) break;

    let segment = buffer.slice(cursor, next);
    if (segment.slice(0, 2).toString('binary') === '\r\n') segment = segment.slice(2);
    if (segment.slice(-2).toString('binary') === '\r\n') segment = segment.slice(0, -2);

    const headerEnd = segment.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const rawHeaders = segment.slice(0, headerEnd).toString('utf8');
      const body = segment.slice(headerEnd + 4);
      const nameMatch = /name="([^"]*)"/i.exec(rawHeaders);
      const filenameMatch = /filename="([^"]*)"/i.exec(rawHeaders);
      const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(rawHeaders);
      parts.push({
        name: nameMatch ? nameMatch[1] : '',
        filename: filenameMatch ? filenameMatch[1] : null,
        mime: typeMatch ? typeMatch[1].trim() : null,
        data: body
      });
    }
    cursor = next + boundaryBuf.length;
  }
  return parts;
}

function randomToken() {
  return crypto.randomBytes(16).toString('hex');
}

function jsonHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (req.method === 'GET') {
    const token = String(req.query?.token || '');
    if (!/^[a-f0-9]{32}$/.test(token)) { jsonHeaders(res); return res.status(400).json({ error: 'Invalid token.' }); }
    try {
      const raw = await redisCommand(['GET', `share:${token}`]);
      jsonHeaders(res);
      if (!raw) return res.status(404).json({ error: 'This shared content has expired or was already used.' });
      await redisCommand(['DEL', `share:${token}`]); // one-time read
      return res.status(200).send(raw);
    } catch (err) {
      jsonHeaders(res);
      return res.status(500).json({ error: err.message || 'Could not read shared content.' });
    }
  }

  if (req.method === 'POST') {
    try {
      const contentType = String(req.headers['content-type'] || '');
      const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
      const boundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2]) : null;
      if (!contentType.toLowerCase().startsWith('multipart/form-data') || !boundary) {
        jsonHeaders(res);
        return res.status(400).json({ error: 'Expected multipart/form-data.' });
      }

      const buffer = await readRawBody(req);
      const parts = parseMultipart(buffer, boundary);

      let title = '', text = '', url = '';
      const files = [];
      let totalBytes = 0;

      for (const part of parts) {
        if (part.filename) {
          totalBytes += part.data.length;
          if (totalBytes > MAX_SHARE_BYTES) continue; // drop overflow rather than fail the whole share
          files.push({
            name: (part.filename || 'shared-file').slice(0, 200),
            mime: part.mime || 'application/octet-stream',
            data: part.data.toString('base64')
          });
        } else if (part.name === 'title') title = part.data.toString('utf8').slice(0, 300);
        else if (part.name === 'text') text = part.data.toString('utf8').slice(0, 5000);
        else if (part.name === 'url') url = part.data.toString('utf8').slice(0, 2000);
      }

      if (!title && !text && !url && !files.length) {
        jsonHeaders(res);
        return res.status(400).json({ error: 'Nothing was shared.' });
      }

      const token = randomToken();
      await redisCommand(['SET', `share:${token}`, JSON.stringify({ title, text, url, files }), 'EX', String(SHARE_TTL_SECONDS)]);

      res.writeHead(303, { Location: `/?share=${token}` });
      return res.end();
    } catch (err) {
      jsonHeaders(res);
      return res.status(500).json({ error: err.message || 'Could not process shared content.' });
    }
  }

  res.setHeader('Allow', 'GET, POST, OPTIONS');
  jsonHeaders(res);
  return res.status(405).json({ error: 'Method not allowed.' });
};
