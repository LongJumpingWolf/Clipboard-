const ROOM_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_ITEMS_PER_ROOM = 120;
const MAX_TEXT_BYTES = 200 * 1024;
const CHUNK_BYTES = 1536 * 1024; // 1.5 MiB source chunks; comfortably below Vercel's request limit after base64.
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ROOM_BYTES = 32 * 1024 * 1024; // Estimated Redis bytes, including base64 overhead.
const STALE_UPLOAD_MS = 15 * 60 * 1000;
const MAX_THUMB_CHARS = 60 * 1024; // base64 chars; comfortably covers a ~480px JPEG preview
const MONTHLY_REQUEST_BUDGET = 500000; // Upstash free-tier command budget, shared across the whole account

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
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });

  let payload;
  try { payload = await response.json(); }
  catch (_) { throw new Error(`Redis returned HTTP ${response.status}`); }

  if (!response.ok || payload.error) {
    throw new Error(payload.error || `Redis returned HTTP ${response.status}`);
  }
  return payload.result;
}

async function redisPipeline(commands) {
  if (!commands.length) return [];
  const { url, token } = redisConfig();
  const response = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(commands)
  });

  let payload;
  try { payload = await response.json(); }
  catch (_) { throw new Error(`Redis pipeline returned HTTP ${response.status}`); }

  if (!response.ok || !Array.isArray(payload)) {
    throw new Error(payload?.error || `Redis pipeline returned HTTP ${response.status}`);
  }
  const failed = payload.find(x => x && x.error);
  if (failed) throw new Error(failed.error);
  return payload.map(x => x.result);
}

function normalizeRoom(value) {
  return String(value || '').trim().toLowerCase();
}

function validRoom(room) {
  return /^[a-z0-9_-]{3,64}$/.test(room);
}

function validId(id) {
  return /^[a-zA-Z0-9-]{8,100}$/.test(String(id || ''));
}

function metaKey(room) {
  return `clipboard:${room}:meta`;
}

function blobKey(room, id, index) {
  return `clipboard:${room}:blob:${id}:${index}`;
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function encodedBytesForSource(sourceBytes) {
  return Math.ceil(Number(sourceBytes || 0) / 3) * 4;
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length) {
    try { return JSON.parse(req.body); } catch (_) { return null; }
  }
  return null;
}

function parseHashResult(result) {
  if (!result) return [];
  let values = [];
  if (Array.isArray(result)) {
    for (let i = 1; i < result.length; i += 2) values.push(result[i]);
  } else if (typeof result === 'object') {
    values = Object.values(result);
  }

  return values
    .map(raw => {
      try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
      catch (_) { return null; }
    })
    .filter(Boolean)
    .filter(item => item && typeof item.id === 'string' && ['text', 'image', 'file'].includes(item.type))
    .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
}

function publicItem(meta) {
  const clean = {
    id: meta.id,
    type: meta.type,
    ts: Number(meta.ts || 0),
    size: Number(meta.size || 0),
    storedBytes: Number(meta.storedBytes || 0),
    pinned: !!meta.pinned
  };
  if (meta.type === 'text') clean.data = String(meta.data || '');
  else {
    clean.name = String(meta.name || 'file');
    clean.mime = String(meta.mime || 'application/octet-stream');
    clean.chunks = Number(meta.chunks || 1);
    if (meta.type === 'image' && meta.thumb) clean.thumb = String(meta.thumb);
  }
  return clean;
}

async function roomStats(items, ttlSecondsRemaining) {
  const ready = items.filter(x => x.status !== 'uploading');
  const monthlyRequests = await getMonthlyUsage();
  return {
    itemCount: ready.length,
    usageBytes: items.reduce((sum, x) => sum + Number(x.storedBytes || 0), 0),
    maxRoomBytes: MAX_ROOM_BYTES,
    maxItems: MAX_ITEMS_PER_ROOM,
    maxFileBytes: MAX_FILE_BYTES,
    chunkBytes: CHUNK_BYTES,
    ttlSeconds: ROOM_TTL_SECONDS,
    secondsRemaining: Number.isFinite(ttlSecondsRemaining) && ttlSecondsRemaining >= 0 ? ttlSecondsRemaining : null,
    monthlyRequests: monthlyRequests,
    monthlyRequestBudget: MONTHLY_REQUEST_BUDGET
  };
}

