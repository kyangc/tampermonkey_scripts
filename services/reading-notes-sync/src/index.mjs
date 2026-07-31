const API_VERSION = 1;
const SERVICE_VERSION = '0.4.0';
const PAIRING_TTL_SECONDS = 5 * 60;
const MAX_MUTATIONS = 100;
const MAX_CHANGES = 500;
const MAX_CIPHERTEXT_LENGTH = 128 * 1024;
const MAX_PAIRING_BODY_BYTES = 16 * 1024;
const MAX_SMALL_BODY_BYTES = 4 * 1024;
const MAX_SYNC_BODY_BYTES = 14 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9:_-]{8,160}$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{40,64}$/;
const PUBLIC_KEY_COORDINATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function corsHeaders() {
  return {
    'access-control-allow-headers': [
      'authorization',
      'content-type',
      'x-bootstrap-token',
      'x-device-id',
      'x-library-id',
      'x-pair-secret',
    ].join(', '),
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-origin': '*',
    'access-control-max-age': '86400',
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    headers: {
      ...corsHeaders(),
      ...extraHeaders,
    },
    status,
  });
}

function apiError(status, code, message, details) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
}

function cleanText(value, maxLength = 120) {
  return String(value || '').trim().slice(0, maxLength);
}

function assertId(value, label) {
  const result = cleanText(value, 160);
  if (!ID_PATTERN.test(result)) {
    throw apiError(400, 'invalid_request', `${label} 格式不正确。`);
  }
  return result;
}

function assertHash(value, label) {
  const result = cleanText(value, 80);
  if (!HASH_PATTERN.test(result)) {
    throw apiError(400, 'invalid_request', `${label} 格式不正确。`);
  }
  return result;
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function randomToken(byteLength = 24) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return base64Url(new Uint8Array(digest));
}

async function constantTimeEqual(left, right) {
  const [leftHash, rightHash] = await Promise.all([sha256(left), sha256(right)]);
  if (leftHash.length !== rightHash.length) return false;
  let difference = 0;
  for (let index = 0; index < leftHash.length; index += 1) {
    difference |= leftHash.charCodeAt(index) ^ rightHash.charCodeAt(index);
  }
  return difference === 0;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

async function readJson(request, maxBytes = MAX_SMALL_BODY_BYTES) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw apiError(415, 'invalid_content_type', '请求必须使用 application/json。');
  }

  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw apiError(413, 'request_too_large', '请求正文超过大小限制。');
  }

  let source = '';
  try {
    if (request.body?.getReader) {
      const reader = request.body.getReader();
      const decoder = new TextDecoder();
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          await reader.cancel().catch(() => {});
          throw apiError(413, 'request_too_large', '请求正文超过大小限制。');
        }
        source += decoder.decode(value, { stream: true });
      }
      source += decoder.decode();
    } else {
      source = await request.text();
    }
  } catch (_error) {
    if (_error?.code === 'request_too_large') throw _error;
    throw apiError(400, 'invalid_json', '请求正文不是有效的 JSON 对象。');
  }
  if (new TextEncoder().encode(source).byteLength > maxBytes) {
    throw apiError(413, 'request_too_large', '请求正文超过大小限制。');
  }

  try {
    const value = JSON.parse(source);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not an object');
    }
    return value;
  } catch (_error) {
    throw apiError(400, 'invalid_json', '请求正文不是有效的 JSON 对象。');
  }
}

function bearerToken(request) {
  const value = request.headers.get('authorization') || '';
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

async function authenticateDevice(request, env) {
  const libraryId = assertId(request.headers.get('x-library-id'), 'libraryId');
  const deviceId = assertId(request.headers.get('x-device-id'), 'deviceId');
  const token = bearerToken(request);
  if (token.length < 32) {
    throw apiError(401, 'unauthorized', '缺少设备凭证。');
  }

  const tokenHash = await sha256(token);
  const device = await env.DB.prepare(`
    SELECT device_id, library_id, device_name, token_hash, revoked_at
    FROM devices
    WHERE device_id = ? AND library_id = ?
  `).bind(deviceId, libraryId).first();

  if (
    !device
    || device.revoked_at
    || !await constantTimeEqual(device.token_hash, tokenHash)
  ) {
    throw apiError(401, 'unauthorized', '设备凭证无效或已被撤销。');
  }

  await env.DB.prepare(`
    UPDATE devices SET last_seen_at = ? WHERE device_id = ?
  `).bind(nowSeconds(), deviceId).run();

  return {
    deviceId,
    deviceName: device.device_name,
    libraryId,
  };
}

function parsePublicKey(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw apiError(400, 'invalid_public_key', '设备公钥格式不正确。');
  }
  const jsonValue = JSON.stringify(value);
  if (
    jsonValue.length > 4096
    || value.kty !== 'EC'
    || value.crv !== 'P-256'
    || !PUBLIC_KEY_COORDINATE_PATTERN.test(value.x)
    || !PUBLIC_KEY_COORDINATE_PATTERN.test(value.y)
  ) {
    throw apiError(400, 'invalid_public_key', '只接受 P-256 ECDH 公钥。');
  }
  return jsonValue;
}

function parseKeyEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw apiError(400, 'invalid_envelope', '密钥包格式不正确。');
  }
  const serialized = JSON.stringify(value);
  if (
    serialized.length > 8192
    || !value.ephemeralPublicKey
    || typeof value.iv !== 'string'
    || typeof value.ciphertext !== 'string'
  ) {
    throw apiError(400, 'invalid_envelope', '密钥包格式不正确。');
  }
  parsePublicKey(value.ephemeralPublicKey);
  return serialized;
}

async function handleBootstrap(request, env) {
  const suppliedToken = request.headers.get('x-bootstrap-token') || '';
  if (!env.BOOTSTRAP_TOKEN || !await constantTimeEqual(suppliedToken, env.BOOTSTRAP_TOKEN)) {
    throw apiError(401, 'unauthorized', '初始化凭证无效。');
  }

  const body = await readJson(request, MAX_SMALL_BODY_BYTES);
  const libraryId = assertId(body.libraryId, 'libraryId');
  const deviceId = assertId(body.deviceId, 'deviceId');
  const deviceName = cleanText(body.deviceName, 80);
  const tokenHash = assertHash(body.tokenHash, 'tokenHash');
  if (!deviceName) throw apiError(400, 'invalid_request', '设备名称不能为空。');

  const existing = await env.DB.prepare('SELECT library_id FROM libraries LIMIT 1').first();
  if (existing) {
    throw apiError(409, 'already_bootstrapped', '笔记库已经初始化。');
  }

  const createdAt = nowSeconds();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO libraries(library_id, created_at) VALUES (?, ?)
    `).bind(libraryId, createdAt),
    env.DB.prepare(`
      INSERT INTO devices(
        device_id, library_id, device_name, token_hash, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(deviceId, libraryId, deviceName, tokenHash, createdAt, createdAt),
  ]);

  return json({
    apiVersion: API_VERSION,
    deviceId,
    libraryId,
  }, 201);
}

async function handleCreatePairing(request, env) {
  const auth = await authenticateDevice(request, env);
  const pairId = `pair_${randomToken(18)}`;
  const code = randomToken(7).toUpperCase();
  const codeHash = await sha256(code);
  const createdAt = nowSeconds();
  const expiresAt = createdAt + PAIRING_TTL_SECONDS;

  await env.DB.prepare(`
    INSERT INTO pairings(
      pair_id, library_id, code_hash, status, created_at, expires_at
    ) VALUES (?, ?, ?, 'invited', ?, ?)
  `).bind(pairId, auth.libraryId, codeHash, createdAt, expiresAt).run();

  return json({
    code,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    pairId,
  }, 201);
}

async function enforcePairingClaimRateLimit(env) {
  if (typeof env.PAIRING_RATE_LIMITER?.limit !== 'function') return;
  const result = await env.PAIRING_RATE_LIMITER.limit({
    key: '/v1/pair/claim',
  });
  if (!result?.success) {
    throw apiError(429, 'rate_limited', '配对尝试过于频繁，请稍后再试。');
  }
}

async function handleClaimPairing(request, env) {
  const body = await readJson(request, MAX_PAIRING_BODY_BYTES);
  const code = cleanText(body.code, 32).toUpperCase();
  const deviceId = assertId(body.deviceId, 'deviceId');
  const deviceName = cleanText(body.deviceName, 80);
  const tokenHash = assertHash(body.tokenHash, 'tokenHash');
  const pairSecretHash = assertHash(body.pairSecretHash, 'pairSecretHash');
  const publicKey = parsePublicKey(body.publicKey);
  if (!code || !deviceName) {
    throw apiError(400, 'invalid_request', '配对码和设备名称不能为空。');
  }

  const codeHash = await sha256(code);
  const pairing = await env.DB.prepare(`
    SELECT pair_id, library_id, status, expires_at
    FROM pairings WHERE code_hash = ?
  `).bind(codeHash).first();

  if (!pairing || pairing.status !== 'invited' || pairing.expires_at <= nowSeconds()) {
    throw apiError(404, 'pairing_not_found', '配对码无效或已过期。');
  }

  const existingDevice = await env.DB.prepare(`
    SELECT device_id FROM devices WHERE device_id = ?
  `).bind(deviceId).first();
  if (existingDevice) {
    throw apiError(409, 'device_exists', '该设备标识已经注册。');
  }

  const result = await env.DB.prepare(`
    UPDATE pairings
    SET status = 'claimed',
        pair_secret_hash = ?,
        device_id = ?,
        device_name = ?,
        token_hash = ?,
        public_key = ?
    WHERE pair_id = ? AND status = 'invited' AND expires_at > ?
  `).bind(
    pairSecretHash,
    deviceId,
    deviceName,
    tokenHash,
    publicKey,
    pairing.pair_id,
    nowSeconds(),
  ).run();

  if (!result.meta?.changes) {
    throw apiError(409, 'pairing_claimed', '该配对码已经被使用。');
  }

  return json({
    pairId: pairing.pair_id,
    status: 'claimed',
  });
}

