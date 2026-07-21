import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const require = createRequire(import.meta.url);
const core = require('../scripts/make-x-great-again.user.js');
const scriptText = readFileSync(new URL('../scripts/make-x-great-again.user.js', import.meta.url), 'utf8');

function metadataValues(key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...scriptText.matchAll(new RegExp(`^//\\s+@${escapedKey}\\s+(.+)$`, 'gm'))]
    .map((match) => match[1].trim());
}

test('official whitelist wins over a blacklist match regardless of handle casing', () => {
  const index = core.createAccountIndex(
    [['1001', 'SpamAccount', 'pph']],
    [['1001', 'spamaccount']],
  );

  assert.equal(index.lookup({ handle: 'SPAMACCOUNT' }), null);
});

test('lite artifact entry validation rejects the whole update when any row is invalid', () => {
  const valid = core.validateLiteArtifact({
    schema: 2,
    version: 'v-test-2',
    count: 2,
    entries: [
      ['1001', 'FirstAccount', 'pph'],
      ['', 'Second_Account', 'sca'],
    ],
  });
  const invalid = core.validateLiteArtifact({
    schema: 2,
    version: 'v-test-2',
    count: 2,
    entries: [
      ['1001', 'FirstAccount', 'pph'],
      ['', 'not-a-valid-handle', 'sca'],
    ],
  });

  assert.equal(valid.ok, true);
  assert.equal(valid.value.entries.length, 2);
  assert.deepEqual(invalid, { ok: false, error: 'invalid entry row' });
});

test('whitelist response is normalized into compact identity rows', () => {
  const result = core.validateWhitelist({
    list: [
      { x_user_id: '1001', handle: 'SafeAccount' },
      { x_user_id: null, handle: 'HandleOnly' },
    ],
  });

  assert.deepEqual(result, {
    ok: true,
    value: [
      ['1001', 'SafeAccount'],
      ['', 'HandleOnly'],
    ],
  });
});

test('auto-published list hits are visibly labeled and never auto-hidden', () => {
  const index = core.createAccountIndex([['', 'AutoListed', 'pca']], []);
  const presentation = core.getAccountPresentation(index.lookup({ handle: 'autolisted' }));

  assert.equal(presentation.badgeText, '色情');
  assert.equal(presentation.tierText, '自动收录');
  assert.equal(presentation.shouldAutoHide, false);
  assert.equal(presentation.canHideManually, true);
});

test('list sync refreshes the whitelist but skips the large artifact when the version is unchanged', async () => {
  const values = new Map([
    ['mxga:list-meta:v1', { version: 'v-current', fetchedAt: 1, count: 1200 }],
    ['mxga:list-raw:v1', '{"schema":2,"entries":[]}'],
  ]);
  const requests = [];
  const responses = new Map([
    ['https://x.zuoluo.tv/v1/whitelist', JSON.stringify({ list: [{ x_user_id: '9', handle: 'Safe' }] })],
    [
      'https://x.zuoluo.tv/v1/list/meta',
      JSON.stringify({ version: 'v-current', artifacts: { lite: '/v1/artifacts/lite-v-current.json' } }),
    ],
  ]);
  const synchronizer = core.createListSynchronizer({
    now: () => 1000,
    requestText: async (url) => {
      requests.push(url);
      return responses.get(url);
    },
    storage: {
      get: async (key, fallback) => values.has(key) ? values.get(key) : fallback,
      set: async (key, value) => values.set(key, value),
    },
  });

  const result = await synchronizer.sync(false);

  assert.deepEqual(requests, [
    'https://x.zuoluo.tv/v1/whitelist',
    'https://x.zuoluo.tv/v1/list/meta',
  ]);
  assert.equal(result.updated, false);
  assert.deepEqual(values.get('mxga:whitelist:v1').entries, [['9', 'Safe']]);
});

test('a corrupt list update never replaces the last known-good cache', async () => {
  const oldRaw = JSON.stringify({ schema: 2, version: 'v-old', count: 1, entries: [['1', 'Old', 'sph']] });
  const oldMeta = { version: 'v-old', fetchedAt: 10, count: 1200 };
  const values = new Map([
    ['mxga:list-meta:v1', oldMeta],
    ['mxga:list-raw:v1', oldRaw],
  ]);
  const synchronizer = core.createListSynchronizer({
    now: () => 2000,
    requestText: async (url) => {
      if (url.endsWith('/v1/whitelist')) return '{"list":[]}';
      if (url.endsWith('/v1/list/meta')) {
        return '{"version":"v-new","artifacts":{"lite":"/v1/artifacts/lite-v-new.json"}}';
      }
      return '{"schema":2,"version":"v-new","count":1,"entries":[["1","bad-handle","sph"]]}';
    },
    storage: {
      get: async (key, fallback) => values.has(key) ? values.get(key) : fallback,
      set: async (key, value) => values.set(key, value),
    },
  });

  const result = await synchronizer.sync(false);

  assert.equal(result.updated, false);
  assert.equal(result.error, 'invalid entry row');
  assert.equal(values.get('mxga:list-raw:v1'), oldRaw);
  assert.equal(values.get('mxga:list-meta:v1'), oldMeta);
});