function validateTextItem(item) {
  if (!item || typeof item !== 'object') return 'Missing item.';
  if (!validId(item.id)) return 'Invalid item id.';
  if (!Number.isFinite(Number(item.ts))) return 'Invalid timestamp.';
  if (item.type !== 'text') return 'Invalid item type.';
  if (typeof item.data !== 'string' || !item.data.trim()) return 'Text cannot be empty.';
  if (byteLength(item.data) > MAX_TEXT_BYTES) return 'Text is too large.';
  return null;
}

function validateBinaryMeta(item) {
  if (!item || typeof item !== 'object') return 'Missing file metadata.';
  if (!validId(item.id)) return 'Invalid item id.';
  if (!Number.isFinite(Number(item.ts))) return 'Invalid timestamp.';
  if (item.type !== 'image' && item.type !== 'file') return 'Invalid file type.';
  if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 220) return 'Invalid file name.';
  if (/[\r\n]/.test(item.name)) return 'Invalid file name.';
  if (typeof item.mime !== 'string' || item.mime.length > 160 || /[\r\n]/.test(item.mime)) return 'Invalid MIME type.';
  const size = Number(item.size);
  const chunks = Number(item.chunks);
  if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_BYTES) {
    return `File is too large. Maximum file size is ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB.`;
  }
  const expectedChunks = Math.max(1, Math.ceil(size / CHUNK_BYTES));
  if (!Number.isInteger(chunks) || chunks !== expectedChunks) return 'Invalid chunk count.';
  return null;
}

function metaDeleteCommands(room, victims) {
  if (!victims.length) return [];
  const commands = [['HDEL', metaKey(room), ...victims.map(x => x.id)]];
  const blobKeys = [];
  victims.forEach(meta => {
    if (meta.type === 'image' || meta.type === 'file') {
      const chunks = Math.max(1, Number(meta.chunks || 1));
      for (let i = 0; i < chunks; i++) blobKeys.push(blobKey(room, meta.id, i));
    }
  });
  if (blobKeys.length) commands.push(['DEL', ...blobKeys]);
  return commands;
}

function chooseVictims(items, incomingBytes, incomingId) {
  const now = Date.now();
  const withoutSameId = items.filter(x => x.id !== incomingId);
  const stale = withoutSameId.filter(x => x.status === 'uploading' && now - Number(x.ts || 0) > STALE_UPLOAD_MS);
  const kept = withoutSameId.filter(x => !stale.includes(x));

  let usage = kept.reduce((sum, x) => sum + Number(x.storedBytes || 0), 0);
  let count = kept.length;
  const victims = [...stale];

  // Pinned items are protected from routine cleanup — evict unpinned items first, oldest first.
  const unpinned = kept.filter(x => !x.pinned);
  const pinned = kept.filter(x => x.pinned);

  for (const item of unpinned) {
    if (usage + incomingBytes <= MAX_ROOM_BYTES && count + 1 <= MAX_ITEMS_PER_ROOM) break;
    victims.push(item);
    usage -= Number(item.storedBytes || 0);
    count -= 1;
  }

  // Last resort only: if unpinned items alone can't make room, pinned items become eligible too,
  // so a room can never be permanently deadlocked by pins.
  if (usage + incomingBytes > MAX_ROOM_BYTES || count + 1 > MAX_ITEMS_PER_ROOM) {
    for (const item of pinned) {
      if (usage + incomingBytes <= MAX_ROOM_BYTES && count + 1 <= MAX_ITEMS_PER_ROOM) break;
      victims.push(item);
      usage -= Number(item.storedBytes || 0);
      count -= 1;
    }
  }

  if (usage + incomingBytes > MAX_ROOM_BYTES) {
    throw new Error('This item cannot fit in the room storage limit.');
  }

  return victims;
}

function setJsonHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