async function handlePairingRequest(request, env, url) {
  const auth = await authenticateDevice(request, env);
  const pairId = assertId(url.searchParams.get('pairId'), 'pairId');
  const pairing = await env.DB.prepare(`
    SELECT pair_id, status, device_id, device_name, public_key, expires_at
    FROM pairings
    WHERE pair_id = ? AND library_id = ?
  `).bind(pairId, auth.libraryId).first();

  if (!pairing || pairing.expires_at <= nowSeconds()) {
    throw apiError(404, 'pairing_not_found', '配对请求不存在或已过期。');
  }

  return json({
    deviceId: pairing.device_id,
    deviceName: pairing.device_name,
    expiresAt: new Date(pairing.expires_at * 1000).toISOString(),
    pairId: pairing.pair_id,
    publicKey: pairing.public_key ? JSON.parse(pairing.public_key) : null,
    status: pairing.status,
  });
}

async function handleApprovePairing(request, env) {
  const auth = await authenticateDevice(request, env);
  const body = await readJson(request, MAX_PAIRING_BODY_BYTES);
  const pairId = assertId(body.pairId, 'pairId');
  const keyEnvelope = parseKeyEnvelope(body.keyEnvelope);
  const pairing = await env.DB.prepare(`
    SELECT pair_id, library_id, status, device_id, device_name, token_hash, expires_at
    FROM pairings
    WHERE pair_id = ? AND library_id = ?
  `).bind(pairId, auth.libraryId).first();

  if (!pairing || pairing.status !== 'claimed' || pairing.expires_at <= nowSeconds()) {
    throw apiError(409, 'pairing_not_claimed', '配对请求尚未认领、已处理或已经过期。');
  }

  const approvedAt = nowSeconds();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO devices(
        device_id, library_id, device_name, token_hash, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      pairing.device_id,
      pairing.library_id,
      pairing.device_name,
      pairing.token_hash,
      approvedAt,
      approvedAt,
    ),
    env.DB.prepare(`
      UPDATE pairings
      SET status = 'approved', key_envelope = ?, approved_at = ?
      WHERE pair_id = ? AND status = 'claimed'
    `).bind(keyEnvelope, approvedAt, pairId),
  ]);

  return json({
    deviceId: pairing.device_id,
    status: 'approved',
  });
}

async function handlePairingStatus(request, env, url) {
  const pairId = assertId(url.searchParams.get('pairId'), 'pairId');
  const pairSecret = request.headers.get('x-pair-secret') || '';
  if (pairSecret.length < 32) {
    throw apiError(401, 'unauthorized', '缺少配对凭证。');
  }

  const pairing = await env.DB.prepare(`
    SELECT library_id, pair_secret_hash, status, key_envelope, expires_at
    FROM pairings WHERE pair_id = ?
  `).bind(pairId).first();

  if (
    !pairing
    || !pairing.pair_secret_hash
    || !await constantTimeEqual(pairing.pair_secret_hash, await sha256(pairSecret))
  ) {
    throw apiError(401, 'unauthorized', '配对凭证无效。');
  }

  if (pairing.expires_at <= nowSeconds() && pairing.status !== 'approved') {
    return json({ status: 'expired' });
  }

  return json({
    keyEnvelope: pairing.key_envelope ? JSON.parse(pairing.key_envelope) : null,
    libraryId: pairing.status === 'approved' ? pairing.library_id : null,
    status: pairing.status,
  });
}

