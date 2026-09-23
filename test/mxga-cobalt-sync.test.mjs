import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const core = require('../scripts/make-x-great-again.user.js');
const config = { endpoint: 'https://cobalt.example.test/', apiKey: 'secret-test-key' };
const empty = () => ({schema:1,items:{}});
function device(initial={}) {
  const store = structuredClone(initial);
  const gm = {getValue:async(k,d)=>structuredClone(store[k]??d),setValue:async(k,v)=>{store[k]=structuredClone(v)}};
  return {store,gm,sync:core.createCobaltConfigSync(gm)};
}

test('two devices sync config with rules without a separate switch or passphrase, including reset', async () => {
  const a=device({'mxga:cobalt:v1':config});const b=device();
  let doc=await a.sync.prepare(empty(),empty(),'device-first');
  assert.deepEqual(doc.cobalt.config,config);
  assert.equal(await a.sync.apply(doc.cobalt),true);
  const incoming=await b.sync.prepare(empty(),doc,'device-second');
  assert.deepEqual(incoming.cobalt,doc.cobalt);
  await b.sync.apply(doc.cobalt);
  assert.deepEqual(b.store['mxga:cobalt:v1'],config);
  const withRules=core.reconcileFilterDocument(doc,{blockedKeywords:['spam'],hiddenRecords:[]},{deviceId:'device-first'});
  assert.deepEqual(withRules.cobalt,doc.cobalt);
  assert.deepEqual(core.mergeFilterDocuments(empty(),withRules).cobalt,doc.cobalt);
  b.store['mxga:cobalt:v1']={endpoint:'',apiKey:''};await b.sync.markChanged();
  const reset=await b.sync.prepare(doc,doc,'device-second');assert.ok(reset.cobalt.updatedAt>doc.cobalt.updatedAt);
  await a.sync.prepare(doc,reset,'device-first');await a.sync.apply(reset.cobalt);
  assert.deepEqual(a.store['mxga:cobalt:v1'],{endpoint:'',apiKey:''});
});

test('fresh device takes remote settings as an endpoint/key pair', async () => {
  const a=device({'mxga:cobalt:v1':config});
  const doc=await a.sync.prepare(empty(),empty(),'device-first');
  const b=device({'mxga:cobalt:v1':{endpoint:'https://local.example/',apiKey:'local-only'}});
  const incoming=await b.sync.prepare(empty(),doc,'device-second');
  await b.sync.apply(incoming.cobalt);
  assert.deepEqual(b.store['mxga:cobalt:v1'],config);
});

test('outbox survives failed request/restart and in-flight local edits are not replaced', async () => {
  const a=device({'mxga:cobalt:v1':config});
  const pending=await a.sync.prepare(empty(),empty(),'device-first');
  const restart=device(a.store);const retry=await restart.sync.prepare(empty(),empty(),'device-first');
  assert.deepEqual(retry.cobalt,pending.cobalt);
  restart.store['mxga:cobalt:v1']={...config,apiKey:'new-key'};
  assert.equal(await restart.sync.apply(retry.cobalt),false);
  const updated=await restart.sync.prepare(retry,retry,'device-first');
  assert.equal(updated.cobalt.config.apiKey,'new-key');
});

test('failed storage read does not become an empty configuration update', async () => {
  const a=device({'mxga:cobalt:v1':config});
  const real=a.gm.getValue;a.gm.getValue=async(k,d)=>{if(k==='mxga:cobalt:v1')throw Error('storage denied');return real(k,d)};
  await assert.rejects(a.sync.prepare(empty(),empty(),'device-first'),/storage denied/);
  assert.equal(a.store['mxga:cobalt-sync:v2'],undefined);
});

test('malformed configuration is rejected; encrypted history does not prevent syncing local settings', async () => {
  assert.throws(() => core.normalizeFilterDocument({schema:1,items:{},cobalt:{endpoint:'invalid'}}), /配置格式无效/);
  const history = core.normalizeFilterDocument({...empty(),cobalt:{v:1,salt:'old',data:'encrypted'}});
  const a=device({'mxga:cobalt:v1':config,'mxga:cobalt-sync:v1':{passphrase:'unused'}});
  const doc=await a.sync.prepare(history,history,'device-first');
  assert.deepEqual(doc.cobalt.config,config);
});

test('conflicting config events converge without mixing endpoint and key', () => {
  const a={...empty(),cobalt:{v:2,source:'device-first',updatedAt:100,config}};
  const b={...empty(),cobalt:{v:2,source:'device-second',updatedAt:101,config:{endpoint:'https://other.example/',apiKey:'other-key'}}};
  assert.deepEqual(core.mergeFilterDocuments(a,b),core.mergeFilterDocuments(b,a));
  assert.deepEqual(core.mergeFilterDocuments(a,b).cobalt.config,b.cobalt.config);
});

test('unavailable v2 endpoint stops before preparing or sending configuration', async () => {
  const calls=[];
  const sync=core.createFilterSynchronizer({endpoint:'https://old-sync.example/',
    requestJson:async request=>{calls.push(request);return {status:404,body:{}};},
    prepareDocument:()=>{throw Error('must not prepare configuration');},
  });
  await assert.rejects(sync.sync({token:'write-token-long-enough-for-tests',document:empty()}),/无法读取/);
  assert.equal(calls.length,1);
  assert.equal(calls[0].method,'GET');
  assert.equal(calls[0].body,undefined);
});