function usageKey() {
  // One key per calendar month (UTC) -- naturally resets each month with no
  // explicit cleanup needed; the EXPIRE below just keeps old months from
  // lingering forever.
  return `usage:requests:${new Date().toISOString().slice(0, 7)}`;
}

// Best-effort, approximate proxy for Upstash's actual billed command count --
// not exact (a single request can cost more than one real Redis command
// under the hood, and this increment itself adds to the count), but close
// enough to give an honest sense of how close the free tier's monthly ceiling
// is, without needing a separate Upstash Management API credential just to
// fetch the real number. Never allowed to fail the actual request.
async function recordApiUsage() {
  try {
    await redisPipeline([
      ['INCR', usageKey()],
      ['EXPIRE', usageKey(), 60 * 60 * 24 * 40]
    ]);
  } catch (_) {
    // tracking must never break the real request
  }
}

async function getMonthlyUsage() {
  try {
    const raw = await redisCommand(['GET', usageKey()]);
    const count = Number(raw);
    return Number.isFinite(count) ? count : 0;
  } catch (_) {
    return null;
  }
}

function sendError(res, status, message) {
  setJsonHeaders(res);
  return res.status(status).json({ error: message });
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  await recordApiUsage();

  try {
    if (req.method === 'GET') {
      const room = normalizeRoom(req.query?.room);
      if (!validRoom(room)) return sendError(res, 400, 'Invalid room code.');

      const id = String(req.query?.id || '');
      const chunkParam = req.query?.chunk;

      if (id && chunkParam !== undefined) {
        if (!validId(id)) return sendError(res, 400, 'Invalid item id.');
        const chunk = Number(chunkParam);
        if (!Number.isInteger(chunk) || chunk < 0) return sendError(res, 400, 'Invalid chunk number.');

        const rawMeta = await redisCommand(['HGET', metaKey(room), id]);
        if (!rawMeta) return sendError(res, 404, 'File no longer exists.');
        let meta;
        try { meta = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta; }
        catch (_) { return sendError(res, 500, 'Stored file metadata is invalid.'); }

        if (meta.type !== 'image' && meta.type !== 'file') return sendError(res, 400, 'Item is not a file.');
        if (meta.status === 'uploading') return sendError(res, 409, 'File is still uploading.');
        if (chunk >= Number(meta.chunks || 1)) return sendError(res, 416, 'Chunk is out of range.');

        const encoded = await redisCommand(['GET', blobKey(room, id, chunk)]);
        if (encoded === null || encoded === undefined) return sendError(res, 404, 'File chunk no longer exists.');

        const buffer = Buffer.from(String(encoded), 'base64');
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(buffer.length));
        return res.status(200).send(buffer);
      }

      const result = await redisCommand(['HGETALL', metaKey(room)]);
      const all = parseHashResult(result);
      const ready = all.filter(item => item.status !== 'uploading');
      let ttl = null;
      try { const t = await redisCommand(['TTL', metaKey(room)]); ttl = Number(t); if (!Number.isFinite(ttl) || ttl < 0) ttl = null; } catch (_) { ttl = null; }
      setJsonHeaders(res);
      return res.status(200).json({
        items: ready.slice(-MAX_ITEMS_PER_ROOM).map(publicItem),
        stats: await roomStats(all, ttl)
      });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      if (!body) return sendError(res, 400, 'Invalid JSON body.');
      const room = normalizeRoom(body.room);
      if (!validRoom(room)) return sendError(res, 400, 'Invalid room code.');
      const action = String(body.action || 'addText');
      const key = metaKey(room);

      if (action === 'addText') {
        const item = body.item;
        const itemError = validateTextItem(item);
        if (itemError) return sendError(res, 400, itemError);

        const storedBytes = byteLength(item.data) + 256;
        const meta = {
          id: item.id,
          type: 'text',
          data: item.data,
          ts: Number(item.ts),
          size: byteLength(item.data),
          storedBytes,
          status: 'ready'
        };

        const existing = parseHashResult(await redisCommand(['HGETALL', key]));
        const victims = chooseVictims(existing, storedBytes, item.id);
        const commands = [
          ...metaDeleteCommands(room, victims),
          ['HSET', key, item.id, JSON.stringify(meta)],
          ['EXPIRE', key, ROOM_TTL_SECONDS]
        ];
        await redisPipeline(commands);
        const updated = existing.filter(x => x.id !== item.id && !victims.some(v => v.id === x.id)).concat(meta);
        setJsonHeaders(res);
        return res.status(201).json({ ok: true, evicted: victims.map(publicItem), stats: await roomStats(updated) });
      }

      if (action === 'initBinary') {
        const item = body.item;
        const itemError = validateBinaryMeta(item);
        if (itemError) return sendError(res, 400, itemError);

        const hasThumb = item.type === 'image' && typeof item.thumb === 'string' && item.thumb.length > 0
          && item.thumb.length <= MAX_THUMB_CHARS && /^[A-Za-z0-9+/]+={0,2}$/.test(item.thumb);
        const thumbBytes = hasThumb ? item.thumb.length + 48 : 0;
        const storedBytes = encodedBytesForSource(item.size) + (Number(item.chunks) * 160) + 512 + thumbBytes;
        if (storedBytes > MAX_ROOM_BYTES) return sendError(res, 400, 'File is too large for this room.');

        const meta = {
          id: item.id,
          type: item.type,
          name: item.name.trim(),
          mime: item.mime || 'application/octet-stream',
          ts: Number(item.ts),
          size: Number(item.size),
          storedBytes,
          chunks: Number(item.chunks),
          status: 'uploading'
        };
        if (hasThumb) meta.thumb = item.thumb;

        const existing = parseHashResult(await redisCommand(['HGETALL', key]));
        const victims = chooseVictims(existing, storedBytes, item.id);
        const sameId = existing.filter(x => x.id === item.id);
        const commands = [
          ...metaDeleteCommands(room, [...victims, ...sameId]),
          ['HSET', key, item.id, JSON.stringify(meta)],
          ['EXPIRE', key, ROOM_TTL_SECONDS]
        ];
        await redisPipeline(commands);
        const updated = existing.filter(x => x.id !== item.id && !victims.some(v => v.id === x.id)).concat(meta);
        setJsonHeaders(res);
        return res.status(201).json({ ok: true, evicted: victims.map(publicItem), stats: await roomStats(updated) });
      }

      if (action === 'uploadChunk') {
        const id = String(body.id || '');
        const index = Number(body.index);
        const data = body.data;
        if (!validId(id)) return sendError(res, 400, 'Invalid item id.');
        if (!Number.isInteger(index) || index < 0) return sendError(res, 400, 'Invalid chunk number.');
        if (typeof data !== 'string') return sendError(res, 400, 'Missing chunk data.');

        const rawMeta = await redisCommand(['HGET', key, id]);
        if (!rawMeta) return sendError(res, 404, 'Upload session no longer exists.');
        const meta = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta;
        if (meta.status !== 'uploading') return sendError(res, 409, 'Upload is not active.');
        if (index >= Number(meta.chunks || 1)) return sendError(res, 400, 'Chunk number is out of range.');

        const decodedBytes = Math.floor(data.length * 3 / 4) - ((data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0));
        const expectedBytes = Math.max(0, Math.min(CHUNK_BYTES, Number(meta.size || 0) - (index * CHUNK_BYTES)));
        if (decodedBytes < 0 || decodedBytes > CHUNK_BYTES) return sendError(res, 400, 'Chunk is too large.');
        if (decodedBytes !== expectedBytes) return sendError(res, 400, 'Chunk size does not match the file metadata.');
        if (data && !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return sendError(res, 400, 'Invalid chunk encoding.');

        await redisPipeline([
          ['SET', blobKey(room, id, index), data],
          ['EXPIRE', blobKey(room, id, index), ROOM_TTL_SECONDS],
          ['EXPIRE', key, ROOM_TTL_SECONDS]
        ]);
        setJsonHeaders(res);
        return res.status(200).json({ ok: true });
      }

      if (action === 'finishBinary') {
        const id = String(body.id || '');
        if (!validId(id)) return sendError(res, 400, 'Invalid item id.');
        const rawMeta = await redisCommand(['HGET', key, id]);
        if (!rawMeta) return sendError(res, 404, 'Upload session no longer exists.');
        const meta = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta;
        if (meta.status !== 'uploading') return sendError(res, 409, 'Upload is not active.');

        const chunks = Number(meta.chunks || 1);
        const keys = Array.from({ length: chunks }, (_, i) => blobKey(room, id, i));
        const exists = Number(await redisCommand(['EXISTS', ...keys]));
        if (exists !== chunks) return sendError(res, 409, 'Upload is incomplete. Retry the file.');

        meta.status = 'ready';
        await redisPipeline([
          ['HSET', key, id, JSON.stringify(meta)],
          ['EXPIRE', key, ROOM_TTL_SECONDS]
        ]);
        const all = parseHashResult(await redisCommand(['HGETALL', key]));
        setJsonHeaders(res);
        return res.status(200).json({ ok: true, item: publicItem(meta), stats: await roomStats(all) });
      }

      if (action === 'cancelBinary') {
        const id = String(body.id || '');
        if (!validId(id)) return sendError(res, 400, 'Invalid item id.');
        const rawMeta = await redisCommand(['HGET', key, id]);
        if (!rawMeta) {
          setJsonHeaders(res);
          return res.status(200).json({ ok: true });
        }
        const meta = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta;
        await redisPipeline(metaDeleteCommands(room, [meta]));
        setJsonHeaders(res);
        return res.status(200).json({ ok: true });
      }

      if (action === 'setPinned') {
        const id = String(body.id || '');
        if (!validId(id)) return sendError(res, 400, 'Invalid item id.');
        const rawMeta = await redisCommand(['HGET', key, id]);
        if (!rawMeta) return sendError(res, 404, 'Item no longer exists.');
        const meta = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta;
        meta.pinned = !!body.pinned;
        await redisPipeline([
          ['HSET', key, id, JSON.stringify(meta)],
          ['EXPIRE', key, ROOM_TTL_SECONDS]
        ]);
        setJsonHeaders(res);
        return res.status(200).json({ ok: true, pinned: meta.pinned });
      }

      if (action === 'resetRoom') {
        const all = parseHashResult(await redisCommand(['HGETALL', key]));
        const blobKeys = [];
        all.forEach(meta => {
          if (meta.type === 'image' || meta.type === 'file') {
            const chunks = Math.max(1, Number(meta.chunks || 1));
            for (let i = 0; i < chunks; i++) blobKeys.push(blobKey(room, meta.id, i));
          }
        });
        const commands = [['DEL', key]];
        if (blobKeys.length) commands.push(['DEL', ...blobKeys]);
        await redisPipeline(commands);
        setJsonHeaders(res);
        return res.status(200).json({ ok: true, removed: all.length, stats: await roomStats([], null) });
      }

      return sendError(res, 400, 'Unknown action.');
    }

    if (req.method === 'DELETE') {
      const body = parseBody(req);
      if (!body) return sendError(res, 400, 'Invalid JSON body.');
      const room = normalizeRoom(body.room);
      const id = String(body.id || '');
      if (!validRoom(room)) return sendError(res, 400, 'Invalid room code.');
      if (!validId(id)) return sendError(res, 400, 'Invalid item id.');

      const key = metaKey(room);
      const rawMeta = await redisCommand(['HGET', key, id]);
      if (!rawMeta) {
        setJsonHeaders(res);
        return res.status(200).json({ ok: true, removed: false });
      }
      const meta = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta;
      await redisPipeline(metaDeleteCommands(room, [meta]));
      setJsonHeaders(res);
      return res.status(200).json({ ok: true, removed: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
    return sendError(res, 405, 'Method not allowed.');
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : 'Unexpected server error.';
    const configurationError = message.startsWith('Redis is not configured.');
    return sendError(
      res,
      configurationError ? 503 : 500,
      configurationError
        ? 'Sync storage is not configured yet. Add the Redis environment variables in Vercel.'
        : (message === 'This item cannot fit in the room storage limit.' ? message : 'Sync service error. Try again.')
    );
  }
};
