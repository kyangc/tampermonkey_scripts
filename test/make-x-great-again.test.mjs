import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const require = createRequire(import.meta.url);
const core = require('../scripts/make-x-great-again.user.js');
const scriptText = readFileSync(new URL('../scripts/make-x-great-again.user.js', import.meta.url), 'utf8');
const mxgaSourceText = readFileSync(
  new URL('../src/userscripts/make-x-great-again.entry.js', import.meta.url),
  'utf8',
);

function metadataValues(key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...scriptText.matchAll(new RegExp(`^//\\s+@${escapedKey}\\s+(.+)$`, 'gm'))]
    .map((match) => match[1].trim());
}

function makeListEntries(count = 1000) {
  return Array.from({ length: count }, (_, index) => [
    String(index + 1),
    `account${String(index).padStart(4, '0')}`,
    'sph',
  ]);
}

test('official whitelist wins over a blacklist match regardless of handle casing', () => {
  const index = core.createAccountIndex(
    [['1001', 'SpamAccount', 'pph']],
    [['1001', 'spamaccount']],
  );

  assert.equal(index.lookup({ handle: 'SPAMACCOUNT' }), null);
});

test('runtime matching does not treat an unobservable user ID as a whitelist guarantee', () => {
  const index = core.createAccountIndex(
    [['1001', 'RenamedSpam', 'sph']],
    [['1001', 'PreviouslySafe']],
  );

  assert.equal(index.lookup({ userId: '1001', handle: 'renamedspam' })?.handle, 'renamedspam');
  assert.equal(index.lookup({ handle: 'PREVIOUSLYSAFE' }), null);
});

