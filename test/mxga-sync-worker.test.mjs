import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import worker from '../services/mxga-sync/src/index.mjs';

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

  run() {
    const result = this.database.prepare(this.query).run(...this.parameters);
    return { meta: { changes: Number(result.changes) } };
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
}

const schema = readFileSync(
  new URL('../services/mxga-sync/migrations/0001_initial.sql', import.meta.url),
  'utf8',
);

function request(path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`https://mxga-sync.example.test${path}`, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers,
    method: options.method || (options.body === undefined ? 'GET' : 'POST'),
  });
}

async function call(env, path, options) {
  const response = await worker.fetch(request(path, options), env);
  return { body: await response.json(), status: response.status };
}

test('MXGA sync snapshots are public to read, authenticated to write, and revision guarded', async () => {
  const env = {
    DB: new FakeD1(schema),
    SYNC_TOKEN: 'write-token-long-enough-for-tests',
  };
  const document = {
    schema: 1,
    items: {
      'keyword:spam': {
        deleted: false,
        key: 'spam',
        kind: 'keyword',
        source: 'device-primary',
        updatedAt: 1_787_900_000_000,
        value: 'Spam',
      },
    },
  };

  const empty = await call(env, '/v1/snapshot');
  assert.deepEqual(empty, {
    body: { document: { items: {}, schema: 1 }, revision: 0 },
    status: 200,
  });

  const unauthorized = await call(env, '/v1/snapshot', {
    body: { baseRevision: 0, document },
  });
  assert.equal(unauthorized.status, 401);

  const saved = await call(env, '/v1/snapshot', {
    body: { baseRevision: 0, document },
    headers: { authorization: `Bearer ${env.SYNC_TOKEN}` },
  });
  assert.deepEqual(saved, { body: { revision: 1 }, status: 200 });

  const publicRead = await call(env, '/v1/snapshot');
  assert.equal(publicRead.status, 200);
  assert.equal(publicRead.body.revision, 1);
  assert.deepEqual(publicRead.body.document, document);

  const stale = await call(env, '/v1/snapshot', {
    body: { baseRevision: 0, document: { items: {}, schema: 1 } },
    headers: { authorization: `Bearer ${env.SYNC_TOKEN}` },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.revision, 1);
  assert.deepEqual(stale.body.document, document);
});

test('encrypted cobalt envelope survives legacy client writes and rejects plaintext', async () => {
  const env={DB:new FakeD1(schema),SYNC_TOKEN:'write-token-long-enough-for-tests'};
  const headers={authorization:`Bearer ${env.SYNC_TOKEN}`};
  const cobalt={v:1,updatedAt:100,source:'device-primary',salt:'A'.repeat(22)+'==',iv:'A'.repeat(16),data:'A'.repeat(24)};
  const document={schema:1,items:{},cobalt};
  assert.equal((await call(env,'/v1/snapshot',{headers,body:{baseRevision:0,document}})).status,200);
  const legacy={schema:1,items:{}};
  assert.equal((await call(env,'/v1/snapshot',{headers,body:{baseRevision:1,document:legacy}})).status,200);
  assert.deepEqual((await call(env,'/v1/snapshot')).body.document.cobalt,cobalt);
  const bad=await call(env,'/v1/snapshot',{headers,body:{baseRevision:2,document:{...document,cobalt:{...cobalt,apiKey:'must-never-publish'}}}});
  assert.equal(bad.status,400);
  assert.deepEqual((await call(env,'/v1/snapshot')).body.document.cobalt,cobalt);
});
