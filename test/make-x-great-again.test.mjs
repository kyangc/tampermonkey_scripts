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

  assert.deepEqual(defaults, { enabled: true, hideConfirmed: true, blockedKeywords: [] });
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

test('keyword blocking normalizes user settings and matches tweet text without case or spacing differences', () => {
  const settings = core.normalizeSettings({
    blockedKeywords: [' Great   insight ', '私信了解', 'great insight', '', 42],
  });

  assert.deepEqual(settings.blockedKeywords, ['Great insight', '私信了解']);
  assert.deepEqual(
    core.normalizeSettings({ blockedKeywords: 'Great insight\n私信了解\ngreat insight' })
      .blockedKeywords,
    ['Great insight', '私信了解'],
  );
  assert.equal(
    core.findBlockedKeyword('This is a GREAT\nINSIGHT — send me a DM.', settings.blockedKeywords),
    'Great insight',
  );
  assert.equal(core.findBlockedKeyword('欢迎私信了解详情', settings.blockedKeywords), '私信了解');
  assert.equal(core.findBlockedKeyword('A specific, ordinary reply.', settings.blockedKeywords), null);
});

test('keyword blocking inspects only the tweet body rendered by X', () => {
  const tweet = {
    textContent: 'Specific reply — great insight!',
    closest: () => null,
  };
  const quotedRoot = {
    querySelector: (selector) => selector.includes('User-Name') ? {} : null,
  };
  const quotedTweet = {
    textContent: 'Card summary',
    closest: (selector) => selector === '[role="link"]' ? quotedRoot : null,
  };
  const item = {
    textContent: 'Blocked Author @blocked Specific reply — great insight! Card summary',
    querySelector: (selector) => selector === '[data-testid="tweetText"]' ? tweet : null,
    querySelectorAll: (selector) => selector === '[data-testid="tweetText"]'
      ? [tweet, quotedTweet]
      : [],
  };

  assert.equal(core.findBlockedKeywordInContent(item, ['great insight']), 'great insight');
  assert.equal(core.findBlockedKeywordInContent(item, ['Blocked Author']), null);
  assert.equal(core.findBlockedKeywordInContent(item, ['Card summary']), null);
  assert.equal(core.findBlockedKeywordInContent({ querySelector: () => null }, ['blocked']), null);
  assert.equal(core.findBlockedKeywordInContent({
    querySelector: () => quotedTweet,
    querySelectorAll: () => [quotedTweet],
  }, ['Card summary']), null);
});

test('multi-device filter documents preserve newer removals and independent additions', () => {
  const initial = core.reconcileFilterDocument(
    { items: {}, schema: 1 },
    {
      blockedKeywords: ['Spam phrase'],
      hiddenRecords: [{
        categoryText: '手动屏蔽',
        handle: 'first_bot',
        hiddenAt: 100,
        tierText: '头像操作',
      }],
    },
    { deviceId: 'device-primary', now: () => 1_000 },
  );
  const removedKeyword = core.reconcileFilterDocument(
    initial,
    {
      blockedKeywords: [],
      hiddenRecords: core.materializeFilterDocument(initial).hiddenRecords,
    },
    { deviceId: 'device-primary', now: () => 3_000 },
  );
  const addedElsewhere = core.reconcileFilterDocument(
    initial,
    {
      blockedKeywords: ['Spam phrase'],
      hiddenRecords: [
        ...core.materializeFilterDocument(initial).hiddenRecords,
        {
          categoryText: '手动屏蔽',
          handle: 'second_bot',
          hiddenAt: 200,
          tierText: '头像操作',
        },
      ],
    },
    { deviceId: 'device-secondary', now: () => 2_000 },
  );

  const merged = core.materializeFilterDocument(
    core.mergeFilterDocuments(removedKeyword, addedElsewhere),
  );
  assert.deepEqual(merged.blockedKeywords, []);
  assert.deepEqual(merged.hiddenRecords.map((record) => record.handle), [
    'second_bot',
    'first_bot',
  ]);
});

