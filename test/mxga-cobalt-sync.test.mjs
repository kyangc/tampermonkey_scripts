import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const core = require('../scripts/make-x-great-again.user.js');
const phrase = 'a-long-test-passphrase-unique';
const config = { endpoint: 'https://cobalt.example.test/', apiKey: 'secret-test-key' };
const empty = () => ({schema:1,items:{}});
function device(initial={}) {
  const store = structuredClone(initial);
  const gm = {getValue:async(k,d)=>structuredClone(store[k]??d),setValue:async(k,v)=>{store[k]=structuredClone(v)}};
  return {store,gm,sync:core.createCobaltConfigSync(gm)};
}

test('AES-GCM round trip, randomized envelopes, wrong key and metadata tampering', async () => {
  const {sync}=device();
  const a=await sync.encrypt(config,phrase,'device-first',100);
  const b=await sync.encrypt(config,phrase,'device-first',100);
  assert.notEqual(a.data,b.data);
  assert.deepEqual(await sync.decrypt(a,phrase),config);
  assert.ok(!JSON.stringify(a).includes(config.endpoint));
  assert.ok(!JSON.stringify(a).includes(config.apiKey));
  await assert.rejects(sync.decrypt(a,'wrong-passphrase'),/解密失败/);
  await assert.rejects(sync.decrypt({...a,updatedAt:101},phrase),/解密失败/);
  await assert.rejects(sync.decrypt({...a,data:'A'.repeat(a.data.length)},phrase),/解密失败/);
});

test('two devices sync config, retain ciphertext across rule changes, and sync explicit reset', async () => {
  const a=device({'mxga:cobalt:v1':config});const b=device();
  await a.sync.configure(phrase);await b.sync.configure(phrase);
  let doc=await a.sync.prepare(empty(),empty(),'device-first');
  assert.ok(doc.cobalt);
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

test('wrong passphrase cannot overwrite remote or local config; opting out preserves envelope', async () => {
  const a=device({'mxga:cobalt:v1':config});await a.sync.configure(phrase);
  const doc=await a.sync.prepare(empty(),empty(),'device-first');
  const b=device({'mxga:cobalt:v1':{endpoint:'https://local.example/',apiKey:'local-only'}});
  await b.sync.configure('different-long-passphrase');
  await assert.rejects(b.sync.prepare(empty(),doc,'device-second'),/解密失败/);
  assert.equal(b.store['mxga:cobalt:v1'].apiKey,'local-only');
  await b.sync.configure('');assert.deepEqual(await b.sync.prepare(doc,doc,'device-second'),doc);
});

test('encrypted outbox survives failed request/restart and in-flight local edits are not replaced', async () => {
  const a=device({'mxga:cobalt:v1':config});await a.sync.configure(phrase);
  const pending=await a.sync.prepare(empty(),empty(),'device-first');
  const restart=device(a.store);const retry=await restart.sync.prepare(empty(),empty(),'device-first');
  assert.deepEqual(retry.cobalt,pending.cobalt);
  restart.store['mxga:cobalt:v1']={...config,apiKey:'new-key'};
  assert.equal(await restart.sync.apply(retry.cobalt),false);
  const updated=await restart.sync.prepare(retry,retry,'device-first');
  assert.equal((await restart.sync.decrypt(updated.cobalt,phrase)).apiKey,'new-key');
});

test('failed storage read does not become an empty configuration update', async () => {
  const a=device({'mxga:cobalt:v1':config});await a.sync.configure(phrase);
  const real=a.gm.getValue;a.gm.getValue=async(k,d)=>{if(k==='mxga:cobalt:v1')throw Error('storage denied');return real(k,d)};
  await assert.rejects(a.sync.prepare(empty(),empty(),'device-first'),/storage denied/);
  assert.equal(a.store['mxga:cobalt-sync:v1'].pending,undefined);
});

test('malformed encrypted configuration is rejected instead of silently stripped', () => {
  assert.throws(() => core.normalizeFilterDocument({schema:1,items:{},cobalt:{endpoint:'plaintext'}}), /密文格式无效/);
});

test('configuration encryption cannot reuse the server write token', async () => {
  const a=device({'mxga:cobalt:v1':config});await a.sync.configure(phrase);
  await assert.rejects(a.sync.prepare(empty(),empty(),'device-first',phrase), /必须与同步密钥不同/);
});
