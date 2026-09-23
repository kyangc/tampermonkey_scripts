const SERVICE_VERSION = '0.2.0';
const MAX_BODY_BYTES = 512 * 1024;
const MAX_ITEMS = 5000;
const SOURCE_RE = /^[A-Za-z0-9_-]{8,80}$/;
const HANDLE_RE = /^[a-z0-9_]{1,15}$/;

function corsHeaders() {
  return {
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-origin': '*',
    'access-control-max-age': '86400',
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    headers: corsHeaders(),
    status,
  });
}

function apiError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value));
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

async function constantTimeEqual(left, right) {
  const [leftHash, rightHash] = await Promise.all([sha256(left), sha256(right)]);
  let difference = 0;
  for (let index = 0; index < leftHash.length; index += 1) {
    difference |= leftHash[index] ^ rightHash[index];
  }
  return difference === 0;
}

async function authenticate(request, env) {
  if (!env.SYNC_TOKEN) throw apiError(503, 'not_configured', '同步服务尚未配置。');
  const match = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim() || '';
  if (token.length < 20 || !await constantTimeEqual(token, env.SYNC_TOKEN)) {
    throw apiError(401, 'unauthorized', '同步密钥无效。');
  }
}

async function readJson(request) {
  if (!(request.headers.get('content-type') || '').toLowerCase().includes('application/json')) {
    throw apiError(415, 'invalid_content_type', '请求必须使用 application/json。');
  }
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw apiError(413, 'request_too_large', '同步内容超过大小限制。');
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw apiError(413, 'request_too_large', '同步内容超过大小限制。');
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch (_error) {
    throw apiError(400, 'invalid_json', '请求正文不是有效的 JSON 对象。');
  }
}

function validateEvent(id, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw apiError(400, 'invalid_document', '同步条目格式不正确。');
  }
  if (!['handle', 'keyword'].includes(value.kind) || typeof value.deleted !== 'boolean') {
    throw apiError(400, 'invalid_document', '同步条目类型不正确。');
  }
  if (!Number.isSafeInteger(value.updatedAt) || value.updatedAt <= 0) {
    throw apiError(400, 'invalid_document', '同步条目时间不正确。');
  }
  if (!SOURCE_RE.test(value.source || '')) {
    throw apiError(400, 'invalid_document', '同步条目来源不正确。');
  }
  if (value.kind === 'handle') {
    if (id !== 'handle:' + value.key || !HANDLE_RE.test(value.key || '')) {
      throw apiError(400, 'invalid_document', '屏蔽账号格式不正确。');
    }
    if (!value.deleted) {
      const record = value.value;
      if (!record || typeof record !== 'object' || record.handle !== value.key) {
        throw apiError(400, 'invalid_document', '屏蔽账号内容不正确。');
      }
    }
  } else {
    if (id !== 'keyword:' + value.key || typeof value.key !== 'string' || !value.key || value.key.length > 240) {
      throw apiError(400, 'invalid_document', '屏蔽词格式不正确。');
    }
    if (!value.deleted && (typeof value.value !== 'string' || !value.value || value.value.length > 240)) {
      throw apiError(400, 'invalid_document', '屏蔽词内容不正确。');
    }
  }
  return value;
}

function validateCobaltEnvelope(value) {
  const encoded = (text, length) => typeof text === 'string' && text.length === length && /^[A-Za-z0-9+/]+={0,2}$/.test(text);
  if (!value || value.v !== 1 || !Number.isSafeInteger(value.updatedAt) || value.updatedAt <= 0
    || !SOURCE_RE.test(value.source || '') || !encoded(value.salt, 24) || !encoded(value.iv, 16)
    || typeof value.data !== 'string' || value.data.length < 24 || value.data.length > 8192
    || value.data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)
    || Object.keys(value).some((key) => !['v', 'updatedAt', 'source', 'salt', 'iv', 'data'].includes(key))) {
    throw apiError(400, 'invalid_cobalt_ciphertext', 'cobalt 配置只能以有效密文同步。');
  }
  return value;
}

function newestCobalt(left, right) {
  if (!left) return right;
  if (!right) return left;
  if (left.updatedAt !== right.updatedAt) return left.updatedAt > right.updatedAt ? left : right;
  if (left.source !== right.source) return left.source > right.source ? left : right;
  return JSON.stringify(left) > JSON.stringify(right) ? left : right;
}

function validateDocument(value) {
  if (!value || value.schema !== 1 || !value.items || typeof value.items !== 'object' || Array.isArray(value.items)) {
    throw apiError(400, 'invalid_document', '同步文档格式不正确。');
  }
  const entries = Object.entries(value.items);
  if (entries.length > MAX_ITEMS) {
    throw apiError(413, 'too_many_items', `同步条目不能超过 ${MAX_ITEMS} 个。`);
  }
  for (const [id, event] of entries) {
    if (id.length > 256) throw apiError(400, 'invalid_document', '同步条目标识过长。');
    validateEvent(id, event);
  }
  return { items: Object.fromEntries(entries), schema: 1,
    ...(value.cobalt === undefined ? {} : { cobalt: validateCobaltEnvelope(value.cobalt) }) };
}

async function readSnapshot(env) {
  const row = await env.DB.prepare(`
    SELECT revision, document FROM snapshot WHERE id = 1
  `).first();
  if (!row) return { document: { items: {}, schema: 1 }, revision: 0 };
  return { document: JSON.parse(row.document), revision: Number(row.revision) };
}

async function writeSnapshot(request, env) {
  await authenticate(request, env);
  const body = await readJson(request);
  const baseRevision = Number(body.baseRevision);
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
    throw apiError(400, 'invalid_revision', 'baseRevision 必须是非负整数。');
  }
  const document = validateDocument(body.document);
  // Old clients omit cobalt when writing their v1 rule document. Preserve it.
  // The revision-guarded write below still detects changes after this read.
  const current = await readSnapshot(env);
  const cobalt = newestCobalt(current.document.cobalt, document.cobalt);
  if (cobalt) document.cobalt = cobalt;
  const serialized = JSON.stringify(document);
  const updatedAt = Math.floor(Date.now() / 1000);
  const result = baseRevision === 0
    ? await env.DB.prepare(`
        INSERT OR IGNORE INTO snapshot(id, revision, document, updated_at)
        VALUES (1, 1, ?, ?)
      `).bind(serialized, updatedAt).run()
    : await env.DB.prepare(`
        UPDATE snapshot
        SET revision = revision + 1, document = ?, updated_at = ?
        WHERE id = 1 AND revision = ?
      `).bind(serialized, updatedAt, baseRevision).run();

  if (!result.meta?.changes) {
    return json(await readSnapshot(env), 409);
  }
  return json({ revision: baseRevision + 1 });
}

async function route(request, env) {
  if (!env.DB) throw apiError(500, 'missing_binding', '缺少 D1 DB binding。');
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(), status: 204 });
  if (request.method === 'GET' && path === '/health') {
    return json({ ok: true, serviceVersion: SERVICE_VERSION });
  }
  if (request.method === 'GET' && path === '/v1/snapshot') return json(await readSnapshot(env));
  if (request.method === 'POST' && path === '/v1/snapshot') return writeSnapshot(request, env);
  throw apiError(404, 'not_found', '接口不存在。');
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      const status = Number(error?.status) || 500;
      if (status >= 500) console.error(error);
      return json({
        error: {
          code: error?.code || 'internal_error',
          message: status >= 500 ? '服务暂时不可用。' : error.message,
        },
      }, status);
    }
  },
};
