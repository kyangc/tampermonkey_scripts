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

test('metadata targets desktop Tampermonkey without public list permissions', () => {
  assert.deepEqual(metadataValues('inject-into'), []);
  assert.deepEqual(metadataValues('match'), ['https://x.com/*', 'https://twitter.com/*']);
  assert.deepEqual(metadataValues('connect'), [
    'mxga-sync.1109.workers.dev',
    'pbs.twimg.com',
    '*', // User-configured cobalt instance; no private endpoint in the public bundle.
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
    'GM.download',
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
  assert.match(scriptText, /callbacks\.onHide\(selected\.handle\)/);
  assert.doesNotMatch(scriptText, /账号操作浮窗/);
  assert.match(scriptText, /categoryText: '手动屏蔽'/);
});

test('userscript contains no X private API or page-world network client', () => {
  assert.doesNotMatch(mxgaSourceText, /\b(?:fetch|XMLHttpRequest)\s*\(/);
  assert.doesNotMatch(scriptText, /(?:blocks\/create|mutes\/users|\/i\/api\/|graphql)/i);
});

test('retired caches are deleted without being read and personal keys are untouched', async () => {
  const removed = [];
  await core.removeRetiredListCache({ delete: async (key) => removed.push(key), get: () => assert.fail('must not parse old cache') });
  assert.deepEqual(removed, ['mxga:list-cache:v2', 'mxga:list-meta:v1', 'mxga:list-raw:v1', 'mxga:whitelist:v1', 'mxga:sync-lock:v1']);
  assert.doesNotMatch(scriptText, /x\.zuoluo\.tv|createListSynchronizer|createAccountIndex|hideConfirmed|safe-area-inset/);
});

test('existing personal settings survive while retired automatic list controls are discarded', () => {
  assert.deepEqual(core.normalizeSettings({enabled:false, hideConfirmed:true, blockedKeywords:[' keep me ']}), {enabled:false, blockedKeywords:['keep me']});
});

test('floating position is validated and stays within resized desktop viewports', () => {
  assert.deepEqual(core.normalizeMxgaPosition(null), {side:'right',ratio:0.85});
  assert.deepEqual(core.normalizeMxgaPosition({side:'up',ratio:Infinity}), {side:'right',ratio:0.85});
  assert.deepEqual(core.normalizeMxgaPosition({side:'left',ratio:2}), {side:'left',ratio:1});
  const control = {width:96,height:40};
  assert.deepEqual(core.getMxgaDock({side:'left',ratio:0}, {width:1000,height:800}, control), {left:12,top:12});
  assert.deepEqual(core.getMxgaDock({side:'right',ratio:1}, {width:640,height:480}, control), {left:532,top:428});
});