function normalizeMutation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw apiError(400, 'invalid_mutation', '同步变更格式不正确。');
  }

  const mutationId = assertId(value.mutationId, 'mutationId');
  const recordId = assertId(value.recordId, 'recordId');
  const baseVersion = Number(value.baseVersion);
  const deleted = Boolean(value.deleted);
  if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) {
    throw apiError(400, 'invalid_mutation', 'baseVersion 必须是非负整数。');
  }

  const nonce = deleted ? null : cleanText(value.nonce, 256);
  const ciphertext = deleted ? null : String(value.ciphertext || '');
  if (
    !deleted
    && (!nonce || !ciphertext || ciphertext.length > MAX_CIPHERTEXT_LENGTH)
  ) {
    throw apiError(400, 'invalid_mutation', '密文为空或超过大小限制。');
  }

  return {
    baseVersion,
    ciphertext,
    deleted,
    mutationId,
    nonce,
    recordId,
  };
}

function mutationStatements(env, auth, mutation, createdAt) {
  const nextVersion = mutation.baseVersion + 1;
  const upsert = env.DB.prepare(`
    INSERT INTO records(
      library_id, record_id, version, deleted, nonce, ciphertext,
      last_mutation_id, updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?
    WHERE ? = 0
    ON CONFLICT(library_id, record_id) DO UPDATE SET
      version = records.version + 1,
      deleted = excluded.deleted,
      nonce = excluded.nonce,
      ciphertext = excluded.ciphertext,
      last_mutation_id = excluded.last_mutation_id,
      updated_at = excluded.updated_at
    WHERE records.version = ?
      AND NOT EXISTS (
        SELECT 1 FROM changes
        WHERE library_id = ? AND mutation_id = ?
      )
  `).bind(
    auth.libraryId,
    mutation.recordId,
    nextVersion,
    mutation.deleted ? 1 : 0,
    mutation.nonce,
    mutation.ciphertext,
    mutation.mutationId,
    createdAt,
    mutation.baseVersion,
    mutation.baseVersion,
    auth.libraryId,
    mutation.mutationId,
  );

  const appendChange = env.DB.prepare(`
    INSERT OR IGNORE INTO changes(
      library_id, record_id, version, deleted, nonce, ciphertext,
      device_id, mutation_id, created_at
    )
    SELECT
      library_id, record_id, version, deleted, nonce, ciphertext,
      ?, ?, ?
    FROM records
    WHERE library_id = ?
      AND record_id = ?
      AND last_mutation_id = ?
  `).bind(
    auth.deviceId,
    mutation.mutationId,
    createdAt,
    auth.libraryId,
    mutation.recordId,
    mutation.mutationId,
  );

  return [upsert, appendChange];
}

function recordPayload(row) {
  if (!row) return null;
  return {
    ciphertext: row.ciphertext,
    deleted: Boolean(row.deleted),
    nonce: row.nonce,
    recordId: row.record_id,
    version: row.version,
  };
}

async function handleSync(request, env) {
  const auth = await authenticateDevice(request, env);
  const body = await readJson(request, MAX_SYNC_BODY_BYTES);
  const since = Number(body.since || 0);
  if (!Number.isSafeInteger(since) || since < 0) {
    throw apiError(400, 'invalid_cursor', '同步游标格式不正确。');
  }

  const rawMutations = Array.isArray(body.mutations) ? body.mutations : [];
  if (rawMutations.length > MAX_MUTATIONS) {
    throw apiError(413, 'too_many_mutations', `每次最多提交 ${MAX_MUTATIONS} 条变更。`);
  }
  const mutations = rawMutations.map(normalizeMutation);
  const duplicateIds = new Set();
  for (const mutation of mutations) {
    if (duplicateIds.has(mutation.mutationId)) {
      throw apiError(400, 'duplicate_mutation', '一次请求中不能包含重复 mutationId。');
    }
    duplicateIds.add(mutation.mutationId);
  }

  if (mutations.length) {
    const createdAt = nowSeconds();
    const statements = mutations.flatMap((mutation) => (
      mutationStatements(env, auth, mutation, createdAt)
    ));
    await env.DB.batch(statements);
  }

  const accepted = [];
  const conflicts = [];
  for (const mutation of mutations) {
    const applied = await env.DB.prepare(`
      SELECT version FROM changes
      WHERE library_id = ? AND mutation_id = ?
    `).bind(auth.libraryId, mutation.mutationId).first();

    if (applied) {
      accepted.push({
        mutationId: mutation.mutationId,
        recordId: mutation.recordId,
        version: applied.version,
      });
      continue;
    }

    const current = await env.DB.prepare(`
      SELECT record_id, version, deleted, nonce, ciphertext
      FROM records
      WHERE library_id = ? AND record_id = ?
    `).bind(auth.libraryId, mutation.recordId).first();
    conflicts.push({
      current: recordPayload(current),
      mutationId: mutation.mutationId,
      recordId: mutation.recordId,
    });
  }

  const result = await env.DB.prepare(`
    SELECT seq, record_id, version, deleted, nonce, ciphertext
    FROM changes
    WHERE library_id = ? AND seq > ?
    ORDER BY seq ASC
    LIMIT ?
  `).bind(auth.libraryId, since, MAX_CHANGES + 1).all();
  const rows = result.results || [];
  const hasMore = rows.length > MAX_CHANGES;
  const page = hasMore ? rows.slice(0, MAX_CHANGES) : rows;
  const cursor = page.length ? page.at(-1).seq : since;

  return json({
    accepted,
    changes: page.map((row) => ({
      ...recordPayload(row),
      seq: row.seq,
    })),
    conflicts,
    cursor,
    hasMore,
  });
}

