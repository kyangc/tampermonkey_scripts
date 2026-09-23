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

test('MXGA sync snapshots require authentication to read and write, and revision guarded', async () => {
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

  const empty = await call(env, '/v2/snapshot', { headers: { authorization: `Bearer ${env.SYNC_TOKEN}` } });
  assert.deepEqual(empty, {
    body: { document: { items: {}, schema: 1 }, revision: 0 },
    status: 200,
  });

  const unauthorized = await call(env, '/v2/snapshot', {
    body: { baseRevision: 0, document },
  });
  assert.equal(unauthorized.status, 401);

  const saved = await call(env, '/v2/snapshot', {
    body: { baseRevision: 0, document },
    headers: { authorization: `Bearer ${env.SYNC_TOKEN}` },
  });
  assert.deepEqual(saved, { body: { revision: 1 }, status: 200 });

  const publicRead = await call(env, '/v2/snapshot', { headers: { authorization: `Bearer ${env.SYNC_TOKEN}` } });
  assert.equal(publicRead.status, 200);
  assert.equal(publicRead.body.revision, 1);
  assert.deepEqual(publicRead.body.document, document);

  const stale = await call(env, '/v2/snapshot', {
    body: { baseRevision: 0, document: { items: {}, schema: 1 } },
    headers: { authorization: `Bearer ${env.SYNC_TOKEN}` },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.revision, 1);
  assert.deepEqual(stale.body.document, document);
});

test('cobalt settings survive rule-only writes and cannot be read without the shared token', async () => {
  const env={DB:new FakeD1(schema),SYNC_TOKEN:'write-token-long-enough-for-tests'};
  const headers={authorization:`Bearer ${env.SYNC_TOKEN}`};
  const cobalt={v:2,updatedAt:100,source:'device-primary',config:{endpoint:'https://cobalt.example/',apiKey:'test-private-key'}};
  const document={schema:1,items:{},cobalt};
  assert.equal((await call(env,'/v2/snapshot',{headers,body:{baseRevision:0,document}})).status,200);
  assert.equal((await call(env,'/v2/snapshot',{headers,body:{baseRevision:1,document:{schema:1,items:{}}}})).status,200);
  assert.deepEqual((await call(env,'/v2/snapshot',{headers})).body.document.cobalt,cobalt);
  for (const path of ['/v1/snapshot','/v2/snapshot']) {
    for (const authorization of ['', 'Bearer incorrect-token-long-enough']) {
      const result=await call(env,path,{headers:{authorization}});
      assert.equal(result.status,401);
      assert.ok(!JSON.stringify(result.body).includes(cobalt.config.apiKey));
      assert.equal(result.body.document,undefined);
    }
  }
  const bad=await call(env,'/v2/snapshot',{headers,body:{baseRevision:2,document:{...document,cobalt:{...cobalt,config:{endpoint:'http://insecure.example/',apiKey:'key'}}}}});
  assert.equal(bad.status,400);
  assert.deepEqual((await call(env,'/v2/snapshot',{headers})).body.document.cobalt,cobalt);
  const reset={...cobalt,updatedAt:101,config:{endpoint:'',apiKey:''}};
  assert.equal((await call(env,'/v2/snapshot',{headers,body:{baseRevision:2,document:{...document,cobalt:reset}}})).status,200);
  assert.deepEqual((await call(env,'/v2/snapshot',{headers})).body.document.cobalt,reset);
});

test('new settings replace encrypted history and old writers cannot overwrite them', async () => {
  const env={DB:new FakeD1(schema),SYNC_TOKEN:'write-token-long-enough-for-tests'};
  const headers={authorization:`Bearer ${env.SYNC_TOKEN}`};
  const old={v:1,updatedAt:9999999999999,source:'device-primary',data:'encrypted'};
  env.DB.database.prepare('INSERT INTO snapshot VALUES (1, 1, ?, 1)').run(JSON.stringify({schema:1,items:{},cobalt:old}));
  const cobalt={v:2,updatedAt:100,source:'device-primary',config:{endpoint:'https://cobalt.example/',apiKey:'key'}};
  const document={schema:1,items:{},cobalt};
  assert.equal((await call(env,'/v2/snapshot',{headers,body:{baseRevision:1,document}})).status,200);
  assert.deepEqual((await call(env,'/v2/snapshot',{headers})).body.document.cobalt,cobalt);
  assert.equal((await call(env,'/v1/snapshot',{headers,body:{baseRevision:2,document:{...document,cobalt:old}}})).status,404);
  assert.deepEqual((await call(env,'/v2/snapshot',{headers})).body.document.cobalt,cobalt);
});

test('real client synchronizer and Worker round-trip rules and cobalt on two devices', async () => {
  const { createRequire } = await import('node:module');
  const core = createRequire(import.meta.url)('../scripts/make-x-great-again.user.js');
  const env={DB:new FakeD1(schema),SYNC_TOKEN:'write-token-long-enough-for-tests'};
  const calls=[];
  function client(deviceId, config) {
    const store={'mxga:cobalt:v1':config};
    const gm={getValue:async(k,d)=>structuredClone(store[k]??d),setValue:async(k,v)=>{store[k]=structuredClone(v)}};
    const cobalt=core.createCobaltConfigSync(gm);
    const sync=core.createFilterSynchronizer({endpoint:'https://mxga-sync.example.test',
      requestJson: async (options) => {
        calls.push({method:options.method,path:new URL(options.url).pathname,authorized:options.headers.Authorization===`Bearer ${env.SYNC_TOKEN}`});
        return call(env,new URL(options.url).pathname,options);
      },
      prepareDocument:(local,remote)=>cobalt.prepare(local,remote,deviceId),
    });
    return {store,cobalt,sync};
  }
  const config={endpoint:'https://cobalt.example/',apiKey:'test-key'};
  const a=client('device-first',config), b=client('device-second',{endpoint:'',apiKey:''});
  const rules=core.reconcileFilterDocument({schema:1,items:{}},{blockedKeywords:['spam'],hiddenRecords:[]},{deviceId:'device-first'});
  const first=await a.sync.sync({token:env.SYNC_TOKEN,document:rules});
  await a.cobalt.apply(first.document.cobalt);
  const second=await b.sync.sync({token:env.SYNC_TOKEN,document:{schema:1,items:{}}});
  await b.cobalt.apply(second.document.cobalt);
  assert.deepEqual(b.store['mxga:cobalt:v1'],config);
  assert.deepEqual(core.materializeFilterDocument(second.document).blockedKeywords,['spam']);
  b.store['mxga:cobalt:v1']={endpoint:'',apiKey:''};
  await b.cobalt.markChanged();
  const cleared=await b.sync.sync({token:env.SYNC_TOKEN,document:second.document});
  await b.cobalt.apply(cleared.document.cobalt);
  const received=await a.sync.sync({token:env.SYNC_TOKEN,document:first.document});
  await a.cobalt.apply(received.document.cobalt);
  assert.deepEqual(a.store['mxga:cobalt:v1'],{endpoint:'',apiKey:''});
  assert.ok(calls.every(call=>call.authorized && call.path==='/v2/snapshot'));
});
