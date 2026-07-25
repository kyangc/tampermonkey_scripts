import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import worker, {
  internals,
} from '../services/reading-notes-sync/src/index.mjs';

class FakeD1Statement {
  constructor(database, query, parameters = []) {
    this.database = database;
    this.query = query;
    this.parameters = parameters;
  }

  bind(...parameters) {
    return new FakeD1Statement(this.database, this.query, parameters);
  }

  first() {
    return this.database.prepare(this.query).get(...this.parameters) || null;
  }

  all() {
    return {
      results: this.database.prepare(this.query).all(...this.parameters),
    };
  }

  run() {
    const result = this.database.prepare(this.query).run(...this.parameters);
    return {
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
}

class FakeD1 {
  constructor(schema) {
    this.database = new DatabaseSync(':memory:');
    this.database.exec(schema);
  }

  prepare(query) {
    return new FakeD1Statement(this.database, query);
  }

  async batch(statements) {
    this.database.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

const schema = readFileSync(
  new URL('../services/reading-notes-sync/migrations/0001_initial.sql', import.meta.url),
  'utf8',
);

function jsonRequest(path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`https://sync.example.test${path}`, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers,
    method: options.method || (options.body === undefined ? 'GET' : 'POST'),
  });
}

async function call(env, path, options) {
  const response = await worker.fetch(jsonRequest(path, options), env);
  return {
    body: await response.json(),
    status: response.status,
  };
}

function authHeaders(identity) {
  return {
    authorization: `Bearer ${identity.token}`,
    'x-device-id': identity.deviceId,
    'x-library-id': identity.libraryId,
  };
}

async function bootstrapEnvironment() {
  const env = {
    BOOTSTRAP_TOKEN: 'bootstrap-secret-for-tests',
    DB: new FakeD1(schema),
  };
  const identity = {
    deviceId: 'dev_primary_0001',
    libraryId: 'lib_personal_0001',
    token: 'primary-device-token-that-is-long-enough',
  };
  const result = await call(env, '/v1/bootstrap', {
    body: {
      deviceId: identity.deviceId,
      deviceName: 'Primary Mac',
      libraryId: identity.libraryId,
      tokenHash: await internals.sha256(identity.token),
    },
    headers: {
      'x-bootstrap-token': env.BOOTSTRAP_TOKEN,
    },
  });
  assert.equal(result.status, 201);
  return { env, identity };
}

test('bootstraps only one encrypted notes library', async () => {
  const { env, identity } = await bootstrapEnvironment();
  const repeated = await call(env, '/v1/bootstrap', {
    body: {
      deviceId: 'dev_second_0002',
      deviceName: 'Second',
      libraryId: 'lib_second_0002',
      tokenHash: await internals.sha256('another-device-token-that-is-long-enough'),
    },
    headers: {
      'x-bootstrap-token': env.BOOTSTRAP_TOKEN,
    },
  });

  assert.equal(repeated.status, 409);
  assert.equal(repeated.body.error.code, 'already_bootstrapped');
  const devices = await call(env, '/v1/devices', {
    headers: authHeaders(identity),
  });
  assert.equal(devices.status, 200);
  assert.equal(devices.body.devices.length, 1);
  assert.equal(devices.body.devices[0].current, true);
});

test('applies encrypted mutations idempotently and reports version conflicts', async () => {
  const { env, identity } = await bootstrapEnvironment();
  const firstMutation = {
    baseVersion: 0,
    ciphertext: 'opaque-encrypted-payload',
    deleted: false,
    mutationId: 'mutation_first_0001',
    nonce: 'nonce_first_0001',
    recordId: 'annotation_record_0001',
  };
  const first = await call(env, '/v1/sync', {
    body: {
      mutations: [firstMutation],
      since: 0,
    },
    headers: authHeaders(identity),
  });

  assert.equal(first.status, 200);
  assert.deepEqual(first.body.accepted, [{
    mutationId: firstMutation.mutationId,
    recordId: firstMutation.recordId,
    version: 1,
  }]);
  assert.equal(first.body.changes.length, 1);
  assert.equal(first.body.changes[0].ciphertext, firstMutation.ciphertext);

  const replay = await call(env, '/v1/sync', {
    body: {
      mutations: [firstMutation],
      since: first.body.cursor,
    },
    headers: authHeaders(identity),
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.accepted[0].version, 1);
  assert.equal(replay.body.changes.length, 0);

  const stale = await call(env, '/v1/sync', {
    body: {
      mutations: [{
        ...firstMutation,
        ciphertext: 'stale-device-payload',
        mutationId: 'mutation_stale_0002',
      }],
      since: first.body.cursor,
    },
    headers: authHeaders(identity),
  });
  assert.equal(stale.status, 200);
  assert.equal(stale.body.accepted.length, 0);
  assert.equal(stale.body.conflicts[0].current.version, 1);
  assert.equal(stale.body.conflicts[0].current.ciphertext, firstMutation.ciphertext);
});

test('pairs a new device, authenticates it independently, and supports revocation', async () => {
  const { env, identity } = await bootstrapEnvironment();
  const invite = await call(env, '/v1/pair/invite', {
    body: {},
    headers: authHeaders(identity),
  });
  assert.equal(invite.status, 201);

  const secondToken = 'second-device-token-that-is-long-enough';
  const pairSecret = 'pair-secret-that-is-long-enough-for-tests';
  const claim = await call(env, '/v1/pair/claim', {
    body: {
      code: invite.body.code,
      deviceId: 'dev_secondary_0002',
      deviceName: 'iPad',
      pairSecretHash: await internals.sha256(pairSecret),
      publicKey: {
        crv: 'P-256',
        kty: 'EC',
        x: 'public-x',
        y: 'public-y',
      },
      tokenHash: await internals.sha256(secondToken),
    },
  });
  assert.equal(claim.status, 200);

  const pending = await call(
    env,
    `/v1/pair/request?pairId=${encodeURIComponent(invite.body.pairId)}`,
    { headers: authHeaders(identity) },
  );
  assert.equal(pending.body.status, 'claimed');
  assert.equal(pending.body.deviceName, 'iPad');

  const approve = await call(env, '/v1/pair/approve', {
    body: {
      keyEnvelope: {
        ciphertext: 'encrypted-library-key',
        ephemeralPublicKey: { crv: 'P-256', kty: 'EC', x: 'x', y: 'y' },
        iv: 'envelope-iv',
      },
      pairId: invite.body.pairId,
    },
    headers: authHeaders(identity),
  });
  assert.equal(approve.status, 200);

  const status = await call(
    env,
    `/v1/pair/status?pairId=${encodeURIComponent(invite.body.pairId)}`,
    {
      headers: {
        'x-pair-secret': pairSecret,
      },
    },
  );
  assert.equal(status.body.status, 'approved');
  assert.equal(status.body.libraryId, identity.libraryId);
  assert.equal(status.body.keyEnvelope.ciphertext, 'encrypted-library-key');

  const secondIdentity = {
    deviceId: 'dev_secondary_0002',
    libraryId: identity.libraryId,
    token: secondToken,
  };
  const secondDeviceList = await call(env, '/v1/devices', {
    headers: authHeaders(secondIdentity),
  });
  assert.equal(secondDeviceList.status, 200);
  assert.equal(secondDeviceList.body.devices.length, 2);

  const revoked = await call(env, '/v1/devices/revoke', {
    body: { deviceId: secondIdentity.deviceId },
    headers: authHeaders(identity),
  });
  assert.equal(revoked.status, 200);

  const rejected = await call(env, '/v1/devices', {
    headers: authHeaders(secondIdentity),
  });
  assert.equal(rejected.status, 401);
});