test('list freshness is determined from the last successful list confirmation', () => {
  const now = 10 * 60 * 60 * 1000;

  assert.equal(core.isListStale(null, now), true);
  assert.equal(core.isListStale({ fetchedAt: 0 }, now), true);
  assert.equal(core.isListStale({ fetchedAt: now - core.LIST_STALE_MS + 1 }, now), false);
  assert.equal(core.isListStale({ fetchedAt: now - core.LIST_STALE_MS }, now), true);
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

test('human-confirmed list hits are eligible for automatic hiding', () => {
  const index = core.createAccountIndex([['', 'ConfirmedSpam', 'sph']], []);
  const presentation = core.getAccountPresentation(index.lookup({ handle: 'confirmedspam' }));

  assert.equal(presentation.tierText, '人工确认');
  assert.equal(presentation.shouldAutoHide, true);
  assert.equal(presentation.canHideManually, true);
});

test('confirmed-hit visibility defaults to hidden and can be temporarily switched back to labels', () => {
  const confirmed = core.decodeEntry(['', 'ConfirmedSpam', 'sph']);
  const automatic = core.decodeEntry(['', 'AutoListed', 'spa']);
  const defaults = core.normalizeSettings({});

  assert.deepEqual(defaults, { enabled: true, hideConfirmed: true });
  assert.equal(
    core.getAccountVisibility({ entry: confirmed, settings: defaults }),
    'hidden',
  );
  assert.equal(
    core.getAccountVisibility({ entry: automatic, settings: defaults }),
    'labeled',
  );
  assert.equal(
    core.getAccountVisibility({
      entry: confirmed,
      settings: core.normalizeSettings({ hideConfirmed: false }),
    }),
    'labeled',
  );
  assert.equal(
    core.getAccountVisibility({
      entry: confirmed,
      settings: core.normalizeSettings({ hideConfirmed: false }),
      locallyHidden: true,
    }),
    'hidden',
  );
  assert.equal(
    core.getAccountVisibility({
      entry: confirmed,
      settings: core.normalizeSettings({ enabled: false }),
      locallyHidden: true,
    }),
    'shown',
  );
});

test('panel backdrop clicks are consumed so they close without reaching the page below', () => {
  const backdrop = {};
  let prevented = false;
  let stopped = false;
  const event = {
    target: backdrop,
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
  };

  assert.equal(core.consumeBackdropClick(event, backdrop), true);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(core.consumeBackdropClick({ target: {} }, backdrop), false);
});

test('mutation scan collection keeps only the affected account content roots', () => {
  const existingArticle = { id: 'existing-article' };
  const addedArticle = {
    id: 'added-article',
    closest: () => null,
    matches: (selector) => selector.includes('article'),
    querySelectorAll: () => [],
  };
  const changedLeaf = {
    closest: () => existingArticle,
  };
  const addedContainer = {
    closest: () => null,
    matches: () => false,
    querySelectorAll: () => [addedArticle],
  };

  const items = core.collectMutationScanItems([
    {
      target: changedLeaf,
      addedNodes: [addedContainer],
    },
  ]);

  assert.deepEqual(items, [existingArticle, addedArticle]);
});

test('the MXGA runtime mount can only be claimed once per page', () => {
  const attributes = new Set();
  const root = {
    hasAttribute: (name) => attributes.has(name),
    setAttribute: (name) => attributes.add(name),
  };

  assert.equal(core.claimRuntimeMount(root), true);
  assert.equal(core.claimRuntimeMount(root), false);
});

test('list sync refreshes the whitelist but skips the large artifact when the version is unchanged', async () => {
  const entries = makeListEntries();
  const raw = JSON.stringify({
    schema: 2,
    version: 'v-current',
    count: entries.length,
    entries,
  });
  const values = new Map([
    ['mxga:list-cache:v2', {
      schema: 1,
      raw,
      meta: { version: 'v-current', fetchedAt: 1, count: entries.length },
    }],
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
  assert.deepEqual(values.get('mxga:list-cache:v2'), {
    schema: 1,
    raw,
    meta: { version: 'v-current', fetchedAt: 1000, count: entries.length },
  });
});

test('unchanged metadata still redownloads when the cached artifact is invalid', async () => {
  const entries = makeListEntries();
  const artifactText = JSON.stringify({
    schema: 2,
    version: 'v-current',
    count: entries.length,
    entries,
  });
  const values = new Map([
    ['mxga:list-cache:v2', {
      schema: 1,
      raw: '{"schema":2,"version":"v-current","count":1000,"entries":[]}',
      meta: { version: 'v-current', fetchedAt: 1, count: entries.length },
    }],
  ]);
  const requests = [];
  const synchronizer = core.createListSynchronizer({
    now: () => 1000,
    requestText: async (url) => {
      requests.push(url);
      if (url.endsWith('/v1/whitelist')) return '{"list":[]}';
      if (url.endsWith('/v1/list/meta')) {
        return '{"version":"v-current","artifacts":{"lite":"/v1/artifacts/lite-v-current.json"}}';
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
  assert.equal(requests.at(-1), 'https://x.zuoluo.tv/v1/artifacts/lite-v-current.json');
  assert.equal(values.get('mxga:list-cache:v2').raw, artifactText);
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

test('a failed cache commit keeps the previous list snapshot intact', async () => {
  const oldRaw = JSON.stringify({
    schema: 2,
    version: 'v-old',
    count: 1,
    entries: [['1', 'OldAccount', 'sph']],
  });
  const oldSnapshot = {
    schema: 1,
    raw: oldRaw,
    meta: { version: 'v-old', fetchedAt: 10, count: 1 },
  };
  const values = new Map([['mxga:list-cache:v2', oldSnapshot]]);
  const entries = makeListEntries();
  const artifactText = JSON.stringify({
    schema: 2,
    version: 'v-new',
    count: entries.length,
    entries,
  });
  const synchronizer = core.createListSynchronizer({
    now: () => 2000,
    requestText: async (url) => {
      if (url.endsWith('/v1/whitelist')) return '{"list":[]}';
      if (url.endsWith('/v1/list/meta')) {
        return '{"version":"v-new","artifacts":{"lite":"/v1/artifacts/lite-v-new.json"}}';
      }
      return artifactText;
    },
    storage: {
      get: async (key, fallback) => values.has(key) ? values.get(key) : fallback,
      set: async (key, value) => {
        if (key === 'mxga:list-cache:v2') throw new Error('simulated cache commit failure');
        values.set(key, value);
      },
    },
  });

  const result = await synchronizer.sync(false);

  assert.equal(result.updated, false);
  assert.equal(result.error, 'simulated cache commit failure');
  assert.deepEqual(values.get('mxga:list-cache:v2'), oldSnapshot);
  assert.equal(values.has('mxga:list-raw:v1'), false);
  assert.equal(values.has('mxga:list-meta:v1'), false);
});

test('the stored list reader loads one complete atomic snapshot', async () => {
  const entries = makeListEntries();
  const meta = { version: 'v-current', fetchedAt: 1234, count: entries.length };
  const values = new Map([
    ['mxga:list-cache:v2', {
      schema: 1,
      raw: JSON.stringify({
        schema: 2,
        version: meta.version,
        count: entries.length,
        entries,
      }),
      meta,
    }],
    ['mxga:whitelist:v1', {
      entries: [['9', 'SafeAccount']],
    }],
  ]);

  const result = await core.readStoredList({
    get: async (key, fallback) => values.has(key) ? values.get(key) : fallback,
  });

  assert.equal(result.error, null);
  assert.equal(result.entries.length, entries.length);
  assert.deepEqual(result.entries[0], entries[0]);
  assert.deepEqual(result.meta, meta);
  assert.deepEqual(result.whitelistEntries, [['9', 'SafeAccount']]);
});

test('the stored list reader rejects a snapshot whose artifact and metadata versions differ', async () => {
  const entries = makeListEntries();
  const values = new Map([['mxga:list-cache:v2', {
    schema: 1,
    raw: JSON.stringify({
      schema: 2,
      version: 'v-artifact',
      count: entries.length,
      entries,
    }),
    meta: { version: 'v-metadata', fetchedAt: 1234, count: entries.length },
  }]]);

  const result = await core.readStoredList({
    get: async (key, fallback) => values.has(key) ? values.get(key) : fallback,
  });

  assert.deepEqual(result.entries, []);
  assert.equal(result.meta, null);
  assert.equal(result.error, 'cached list version mismatch');
});

test('the stored list reader rejects a snapshot whose metadata count differs', async () => {
  const entries = makeListEntries();
  const values = new Map([['mxga:list-cache:v2', {
    schema: 1,
    raw: JSON.stringify({
      schema: 2,
      version: 'v-current',
      count: entries.length,
      entries,
    }),
    meta: { version: 'v-current', fetchedAt: 1234, count: entries.length - 1 },
  }]]);

  const result = await core.readStoredList({
    get: async (key, fallback) => values.has(key) ? values.get(key) : fallback,
  });

  assert.deepEqual(result.entries, []);
  assert.equal(result.meta, null);
  assert.equal(result.error, 'cached list count mismatch');
});

test('GM request object rejections become a readable network error', async () => {
  const requestText = core.createRequestAdapter({
    xmlHttpRequest: async () => Promise.reject({ status: 0, statusText: '' }),
  });

  await assert.rejects(
    requestText('https://x.zuoluo.tv/v1/list/meta', 1024),
    /网络请求失败/,
  );
});

test('GM request adapter performs a bodyless read-only request', async () => {
  const requests = [];
  const requestText = core.createRequestAdapter({
    xmlHttpRequest: async (request) => {
      requests.push(request);
      return { status: 200, responseText: '{"ok":true}' };
    },
  });

  assert.equal(
    await requestText('https://x.zuoluo.tv/v1/list/meta', 1024),
    '{"ok":true}',
  );
  assert.deepEqual(requests, [{
    method: 'GET',
    url: 'https://x.zuoluo.tv/v1/list/meta',
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
    },
    responseType: 'text',
    timeout: 60000,
  }]);
  assert.equal('data' in requests[0], false);
});

test('a valid changed artifact is stored with a safe fallback version', async () => {
  const values = new Map();
  const entries = makeListEntries();
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
  assert.deepEqual(values.get('mxga:list-cache:v2'), {
    schema: 1,
    raw: artifactText,
    meta: {
      version: 'n1000',
      fetchedAt: 3000,
      count: 1000,
    },
  });
  assert.equal(values.has('mxga:list-raw:v1'), false);
  assert.equal(values.has('mxga:list-meta:v1'), false);
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

test('profile badge mount falls back to the semantic public-profile markup used by X', () => {
  const mount = {};
  const handleLeaf = {
    children: [],
    parentElement: mount,
    textContent: '@Public_Profile',
  };
  const additionalName = {
    getAttribute: (name) => name === 'content' ? 'Public_Profile' : null,
  };
  const person = {
    contains: (node) => node === mount,
    querySelector: (selector) => selector === 'meta[itemprop="additionalName"][content]'
      ? additionalName
      : null,
    querySelectorAll: () => [handleLeaf],
  };
  const root = {
    querySelector: (selector) => {
      if (selector === '[data-testid="UserName"]') return null;
      if (selector === '[itemprop="mainEntity"][itemtype="https://schema.org/Person"]') return person;
      return null;
    },
  };

  assert.equal(core.findProfileNameBlock(root, 'public_profile'), mount);
  assert.equal(core.findProfileNameBlock(root, 'different_profile'), null);
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
  assert.deepEqual(metadataValues('connect'), ['x.zuoluo.tv', 'pbs.twimg.com']);
  assert.match(
    metadataValues('require')[0],
    /^https:\/\/raw\.githubusercontent\.com\/kazuhikoarase\/qrcode-generator\/.*#sha256-/,
  );
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

test('MXGA bundles the tested share-card interface and prevents duplicate runtime mounts', () => {
  assert.equal(typeof core.normalizeTweetData, 'function');
  assert.equal(typeof core.buildCardLayout, 'function');
  assert.match(scriptText, /data-tsc-runtime-mounted/);
  assert.match(scriptText, /data-tsc-action="share-card"/);
});

test('settings version metric stays on one line while retaining the full machine version', () => {
  assert.match(
    scriptText,
    /\[data-role="version"\]\{[^}]*overflow:hidden;[^}]*text-overflow:ellipsis;[^}]*white-space:nowrap[^}]*\}/,
  );
  assert.match(scriptText, /elements\.version\.title\s*=\s*version;/);
});

test('userscript contains no X private API or page-world network client', () => {
  assert.doesNotMatch(mxgaSourceText, /\b(?:fetch|XMLHttpRequest)\s*\(/);
  assert.doesNotMatch(scriptText, /(?:blocks\/create|mutes\/users|\/i\/api\/|graphql)/i);
});