test('a valid changed artifact is stored with a safe fallback version', async () => {
  const values = new Map();
  const entries = Array.from({ length: 1000 }, (_, index) => [
    String(index + 1),
    `account${String(index).padStart(4, '0')}`,
    'sph',
  ]);
  const artifactText = JSON.stringify({ schema: 2, count: entries.length, entries });
  const synchronizer = core.createListSynchronizer({
    now: () => 3000,
    requestText: async (url) => {
      if (url.endsWith('/v1/whitelist')) return '{"list":[]}';
      if (url.endsWith('/v1/list/meta')) {
        return '{"version":{"unsafe":true},"artifacts":{"lite":"/v1/artifacts/lite-next.json"}}';
      }
      return artifactText;
    },
    storage: {
      get: async (key, fallback) => values.has(key) ? values.get(key) : fallback,
      set: async (key, value) => values.set(key, value),
    },
  });

  const result = await synchronizer.sync(false);

  assert.equal(result.updated, true);
  assert.equal(result.version, 'n1000');
  assert.equal(values.get('mxga:list-raw:v1'), artifactText);
  assert.deepEqual(values.get('mxga:list-meta:v1'), {
    version: 'n1000',
    fetchedAt: 3000,
    count: 1000,
  });
});

test('local hidden accounts are case-insensitive, deduplicated, and reversible', () => {
  let now = 100;
  const hidden = core.createHiddenRegistry([], { now: () => now });

  hidden.hide('SpamAccount', { categoryText: '色情招揽', tierText: '自动收录' });
  now = 200;
  hidden.hide('@spamaccount', { categoryText: '色情招揽', tierText: '人工确认' });

  assert.equal(hidden.has('SPAMACCOUNT'), true);
  assert.deepEqual(hidden.list(), [{
    handle: 'spamaccount',
    hiddenAt: 200,
    categoryText: '色情招揽',
    tierText: '人工确认',
  }]);

  hidden.restore('SpamAccount');
  assert.equal(hidden.has('spamaccount'), false);
  assert.deepEqual(hidden.list(), []);
});

test('profile-link parsing accepts only direct X account paths', () => {
  assert.equal(core.extractHandleFromHref('/Some_User'), 'Some_User');
  assert.equal(core.extractHandleFromHref('https://x.com/Some_User'), 'Some_User');
  assert.equal(core.extractHandleFromHref('/Some_User/status/123'), null);
  assert.equal(core.extractHandleFromHref('/home'), null);
  assert.equal(core.extractHandleFromHref('/bad-handle'), null);
});

test('binary lookup remains correct for underscore-prefixed and mixed-case handles', () => {
  const index = core.createAccountIndex([
    ['', 'Zulu', 'soh'],
    ['', '_Leading', 'sph'],
    ['', 'Alpha', 'sph'],
  ]);

  assert.equal(index.lookup({ handle: '_LEADING' }).normalizedHandle, '_leading');
  assert.equal(index.lookup({ handle: 'alpha' }).normalizedHandle, 'alpha');
  assert.equal(index.lookup({ handle: 'zulu' }).normalizedHandle, 'zulu');
});

test('metadata exposes the cross-platform interface required by Tampermonkey and iOS Userscripts', () => {
  assert.deepEqual(metadataValues('inject-into'), ['content']);
  assert.deepEqual(metadataValues('match'), ['https://x.com/*', 'https://twitter.com/*']);
  assert.deepEqual(new Set(metadataValues('grant')), new Set([
    'GM.getValue',
    'GM.setValue',
    'GM.deleteValue',
    'GM.xmlHttpRequest',
    'GM.openInTab',
  ]));
  assert.deepEqual(metadataValues('updateURL'), [
    'https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/make-x-great-again.user.js',
  ]);
  assert.deepEqual(metadataValues('downloadURL'), metadataValues('updateURL'));
});