async function handleListDevices(request, env) {
  const auth = await authenticateDevice(request, env);
  const result = await env.DB.prepare(`
    SELECT device_id, device_name, created_at, last_seen_at, revoked_at
    FROM devices
    WHERE library_id = ?
    ORDER BY revoked_at IS NOT NULL, last_seen_at DESC, created_at DESC
  `).bind(auth.libraryId).all();

  return json({
    devices: (result.results || []).map((device) => ({
      createdAt: new Date(device.created_at * 1000).toISOString(),
      current: device.device_id === auth.deviceId,
      deviceId: device.device_id,
      deviceName: device.device_name,
      lastSeenAt: device.last_seen_at
        ? new Date(device.last_seen_at * 1000).toISOString()
        : null,
      revokedAt: device.revoked_at
        ? new Date(device.revoked_at * 1000).toISOString()
        : null,
    })),
  });
}

async function handleRevokeDevice(request, env) {
  const auth = await authenticateDevice(request, env);
  const body = await readJson(request, MAX_SMALL_BODY_BYTES);
  const deviceId = assertId(body.deviceId, 'deviceId');
  if (deviceId === auth.deviceId) {
    throw apiError(400, 'cannot_revoke_self', '不能从当前设备撤销自己。');
  }

  const result = await env.DB.prepare(`
    UPDATE devices
    SET revoked_at = ?
    WHERE device_id = ? AND library_id = ? AND revoked_at IS NULL
  `).bind(nowSeconds(), deviceId, auth.libraryId).run();
  if (!result.meta?.changes) {
    throw apiError(404, 'device_not_found', '设备不存在或已经撤销。');
  }
  return json({ deviceId, revoked: true });
}

async function route(request, env) {
  if (!env.DB) throw apiError(500, 'missing_binding', '缺少 D1 DB binding。');
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders(), status: 204 });
  }
  if (request.method === 'GET' && path === '/health') {
    return json({
      apiVersion: API_VERSION,
      deployment: {
        id: env.CF_VERSION_METADATA?.id || null,
        tag: env.CF_VERSION_METADATA?.tag || null,
        timestamp: env.CF_VERSION_METADATA?.timestamp || null,
      },
      ok: true,
      serviceVersion: SERVICE_VERSION,
    });
  }
  if (request.method === 'POST' && path === '/v1/bootstrap') {
    return handleBootstrap(request, env);
  }
  if (request.method === 'POST' && path === '/v1/pair/invite') {
    return handleCreatePairing(request, env);
  }
  if (request.method === 'POST' && path === '/v1/pair/claim') {
    await enforcePairingClaimRateLimit(env);
    return handleClaimPairing(request, env);
  }
  if (request.method === 'GET' && path === '/v1/pair/request') {
    return handlePairingRequest(request, env, url);
  }
  if (request.method === 'POST' && path === '/v1/pair/approve') {
    return handleApprovePairing(request, env);
  }
  if (request.method === 'GET' && path === '/v1/pair/status') {
    return handlePairingStatus(request, env, url);
  }
  if (request.method === 'POST' && path === '/v1/sync') {
    return handleSync(request, env);
  }
  if (request.method === 'GET' && path === '/v1/devices') {
    return handleListDevices(request, env);
  }
  if (request.method === 'POST' && path === '/v1/devices/revoke') {
    return handleRevokeDevice(request, env);
  }
  throw apiError(404, 'not_found', '接口不存在。');
}

export const internals = Object.freeze({
  constantTimeEqual,
  normalizeMutation,
  sha256,
});

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
          details: error?.details,
          message: status >= 500 ? '服务暂时不可用。' : error.message,
        },
      }, status, status === 429 ? { 'retry-after': '60' } : undefined);
    }
  },
};