test('filter sync merges a public snapshot and retries a concurrent revision', async () => {
  const local = core.reconcileFilterDocument(
    { items: {}, schema: 1 },
    {
      blockedKeywords: [],
      hiddenRecords: [{ handle: 'local_bot', hiddenAt: 300 }],
    },
    { deviceId: 'device-local', now: () => 3_000 },
  );
  const remote = core.reconcileFilterDocument(
    { items: {}, schema: 1 },
    { blockedKeywords: ['Remote phrase'], hiddenRecords: [] },
    { deviceId: 'device-remote', now: () => 1_000 },
  );
  const concurrent = core.reconcileFilterDocument(
    remote,
    {
      blockedKeywords: ['Remote phrase'],
      hiddenRecords: [{ handle: 'other_bot', hiddenAt: 200 }],
    },
    { deviceId: 'device-other', now: () => 2_000 },
  );
  const requests = [];
  const responses = [
    { body: { document: remote, revision: 2 }, status: 200 },
    { body: { document: concurrent, revision: 3 }, status: 409 },
    { body: { revision: 4 }, status: 200 },
  ];
  const synchronizer = core.createFilterSynchronizer({
    endpoint: 'https://sync.example.test',
    requestJson: async (request) => {
      requests.push(request);
      return responses.shift();
    },
  });

  const result = await synchronizer.sync({
    document: local,
    token: 'write-token-long-enough-for-tests',
  });

  assert.deepEqual(
    core.materializeFilterDocument(result.document).blockedKeywords,
    ['Remote phrase'],
  );
  assert.deepEqual(
    core.materializeFilterDocument(result.document).hiddenRecords.map((record) => record.handle),
    ['local_bot', 'other_bot'],
  );
  assert.equal(result.revision, 4);
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[1].body.baseRevision, 2);
  assert.equal(requests[2].body.baseRevision, 3);
  assert.equal(requests[2].headers.Authorization, 'Bearer write-token-long-enough-for-tests');
});

test('a text selection becomes a block candidate only inside one primary tweet body', () => {
  const rect = { left: 100, top: 80, right: 180, bottom: 100, width: 80, height: 20 };
  const article = {
    querySelectorAll: (selector) => selector === '[data-testid="tweetText"]' ? [tweetText] : [],
  };
  const tweetText = {
    closest: (selector) => selector === 'article[data-testid="tweet"]' ? article : null,
    contains: (node) => node === startNode || node === endNode,
  };
  const startNode = {
    parentElement: { closest: () => tweetText },
  };
  const endNode = {
    parentElement: { closest: () => tweetText },
  };
  const range = {
    startContainer: startNode,
    endContainer: endNode,
    getBoundingClientRect: () => rect,
  };
  const selection = {
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => range,
    toString: () => '  Great\n  insight  ',
  };

  assert.deepEqual(core.getKeywordSelectionCandidate(selection), {
    keyword: 'Great insight',
    rect,
  });
  assert.equal(core.getKeywordSelectionCandidate({ ...selection, isCollapsed: true }), null);
  assert.equal(core.getKeywordSelectionCandidate({
    ...selection,
    getRangeAt: () => ({ ...range, endContainer: { parentElement: { closest: () => ({}) } } }),
  }), null);
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

test('GM JSON request adapter preserves authenticated writes and conflict payloads', async () => {
  let seen;
  const requestJson = core.createJsonRequestAdapter({
    xmlHttpRequest: async (request) => {
      seen = request;
      return {
        responseText: JSON.stringify({
          document: { items: {}, schema: 1 },
          revision: 3,
        }),
        status: 409,
      };
    },
  });

  const result = await requestJson({
    body: { baseRevision: 2, document: { items: {}, schema: 1 } },
    headers: { Authorization: 'Bearer test-token' },
    method: 'POST',
    url: 'https://sync.example.test/v1/snapshot',
  });

  assert.equal(seen.method, 'POST');
  assert.equal(seen.headers.Authorization, 'Bearer test-token');
  assert.equal(seen.headers['Content-Type'], 'application/json');
  assert.equal(JSON.parse(seen.data).baseRevision, 2);
  assert.deepEqual(result, {
    body: { document: { items: {}, schema: 1 }, revision: 3 },
    status: 409,
  });
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

test('avatar blocking binds only to the avatar link for the current tweet author', () => {
  const quotedAvatar = {
    getAttribute: (name) => name === 'href' ? '/QuotedAccount' : null,
  };
  const authorAvatar = {
    getAttribute: (name) => name === 'href' ? '/CurrentAuthor' : null,
  };
  const item = {
    querySelectorAll: (selector) => selector === '[data-testid="Tweet-User-Avatar"] a[href]'
      ? [quotedAvatar, authorAvatar]
      : [],
  };

  assert.equal(core.findAvatarTrigger(item, 'currentauthor'), authorAvatar);
  assert.equal(core.findAvatarTrigger(item, 'missingauthor'), null);
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
  assert.deepEqual(metadataValues('connect'), [
    'x.zuoluo.tv',
    'mxga-sync.1109.workers.dev',
    'pbs.twimg.com',
  ]);
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

test('settings panel exposes a local multiline keyword editor that can be saved and applied', () => {
  assert.match(scriptText, /<textarea[^>]+data-role="blocked-keywords"/);
  assert.match(scriptText, /data-action="save-keywords"/);
  assert.match(scriptText, /callbacks\.onBlockedKeywordsChange\(elements\.blockedKeywords\.value\)/);
  assert.match(scriptText, /仅匹配推文正文/);
});

test('published userscript exposes public multi-device filter sync controls', () => {
  assert.ok(metadataValues('connect').includes('mxga-sync.1109.workers.dev'));
  assert.match(scriptText, /mxga:filter-sync:v1/);
  assert.match(scriptText, /data-role="filter-sync-token"/);
  assert.match(scriptText, /data-action="save-filter-sync"/);
  assert.match(scriptText, /屏蔽词和账号列表公开可读/);
  assert.match(scriptText, /scheduleFilterSync\(\)/);
});

test('published userscript offers an immediate block action for selected tweet text', () => {
  assert.match(scriptText, /role="toolbar" aria-label="选中文本操作"/);
  assert.match(scriptText, /data-action="block-selection">屏蔽<\/button>/);
  assert.doesNotMatch(scriptText, />屏蔽所选文字<\/button>/);
  assert.match(scriptText, /callbacks\.onBlockKeyword\(keyword\)/);
  assert.match(scriptText, /getKeywordSelectionCandidate\(global\.getSelection\(\)\)/);
});

test('published userscript mounts a compact direct-block icon on tweet author avatars', () => {
  assert.match(scriptText, /\[data-testid="Tweet-User-Avatar"\] a\[href\]/);
  assert.match(scriptText, /data-mxga-avatar-trigger/);
  assert.match(scriptText, /class="avatar-block"/);
  assert.match(scriptText, /data-action="block-avatar"/);
  assert.match(scriptText, /aria-label="屏蔽用户"/);
  assert.match(scriptText, /callbacks\.onHide\(selected\.handle, selected\.entry\)/);
  assert.doesNotMatch(scriptText, /账号操作浮窗/);
  assert.match(scriptText, /categoryText: '手动屏蔽'/);
});

test('userscript contains no X private API or page-world network client', () => {
  assert.doesNotMatch(mxgaSourceText, /\b(?:fetch|XMLHttpRequest)\s*\(/);
  assert.doesNotMatch(scriptText, /(?:blocks\/create|mutes\/users|\/i\/api\/|graphql)/i);
});
