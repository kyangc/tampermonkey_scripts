// ==UserScript==
// @name         Make X Great Again (Userscript)
// @namespace    https://github.com/kyangc/tampermonkey_scripts
// @version      0.7.0
// @description  Quick-block and sync selected phrases or users, hide spam, generate share cards, and download videos via cobalt on X.
// @author       kyangc
// @license      AGPL-3.0-or-later
// @source       https://github.com/foru17/make-x-great-again
// @homepageURL  https://github.com/kyangc/tampermonkey_scripts
// @supportURL   https://github.com/kyangc/tampermonkey_scripts/issues
// @updateURL    https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/make-x-great-again.user.js
// @downloadURL  https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/make-x-great-again.user.js
// @match        https://x.com/*
// @match        https://twitter.com/*
// @require      https://raw.githubusercontent.com/kazuhikoarase/qrcode-generator/js2.0.4/js/dist/qrcode.js#sha256-eeyG+ChWAFsciHkFz8z8++w4Icphx/1alS+qX3ePeRw=
// @run-at       document-idle
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.xmlHttpRequest
// @grant        GM.openInTab
// @connect      mxga-sync.1109.workers.dev
// @connect      pbs.twimg.com
// @connect      *
// @noframes
// ==/UserScript==

// Source entry for tools/build-userscripts.mjs.
// SPDX-License-Identifier: AGPL-3.0-or-later
// Userscript adaptation of https://github.com/foru17/make-x-great-again
// Original project and this derivative are licensed under AGPL-3.0-or-later.
// Modified by kyangc: desktop userscript with personal filters, share cards,
// and cobalt downloads. Public account lists have been retired.

(function makeXGreatAgainUserscript(global) {
  'use strict';

  const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
  const FILTER_SYNC_ENDPOINT = 'https://mxga-sync.1109.workers.dev';
  const SYNC_SOURCE_RE = /^[A-Za-z0-9_-]{8,80}$/;
  const ACCOUNT_CONTENT_SELECTOR =
    'article[data-testid="tweet"], [data-testid="UserCell"]';
  const RUNTIME_MOUNT_ATTRIBUTE = 'data-mxga-userscript-runtime-mounted';
  const STORAGE_KEYS = {
    settings: 'mxga:settings:v1',
    hidden: 'mxga:hidden:v1',
    filterSync: 'mxga:filter-sync:v1',
    position: 'mxga:position:v1',
  };

  function errorMessage(error, fallback = '未知错误') {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string' && error.trim()) return error.trim();
    if (error && typeof error === 'object') {
      for (const key of ['message', 'error', 'statusText']) {
        const value = error[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
      const status = Number(error.status);
      if (Number.isFinite(status) && status > 0) return `HTTP ${status}`;
    }
    return fallback;
  }

  function normalizeHandle(handle) {
    return typeof handle === 'string' ? handle.replace(/^@/, '').trim().toLowerCase() : '';
  }

  function normalizeMatchText(value) {
    return typeof value === 'string'
      ? value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
      : '';
  }

  function normalizeKeyword(value) {
    return typeof value === 'string'
      ? value.normalize('NFKC').replace(/\s+/g, ' ').trim()
      : '';
  }

  function normalizeKeywords(value) {
    const rows = typeof value === 'string' ? value.split(/\r?\n/) : value;
    const keywords = [];
    const seen = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      const keyword = normalizeKeyword(row);
      const normalized = normalizeMatchText(keyword);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      keywords.push(keyword);
    }
    return keywords;
  }

  function findBlockedKeyword(text, keywords) {
    const normalizedText = normalizeMatchText(text);
    if (!normalizedText) return null;
    for (const keyword of normalizeKeywords(keywords)) {
      if (normalizedText.includes(normalizeMatchText(keyword))) return keyword;
    }
    return null;
  }

  function getPrimaryTweetTextNode(item) {
    const selector = '[data-testid="tweetText"]';
    const tweetTexts = typeof item?.querySelectorAll === 'function'
      ? Array.from(item.querySelectorAll(selector))
      : [item?.querySelector?.(selector)].filter(Boolean);
    const tweetText = tweetTexts.find((node) => {
      const linkedCard = node?.closest?.('[role="link"]');
      return !(
        linkedCard &&
        linkedCard !== item &&
        linkedCard.querySelector?.('[data-testid="User-Name"], [data-testid="UserName"]')
      );
    });
    return tweetText || null;
  }

  function findBlockedKeywordInContent(item, keywords) {
    const tweetText = getPrimaryTweetTextNode(item);
    return findBlockedKeyword(tweetText?.textContent || '', keywords);
  }

  function getKeywordSelectionCandidate(selection) {
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt?.(0);
    const startElement = range?.startContainer?.closest
      ? range.startContainer
      : range?.startContainer?.parentElement;
    const endElement = range?.endContainer?.closest
      ? range.endContainer
      : range?.endContainer?.parentElement;
    const startTweetText = startElement?.closest?.('[data-testid="tweetText"]');
    const endTweetText = endElement?.closest?.('[data-testid="tweetText"]');
    if (!startTweetText || startTweetText !== endTweetText) return null;
    if (
      !startTweetText.contains?.(range.startContainer) ||
      !startTweetText.contains?.(range.endContainer)
    ) {
      return null;
    }
    const article = startTweetText.closest?.('article[data-testid="tweet"]');
    if (!article || getPrimaryTweetTextNode(article) !== startTweetText) return null;
    const keyword = normalizeKeyword(selection.toString?.() || '');
    if (!keyword) return null;
    const rect = range.getBoundingClientRect?.();
    if (!rect) return null;
    return { keyword, rect };
  }

  const RESERVED_X_PATHS = new Set([
    'compose',
    'explore',
    'hashtag',
    'home',
    'i',
    'intent',
    'jobs',
    'login',
    'logout',
    'messages',
    'notifications',
    'privacy',
    'search',
    'settings',
    'share',
    'tos',
  ]);

  function extractHandleFromHref(href) {
    if (typeof href !== 'string' || !href.trim()) return null;
    try {
      const url = new URL(href, 'https://x.com');
      if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname)) return null;
      const segments = url.pathname.split('/').filter(Boolean);
      if (segments.length !== 1 || !HANDLE_RE.test(segments[0])) return null;
      if (RESERVED_X_PATHS.has(segments[0].toLowerCase())) return null;
      return segments[0];
    } catch (_error) {
      return null;
    }
  }

  function findAvatarTrigger(item, handle) {
    const normalized = normalizeHandle(handle);
    if (!normalized || typeof item?.querySelectorAll !== 'function') return null;
    for (const link of item.querySelectorAll('[data-testid="Tweet-User-Avatar"] a[href]')) {
      if (normalizeHandle(extractHandleFromHref(link.getAttribute?.('href') || '')) === normalized) {
        return link;
      }
    }
    return null;
  }

  function collectMutationScanItems(records) {
    const items = new Set();
    const addClosest = (node) => {
      const item = node?.closest?.(ACCOUNT_CONTENT_SELECTOR);
      if (item) items.add(item);
    };
    const addInsertedRoot = (node) => {
      if (!node) return;
      if (node.matches?.(ACCOUNT_CONTENT_SELECTOR)) items.add(node);
      else addClosest(node);
      for (const item of node.querySelectorAll?.(ACCOUNT_CONTENT_SELECTOR) || []) {
        items.add(item);
      }
    };

    for (const record of Array.from(records || [])) {
      addClosest(record?.target);
      for (const node of Array.from(record?.addedNodes || [])) addInsertedRoot(node);
    }
    return [...items];
  }

  function claimRuntimeMount(root) {
    if (!root || typeof root.hasAttribute !== 'function' || typeof root.setAttribute !== 'function') {
      return false;
    }
    if (root.hasAttribute(RUNTIME_MOUNT_ATTRIBUTE)) return false;
    root.setAttribute(RUNTIME_MOUNT_ATTRIBUTE, '');
    return true;
  }

  function createHiddenRegistry(initialRecords, options = {}) {
    const now = options.now || Date.now;
    const maxEntries = options.maxEntries || 2000;
    const records = new Map();

    function put(handle, metadata = {}, hiddenAt = now()) {
      const normalized = normalizeHandle(handle);
      if (!HANDLE_RE.test(normalized)) return false;
      records.set(normalized, {
        handle: normalized,
        hiddenAt: Number.isFinite(Number(hiddenAt)) ? Number(hiddenAt) : now(),
        categoryText: typeof metadata.categoryText === 'string' ? metadata.categoryText : '',
        tierText: typeof metadata.tierText === 'string' ? metadata.tierText : '',
      });
      return true;
    }

    for (const record of Array.isArray(initialRecords) ? initialRecords : []) {
      if (!record || typeof record !== 'object') continue;
      put(record.handle, record, record.hiddenAt);
    }

    function list() {
      return [...records.values()]
        .sort((left, right) => right.hiddenAt - left.hiddenAt)
        .slice(0, maxEntries);
    }

    function trim() {
      const kept = new Set(list().map((record) => record.handle));
      for (const handle of records.keys()) {
        if (!kept.has(handle)) records.delete(handle);
      }
    }

    return {
      has(handle) {
        return records.has(normalizeHandle(handle));
      },
      hide(handle, metadata) {
        const changed = put(handle, metadata);
        trim();
        return changed;
      },
      restore(handle) {
        return records.delete(normalizeHandle(handle));
      },
      list,
    };
  }

  function normalizeFilterDocument(value) {
    const items = {};
    const rows = value?.schema === 1 && value.items && typeof value.items === 'object'
      ? Object.values(value.items)
      : [];
    for (const row of rows) {
      if (
        !row ||
        !['handle', 'keyword'].includes(row.kind) ||
        typeof row.deleted !== 'boolean' ||
        !Number.isSafeInteger(row.updatedAt) ||
        row.updatedAt <= 0 ||
        typeof row.source !== 'string' ||
        !row.source
      ) {
        continue;
      }
      if (row.kind === 'handle') {
        const key = normalizeHandle(row.key);
        if (!HANDLE_RE.test(key)) continue;
        const record = row.deleted ? null : createHiddenRegistry([row.value]).list()[0];
        if (!row.deleted && (!record || record.handle !== key)) continue;
        items['handle:' + key] = {
          deleted: row.deleted,
          key,
          kind: 'handle',
          source: row.source,
          updatedAt: row.updatedAt,
          value: record,
        };
        continue;
      }
      const keyword = row.deleted ? '' : normalizeKeyword(row.value);
      const key = normalizeMatchText(row.key || keyword);
      if (!key || (!row.deleted && !keyword)) continue;
      items['keyword:' + key] = {
        deleted: row.deleted,
        key,
        kind: 'keyword',
        order: Number.isSafeInteger(row.order) && row.order >= 0 ? row.order : 0,
        source: row.source,
        updatedAt: row.updatedAt,
        value: keyword || null,
      };
    }
    return { items, schema: 1 };
  }

  function filterItems(filters) {
    const items = new Map();
    normalizeKeywords(filters?.blockedKeywords).forEach((keyword, order) => {
      const key = normalizeMatchText(keyword);
      items.set('keyword:' + key, {
        key,
        kind: 'keyword',
        order,
        value: keyword,
      });
    });
    for (const record of createHiddenRegistry(filters?.hiddenRecords).list()) {
      items.set('handle:' + record.handle, {
        key: record.handle,
        kind: 'handle',
        value: record,
      });
    }
    return items;
  }

  function sameFilterItem(event, item) {
    if (!event || event.deleted || event.kind !== item.kind || event.key !== item.key) return false;
    if (item.kind === 'keyword') {
      return event.value === item.value && event.order === item.order;
    }
    return JSON.stringify(event.value) === JSON.stringify(item.value);
  }

  function reconcileFilterDocument(documentValue, filters, options = {}) {
    const document = normalizeFilterDocument(documentValue);
    const desired = filterItems(filters);
    const source = String(options.deviceId || '').trim();
    if (!source) throw new Error('deviceId is required');
    const latest = Math.max(0, ...Object.values(document.items).map((item) => item.updatedAt));
    let updatedAt = Math.max(Number((options.now || Date.now)()) || 0, latest + 1);
    const items = { ...document.items };

    for (const [id, item] of desired) {
      const existing = items[id];
      if (sameFilterItem(existing, item)) continue;
      items[id] = {
        deleted: false,
        ...item,
        source,
        updatedAt: updatedAt++,
      };
    }
    for (const [id, existing] of Object.entries(items)) {
      if (desired.has(id) || existing.deleted) continue;
      items[id] = {
        deleted: true,
        key: existing.key,
        kind: existing.kind,
        order: existing.order || 0,
        source,
        updatedAt: updatedAt++,
        value: null,
      };
    }
    return { items, schema: 1 };
  }

  function mergeFilterDocuments(leftValue, rightValue) {
    const left = normalizeFilterDocument(leftValue);
    const right = normalizeFilterDocument(rightValue);
    const items = { ...left.items };
    for (const [id, candidate] of Object.entries(right.items)) {
      const current = items[id];
      if (
        !current ||
        candidate.updatedAt > current.updatedAt ||
        (candidate.updatedAt === current.updatedAt && candidate.source > current.source)
      ) {
        items[id] = candidate;
      }
    }
    return { items, schema: 1 };
  }

  function materializeFilterDocument(value) {
    const document = normalizeFilterDocument(value);
    const keywords = [];
    const hiddenRecords = [];
    for (const event of Object.values(document.items)) {
      if (event.deleted) continue;
      if (event.kind === 'keyword') keywords.push(event);
      else if (event.value) hiddenRecords.push(event.value);
    }
    keywords.sort((left, right) => left.order - right.order || left.updatedAt - right.updatedAt);
    hiddenRecords.sort((left, right) => right.hiddenAt - left.hiddenAt);
    return {
      blockedKeywords: keywords.map((event) => event.value),
      hiddenRecords,
    };
  }

  function serializeFilterDocument(value) {
    const document = normalizeFilterDocument(value);
    const items = {};
    for (const key of Object.keys(document.items).sort()) items[key] = document.items[key];
    return JSON.stringify({ items, schema: 1 });
  }

  function createFilterSynchronizer(options) {
    const requestJson = options.requestJson;
    const endpoint = String(options.endpoint || '').replace(/\/+$/, '');
    if (!endpoint || typeof requestJson !== 'function') {
      throw new Error('filter synchronizer requires endpoint and requestJson');
    }

    async function sync(localState) {
      const token = String(localState?.token || '').trim();
      if (token.length < 20) throw new Error('同步密钥格式不正确。');
      const fetched = await requestJson({
        headers: { Accept: 'application/json' },
        method: 'GET',
        url: endpoint + '/v1/snapshot',
      });
      if (fetched?.status !== 200) {
        throw new Error(fetched?.body?.error?.message || '无法读取同步列表。');
      }

      let revision = Number(fetched.body?.revision) || 0;
      let document = mergeFilterDocuments(localState?.document, fetched.body?.document);
      let remote = normalizeFilterDocument(fetched.body?.document);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (serializeFilterDocument(document) === serializeFilterDocument(remote)) {
          return { document, revision };
        }
        const response = await requestJson({
          body: { baseRevision: revision, document },
          headers: {
            Accept: 'application/json',
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json',
          },
          method: 'POST',
          url: endpoint + '/v1/snapshot',
        });
        if (response?.status >= 200 && response.status < 300) {
          return { document, revision: Number(response.body?.revision) || revision + 1 };
        }
        if (response?.status !== 409) {
          throw new Error(response?.body?.error?.message || '同步列表写入失败。');
        }
        revision = Number(response.body?.revision) || revision;
        remote = normalizeFilterDocument(response.body?.document);
        document = mergeFilterDocuments(document, remote);
      }
      throw new Error('同步冲突次数过多，请稍后重试。');
    }

    return { sync };
  }

  function normalizeFilterSyncState(value) {
    const revision = Number(value?.revision);
    const lastSyncAt = Number(value?.lastSyncAt);
    const deviceId = SYNC_SOURCE_RE.test(value?.deviceId || '') ? value.deviceId : '';
    const token = typeof value?.token === 'string' ? value.token.trim().slice(0, 256) : '';
    return {
      deviceId,
      document: normalizeFilterDocument(value?.document),
      lastSyncAt: Number.isFinite(lastSyncAt) && lastSyncAt > 0 ? lastSyncAt : 0,
      revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
      schema: 1,
      token,
    };
  }

  const core = {
    claimRuntimeMount,
    collectMutationScanItems,
    createFilterSynchronizer,
    createHiddenRegistry,
    createJsonRequestAdapter,
    errorMessage,
    extractHandleFromHref,
    findAvatarTrigger,
    findBlockedKeyword,
    findBlockedKeywordInContent,
    getKeywordSelectionCandidate,
    materializeFilterDocument,
    mergeFilterDocuments,
    normalizeFilterDocument,
    normalizeFilterSyncState,
    normalizeSettings,
    normalizeHandle,
    normalizeKeywords,
    reconcileFilterDocument,
    STORAGE_KEYS,
    normalizeMxgaPosition,
    getMxgaDock,
    removeRetiredListCache,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = core;
    return;
  }

  const runtimeRoot = global.document?.documentElement;
  if (!claimRuntimeMount(runtimeRoot)) return;

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    blockedKeywords: Object.freeze([]),
  });
  function createFilterDeviceId() {
    const bytes = new Uint8Array(10);
    global.crypto.getRandomValues(bytes);
    return 'device-' + [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  }

  function normalizeSettings(raw) {
    return {
      enabled: raw?.enabled !== false,
      blockedKeywords: normalizeKeywords(raw?.blockedKeywords),
    };
  }

  function createStorageAdapter(gm) {
    if (!gm || typeof gm.getValue !== 'function' || typeof gm.setValue !== 'function') {
      throw new Error('当前 userscript 管理器没有提供 GM 存储接口');
    }
    return {
      async get(key, fallback) {
        try {
          const value = await gm.getValue(key, fallback);
          return value === undefined ? fallback : value;
        } catch (_error) {
          return fallback;
        }
      },
      async set(key, value) {
        await gm.setValue(key, value);
      },
      async delete(key) {
        if (typeof gm.deleteValue === 'function') await gm.deleteValue(key);
      },
    };
  }

  function byteLength(text) {
    if (typeof Blob === 'function') return new Blob([text]).size;
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).byteLength;
    return String(text).length;
  }

  function createJsonRequestAdapter(gm) {
    if (!gm || typeof gm.xmlHttpRequest !== 'function') {
      throw new Error('当前 userscript 管理器没有提供 GM.xmlHttpRequest');
    }
    return async function requestJson(options) {
      const method = String(options?.method || 'GET').toUpperCase();
      const headers = { ...(options?.headers || {}) };
      const request = {
        method,
        url: options?.url,
        headers,
        responseType: 'text',
        timeout: 30000,
      };
      if (options?.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        request.data = JSON.stringify(options.body);
      }
      let response;
      try {
        response = await gm.xmlHttpRequest(request);
      } catch (error) {
        throw new Error(errorMessage(error, '无法连接多端同步服务。'));
      }
      const text = typeof response?.responseText === 'string'
        ? response.responseText
        : typeof response?.response === 'string'
          ? response.response
          : '';
      if (byteLength(text) > 1024 * 1024) throw new Error('同步响应超过大小限制。');
      let body = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch (_error) {
          throw new Error('同步服务返回了无法解析的响应。');
        }
      }
      return { body, status: Number(response?.status) || 0 };
    };
  }

  function openExternal(gm, url) {
    try {
      if (typeof gm?.openInTab === 'function') {
        void Promise.resolve(gm.openInTab(url, false)).catch(() => {
          global.open(url, '_blank', 'noopener,noreferrer');
        });
        return;
      }
    } catch (_error) {
      // Fall through to window.open.
    }
    global.open(url, '_blank', 'noopener,noreferrer');
  }

  function handleFromNameBlock(nameBlock) {
    if (!(nameBlock instanceof Element)) return null;
    for (const anchor of nameBlock.querySelectorAll('a[href]')) {
      const handle = extractHandleFromHref(anchor.getAttribute('href') || '');
      if (handle) return handle;
    }
    return null;
  }

  function cellForContent(item) {
    const cell = item.closest('[data-testid="cellInnerDiv"]') || item;
    return cell instanceof HTMLElement ? cell : null;
  }

  function hideContentLocally(item, handle) {
    const cell = cellForContent(item);
    const normalized = normalizeHandle(handle);
    if (!cell || !normalized) return;
    if (
      cell.dataset.mxgaUserscriptHidden === '1' &&
      cell.dataset.mxgaUserscriptHandle === normalized &&
      cell.style.getPropertyValue('display') === 'none'
    ) {
      return;
    }
    if (cell.dataset.mxgaUserscriptHidden !== '1') {
      cell.dataset.mxgaUserscriptPreviousDisplay = cell.style.getPropertyValue('display');
      cell.dataset.mxgaUserscriptPreviousDisplayPriority = cell.style.getPropertyPriority('display');
    }
    cell.dataset.mxgaUserscriptHidden = '1';
    cell.dataset.mxgaUserscriptHandle = normalized;
    cell.style.setProperty('display', 'none', 'important');
  }

  function revealCell(cell) {
    if (!(cell instanceof HTMLElement) || cell.dataset.mxgaUserscriptHidden !== '1') return;
    const previousDisplay = cell.dataset.mxgaUserscriptPreviousDisplay || '';
    const previousPriority = cell.dataset.mxgaUserscriptPreviousDisplayPriority || '';
    delete cell.dataset.mxgaUserscriptHidden;
    delete cell.dataset.mxgaUserscriptHandle;
    delete cell.dataset.mxgaUserscriptPreviousDisplay;
    delete cell.dataset.mxgaUserscriptPreviousDisplayPriority;
    if (previousDisplay) cell.style.setProperty('display', previousDisplay, previousPriority);
    else cell.style.removeProperty('display');
  }

  function revealAllUserscriptHidden() {
    for (const cell of document.querySelectorAll('[data-mxga-userscript-hidden="1"]')) {
      revealCell(cell);
    }
  }

  function createScanner(state, ui) {
    let scheduled = false;
    let fullScanRequested = true;
    const pendingItems = new Set();

    function processContentItem(item) {
      const nameBlock = item.querySelector('[data-testid="User-Name"]');
      const handle = handleFromNameBlock(nameBlock);
      if (!nameBlock || !handle) return;
      const normalized = normalizeHandle(handle);
      const cell = cellForContent(item);
      if (
        state.hidden.has(normalized) ||
        findBlockedKeywordInContent(item, state.settings.blockedKeywords)
      ) {
        hideContentLocally(item, normalized);
        return;
      }
      revealCell(cell);
      const avatarTrigger = findAvatarTrigger(item, normalized);
      if (avatarTrigger) ui.mountAvatarTrigger(avatarTrigger, normalized);

    }

    function scan() {
      scheduled = false;
      if (!state.settings.enabled) {
        pendingItems.clear();
        fullScanRequested = false;
        revealAllUserscriptHidden();
        return;
      }
      const items = fullScanRequested
        ? document.querySelectorAll(ACCOUNT_CONTENT_SELECTOR)
        : [...pendingItems];
      fullScanRequested = false;
      pendingItems.clear();
      for (const item of items) {
        if (!item?.isConnected) continue;
        processContentItem(item);
      }
    }

    function schedule(records) {
      if (Array.isArray(records)) {
        for (const item of collectMutationScanItems(records)) pendingItems.add(item);
      } else {
        fullScanRequested = true;
      }
      if (scheduled) return;
      scheduled = true;
      global.setTimeout(scan, 80);
    }

    function hideVisible(handle) {
      const normalized = normalizeHandle(handle);
      for (const item of document.querySelectorAll(ACCOUNT_CONTENT_SELECTOR)) {
        const nameBlock = item.querySelector('[data-testid="User-Name"]');
        if (normalizeHandle(handleFromNameBlock(nameBlock)) !== normalized) continue;
        hideContentLocally(item, normalized);
      }
    }

    function restoreVisible(handle) {
      const normalized = normalizeHandle(handle);
      for (const cell of document.querySelectorAll('[data-mxga-userscript-hidden="1"]')) {
        if (cell.dataset.mxgaUserscriptHandle === normalized) revealCell(cell);
      }
      schedule();
    }

    return {
      hideVisible,
      restoreVisible,
      scan,
      schedule,
    };
  }

  // Delete retired caches by key without loading or parsing their contents.
  async function removeRetiredListCache(storage) {
    for (const key of ['mxga:list-cache:v2', 'mxga:list-meta:v1', 'mxga:list-raw:v1',
      'mxga:whitelist:v1', 'mxga:sync-lock:v1']) await storage.delete(key);
  }

  async function bootstrap() {
    const gm = typeof GM === 'object' && GM ? GM : global.GM;
    const storage = createStorageAdapter(gm);
    void removeRetiredListCache(storage).catch((error) => {
      console.warn('[MXGA] 旧缓存清理失败，下次启动重试', errorMessage(error));
    });
    const requestJson = createJsonRequestAdapter(gm);
    const filterSynchronizer = createFilterSynchronizer({
      endpoint: FILTER_SYNC_ENDPOINT,
      requestJson,
    });
    const [storedSettings, storedHidden, storedPosition, storedFilterSync] = await Promise.all([
      storage.get(STORAGE_KEYS.settings, DEFAULT_SETTINGS),
      storage.get(STORAGE_KEYS.hidden, []),
      storage.get(STORAGE_KEYS.position, null),
      storage.get(STORAGE_KEYS.filterSync, null),
    ]);

    const filterSync = normalizeFilterSyncState(storedFilterSync);
    if (!filterSync.deviceId) filterSync.deviceId = createFilterDeviceId();

    const state = {
      settings: normalizeSettings(storedSettings),
      hidden: createHiddenRegistry(storedHidden),
      error: null,
      filterSync,
      filterSyncing: false,
      filterSyncError: '',
    };
    if (state.filterSync.token) {
      state.filterSync.document = reconcileFilterDocument(
        state.filterSync.document,
        {
          blockedKeywords: state.settings.blockedKeywords,
          hiddenRecords: state.hidden.list(),
        },
        { deviceId: state.filterSync.deviceId },
      );
    }

    let scanner;
    let ui;
    let filterSyncPromise = null;
    let filterSyncTimer = 0;
    let filterSyncQueued = false;
    function render() {
      ui.render({
        settings: state.settings,
        hiddenRecords: state.hidden.list(),
        filterSync: {
          ...state.filterSync,
          error: state.filterSyncError,
          syncing: state.filterSyncing,
        },
        error: state.error,
      });
    }

    async function persistHidden() {
      try {
        await storage.set(STORAGE_KEYS.hidden, state.hidden.list());
        return true;
      } catch (error) {
        state.error = '隐藏记录保存失败：' + errorMessage(error);
        render();
        return false;
      }
    }

    async function restoreHandle(handle) {
      if (!state.hidden.restore(handle)) return;
      scanner.restoreVisible(handle);
      render();
      if (await persistHidden()) await recordFilterChange();
    }

    async function hideHandle(handle) {
      const presentation = { categoryText: '手动屏蔽', tierText: '' };
      if (!state.hidden.hide(handle, presentation)) return;
      if (state.settings.enabled) scanner.hideVisible(handle);
      ui.showUndo(handle);
      render();
      if (await persistHidden()) await recordFilterChange();
    }

    async function updateSettings(patch) {
      const previousKeywords = state.settings.blockedKeywords.join('\n');
      state.settings = normalizeSettings({ ...state.settings, ...patch });
      render();
      scanner.schedule();
      try {
        await storage.set(STORAGE_KEYS.settings, state.settings);
        state.error = null;
        if (state.settings.blockedKeywords.join('\n') !== previousKeywords) {
          await recordFilterChange();
        }
      } catch (error) {
        state.error = '设置保存失败：' + errorMessage(error);
        render();
        return false;
      }
      render();
      return true;
    }

    async function blockKeyword(keyword) {
      await updateSettings({
        blockedKeywords: [...state.settings.blockedKeywords, keyword],
      });
    }

    function currentFilters() {
      return {
        blockedKeywords: state.settings.blockedKeywords,
        hiddenRecords: state.hidden.list(),
      };
    }

    async function persistFilterSync() {
      await storage.set(STORAGE_KEYS.filterSync, normalizeFilterSyncState(state.filterSync));
    }

    async function recordFilterChange() {
      if (!state.filterSync.token) return;
      state.filterSync.document = reconcileFilterDocument(
        state.filterSync.document,
        currentFilters(),
        { deviceId: state.filterSync.deviceId },
      );
      try {
        await persistFilterSync();
        scheduleFilterSync();
      } catch (error) {
        state.filterSyncError = '同步状态保存失败：' + errorMessage(error);
        render();
      }
    }

    async function performFilterSync() {
      if (!state.filterSync.token) return;
      state.filterSyncing = true;
      state.filterSyncError = '';
      render();
      try {
        state.filterSync.document = reconcileFilterDocument(
          state.filterSync.document,
          currentFilters(),
          { deviceId: state.filterSync.deviceId },
        );
        await persistFilterSync();
        const result = await filterSynchronizer.sync(state.filterSync);
        const document = mergeFilterDocuments(result.document, state.filterSync.document);
        const needsAnotherPush =
          serializeFilterDocument(document) !== serializeFilterDocument(result.document);
        const filters = materializeFilterDocument(document);
        state.filterSync.document = document;
        state.filterSync.revision = result.revision;
        state.filterSync.lastSyncAt = Date.now();
        state.settings = normalizeSettings({
          ...state.settings,
          blockedKeywords: filters.blockedKeywords,
        });
        state.hidden = createHiddenRegistry(filters.hiddenRecords);
        await Promise.all([
          storage.set(STORAGE_KEYS.settings, state.settings),
          storage.set(STORAGE_KEYS.hidden, state.hidden.list()),
          persistFilterSync(),
        ]);
        scanner.schedule();
        if (needsAnotherPush) filterSyncQueued = true;
      } catch (error) {
        state.filterSyncError = errorMessage(error, '多端同步失败');
      } finally {
        state.filterSyncing = false;
        render();
      }
    }

    function syncFiltersNow() {
      if (!state.filterSync.token) return Promise.resolve();
      if (filterSyncPromise) {
        filterSyncQueued = true;
        return filterSyncPromise;
      }
      filterSyncPromise = performFilterSync().finally(() => {
        filterSyncPromise = null;
        if (filterSyncQueued) {
          filterSyncQueued = false;
          scheduleFilterSync(80);
        }
      });
      return filterSyncPromise;
    }

    function scheduleFilterSync(delay = 700) {
      global.clearTimeout(filterSyncTimer);
      filterSyncTimer = global.setTimeout(() => {
        void syncFiltersNow();
      }, delay);
    }

    async function configureFilterSync(tokenValue) {
      const token = String(tokenValue || '').trim();
      if (token && token.length < 20) {
        state.filterSyncError = '同步密钥格式不正确。';
        render();
        return;
      }
      try {
        global.clearTimeout(filterSyncTimer);
        state.filterSync.token = token;
        state.filterSyncError = '';
        if (!token) {
          state.filterSync.revision = 0;
          state.filterSync.lastSyncAt = 0;
          await persistFilterSync();
          render();
          return;
        }
        state.filterSync.document = reconcileFilterDocument(
          state.filterSync.document,
          currentFilters(),
          { deviceId: state.filterSync.deviceId },
        );
        await persistFilterSync();
        render();
        await syncFiltersNow();
      } catch (error) {
        state.filterSyncError = errorMessage(error, '同步配置保存失败');
        render();
      }
    }

    async function reloadStoredState() {
      const [settings, hiddenRecords] = await Promise.all([
        storage.get(STORAGE_KEYS.settings, state.settings),
        storage.get(STORAGE_KEYS.hidden, state.hidden.list()),
      ]);
      state.settings = normalizeSettings(settings);
      state.hidden = createHiddenRegistry(hiddenRecords);
      render();
      scanner.schedule();
    }

    ui = createMxgaUi(global,
      {
        onConfigureCobalt: () => createMxgaCobalt(global).openCobaltDownload(),
        onEnabledChange: (enabled) => {
          void updateSettings({ enabled });
        },
        onBlockedKeywordsChange: (blockedKeywords) => {
          return updateSettings({ blockedKeywords });
        },
        onBlockKeyword: (keyword) => {
          void blockKeyword(keyword);
        },
        onFilterSync: () => {
          void syncFiltersNow();
        },
        onFilterSyncTokenChange: (token) => {
          void configureFilterSync(token);
        },
        onHide: hideHandle,
        onOpenUrl: (url) => openExternal(gm, url),
        onRestore: (handle) => {
          void restoreHandle(handle);
        },
        onPositionChange: (position) => storage.set(STORAGE_KEYS.position, position),
      },
      storedPosition,
    );
    scanner = createScanner(state, ui);
    render();
    scanner.scan();

    let selectionTimer = 0;
    function captureKeywordSelection() {
      if (!state.settings.enabled) {
        ui.hideSelectionToolbar();
        return;
      }
      ui.showSelectionToolbar(getKeywordSelectionCandidate(global.getSelection()));
    }
    function scheduleSelectionCapture(delay = 0) {
      global.clearTimeout(selectionTimer);
      selectionTimer = global.setTimeout(captureKeywordSelection, delay);
    }

    const observer = new MutationObserver(scanner.schedule);
    observer.observe(document.body || document.documentElement, {
      attributes: true,
      attributeFilter: ['href'],
      childList: true,
      subtree: true,
    });
    global.addEventListener('popstate', scanner.schedule, { passive: true });
    global.addEventListener('pageshow', scanner.schedule, { passive: true });
    global.addEventListener('scroll', ui.hideSelectionToolbar, { capture: true, passive: true });
    document.addEventListener('selectionchange', () => scheduleSelectionCapture(80));
    document.addEventListener('mouseup', (event) => {
      if (event.composedPath().includes(ui.host)) return;
      scheduleSelectionCapture();
    });
    document.addEventListener('keyup', (event) => {
      if (event.key === 'Escape') {
        ui.hideSelectionToolbar();
        return;
      }
      if (event.shiftKey || event.key.startsWith('Arrow')) scheduleSelectionCapture();
    });
    document.addEventListener('pointerdown', (event) => {
      if (!event.composedPath().includes(ui.host)) ui.hideSelectionToolbar();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      void reloadStoredState().then(syncFiltersNow).catch((error) => {
        state.error = errorMessage(error, '个人规则恢复失败');
        render();
      });
    });
    global.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      scanner.schedule();
      if (Date.now() - state.filterSync.lastSyncAt >= 30000) void syncFiltersNow();
    }, 15000);

    void syncFiltersNow();
  }

  void bootstrap().catch((error) => {
    runtimeRoot?.removeAttribute?.(RUNTIME_MOUNT_ATTRIBUTE);
    console.error('[MXGA Userscript] startup failed', error);
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);

// SPDX-License-Identifier: AGPL-3.0-or-later
// Desktop panel for MXGA. Bundled with the userscript entry; no external UI dependencies.
function normalizeMxgaPosition(value) {
  return {
    side: value?.side === 'left' ? 'left' : 'right',
    ratio: Number.isFinite(value?.ratio) ? Math.min(1, Math.max(0, value.ratio)) : 0.85,
  };
}

function getMxgaDock(position, viewport, control) {
  const { side, ratio } = normalizeMxgaPosition(position);
  const margin = 12;
  return {
    left: side === 'left' ? margin : Math.max(margin, viewport.width - control.width - margin),
    top: margin + ratio * Math.max(0, viewport.height - control.height - margin * 2),
  };
}

function createMxgaUi(global, callbacks, initialPosition) {
  const document = global.document;
  const host = document.createElement('div');
  host.id = 'mxga-userscript-root';
  host.style.cssText = 'all:initial;font:14px/1.5 system-ui,-apple-system,sans-serif;color:var(--text);color-scheme:light dark';
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host{color-scheme:light dark;--bg:#fff;--soft:#f3f5f7;--text:#17202a;--muted:#657181;--line:#dce2e8;--accent:#1769aa;--danger:#c23242;font:14px/1.5 system-ui,-apple-system,sans-serif;color:var(--text)}
      @media(prefers-color-scheme:dark){:host{--bg:#192027;--soft:#232d36;--text:#e8edf2;--muted:#a0adba;--line:#35414d;--accent:#8cc8f4;--danger:#ff8994}}
      *{box-sizing:border-box} [hidden]{display:none!important}
      button,input,textarea{font:inherit} button{cursor:pointer;color:inherit} button:disabled{opacity:.5;cursor:default}
      button:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
      button{transition:background .15s} button:hover:not(:disabled){background:var(--line)}
      .control{position:fixed;z-index:2147483003;display:flex;gap:8px;align-items:center;height:40px;padding:0 14px;border:1px solid var(--line);border-radius:12px;background:var(--bg);box-shadow:0 4px 16px #14253522;user-select:none;touch-action:none;cursor:grab;font-weight:650}
      .control.dragging{cursor:grabbing}.dot{width:7px;height:7px;border-radius:50%;background:var(--accent)}.dot.paused{background:var(--muted)}
      .backdrop{position:fixed;inset:0;z-index:2147483001;background:transparent}
      .panel{position:fixed;z-index:2147483002;width:min(400px,calc(100vw - 24px));max-height:min(720px,calc(100vh - 24px));display:flex;flex-direction:column;border:1px solid var(--line);border-radius:16px;background:var(--bg);box-shadow:0 16px 48px #14253533;overflow:hidden}
      header{display:flex;align-items:center;gap:12px;padding:18px 20px 12px}h2{font-size:18px;letter-spacing:-.4px;margin:0;flex:1}h3{font-size:14px;margin:0}p{margin:8px 0 16px}
      .enabled{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--muted)}input[type=checkbox]{accent-color:var(--accent)}
      .icon-button{border:0;background:transparent;border-radius:6px;font-size:18px;width:28px;height:28px}
      .tabs{display:flex;padding:0 20px;border-bottom:1px solid var(--line);gap:20px}.tab{border:0;border-bottom:2px solid transparent;background:transparent;padding:10px 0;color:var(--muted)}.tab[aria-selected=true]{color:var(--accent);border-bottom-color:var(--accent);font-weight:650}
      .body{overflow:auto;overscroll-behavior:contain;padding:20px;min-height:0}.help,.privacy,.empty{font-size:12px;color:var(--muted)}
      textarea,input:not([type=checkbox]){width:100%;border:1px solid var(--line);background:var(--soft);color:var(--text);border-radius:8px;padding:10px 12px}
      .keyword-editor{min-height:230px;resize:vertical;line-height:1.65}.actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px}.button{border:1px solid var(--line);background:var(--soft);border-radius:8px;padding:7px 12px;font-size:12px}.primary{background:var(--accent);color:var(--bg);border-color:transparent}.primary:hover:not(:disabled){background:var(--accent);filter:brightness(.93)}
      .save-state{font-size:12px;color:var(--muted);flex:1}.notice{font-size:12px;color:var(--danger);margin-bottom:12px;overflow-wrap:anywhere}
      .section-heading{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}.count{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
      .add-account{display:flex;gap:8px;margin:12px 0}.add-account input{min-width:0}.add-account button{flex:none}
      .hidden-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 0;border-bottom:1px solid var(--line)}.hidden-account strong{font-size:13px}.hidden-account small{display:block;color:var(--muted);font-size:11px}.restore{background:none}.pagination{justify-content:space-between}.pagination span{font-size:12px;color:var(--muted)}
      details{border-bottom:1px solid var(--line);padding:12px 0}summary{cursor:pointer;font-weight:600;font-size:13px}.sync-status{color:var(--muted);font-size:12px;margin:8px 0}.sync-error{color:var(--danger);font-size:12px;overflow-wrap:anywhere}
      .settings-row{padding:16px 0;border-bottom:1px solid var(--line)}.settings-row .help{margin:6px 0 10px}.links{display:flex;gap:12px;margin-top:20px;font-size:11px;color:var(--muted)}.link-button{border:0;background:none;color:var(--accent);padding:0;font-size:11px}
      .avatar-block{position:fixed;z-index:2147483005;display:grid;place-items:center;width:26px;height:26px;padding:0;border:1px solid var(--danger);border-radius:50%;background:var(--bg);color:var(--danger)}.avatar-block svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8}
      .selection-toolbar{position:fixed;z-index:2147483005;transform:translateX(-50%)}.selection-toolbar button{background:var(--bg);color:var(--danger);box-shadow:0 4px 14px #14253522}
      .toast{position:fixed;z-index:2147483005;bottom:24px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:16px;border:1px solid var(--line);padding:10px 16px;border-radius:10px;background:var(--bg);box-shadow:0 6px 24px #14253533;font-size:13px}.toast button{border:0;background:none;color:var(--accent)}
      @media(prefers-reduced-motion:reduce){button{transition:none}}
    </style>
    <button class="control" type="button" data-action="toggle-panel" aria-expanded="false" aria-controls="mxga-panel" title="点击打开 · 拖动可调整位置"><span class="dot"></span>MXGA</button>
    <div class="backdrop" hidden></div>
    <section class="panel" id="mxga-panel" role="dialog" aria-modal="true" aria-label="MXGA 设置" hidden>
      <header><h2>MXGA</h2><label class="enabled"><input type="checkbox" data-role="enabled">启用过滤</label><button class="icon-button" data-action="close-panel" aria-label="关闭">×</button></header>
      <nav class="tabs" role="tablist" aria-label="设置分类">
        <button class="tab" id="mxga-tab-keywords" role="tab" aria-controls="mxga-keywords" aria-selected="true" data-tab="keywords">关键词</button>
        <button class="tab" id="mxga-tab-accounts" role="tab" aria-controls="mxga-accounts" aria-selected="false" tabindex="-1" data-tab="accounts">屏蔽账号</button>
        <button class="tab" id="mxga-tab-settings" role="tab" aria-controls="mxga-settings" aria-selected="false" tabindex="-1" data-tab="settings">设置</button>
      </nav>
      <div class="body">
        <div class="notice" role="status" aria-live="polite" hidden></div>
        <section id="mxga-keywords" role="tabpanel" aria-labelledby="mxga-tab-keywords" data-page="keywords">
          <div class="section-heading"><h3>关键词屏蔽</h3><span class="count" data-role="keyword-count"></span></div>
          <p class="help">每行一个词或短语。仅匹配推文正文，忽略大小写与连续空白；清空并保存即可停用。</p>
          <textarea class="keyword-editor" data-role="blocked-keywords" aria-label="关键词屏蔽列表" placeholder="每行一个关键词或完整短语" spellcheck="false"></textarea>
          <div class="actions"><span class="save-state" role="status" data-role="save-state">已保存</span><button class="button primary" data-action="save-keywords">保存并应用</button></div>
          <p class="help">也可以在推文中划选文字，点击“屏蔽”直接添加。</p>
        </section>
        <section id="mxga-accounts" role="tabpanel" aria-labelledby="mxga-tab-accounts" data-page="accounts" hidden>
          <div class="section-heading"><h3>屏蔽账号</h3><span class="count" data-role="hidden-count"></span></div>
          <p class="help">隐藏这些账号的内容，不操作 X 的拉黑或静音。也可悬停作者头像快速屏蔽。</p>
          <input type="search" data-role="account-search" aria-label="搜索屏蔽账号" placeholder="搜索已屏蔽账号">
          <form class="add-account"><input data-role="account-input" aria-label="添加屏蔽账号" placeholder="@账号" maxlength="16" required><button class="button" type="submit">添加</button></form>
          <div class="hidden-list" data-role="hidden-list"></div>
          <div class="actions pagination"><button class="button" data-action="previous-page">上一页</button><span data-role="page-count"></span><button class="button" data-action="next-page">下一页</button></div>
        </section>
        <section id="mxga-settings" role="tabpanel" aria-labelledby="mxga-tab-settings" data-page="settings" hidden>
          <details><summary>个人规则同步</summary><div class="sync-status" data-role="filter-sync-status"></div>
            <p class="help">屏蔽词和账号列表公开可读；同步密钥只用于防止他人写入。未连接时仅保存在本机。</p>
            <input type="password" data-role="filter-sync-token" aria-label="多端同步密钥" placeholder="粘贴同步密钥" autocomplete="off" spellcheck="false">
            <div class="sync-error" role="status" data-role="filter-sync-error"></div>
            <div class="actions"><button class="button" data-action="save-filter-sync">保存并同步</button><button class="button" data-action="sync-filters" hidden>立即同步</button><button class="button" data-action="disconnect-filter-sync" hidden>断开</button></div>
          </details>
          <div class="settings-row"><h3>视频下载</h3><p class="help">默认打开 cobalt 网页，也可连接自建 API 自动解析。</p><button class="button" data-action="configure-cobalt">视频下载设置</button></div>
          <div class="settings-row"><h3>浮窗位置</h3><p class="help">拖动 MXGA 按钮，松手后吸附到左右边缘。</p><button class="button" data-action="reset-position">重置位置</button></div>
          <p class="privacy">启用过滤只影响页面隐藏；分享图和下载始终可用。同步不包含浏览页面、命中结果或下载服务凭据。</p>
          <div class="links"><span>MXGA 0.7.0</span><button class="link-button" data-action="open-source">源码 ↗</button><button class="link-button" data-action="open-upstream">原始项目 ↗</button></div>
        </section>
      </div>
    </section>
    <button class="avatar-block" type="button" data-role="avatar-block" data-action="block-avatar" aria-label="屏蔽用户" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle><path d="M6.5 6.5l11 11"></path></svg></button>
    <section class="selection-toolbar" role="toolbar" aria-label="选中文本操作" hidden><button class="button" data-action="block-selection">屏蔽</button></section>
    <div class="toast" hidden role="status" aria-live="polite"><span></span><button data-action="undo">撤销</button></div>`;
  const role = (name) => root.querySelector(`[data-role="${name}"]`);
  const action = (name) => root.querySelector(`[data-action="${name}"]`);
  const elements = {
    control: root.querySelector('.control'), panel: root.querySelector('.panel'),
    backdrop: root.querySelector('.backdrop'), notice: root.querySelector('.notice'),
    enabled: role('enabled'), blockedKeywords: role('blocked-keywords'),
    filterSyncToken: role('filter-sync-token'), avatarBlock: role('avatar-block'),
    selectionToolbar: root.querySelector('.selection-toolbar'), toast: root.querySelector('.toast'),
  };
  let view = null;
  let position = normalizeMxgaPosition(initialPosition);
  let keywordDirty = false;
  let tokenDirty = false;
  let saving = false;
  let page = 0;
  let selectedTab = 'keywords';
  let drag = null;
  let suppressClick = false;
  let avatarTimer = 0;
  let currentAvatar = null;
  let currentSelectionKeyword = '';
  let toastTimer = 0;
  let undoHandle = '';
  const avatarContexts = new WeakMap();
  const dateLabel = (value) => value ? new Date(value).toLocaleString() : '尚未同步';
  function reportError(message) {
    elements.notice.textContent = message;
    elements.notice.hidden = !message;
  }
  function placePanel() {
    if (elements.panel.hidden) return;
    const rect = elements.control.getBoundingClientRect();
    const panel = elements.panel.getBoundingClientRect();
    const x = position.side === 'left' ? rect.right + 8 : rect.left - panel.width - 8;
    elements.panel.style.left = Math.max(12, Math.min(x, global.innerWidth - panel.width - 12)) + 'px';
    elements.panel.style.top = Math.max(12, Math.min(rect.top, global.innerHeight - panel.height - 12)) + 'px';
  }
  function placeControl() {
    const point = getMxgaDock(position, { width: global.innerWidth, height: global.innerHeight }, elements.control.getBoundingClientRect());
    elements.control.style.left = point.left + 'px';
    elements.control.style.top = point.top + 'px';
    placePanel();
  }
  async function savePosition() {
    try { await callbacks.onPositionChange(position); }
    catch (error) { reportError('浮窗位置保存失败：' + (error?.message || '请重试')); }
  }
  function setPanel(open) {
    elements.panel.hidden = !open;
    elements.backdrop.hidden = !open;
    elements.control.setAttribute('aria-expanded', String(open));
    if (open) {
      hideAvatarBlock(); hideSelectionToolbar(); placePanel();
      root.querySelector(`[data-tab="${selectedTab}"]`).focus();
    } else elements.control.focus({ preventScroll: true });
  }
  function selectTab(tab, focus = false) {
    selectedTab = tab;
    for (const button of root.querySelectorAll('[data-tab]')) {
      const selected = button.dataset.tab === tab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected && focus) button.focus();
    }
    for (const section of root.querySelectorAll('[data-page]')) section.hidden = section.dataset.page !== tab;
    placePanel();
  }
  root.querySelector('.tabs').addEventListener('keydown', (event) => {
    const tabs = ['keywords', 'accounts', 'settings'];
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (tabs.indexOf(selectedTab) + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
    selectTab(tabs[index], true);
  });
  document.addEventListener('keydown', (event) => {
    if (elements.panel.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setPanel(false); }
    if (event.key === 'Tab') {
      const focusable = [...elements.panel.querySelectorAll('button,input,textarea,summary')]
        .filter((el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (!elements.panel.contains(root.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && root.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && root.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }, true);
  elements.control.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    suppressClick = false;
    const rect = elements.control.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
    elements.control.setPointerCapture(event.pointerId);
  });
  elements.control.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    elements.control.classList.add('dragging');
    const rect = elements.control.getBoundingClientRect();
    elements.control.style.left = Math.max(12, Math.min(drag.left + dx, global.innerWidth - rect.width - 12)) + 'px';
    elements.control.style.top = Math.max(12, Math.min(drag.top + dy, global.innerHeight - rect.height - 12)) + 'px';
    placePanel();
  });
  function finishDrag(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const moved = drag.moved;
    drag = null;
    elements.control.classList.remove('dragging');
    if (moved) {
      suppressClick = true;
      const rect = elements.control.getBoundingClientRect();
      position = normalizeMxgaPosition({
        side: rect.left + rect.width / 2 < global.innerWidth / 2 ? 'left' : 'right',
        ratio: (rect.top - 12) / Math.max(1, global.innerHeight - rect.height - 24),
      });
      placeControl(); void savePosition();
    }
    if (elements.control.hasPointerCapture(event.pointerId)) elements.control.releasePointerCapture(event.pointerId);
  }
  elements.control.addEventListener('pointerup', finishDrag);
  elements.control.addEventListener('pointercancel', finishDrag);
  elements.control.addEventListener('lostpointercapture', finishDrag);
  global.addEventListener('resize', placeControl, { passive: true });
  new global.ResizeObserver(placePanel).observe(elements.panel);

  function renderAccounts() {
    const records = view?.hiddenRecords || [];
    const query = role('account-search').value.trim().replace(/^@/, '').toLowerCase();
    const filtered = records.filter((record) => record.handle.toLowerCase().includes(query));
    const pages = Math.max(1, Math.ceil(filtered.length / 20));
    page = Math.max(0, Math.min(page, pages - 1));
    role('hidden-count').textContent = records.length + ' 个';
    const list = role('hidden-list'); list.replaceChildren();
    if (!filtered.length) {
      const empty = document.createElement('p'); empty.className = 'empty';
      empty.textContent = query ? '没有匹配的账号。' : '还没有屏蔽账号。'; list.appendChild(empty);
    }
    for (const record of filtered.slice(page * 20, page * 20 + 20)) {
      const row = document.createElement('div'); row.className = 'hidden-row';
      const account = document.createElement('div'); account.className = 'hidden-account';
      const name = document.createElement('strong'); name.textContent = '@' + record.handle;
      const time = document.createElement('small'); time.textContent = dateLabel(record.hiddenAt);
      account.append(name, time);
      const restore = document.createElement('button'); restore.className = 'button restore';
      restore.dataset.action = 'restore'; restore.dataset.handle = record.handle; restore.textContent = '恢复';
      restore.setAttribute('aria-label', '恢复 @' + record.handle);
      row.append(account, restore); list.appendChild(row);
    }
    role('page-count').textContent = `${page + 1} / ${pages}`;
    action('previous-page').disabled = page === 0; action('next-page').disabled = page >= pages - 1;
    placePanel();
  }
  role('account-search').addEventListener('input', () => { page = 0; renderAccounts(); });
  root.querySelector('.add-account').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = role('account-input'); const handle = input.value.trim().replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) { input.setCustomValidity('请输入有效的 X 账号名'); input.reportValidity(); return; }
    await callbacks.onHide(handle); input.value = '';
  });
  role('account-input').addEventListener('input', (event) => event.target.setCustomValidity(''));
  elements.blockedKeywords.addEventListener('input', () => {
    keywordDirty = true; role('save-state').textContent = '未保存';
  });
  elements.filterSyncToken.addEventListener('input', () => { tokenDirty = true; });
  function render(next) {
    view = next;
    elements.enabled.checked = view.settings.enabled;
    root.querySelector('.dot').classList.toggle('paused', !view.settings.enabled);
    elements.control.setAttribute('aria-label', 'MXGA · ' + (view.settings.enabled ? '过滤已开启' : '过滤已暂停'));
    role('keyword-count').textContent = view.settings.blockedKeywords.length + ' 条';
    if (!keywordDirty) elements.blockedKeywords.value = view.settings.blockedKeywords.join('\n');
    const sync = view.filterSync;
    if (!tokenDirty) elements.filterSyncToken.value = sync.token || '';
    role('filter-sync-status').textContent = sync.syncing ? '同步中…' : sync.token ? '已连接 · ' + dateLabel(sync.lastSyncAt) : '未连接 · 仅本机';
    role('filter-sync-error').textContent = sync.error || '';
    action('save-filter-sync').disabled = sync.syncing;
    action('sync-filters').disabled = sync.syncing;
    action('disconnect-filter-sync').disabled = sync.syncing;
    action('sync-filters').hidden = !sync.token; action('disconnect-filter-sync').hidden = !sync.token;
    if (!view.settings.enabled) { hideAvatarBlock(); hideSelectionToolbar(); }
    reportError(view.error || ''); renderAccounts();
  }
  function hideAvatarBlock() {
    global.clearTimeout(avatarTimer); elements.avatarBlock.hidden = true; currentAvatar = null;
  }
  function mountAvatarTrigger(anchor, handle) {
    avatarContexts.set(anchor, { handle });
    if (anchor.hasAttribute('data-mxga-avatar-trigger')) return;
    anchor.setAttribute('data-mxga-avatar-trigger', '1');
    anchor.addEventListener('mouseenter', () => {
      if (!view?.settings.enabled) return;
      global.clearTimeout(avatarTimer); currentAvatar = avatarContexts.get(anchor);
      const rect = anchor.getBoundingClientRect();
      elements.avatarBlock.title = '屏蔽 @' + currentAvatar.handle;
      elements.avatarBlock.style.left = Math.max(4, Math.min(rect.right - 17, global.innerWidth - 30)) + 'px';
      elements.avatarBlock.style.top = Math.max(4, Math.min(rect.top - 7, global.innerHeight - 30)) + 'px';
      elements.avatarBlock.hidden = false;
    });
    anchor.addEventListener('mouseleave', () => { avatarTimer = global.setTimeout(hideAvatarBlock, 140); });
  }
  elements.avatarBlock.addEventListener('mouseenter', () => global.clearTimeout(avatarTimer));
  elements.avatarBlock.addEventListener('mouseleave', hideAvatarBlock);
  global.addEventListener('scroll', hideAvatarBlock, { capture: true, passive: true });
  function hideSelectionToolbar() { elements.selectionToolbar.hidden = true; currentSelectionKeyword = ''; }
  function showSelectionToolbar(candidate) {
    if (!candidate?.keyword || !candidate.rect) { hideSelectionToolbar(); return; }
    currentSelectionKeyword = candidate.keyword;
    const rect = candidate.rect;
    elements.selectionToolbar.hidden = false;
    action('block-selection').title = '屏蔽“' + candidate.keyword + '”';
    elements.selectionToolbar.style.left = Math.max(48, Math.min(rect.left + rect.width / 2, global.innerWidth - 48)) + 'px';
    elements.selectionToolbar.style.top = Math.max(8, Math.min(rect.top < 48 ? rect.bottom + 8 : rect.top - 40, global.innerHeight - 40)) + 'px';
  }
  elements.selectionToolbar.addEventListener('pointerdown', (event) => event.preventDefault());
  function showUndo(handle) {
    global.clearTimeout(toastTimer); undoHandle = handle;
    elements.toast.querySelector('span').textContent = '已屏蔽 @' + handle;
    elements.toast.hidden = false;
    toastTimer = global.setTimeout(() => { elements.toast.hidden = true; undoHandle = ''; }, 5000);
  }
  root.addEventListener('click', async (event) => {
    if (event.target === elements.backdrop) { event.preventDefault(); event.stopPropagation(); setPanel(false); return; }
    const tab = event.target.closest('[data-tab]');
    if (tab) { selectTab(tab.dataset.tab); return; }
    const target = event.target.closest('[data-action]');
    const name = target?.dataset.action;
    if (name === 'toggle-panel') {
      if (suppressClick && event.detail !== 0) { suppressClick = false; return; }
      suppressClick = false; setPanel(elements.panel.hidden);
    } else if (name === 'close-panel') setPanel(false);
    else if (name === 'save-keywords' && !saving) {
      const draft = elements.blockedKeywords.value; saving = true; target.disabled = true;
      try {
        const saved = await callbacks.onBlockedKeywordsChange(elements.blockedKeywords.value);
        if (saved && elements.blockedKeywords.value === draft) {
          keywordDirty = false; render(view); role('save-state').textContent = '已保存';
        }
      } finally { saving = false; target.disabled = false; }
    } else if (name === 'save-filter-sync') { tokenDirty = false; callbacks.onFilterSyncTokenChange(elements.filterSyncToken.value); }
    else if (name === 'sync-filters') callbacks.onFilterSync();
    else if (name === 'disconnect-filter-sync') { tokenDirty = false; elements.filterSyncToken.value = ''; callbacks.onFilterSyncTokenChange(''); }
    else if (name === 'configure-cobalt') { setPanel(false); callbacks.onConfigureCobalt(); }
    else if (name === 'reset-position') { position = normalizeMxgaPosition(null); placeControl(); await savePosition(); }
    else if (name === 'previous-page') { page--; renderAccounts(); }
    else if (name === 'next-page') { page++; renderAccounts(); }
    else if (name === 'restore') { callbacks.onRestore(target.dataset.handle); role('account-search').focus(); }
    else if (name === 'block-avatar' && currentAvatar) { const selected = currentAvatar; hideAvatarBlock(); callbacks.onHide(selected.handle); }
    else if (name === 'block-selection' && currentSelectionKeyword) {
      const keyword = currentSelectionKeyword; hideSelectionToolbar(); global.getSelection()?.removeAllRanges(); callbacks.onBlockKeyword(keyword);
    } else if (name === 'undo' && undoHandle) {
      const handle = undoHandle; undoHandle = ''; global.clearTimeout(toastTimer); elements.toast.hidden = true; callbacks.onRestore(handle);
    } else if (name === 'open-source') callbacks.onOpenUrl('https://github.com/kyangc/tampermonkey_scripts');
    else if (name === 'open-upstream') callbacks.onOpenUrl('https://github.com/foru17/make-x-great-again');
  });
  elements.enabled.addEventListener('change', () => callbacks.onEnabledChange(elements.enabled.checked));
  placeControl();
  return { host, render, mountAvatarTrigger, hideAvatarBlock, showSelectionToolbar, hideSelectionToolbar, showUndo };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Bundled helper; settings stay in userscript storage, outside MXGA filter sync.
function createMxgaCobalt(global) {
  'use strict';
  const STORAGE_KEY = 'mxga:cobalt:v1';

  function normalizeCobaltUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return '';
      return url.href;
    } catch (_) { return ''; }
  }

  function cobaltRequestBody(url) {
    const parsed = new URL(url);
    if (!['x.com', 'twitter.com'].includes(parsed.hostname) || parsed.protocol !== 'https:'
      || parsed.username || parsed.password || !/^\/[A-Za-z0-9_]{1,15}\/status\/\d+\/?$/.test(parsed.pathname)) {
      throw new Error('无法确认视频所属帖子');
    }
    return { url: `https://x.com${parsed.pathname.replace(/\/$/, '')}`, downloadMode: 'auto',
      videoQuality: 'max', localProcessing: 'disabled', convertGif: false, alwaysProxy: true };
  }

  function cobaltError(status, code) {
    if (status === 429) return '请求过于频繁，请稍后重试';
    if (status === 401 || status === 403 || /auth|turnstile/.test(code || '')) return '服务拒绝访问，请检查 API Key 或服务端验证设置';
    if (/private|age|unavailable|empty/.test(code || '')) return '服务无法获取该帖子的视频，内容可能受限或已不可用';
    return `视频解析失败${code && /^[a-zA-Z0-9._-]{1,100}$/.test(code) ? `（${code}）` : status ? `（HTTP ${status}）` : ''}`;
  }

  function parseCobaltResponse(data, status = 200) {
    if (status < 200 || status >= 300 || data?.status === 'error') throw new Error(cobaltError(status, data?.error?.code));
    if (data?.status === 'local-processing') throw new Error('该视频需要本地转码，当前下载器暂不支持');
    const rows = ['tunnel', 'redirect'].includes(data?.status)
      ? [{ url: data.url, filename: data.filename }]
      : data?.status === 'picker' && Array.isArray(data.picker)
        ? data.picker.filter((item) => ['video', 'gif'].includes(item?.type)) : [];
    if (!rows.length) throw new Error('服务没有返回可下载的视频');
    return rows.map((item, index) => {
      let url;
      try { url = new URL(item.url); } catch (_) { throw new Error('服务返回了无效下载地址'); }
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('服务返回了不安全的下载地址');
      return { url: url.href, label: `下载视频${rows.length > 1 ? ` ${index + 1}` : ''}`,
        filename: typeof item.filename === 'string' ? item.filename.slice(0, 240) : '' };
    });
  }

  function requestCobalt(gm, endpoint, apiKey, tweetUrl, signal) {
    const target = normalizeCobaltUrl(endpoint);
    if (!target) return Promise.reject(new Error('请输入有效的 HTTPS API 地址，不含查询参数或密钥'));
    const body = cobaltRequestBody(tweetUrl);
    if (!gm?.xmlHttpRequest) return Promise.reject(new Error('当前脚本管理器不支持跨域请求'));
    return new Promise((resolve, reject) => {
      let request;
      let done = false;
      const finish = (error, value) => {
        if (done) return;
        done = true;
        signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(value);
      };
      const abort = () => {
        finish(new Error('已取消解析'));
        request?.abort?.();
      };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      try {
        request = gm.xmlHttpRequest({
          method: 'POST', url: target, anonymous: true, redirect: 'error', timeout: 45000,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Api-Key ${apiKey}` } : {}) },
          data: JSON.stringify(body),
          onload: (response) => {
            try {
              if (response.finalUrl && new URL(response.finalUrl).origin !== new URL(target).origin) {
                throw new Error('API 地址发生跨站重定向，请检查配置');
              }
              let data;
              try { data = JSON.parse(response.responseText); }
              catch (_) { throw new Error(cobaltError(response.status)); }
              finish(null, parseCobaltResponse(data, response.status));
            } catch (error) { finish(error); }
          },
          onerror: () => finish(new Error('无法连接 cobalt，请检查地址、网络及脚本管理器的域名访问权限')),
          ontimeout: () => finish(new Error('解析超时，请稍后重试')),
          onabort: () => finish(new Error('已取消解析')),
        });
        // Some managers return a promise in addition to invoking callbacks.
        request?.catch?.(() => finish(new Error('cobalt 请求失败，请检查域名访问权限')));
      } catch (_) { finish(new Error('无法发起 cobalt 请求，请检查脚本管理器权限')); }
    });
  }

  function cobaltDownloadRoute(config, tweetUrl) {
    const source = cobaltRequestBody(tweetUrl).url;
    const rawEndpoint = typeof config?.endpoint === 'string' ? config.endpoint.trim() : '';
    if (!rawEndpoint) return { mode: 'web', url: `https://cobalt.tools/#${encodeURIComponent(source)}` };
    const endpoint = normalizeCobaltUrl(rawEndpoint);
    return endpoint ? { mode: 'api', url: endpoint } : { mode: 'settings', url: '' };
  }

  async function openCobaltWebsite(tweetUrl) {
    const url = cobaltDownloadRoute({}, tweetUrl).url;
    const gm = typeof GM !== 'undefined' ? GM : global.GM;
    try {
      if (typeof gm?.openInTab === 'function') {
        await gm.openInTab(url, { active: true, insert: true });
        return;
      }
    } catch (_) { /* Keep a user-clickable link if the manager rejects opening. */ }
    openCobaltDownload(tweetUrl, { webFallback: url });
  }

  let routing = false;
  async function startCobaltDownload(tweetUrl) {
    if (routing) return;
    routing = true;
    try {
      const gm = typeof GM !== 'undefined' ? GM : global.GM;
      // A failed read is not evidence that the user selected public processing.
      const config = gm?.getValue ? await gm.getValue(STORAGE_KEY, {}) : {};
      const route = cobaltDownloadRoute(config, tweetUrl);
      if (route.mode === 'web') await openCobaltWebsite(tweetUrl);
      else openCobaltDownload(tweetUrl, { autoParse: route.mode === 'api' });
    } catch (_) {
      openCobaltDownload(tweetUrl);
    } finally { routing = false; }
  }

  let closeCurrent = null;
  function openCobaltDownload(tweetUrl, options = {}) {
    closeCurrent?.();
    const document = global.document;
    const gm = typeof GM !== 'undefined' ? GM : global.GM;
    document.querySelector('[data-mxga-cobalt]')?.dispatchEvent(new global.Event('mxga-cobalt-close'));
    const settingsOnly = !tweetUrl;
    const previousFocus = document.activeElement;
    const host = document.createElement('div');
    host.setAttribute('data-mxga-cobalt', '');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host{all:initial;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#18212b}
      *{box-sizing:border-box}.backdrop{position:fixed;inset:0;z-index:2147483647;background:#0008;display:flex;align-items:center;justify-content:center;padding:16px}
      .panel{background:#fff;border:1px solid #cdd5dd;border-radius:16px;padding:22px;width:440px;min-width:0;max-width:100%;max-height:90dvh;overflow:auto}
      header{display:flex;align-items:center;justify-content:space-between;gap:12px}h2{font-size:19px;margin:0}
      button,a{font:inherit;cursor:pointer;border-radius:9px;padding:9px 14px}button{border:1px solid #cdd5dd;background:#f3f6f8;color:inherit}
      button:disabled{opacity:.55;cursor:wait}label{display:block;margin-top:14px}input{font:inherit;width:100%;padding:10px;margin-top:5px;border:1px solid #a9b5c1;border-radius:8px;background:#fff;color:inherit}
      :focus-visible{outline:2px solid #1675d1;outline-offset:3px}p{margin:12px 0;color:#536471;font-size:13px;overflow-wrap:anywhere}
      .submit,a{background:#1675d1;color:white;border:0}.submit{margin-top:16px}a{display:block;text-decoration:none;margin-top:10px;text-align:center}.results:empty{display:none}
      .status{white-space:pre-wrap}small{display:block;overflow-wrap:anywhere;color:#536471}
      @media(prefers-color-scheme:dark){:host{color:#e7e9ea}.panel{background:#15202b;border-color:#536471}input,button{background:#22303c;color:#e7e9ea}p,small{color:#a7b5c1}.submit{background:#1675d1}}
    </style><div class="backdrop"><section class="panel" role="dialog" aria-modal="true" aria-labelledby="cobalt-title">
      <header><h2 id="cobalt-title">${settingsOnly ? '视频下载设置' : '下载视频'}</h2><button type="button" class="close" aria-label="关闭">✕</button></header>
      <p>默认打开 cobalt 网页并带入帖子链接。填写自建 API 后，改由该服务解析视频。</p>
      <form><label>cobalt API 地址<input name="endpoint" type="url" placeholder="留空使用 cobalt 网页" autocomplete="off"></label>
      <label>API Key（可选）<input name="key" type="password" autocomplete="off"></label>
      <p>配置仅保存在本机脚本存储，不参与 MXGA 同步。清空地址并保存可恢复默认。</p>
      <button class="submit" type="submit" disabled>${settingsOnly ? '保存设置' : '保存并解析'}</button></form>
      <p class="status" role="status" aria-live="polite">正在读取配置…</p><div class="results"></div>
    </section></div>`;
    document.body.append(host);
    const form = shadow.querySelector('form');
    const endpoint = form.elements.endpoint;
    const key = form.elements.key;
    const button = shadow.querySelector('.submit');
    const status = shadow.querySelector('.status');
    const results = shadow.querySelector('.results');
    let closed = false;
    let controller;
    const close = () => {
      if (closed) return;
      closed = true;
      controller?.abort();
      host.remove();
      if (closeCurrent === close) closeCurrent = null;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
    closeCurrent = close;
    host.addEventListener('mxga-cobalt-close', close, { once: true });
    shadow.querySelector('.close').onclick = close;
    shadow.querySelector('.backdrop').onclick = (event) => { if (event.target.className === 'backdrop') close(); };
    shadow.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); close(); }
      if (event.key === 'Tab') {
        const controls = [...shadow.querySelectorAll('button:not(:disabled), input, a[href]')];
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && shadow.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && shadow.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    shadow.querySelector('.close').focus();
    let busy = false;
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (busy || closed) return;
      const url = normalizeCobaltUrl(endpoint.value);
      if (endpoint.value.trim() && !url) { status.textContent = '请输入有效的 HTTPS API 地址，不含查询参数或密钥'; endpoint.focus(); return; }
      if (!gm?.setValue) { status.textContent = '当前脚本管理器不支持配置存储'; return; }
      busy = true;
      button.disabled = true;
      endpoint.disabled = key.disabled = true;
      results.replaceChildren();
      controller = new global.AbortController();
      status.textContent = settingsOnly ? '正在保存…' : '正在解析视频…';
      try {
        const apiKey = url ? key.value.trim() : '';
        await gm.setValue(STORAGE_KEY, { endpoint: url, apiKey });
        if (closed) return;
        if (settingsOnly) {
          key.value = apiKey;
          status.textContent = url ? '已保存，下载视频时将使用自建服务。' : '已恢复默认，下载视频时将打开 cobalt 网页。';
          return;
        }
        if (!url) { close(); await openCobaltWebsite(tweetUrl); return; }
        const items = await requestCobalt(gm, url, apiKey, tweetUrl, controller.signal);
        if (closed) return;
        for (const item of items) {
          const link = document.createElement('a');
          link.href = item.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.referrerPolicy = 'no-referrer';
          link.textContent = item.label;
          results.append(link);
        }
        status.textContent = '解析完成。点击下载，交由浏览器保存；链接失效时请重新解析。';
      } catch (error) {
        if (!closed) status.textContent = error.message || '解析失败，请重试';
      } finally {
        busy = false;
        if (!closed) { button.disabled = false; endpoint.disabled = key.disabled = false; button.textContent = settingsOnly ? '保存设置' : '重新解析'; }
      }
    };
    (async () => {
      try {
        if (!gm?.getValue) throw new Error('当前脚本管理器不支持配置存储');
        const config = await gm.getValue(STORAGE_KEY, {});
        if (closed) return;
        endpoint.value = typeof config?.endpoint === 'string' ? config.endpoint.trim() : '';
        key.value = typeof config?.apiKey === 'string' ? config.apiKey : '';
        status.textContent = !endpoint.value ? '当前使用 cobalt 网页，无需配置。'
          : normalizeCobaltUrl(endpoint.value) ? '已配置自建服务。' : '已保存的 API 地址无效，请修正或清空后保存。';
        button.disabled = false;
        endpoint.focus();
        if (options.autoParse && endpoint.value) form.requestSubmit();
      } catch (_) { if (!closed) status.textContent = '无法读取本地配置，请检查脚本管理器存储权限'; }
    })();
    if (options.webFallback) {
      const link = document.createElement('a');
      link.href = options.webFallback;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = '打开 cobalt 网页';
      results.append(link);
    }
  }
  return { normalizeCobaltUrl, cobaltRequestBody, parseCobaltResponse, requestCobalt, cobaltDownloadRoute, startCobaltDownload, openCobaltDownload };
}
if (typeof module !== 'undefined' && module.exports) Object.assign(module.exports, createMxgaCobalt(globalThis));

// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared runtime module bundled into Make X Great Again and the standalone
// compatibility userscript by tools/build-userscripts.mjs.

(function xTweetShareCard(global) {
  'use strict';

  function normalizeStatusUrl(value) {
    if (!value) return '';
    try {
      const url = new URL(String(value), 'https://x.com');
      const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/);
      return match ? `https://x.com/${match[1]}/status/${match[2]}` : '';
    } catch (_error) {
      return '';
    }
  }

  function normalizeAvatarUrl(value) {
    if (!value) return '';
    return String(value).replace(
      /_(?:normal|bigger|mini|200x200)(?=\.[A-Za-z0-9]+(?:[?#]|$))/,
      '_400x400',
    );
  }

  function normalizeMediaUrl(value) {
    if (!value) return '';
    try {
      const url = new URL(String(value), 'https://x.com');
      url.searchParams.set('name', 'large');
      return url.href;
    } catch (_error) {
      return '';
    }
  }

  function normalizeTweetData(value = {}, includeContext = true) {
    const mediaUrls = [];
    for (const rawUrl of Array.isArray(value.mediaUrls) ? value.mediaUrls : []) {
      const url = normalizeMediaUrl(rawUrl);
      if (url && !mediaUrls.includes(url)) mediaUrls.push(url);
      if (mediaUrls.length === 4) break;
    }
    const videoPosterUrl = normalizeMediaUrl(value.videoPosterUrl);
    if (!mediaUrls.length && videoPosterUrl) mediaUrls.push(videoPosterUrl);

    const rawHandle = String(value.handle || '').trim().replace(/^@+/, '');
    const handle = /^[A-Za-z0-9_]{1,15}$/.test(rawHandle) ? `@${rawHandle}` : '';
    const publishedAt = Number.isFinite(Date.parse(value.publishedAt || ''))
      ? new Date(value.publishedAt).toISOString()
      : '';
    const contextKind = value.context?.kind;
    const context = includeContext
      && (contextKind === 'quote' || contextKind === 'reply')
      && value.context?.tweet
      ? {
          kind: contextKind,
          tweet: normalizeTweetData(value.context.tweet, false),
        }
      : null;

    return {
      authorName: String(value.authorName || '').trim(),
      handle,
      isVerified: Boolean(value.isVerified),
      text: String(value.text || '').trim(),
      avatarUrl: normalizeAvatarUrl(value.avatarUrl),
      mediaUrls,
      publishedAt,
      statusUrl: normalizeStatusUrl(value.statusUrl),
      videoPosterUrl,
      context,
    };
  }

  function isLikelyVideoPosterUrl(value) {
    if (!value) return false;
    try {
      const url = new URL(String(value), 'https://x.com');
      if (!/^https?:$/.test(url.protocol)) return false;
      return !url.pathname.includes('/profile_images/')
        && /(?:video_thumb|\/media\/)/i.test(url.pathname);
    } catch (_error) {
      return false;
    }
  }

  function extractBackgroundImageUrl(value) {
    const match = String(value || '').match(/url\(["']?([^"')]+)["']?\)/i);
    return match ? match[1] : '';
  }

  function queryScopedNodes(root, selector, excludedRoots = []) {
    if (!root || typeof root.querySelector !== 'function') return [];
    const queried = typeof root.querySelectorAll === 'function'
      ? Array.from(root.querySelectorAll(selector))
      : [];
    const nodes = queried.length ? queried : [root.querySelector(selector)].filter(Boolean);
    return nodes.filter((node) => !excludedRoots.some((excludedRoot) => {
      if (!excludedRoot) return false;
      if (typeof excludedRoot.contains === 'function' && excludedRoot.contains(node)) return true;
      return node?.closest?.('[role="link"]') === excludedRoot;
    }));
  }

  function queryScopedNode(root, selector, excludedRoots = []) {
    return queryScopedNodes(root, selector, excludedRoots)[0] || null;
  }

  function extractVideoPosterUrl(article, excludedRoots = []) {
    if (!article || typeof article.querySelector !== 'function') return '';
    const player = queryScopedNode(article, '[data-testid="videoPlayer"]', excludedRoots);
    if (!player) return '';

    const video = typeof player.querySelector === 'function'
      ? player.querySelector('video[poster]')
      : null;
    const poster = video ? (video.poster || video.getAttribute?.('poster') || '') : '';
    if (isLikelyVideoPosterUrl(poster)) return poster;

    const images = typeof player.querySelectorAll === 'function'
      ? Array.from(player.querySelectorAll('img[src]'))
      : [];
    for (const image of images) {
      const src = image.currentSrc || image.src || image.getAttribute?.('src') || '';
      if (isLikelyVideoPosterUrl(src)) return src;
    }

    const styledNodes = typeof player.querySelectorAll === 'function'
      ? Array.from(player.querySelectorAll('[style*="background-image"]'))
      : [];
    for (const node of styledNodes) {
      const src = extractBackgroundImageUrl(node.style?.backgroundImage || node.getAttribute?.('style'));
      if (isLikelyVideoPosterUrl(src)) return src;
    }

    return '';
  }

  function findQuotedTweetRoot(article) {
    const nameBlocks = queryScopedNodes(
      article,
      '[data-testid="User-Name"], [data-testid="UserName"]',
    );
    for (const nameBlock of nameBlocks.slice(1)) {
      const candidate = nameBlock?.closest?.('[role="link"]');
      if (candidate && candidate !== article) return candidate;
    }

    const textNodes = queryScopedNodes(article, '[data-testid="tweetText"]');
    for (const textNode of textNodes.slice(1)) {
      const candidate = textNode?.closest?.('[role="link"]');
      if (candidate?.querySelector?.('[data-testid="User-Name"], [data-testid="UserName"]')) {
        return candidate;
      }
    }
    return null;
  }

  function normalizeVideoTweetUrl(value) {
    if (!value) return '';
    try {
      const url = new URL(value, 'https://x.com');
      if (!['x.com', 'twitter.com'].includes(url.hostname) || url.protocol !== 'https:'
        || url.username || url.password || !/^\/[A-Za-z0-9_]{1,15}\/status\/\d+\/?$/.test(url.pathname)) return '';
      return normalizeStatusUrl(url.href);
    } catch (_) { return ''; }
  }

  // Detail pages may have plain timestamp links instead of <time datetime>.
  // Exclude nested quotes and require one unambiguous owning permalink.
  function extractVideoTweetUrl(article) {
    if (!article) return '';
    const quote = findQuotedTweetRoot(article);
    const excluded = quote ? [quote] : [];
    const ownNodes = (selector) => queryScopedNodes(article, selector, excluded).filter((node) => {
      const owner = node.closest?.('article');
      if (owner && owner !== article) return false;
      const embedded = node.closest?.('[role="link"][data-href*="/status/"]');
      return !embedded || !article.contains?.(embedded);
    });
    const hasPlayer = ownNodes('[data-testid="videoPlayer"], video').length > 0;
    const hasVideoPreview = ownNodes('[data-testid="previewInterstitial"]')
      .some((preview) => Boolean(preview.querySelector?.('[data-testid="playButton"]')));
    if (!hasPlayer && !hasVideoPreview) return '';
    const time = ownNodes('time[datetime]')[0];
    const timestampUrl = normalizeVideoTweetUrl(time?.closest?.('a[href*="/status/"]')?.getAttribute?.('href'));
    if (timestampUrl) return timestampUrl;
    const urls = new Set(ownNodes('a[href*="/status/"]').filter((node) => !node.closest?.('[data-testid="tweetText"]'))
      .map((node) => normalizeVideoTweetUrl(node.getAttribute?.('href'))).filter(Boolean));
    return urls.size === 1 ? [...urls][0] : '';
  }

  function findNativeVideoDownloadItems(menu) {
    const labelPattern = /^(?:下载视频|下載影片|下載視頻|download video)$/i;
    return Array.from(menu?.querySelectorAll?.('[role="menuitem"]') || []).filter((item) => {
      if (item.getAttribute?.('data-tsc-action')) return false;
      const testId = item.getAttribute?.('data-testid') || '';
      if (/^downloadVideo$/i.test(testId)) return true;
      const labels = [item, ...Array.from(item.querySelectorAll?.('span, div') || [])];
      return labels.some((node) => labelPattern.test(String(node.textContent || '').replace(/\s+/g, ' ').trim()));
    });
  }

  function getStatusId(value) {
    return String(value || '').match(/\/status\/(\d+)/)?.[1] || '';
  }

  function findReplyContextArticle(article, pageUrl, currentStatusUrl) {
    const pageStatusId = getStatusId(pageUrl);
    const currentStatusId = getStatusId(currentStatusUrl);
    const ownerDocument = article?.ownerDocument;
    if (!pageStatusId || !currentStatusId || typeof ownerDocument?.querySelectorAll !== 'function') {
      return null;
    }

    const articles = Array.from(ownerDocument.querySelectorAll('article[data-testid="tweet"]'));
    const currentIndex = articles.indexOf(article);
    if (currentIndex < 0) return null;

    if (currentStatusId === pageStatusId) {
      // On a reply permalink, X renders its ancestor chain before the focused
      // tweet. Require adjacent cells and the parent's avatar connector (the
      // 2px-wide r-m5arl1 line), rather than guessing from document order.
      const cell = article.closest?.('[data-testid="cellInnerDiv"]');
      const previousCell = cell?.previousElementSibling;
      const candidate = previousCell?.querySelector?.('article[data-testid="tweet"]');
      if (!candidate || candidate.closest?.('[data-testid="cellInnerDiv"]') !== previousCell) {
        return null;
      }
      const connector = candidate.querySelector('[data-testid="Tweet-User-Avatar"]')?.nextElementSibling;
      if (!connector?.matches?.('.r-m5arl1')) return null;
      const quoteRoot = findQuotedTweetRoot(candidate);
      const candidateId = getStatusId(extractTweetFields(candidate, quoteRoot ? [quoteRoot] : []).statusUrl);
      return candidateId && candidateId !== currentStatusId ? candidate : null;
    }

    return articles.find((candidate) => {
      const quoteRoot = findQuotedTweetRoot(candidate);
      const candidateStatusUrl = extractTweetFields(candidate, quoteRoot ? [quoteRoot] : []).statusUrl;
      return getStatusId(candidateStatusUrl) === pageStatusId;
    }) || null;
  }

  const TWEET_TEXT_ENTITY_PATTERN = /https?:\/\/[^\s<]+|www\.[^\s<]+|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:[/?#][^\s<]*)?|@[a-z0-9_]{1,15}|#[\p{L}\p{M}\p{N}_]+/giu;
  const TRAILING_LINK_PUNCTUATION_PATTERN = /[.,!?;:'"…，。！？；：、\])}>》】）]+$/u;

  function appendTextRun(runs, text, kind = 'text') {
    if (!text) return;
    const previous = runs.at(-1);
    if (previous?.kind === kind) {
      previous.text += text;
    } else {
      runs.push({ text, kind });
    }
  }

  function getTweetTextSegments(value) {
    const text = String(value || '');
    if (!text) return [];

    const segments = [];
    let cursor = 0;

    for (const match of text.matchAll(TWEET_TEXT_ENTITY_PATTERN)) {
      const matchedText = match[0];
      const start = match.index;
      const end = start + matchedText.length;
      const isMention = matchedText.startsWith('@');
      const isHashtag = matchedText.startsWith('#');
      const previousCharacter = text[start - 1] || '';
      const nextCharacter = text[end] || '';

      if (isMention && (/[A-Za-z0-9_.]/u.test(previousCharacter) || /[A-Za-z0-9_]/u.test(nextCharacter))) {
        continue;
      }
      if (!isMention && !isHashtag && previousCharacter === '@') continue;

      appendTextRun(segments, text.slice(cursor, start));
      if (isMention || isHashtag) {
        appendTextRun(segments, matchedText, 'accent');
      } else {
        const trailingPunctuation = matchedText.match(TRAILING_LINK_PUNCTUATION_PATTERN)?.[0] || '';
        appendTextRun(
          segments,
          matchedText.slice(0, matchedText.length - trailingPunctuation.length),
          'accent',
        );
        appendTextRun(segments, trailingPunctuation);
      }
      cursor = end;
    }

    appendTextRun(segments, text.slice(cursor));
    return segments;
  }

  function getStyledWordTokens(value) {
    const tokens = [];
    let wordRuns = [];
    const flushWord = () => {
      if (!wordRuns.length) return;
      tokens.push({ type: 'word', runs: wordRuns });
      wordRuns = [];
    };

    for (const segment of getTweetTextSegments(value)) {
      for (const chunk of segment.text.match(/\s+|[^\s]+/gu) || []) {
        if (/^\s+$/u.test(chunk)) {
          flushWord();
          tokens.push({ type: 'space', runs: [] });
        } else {
          appendTextRun(wordRuns, chunk, segment.kind);
        }
      }
    }
    flushWord();
    return tokens;
  }

  function trimTextRunsEnd(runs) {
    const trimmed = runs.map((run) => ({ ...run }));
    while (trimmed.length) {
      const last = trimmed.at(-1);
      last.text = last.text.replace(/\s+$/u, '');
      if (last.text) break;
      trimmed.pop();
    }
    return trimmed;
  }

  function wrapTweetTextRuns(value, maxWidth, measureText) {
    const text = String(value || '');
    if (!text) return [];
    if (!(maxWidth > 0) || typeof measureText !== 'function') {
      return [getTweetTextSegments(text)];
    }

    const lines = [];
    for (const paragraph of text.split('\n')) {
      if (!paragraph) {
        lines.push([]);
        continue;
      }

      const tokens = getStyledWordTokens(paragraph);
      let lineRuns = [];
      let lineText = '';

      for (const token of tokens) {
        if (token.type === 'space') {
          if (lineText && !lineText.endsWith(' ')) {
            appendTextRun(lineRuns, ' ');
            lineText += ' ';
          }
          continue;
        }

        const tokenText = token.runs.map((run) => run.text).join('');
        const candidate = `${lineText}${tokenText}`;
        if (measureText(candidate) <= maxWidth) {
          for (const run of token.runs) appendTextRun(lineRuns, run.text, run.kind);
          lineText = candidate;
          continue;
        }

        if (measureText(tokenText) <= maxWidth) {
          if (lineText.trimEnd()) lines.push(trimTextRunsEnd(lineRuns));
          lineRuns = [];
          lineText = '';
          for (const run of token.runs) appendTextRun(lineRuns, run.text, run.kind);
          lineText = tokenText;
          continue;
        }

        for (const run of token.runs) {
          for (const grapheme of Array.from(run.text)) {
            const next = `${lineText}${grapheme}`;
            if (lineText && measureText(next) > maxWidth) {
              lines.push(trimTextRunsEnd(lineRuns));
              lineRuns = [];
              lineText = '';
            }
            appendTextRun(lineRuns, grapheme, run.kind);
            lineText += grapheme;
          }
        }
      }

      if (lineText.trimEnd()) lines.push(trimTextRunsEnd(lineRuns));
    }

    return lines;
  }

  function wrapText(value, maxWidth, measureText) {
    return wrapTweetTextRuns(value, maxWidth, measureText)
      .map((runs) => runs.map((run) => run.text).join(''));
  }

  function addEllipsisToTextRuns(runs) {
    const result = runs.map((run) => ({ ...run }));
    while (result.length) {
      const last = result.at(-1);
      last.text = last.text.replace(/[\s…]+$/u, '');
      if (last.text) break;
      result.pop();
    }
    appendTextRun(result, '…');
    return result;
  }

  function drawTweetTextRuns(context, runs, x, y) {
    let cursorX = x;
    for (const run of runs) {
      context.fillStyle = run.kind === 'accent' ? '#1d9bf0' : '#0f1419';
      context.fillText(run.text, cursorX, y);
      cursorX += context.measureText(run.text).width;
    }
    return cursorX;
  }

  function getMediaLayout(count, area) {
    const itemCount = Math.max(0, Math.min(4, Math.floor(Number(count) || 0)));
    if (!itemCount) return [];

    const { x, y, width, height } = area;
    const gap = Number(area.gap) || 0;
    if (itemCount === 1) return [{ x, y, width, height }];

    const halfWidth = (width - gap) / 2;
    if (itemCount === 2) {
      return [
        { x, y, width: halfWidth, height },
        { x: x + halfWidth + gap, y, width: halfWidth, height },
      ];
    }

    const halfHeight = (height - gap) / 2;
    if (itemCount === 3) {
      return [
        { x, y, width: halfWidth, height },
        { x: x + halfWidth + gap, y, width: halfWidth, height: halfHeight },
        { x: x + halfWidth + gap, y: y + halfHeight + gap, width: halfWidth, height: halfHeight },
      ];
    }

    return [
      { x, y, width: halfWidth, height: halfHeight },
      { x: x + halfWidth + gap, y, width: halfWidth, height: halfHeight },
      { x, y: y + halfHeight + gap, width: halfWidth, height: halfHeight },
      { x: x + halfWidth + gap, y: y + halfHeight + gap, width: halfWidth, height: halfHeight },
    ];
  }

  function getMediaTileRadii(count, index, radius = 22) {
    const none = { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 };
    const all = { topLeft: radius, topRight: radius, bottomRight: radius, bottomLeft: radius };
    if (count <= 1) return all;
    if (count === 2) {
      return index === 0
        ? { ...none, topLeft: radius, bottomLeft: radius }
        : { ...none, topRight: radius, bottomRight: radius };
    }
    if (count === 3) {
      if (index === 0) return { ...none, topLeft: radius, bottomLeft: radius };
      if (index === 1) return { ...none, topRight: radius };
      return { ...none, bottomRight: radius };
    }
    if (index === 0) return { ...none, topLeft: radius };
    if (index === 1) return { ...none, topRight: radius };
    if (index === 2) return { ...none, bottomLeft: radius };
    if (index === 3) return { ...none, bottomRight: radius };
    return none;
  }

  function extractVisibleTweetText(textNode) {
    if (!textNode) return '';
    let text = String(textNode.innerText || textNode.textContent || '');
    const links = typeof textNode.querySelectorAll === 'function'
      ? Array.from(textNode.querySelectorAll('a[href]'))
      : [];

    for (const link of links) {
      const visibleLinkText = String(link.innerText || link.textContent || '');
      if (!visibleLinkText.includes('\n')) continue;
      const compactLinkText = visibleLinkText.replace(/\s+/gu, '');
      if (!compactLinkText) continue;
      text = text.replace(visibleLinkText, compactLinkText);
    }
    return text;
  }

  function extractTweetFields(root, excludedRoots = []) {
    const nameBlock = queryScopedNode(root, '[data-testid="User-Name"]', excludedRoots)
      || queryScopedNode(root, '[data-testid="UserName"]', excludedRoots);
    const links = nameBlock && typeof nameBlock.querySelectorAll === 'function'
      ? Array.from(nameBlock.querySelectorAll('a[href]'))
      : [];
    const profileLink = links.find((link) => {
      const href = link.getAttribute && link.getAttribute('href');
      return /^\/[A-Za-z0-9_]{1,15}\/?$/.test(href || '');
    });
    const spans = nameBlock && typeof nameBlock.querySelectorAll === 'function'
      ? Array.from(nameBlock.querySelectorAll('span'))
      : [];
    const handleText = spans
      .map((span) => String(span.textContent || '').trim())
      .find((text) => /^@[A-Za-z0-9_]{1,15}$/.test(text));
    const profileHref = profileLink && profileLink.getAttribute('href');
    const handleFromHref = profileHref && profileHref.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
    const authorName = String(profileLink?.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
    const verifiedIcon = nameBlock?.querySelector?.('[data-testid="icon-verified"]')
      || nameBlock?.querySelector?.('svg[aria-label="认证账号"]')
      || nameBlock?.querySelector?.('svg[aria-label="Verified account"]');

    const textNode = queryScopedNode(root, '[data-testid="tweetText"]', excludedRoots);
    const avatar = queryScopedNode(root, '[data-testid="Tweet-User-Avatar"] img[src]', excludedRoots);
    const time = queryScopedNode(root, 'time[datetime]', excludedRoots);
    const statusAnchor = time?.closest?.('a[href*="/status/"]')
      || queryScopedNode(root, 'a[href*="/status/"]', excludedRoots);
    const mediaNodes = queryScopedNodes(root, '[data-testid="tweetPhoto"] img[src]', excludedRoots);
    const videoPosterUrl = extractVideoPosterUrl(root, excludedRoots);

    return {
      authorName,
      handle: handleText || (handleFromHref ? handleFromHref[1] : ''),
      isVerified: Boolean(verifiedIcon),
      text: extractVisibleTweetText(textNode),
      avatarUrl: avatar ? (avatar.currentSrc || avatar.src || avatar.getAttribute?.('src') || '') : '',
      mediaUrls: mediaNodes.map((node) => node.currentSrc || node.src || node.getAttribute?.('src') || ''),
      publishedAt: time?.getAttribute?.('datetime') || '',
      statusUrl: statusAnchor?.getAttribute?.('href') || '',
      videoPosterUrl,
    };
  }

  function extractTweetData(article, options = {}) {
    if (!article || typeof article.querySelector !== 'function') return normalizeTweetData();

    const quotedTweetRoot = findQuotedTweetRoot(article);
    const tweet = extractTweetFields(article, quotedTweetRoot ? [quotedTweetRoot] : []);
    const quotedTweet = quotedTweetRoot ? extractTweetFields(quotedTweetRoot) : null;
    const hasQuotedContent = quotedTweet
      && (quotedTweet.authorName || quotedTweet.handle || quotedTweet.text
        || quotedTweet.mediaUrls.length || quotedTweet.videoPosterUrl);
    const pageUrl = options.pageUrl
      || (typeof global?.location?.href === 'string' ? global.location.href : '');
    const replyContextArticle = hasQuotedContent
      ? null
      : findReplyContextArticle(article, pageUrl, tweet.statusUrl);
    const replyQuotedRoot = replyContextArticle ? findQuotedTweetRoot(replyContextArticle) : null;
    const replyToTweet = replyContextArticle
      ? extractTweetFields(replyContextArticle, replyQuotedRoot ? [replyQuotedRoot] : [])
      : null;
    const hasReplyContext = replyToTweet
      && (replyToTweet.authorName || replyToTweet.handle || replyToTweet.text
        || replyToTweet.mediaUrls.length || replyToTweet.videoPosterUrl);

    return normalizeTweetData({
      ...tweet,
      context: hasQuotedContent
        ? { kind: 'quote', tweet: quotedTweet }
        : hasReplyContext
          ? { kind: 'reply', tweet: replyToTweet }
          : null,
    });
  }

  function buildContextTweetLayout(context, area, measureText, options = {}) {
    const tweet = context.tweet;
    const padding = 34;
    const contentX = area.x + padding;
    const contentWidth = area.width - padding * 2;
    const labelTop = area.y + padding;
    const headerTop = labelTop + 44;
    const headerHeight = 58;
    const avatarRect = {
      x: contentX,
      y: headerTop,
      width: 56,
      height: 56,
    };
    const identityX = avatarRect.x + avatarRect.width + 16;
    const identityWidth = contentX + contentWidth - identityX;
    const textTop = headerTop + headerHeight + 26;
    const contextMeasureText = typeof options.contextMeasureText === 'function'
      ? options.contextMeasureText
      : measureText;
    const textLineRuns = wrapTweetTextRuns(tweet.text, contentWidth, contextMeasureText);
    const textLines = textLineRuns.map((runs) => runs.map((run) => run.text).join(''));
    const textLineHeight = 44;
    const textHeight = textLines.length * textLineHeight;
    const mediaCount = Math.min(4, tweet.mediaUrls.length);
    const singleMediaAspectRatio = Number(options.contextSingleMediaAspectRatio);
    let mediaHeight = mediaCount ? 500 : 0;
    if (mediaCount === 1 && singleMediaAspectRatio > 0) {
      mediaHeight = contentWidth * singleMediaAspectRatio;
    }
    const mediaTop = textTop + textHeight + (textLines.length && mediaCount ? 28 : 0);
    const mediaRects = getMediaLayout(mediaCount, {
      x: contentX,
      y: mediaTop,
      width: contentWidth,
      height: mediaHeight,
      gap: 6,
    });
    const contentBottom = mediaCount
      ? mediaTop + mediaHeight
      : textLines.length
        ? textTop + textHeight
        : headerTop + headerHeight;
    const rect = {
      x: area.x,
      y: area.y,
      width: area.width,
      height: contentBottom - area.y + padding,
    };

    return {
      kind: context.kind,
      tweet,
      rect,
      labelTop,
      headerTop,
      avatarRect,
      identityX,
      identityWidth,
      textTop,
      textLineRuns,
      textLines,
      textLineHeight,
      mediaRects,
    };
  }

  function buildCardLayout(tweet, measureText, options = {}) {
    const canvasWidth = 1200;
    const outerMargin = 54;
    const card = {
      x: outerMargin,
      y: outerMargin,
      width: canvasWidth - outerMargin * 2,
    };
    const padding = 64;
    const contentX = card.x + padding;
    const contentWidth = card.width - padding * 2;
    const headerTop = card.y + padding;
    const headerHeight = 104;
    const avatarRect = {
      x: contentX,
      y: headerTop,
      width: headerHeight,
      height: headerHeight,
    };
    const brandLogoSize = getBrandLogoConfig().size;
    const brandLogoRect = {
      x: contentX + contentWidth - brandLogoSize,
      y: headerTop + (headerHeight - brandLogoSize) / 2,
      width: brandLogoSize,
      height: brandLogoSize,
    };
    const textTop = headerTop + headerHeight + 42;
    const textLineHeight = 58;
    const allTextLineRuns = wrapTweetTextRuns(tweet?.text || '', contentWidth, measureText);
    const textLineRuns = allTextLineRuns.length > 48
      ? [...allTextLineRuns.slice(0, 47), addEllipsisToTextRuns(allTextLineRuns[47])]
      : allTextLineRuns;
    const textLines = textLineRuns.map((runs) => runs.map((run) => run.text).join(''));
    const textHeight = textLines.length * textLineHeight;
    const mediaCount = Math.min(4, Array.isArray(tweet?.mediaUrls) ? tweet.mediaUrls.length : 0);
    const singleMediaAspectRatio = Number(options.singleMediaAspectRatio);
    let mediaHeight = mediaCount ? (mediaCount === 1 ? 600 : 620) : 0;
    if (mediaCount === 1 && singleMediaAspectRatio > 0) {
      mediaHeight = contentWidth * singleMediaAspectRatio;
    }
    const mediaTop = textTop + textHeight + (textLines.length ? 42 : 0);
    const mediaRects = getMediaLayout(mediaCount, {
      x: contentX,
      y: mediaTop,
      width: contentWidth,
      height: mediaHeight,
      gap: 6,
    });
    const primaryContentBottom = mediaCount ? mediaTop + mediaHeight : textTop + textHeight;
    const contextLayout = tweet?.context?.tweet
      ? buildContextTweetLayout(
          tweet.context,
          {
            x: contentX,
            y: primaryContentBottom + 42,
            width: contentWidth,
          },
          measureText,
          options,
        )
      : null;
    const contentBottom = contextLayout
      ? contextLayout.rect.y + contextLayout.rect.height
      : primaryContentBottom;
    const footerTop = contentBottom + 56;
    const footerHeight = 38;
    const cardBottom = footerTop + footerHeight + padding;
    const sourceUrl = normalizeStatusUrl(tweet?.statusUrl);
    const sourceGuide = sourceUrl
      ? (() => {
          const rect = {
            x: card.x,
            y: cardBottom + 42,
            width: card.width,
            height: 136,
          };
          const qrSize = 136;
          return {
            label: '扫码查看详情',
            url: sourceUrl,
            rect,
            labelBaselineY: rect.y + 52,
            urlBaselineY: rect.y + 98,
            qrRect: {
              x: rect.x + rect.width - qrSize,
              y: rect.y + (rect.height - qrSize) / 2,
              width: qrSize,
              height: qrSize,
            },
          };
        })()
      : null;
    card.height = cardBottom - card.y;
    const canvasContentBottom = sourceGuide
      ? sourceGuide.rect.y + sourceGuide.rect.height
      : cardBottom;

    return {
      canvasWidth,
      canvasHeight: canvasContentBottom + outerMargin,
      card,
      avatarRect,
      brandLogoRect,
      contentX,
      contentWidth,
      contextLayout,
      footerTop,
      headerTop,
      mediaRects,
      sourceGuide,
      textLineHeight,
      textLineRuns,
      textLines,
      textTop,
    };
  }

  function getCanvasRenderSize(logicalWidth, logicalHeight, options = {}) {
    const width = Number(logicalWidth);
    const height = Number(logicalHeight);
    if (!(width > 0) || !(height > 0)) {
      throw new Error('invalid canvas layout size');
    }
    const maxPixels = Number(options.maxPixels) > 0
      ? Number(options.maxPixels)
      : 8_000_000;
    const maxEdge = Number(options.maxEdge) > 0
      ? Number(options.maxEdge)
      : 8192;
    const scaleLimit = Math.min(
      1,
      maxEdge / width,
      maxEdge / height,
      Math.sqrt(maxPixels / (width * height)),
    );
    const renderWidth = Math.max(1, Math.floor(width * scaleLimit));
    const renderHeight = Math.max(1, Math.floor(height * scaleLimit));
    const scale = Math.min(renderWidth / width, renderHeight / height);
    return {
      width: renderWidth,
      height: renderHeight,
      scale,
      limited: scale < 1,
    };
  }

  function findShareMenuAnchor(menu) {
    if (!menu || typeof menu.querySelector !== 'function') return null;
    const testIdMatch = menu.querySelector('[data-testid="copyLinkToTweet"]')
      || menu.querySelector('[data-testid*="copyLink"]');
    if (testIdMatch) return testIdMatch.closest?.('[role="menuitem"]') || testIdMatch;

    const items = typeof menu.querySelectorAll === 'function'
      ? Array.from(menu.querySelectorAll('[role="menuitem"], [data-testid]'))
      : [];
    return items.find((item) => {
      const testId = item.getAttribute?.('data-testid') || '';
      const label = String(item.textContent || '').replace(/\s+/g, ' ').trim();
      return /copy.*link.*tweet/i.test(testId)
        || /^(?:copy link|复制链接|複製連結|リンクをコピー|링크 복사|copier le lien|copiar enlace|link kopieren|copia link|copiar link)$/i.test(label);
    }) || null;
  }

  function isTweetShareMenu(menu) {
    return Boolean(findShareMenuAnchor(menu));
  }

  function isTweetShareButton(element) {
    if (!element || typeof element.getAttribute !== 'function') return false;
    if (element.getAttribute('data-testid') === 'share'
      || element.getAttribute('data-engagement-action') === 'share') return true;
    const label = String(element.getAttribute('aria-label') || '').trim();
    return /^(?:share|share post|分享|分享帖子|分享貼文|ポストを共有|게시물 공유하기|partager le post|compartir post|post teilen|condividi post|compartilhar post)$/i.test(label);
  }

  function getMediaRenderConfig(count) {
    return {
      borderColor: '#cfd9df',
      borderWidth: 3,
      fit: Number(count) === 1 ? 'contain' : 'cover',
    };
  }

  function getShareMenuStyleText() {
    return `
      [data-mxga-native-video-download] { display: none !important; }
      [data-tsc-action="share-card"], [data-tsc-action="cobalt-download"] {
        transition: background-color 0.15s ease;
      }
      [data-tsc-action="share-card"]:hover,
      [data-tsc-action="share-card"]:focus-visible,
      [data-tsc-action="cobalt-download"]:hover, [data-tsc-action="cobalt-download"]:focus-visible {
        background-color: rgba(127,127,127,0.14) !important;
        background-color: color-mix(in srgb,currentColor 12%,transparent) !important;
      }
    `;
  }

  function getVideoPlayOverlayLayout(rect) {
    const diameter = Math.min(112, Math.max(68, Math.min(rect.width, rect.height) * 0.18));
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    return {
      centerX,
      centerY,
      diameter,
      triangle: [
        { x: centerX - diameter * 0.1, y: centerY - diameter * 0.18 },
        { x: centerX - diameter * 0.1, y: centerY + diameter * 0.18 },
        { x: centerX + diameter * 0.22, y: centerY },
      ],
    };
  }

  function getBrandLogoConfig() {
    return {
      path: 'M21.742 21.75l-7.563-11.179 7.056-8.321h-2.456l-5.691 6.714-4.54-6.714H2.359l7.29 10.776L2.25 21.75h2.456l6.035-7.118 4.818 7.118h6.191-.008zM7.739 3.818L18.81 20.182h-2.447L5.29 3.818h2.447z',
      size: 58,
      viewBoxSize: 24,
    };
  }

  function getVerifiedBadgeConfig() {
    return {
      path: 'M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.218.877 1.688.47.443 1.054.747 1.687.878.633.132 1.29.084 1.897-.136.274.586.705 1.084 1.246 1.439.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681s.075-1.299-.165-1.903c.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z',
      size: 36,
      viewBoxSize: 22,
    };
  }

  function getInlineBadgeTop(baselineY, badgeSize, metrics = {}, fontSize = badgeSize) {
    const ascent = Number.isFinite(metrics.actualBoundingBoxAscent)
      ? metrics.actualBoundingBoxAscent
      : fontSize * 0.78;
    const descent = Number.isFinite(metrics.actualBoundingBoxDescent)
      ? metrics.actualBoundingBoxDescent
      : fontSize * 0.22;
    const textCenterY = baselineY + (descent - ascent) / 2;
    return textCenterY - badgeSize / 2;
  }

  function createQrMatrix(value, qrFactory) {
    const sourceUrl = normalizeStatusUrl(value);
    if (!sourceUrl) return [];
    const factory = typeof qrFactory === 'function'
      ? qrFactory
      : typeof qrcode === 'function'
        ? qrcode
        : global?.qrcode;
    if (typeof factory !== 'function') {
      throw new Error('二维码生成组件未加载');
    }

    const qr = factory(0, 'M');
    qr.addData(sourceUrl, 'Byte');
    qr.make();
    const moduleCount = qr.getModuleCount();
    if (!Number.isInteger(moduleCount) || moduleCount <= 0) {
      throw new Error('二维码矩阵无效');
    }
    return Array.from({ length: moduleCount }, (_, row) => (
      Array.from({ length: moduleCount }, (_, column) => Boolean(qr.isDark(row, column)))
    ));
  }

  function getQrRenderConfig(moduleCount, rect) {
    const count = Math.floor(Number(moduleCount) || 0);
    if (count <= 0) throw new Error('二维码矩阵无效');
    const quietZoneModules = 4;
    const moduleSize = Math.max(1, Math.floor(
      Math.min(rect.width, rect.height) / (count + quietZoneModules * 2),
    ));
    const codeSize = count * moduleSize;
    return {
      moduleSize,
      codeSize,
      quietZoneSize: quietZoneModules * moduleSize,
      originX: Math.round(rect.x + (rect.width - codeSize) / 2),
      originY: Math.round(rect.y + (rect.height - codeSize) / 2),
    };
  }

  function getSourceGuideTextX(sourceGuide, moduleCount) {
    const qrRender = getQrRenderConfig(moduleCount, sourceGuide.qrRect);
    const qrVisibleRight = qrRender.originX + qrRender.codeSize;
    const qrVisibleRightInset = sourceGuide.qrRect.x + sourceGuide.qrRect.width
      - qrVisibleRight;
    return sourceGuide.rect.x + qrVisibleRightInset;
  }

  const core = {
    buildCardLayout,
    createQrMatrix,
    drawTweetTextRuns,
    extractTweetData,
    extractVideoTweetUrl,
    findNativeVideoDownloadItems,
    extractVideoPosterUrl,
    findShareMenuAnchor,
    getCanvasRenderSize,
    getMediaLayout,
    getMediaRenderConfig,
    getMediaTileRadii,
    getQrRenderConfig,
    getSourceGuideTextX,
    getShareMenuStyleText,
    getTweetTextSegments,
    getBrandLogoConfig,
    getVerifiedBadgeConfig,
    getInlineBadgeTop,
    getVideoPlayOverlayLayout,
    isTweetShareButton,
    isTweetShareMenu,
    loadTweetAssetBundle,
    normalizeTweetData,
    wrapTweetTextRuns,
    wrapText,
  };

  if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, core);
  }

  if (!global || !global.document) return;

  const cobalt = createMxgaCobalt(global);
  const document = global.document;
  const runtimeRoot = document.documentElement;
  if (
    runtimeRoot?.hasAttribute('data-tsc-runtime-mounted')
    || document.querySelector('style[data-tsc-page-style]')
  ) {
    return;
  }
  runtimeRoot?.setAttribute('data-tsc-runtime-mounted', '');
  const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
  const state = {
    activeArticle: null,
    mountScheduled: false,
    modalClose: null,
    renderAbort: null,
  };

  function installPageStyle() {
    if (document.querySelector('style[data-tsc-page-style]')) return;
    const style = document.createElement('style');
    style.setAttribute('data-tsc-page-style', '');
    style.textContent = getShareMenuStyleText();
    (document.head || document.documentElement).append(style);
  }

  installPageStyle();

  function roundedRectPath(context, x, y, width, height, radius) {
    const maxRadius = Math.max(0, Math.min(width / 2, height / 2));
    const value = typeof radius === 'number'
      ? { topLeft: radius, topRight: radius, bottomRight: radius, bottomLeft: radius }
      : radius || {};
    const radii = {
      topLeft: Math.max(0, Math.min(Number(value.topLeft) || 0, maxRadius)),
      topRight: Math.max(0, Math.min(Number(value.topRight) || 0, maxRadius)),
      bottomRight: Math.max(0, Math.min(Number(value.bottomRight) || 0, maxRadius)),
      bottomLeft: Math.max(0, Math.min(Number(value.bottomLeft) || 0, maxRadius)),
    };
    context.beginPath();
    context.moveTo(x + radii.topLeft, y);
    context.lineTo(x + width - radii.topRight, y);
    context.arcTo(x + width, y, x + width, y + radii.topRight, radii.topRight);
    context.lineTo(x + width, y + height - radii.bottomRight);
    context.arcTo(x + width, y + height, x + width - radii.bottomRight, y + height, radii.bottomRight);
    context.lineTo(x + radii.bottomLeft, y + height);
    context.arcTo(x, y + height, x, y + height - radii.bottomLeft, radii.bottomLeft);
    context.lineTo(x, y + radii.topLeft);
    context.arcTo(x, y, x + radii.topLeft, y, radii.topLeft);
    context.closePath();
  }

  function drawSvgGlyph(context, config, x, y, color) {
    if (typeof global.Path2D !== 'function') return false;
    try {
      const path = new global.Path2D(config.path);
      context.save();
      context.translate(x, y);
      context.scale(config.size / config.viewBoxSize, config.size / config.viewBoxSize);
      context.fillStyle = color;
      context.fill(path);
      context.restore();
      return true;
    } catch (_error) {
      return false;
    }
  }

  function drawBrandLogo(context, x, y) {
    const config = getBrandLogoConfig();
    if (drawSvgGlyph(context, config, x, y, '#0f1419')) return;
    context.save();
    context.fillStyle = '#0f1419';
    context.font = `700 52px ${FONT_STACK}`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('X', x + config.size / 2, y + config.size / 2);
    context.restore();
  }

  function drawVerifiedBadge(context, x, y, size = getVerifiedBadgeConfig().size) {
    const config = { ...getVerifiedBadgeConfig(), size };
    if (drawSvgGlyph(context, config, x, y, '#1d9bf0')) return;

    context.save();
    context.fillStyle = '#1d9bf0';
    context.beginPath();
    context.arc(x + config.size / 2, y + config.size / 2, config.size / 2, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = '#ffffff';
    context.lineWidth = 3;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(x + config.size * 0.27, y + config.size * 0.52);
    context.lineTo(x + config.size * 0.44, y + config.size * 0.68);
    context.lineTo(x + config.size * 0.75, y + config.size * 0.34);
    context.stroke();
    context.restore();
  }

  function fitCanvasText(context, value, maxWidth) {
    const text = String(value || '');
    if (context.measureText(text).width <= maxWidth) return text;
    const graphemes = Array.from(text);
    while (graphemes.length && context.measureText(`${graphemes.join('')}…`).width > maxWidth) {
      graphemes.pop();
    }
    return `${graphemes.join('')}…`;
  }

  function formatPublishedAt(value) {
    if (!value) return '来自 X';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '来自 X';
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(date);
    } catch (_error) {
      return date.toLocaleString();
    }
  }

  function requestImageBlob(url, options = {}) {
    const gmApi = typeof GM !== 'undefined' ? GM : global.GM;
    if (!gmApi || typeof gmApi.xmlHttpRequest !== 'function') {
      return Promise.reject(new Error('GM.xmlHttpRequest unavailable'));
    }

    return new Promise((resolve, reject) => {
      let request = null;
      let settled = false;
      const signal = options.signal;
      const cleanup = () => signal?.removeEventListener?.('abort', abort);
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const abort = () => {
        try {
          request?.abort?.();
        } catch (_error) {
          // The abort signal still cancels this render job locally.
        }
        finish(reject, createAbortError());
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener?.('abort', abort, { once: true });
      try {
        request = gmApi.xmlHttpRequest({
          method: 'GET',
          url,
          responseType: 'blob',
          timeout: 20000,
          anonymous: true,
          onload: (response) => {
            const blob = response && response.response;
            if (response.status >= 200 && response.status < 300 && blob instanceof Blob) {
              finish(resolve, blob);
            } else {
              finish(reject, new Error(`图片请求失败（HTTP ${response.status || 0}）`));
            }
          },
          onerror: () => finish(reject, new Error('图片请求失败')),
          onabort: () => finish(reject, createAbortError()),
          ontimeout: () => finish(reject, new Error('图片请求超时')),
        });
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  async function fetchImageBlob(url, options = {}) {
    try {
      return await requestImageBlob(url, options);
    } catch (gmError) {
      if (options.signal?.aborted || gmError?.name === 'AbortError') throw createAbortError();
      if (typeof global.fetch !== 'function') throw gmError;
      const response = await global.fetch(url, {
        credentials: 'omit',
        mode: 'cors',
        signal: options.signal,
      });
      if (!response.ok) throw new Error(`图片请求失败（HTTP ${response.status}）`);
      return response.blob();
    }
  }

  function decodeImageSource(src, revoke = null, options = {}) {
    return new Promise((resolve, reject) => {
      const image = new global.Image();
      const signal = options.signal;
      let settled = false;
      const cleanup = () => signal?.removeEventListener?.('abort', abort);
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        image.onload = null;
        image.onerror = null;
        callback(value);
      };
      const abort = () => {
        finish(reject, createAbortError());
        image.src = '';
        if (revoke) revoke();
      };
      image.decoding = 'async';
      image.onload = () => finish(resolve, { image, revoke });
      image.onerror = () => {
        if (revoke) revoke();
        finish(reject, new Error('图片解码失败'));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener?.('abort', abort, { once: true });
      image.src = src;
    });
  }

  async function loadImageAsset(url, options = {}) {
    try {
      const blob = await fetchImageBlob(url, options);
      throwIfAborted(options.signal);
      const objectUrl = global.URL.createObjectURL(blob);
      return await decodeImageSource(
        objectUrl,
        () => global.URL.revokeObjectURL(objectUrl),
        options,
      );
    } catch (error) {
      if (options.signal?.aborted || error?.name === 'AbortError') throw createAbortError();
      const image = new global.Image();
      image.crossOrigin = 'anonymous';
      return new Promise((resolve, reject) => {
        const signal = options.signal;
        let settled = false;
        const cleanup = () => signal?.removeEventListener?.('abort', abort);
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          cleanup();
          image.onload = null;
          image.onerror = null;
          callback(value);
        };
        const abort = () => {
          finish(reject, createAbortError());
          image.src = '';
        };
        image.onload = () => finish(resolve, { image, revoke: null });
        image.onerror = () => finish(reject, new Error('图片加载失败'));
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener?.('abort', abort, { once: true });
        image.src = url;
      });
    }
  }

  function drawImageCover(context, image, rect, radius = 0) {
    const imageWidth = image.naturalWidth || image.width;
    const imageHeight = image.naturalHeight || image.height;
    if (!(imageWidth > 0) || !(imageHeight > 0)) return;

    const scale = Math.max(rect.width / imageWidth, rect.height / imageHeight);
    const sourceWidth = rect.width / scale;
    const sourceHeight = rect.height / scale;
    const sourceX = (imageWidth - sourceWidth) / 2;
    const sourceY = (imageHeight - sourceHeight) / 2;

    context.save();
    if (radius) {
      roundedRectPath(context, rect.x, rect.y, rect.width, rect.height, radius);
      context.clip();
    }
    context.drawImage(
      image,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
    );
    context.restore();
  }

  function drawImageContain(context, image, rect, radius = 0) {
    const imageWidth = image.naturalWidth || image.width;
    const imageHeight = image.naturalHeight || image.height;
    if (!(imageWidth > 0) || !(imageHeight > 0)) return;

    const scale = Math.min(rect.width / imageWidth, rect.height / imageHeight);
    const drawWidth = imageWidth * scale;
    const drawHeight = imageHeight * scale;
    const drawX = rect.x + (rect.width - drawWidth) / 2;
    const drawY = rect.y + (rect.height - drawHeight) / 2;

    context.save();
    if (radius) {
      roundedRectPath(context, rect.x, rect.y, rect.width, rect.height, radius);
      context.clip();
    }
    context.fillStyle = '#f7f9f9';
    context.fillRect(rect.x, rect.y, rect.width, rect.height);
    context.drawImage(image, drawX, drawY, drawWidth, drawHeight);
    context.restore();
  }

  function drawMediaBorder(context, rect, config, radius = 22) {
    const inset = config.borderWidth / 2;
    const sourceRadii = typeof radius === 'number'
      ? { topLeft: radius, topRight: radius, bottomRight: radius, bottomLeft: radius }
      : radius;
    const insetRadii = Object.fromEntries(
      Object.entries(sourceRadii).map(([key, value]) => [key, Math.max(0, value - inset)]),
    );
    context.save();
    roundedRectPath(
      context,
      rect.x + inset,
      rect.y + inset,
      rect.width - config.borderWidth,
      rect.height - config.borderWidth,
      insetRadii,
    );
    context.strokeStyle = config.borderColor;
    context.lineWidth = config.borderWidth;
    context.stroke();
    context.restore();
  }

  function drawVideoPlayOverlay(context, rect) {
    const overlay = getVideoPlayOverlayLayout(rect);
    const radius = overlay.diameter / 2;
    context.save();
    context.fillStyle = 'rgba(15,20,25,0.78)';
    context.strokeStyle = 'rgba(255,255,255,0.94)';
    context.lineWidth = Math.max(3, overlay.diameter * 0.035);
    context.beginPath();
    context.arc(overlay.centerX, overlay.centerY, radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.fillStyle = '#ffffff';
    context.beginPath();
    context.moveTo(overlay.triangle[0].x, overlay.triangle[0].y);
    context.lineTo(overlay.triangle[1].x, overlay.triangle[1].y);
    context.lineTo(overlay.triangle[2].x, overlay.triangle[2].y);
    context.closePath();
    context.fill();
    context.restore();
  }

  function drawAvatarInRect(context, asset, tweet, rect) {
    context.save();
    roundedRectPath(context, rect.x, rect.y, rect.width, rect.height, rect.width / 2);
    context.clip();
    if (asset?.image) {
      drawImageCover(context, asset.image, rect);
    } else {
      const gradient = context.createLinearGradient(rect.x, rect.y, rect.x + rect.width, rect.y + rect.height);
      gradient.addColorStop(0, '#1d9bf0');
      gradient.addColorStop(1, '#7856ff');
      context.fillStyle = gradient;
      context.fillRect(rect.x, rect.y, rect.width, rect.height);
      context.fillStyle = '#ffffff';
      context.font = `700 ${Math.round(rect.width * 0.44)}px ${FONT_STACK}`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(
        Array.from(tweet.authorName || tweet.handle || 'X')[0] || 'X',
        rect.x + rect.width / 2,
        rect.y + rect.height / 2 + 2,
      );
    }
    context.restore();

    context.save();
    context.strokeStyle = 'rgba(15, 20, 25, 0.08)';
    context.lineWidth = 2;
    roundedRectPath(context, rect.x, rect.y, rect.width, rect.height, rect.width / 2);
    context.stroke();
    context.restore();
  }

  function drawAvatar(context, asset, tweet, layout) {
    drawAvatarInRect(context, asset, tweet, layout.avatarRect);
  }

  function drawMediaPlaceholder(context, rect, radius = 22) {
    context.save();
    roundedRectPath(context, rect.x, rect.y, rect.width, rect.height, radius);
    context.fillStyle = '#eff3f4';
    context.fill();
    context.fillStyle = '#8b98a5';
    context.font = `600 30px ${FONT_STACK}`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('图片暂不可用', rect.x + rect.width / 2, rect.y + rect.height / 2);
    context.restore();
  }

  function createAbortError() {
    const error = new Error('图片生成已取消');
    error.name = 'AbortError';
    return error;
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) throw createAbortError();
  }

  async function mapWithConcurrency(values, concurrency, mapper) {
    const items = Array.from(values || []);
    const results = new Array(items.length);
    let nextIndex = 0;
    async function worker() {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    }
    const workerCount = Math.min(
      items.length,
      Math.max(1, Math.floor(Number(concurrency) || 1)),
    );
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }

  async function loadTweetAssetBundle(tweet, options = {}) {
    if (!tweet) return { avatarAsset: null, mediaAssets: [], loaded: [] };
    const assetUrls = [tweet.avatarUrl, ...tweet.mediaUrls].filter(Boolean);
    const loadImage = options.loadImage || loadImageAsset;
    const loaded = await mapWithConcurrency(
      assetUrls,
      options.concurrency || 3,
      async (url) => {
        throwIfAborted(options.signal);
        try {
          const asset = await loadImage(url, { signal: options.signal });
          options.onAsset?.(asset);
          return asset;
        } catch (error) {
          if (options.signal?.aborted || error?.name === 'AbortError') throw createAbortError();
          return null;
        }
      },
    );
    throwIfAborted(options.signal);
    let loadedIndex = 0;
    const avatarAsset = tweet.avatarUrl ? loaded[loadedIndex++] : null;
    const mediaAssets = tweet.mediaUrls.map(() => loaded[loadedIndex++] || null);
    return { avatarAsset, mediaAssets, loaded };
  }

  function getSingleMediaAspectRatio(mediaAssets) {
    const image = mediaAssets.length === 1 ? mediaAssets[0]?.image : null;
    return image
      ? (image.naturalHeight || image.height) / (image.naturalWidth || image.width)
      : undefined;
  }

  function drawTweetMedia(context, tweet, mediaAssets, mediaRects) {
    const mediaRenderConfig = getMediaRenderConfig(mediaRects.length);
    mediaRects.forEach((rect, index) => {
      const asset = mediaAssets[index];
      const radius = getMediaTileRadii(mediaRects.length, index);
      if (asset?.image && mediaRenderConfig.fit === 'contain') {
        drawImageContain(context, asset.image, rect, radius);
      } else if (asset?.image) {
        drawImageCover(context, asset.image, rect, radius);
      } else {
        drawMediaPlaceholder(context, rect, radius);
      }
      drawMediaBorder(context, rect, mediaRenderConfig, radius);
      if (tweet.videoPosterUrl && tweet.mediaUrls[index] === tweet.videoPosterUrl) {
        drawVideoPlayOverlay(context, rect);
      }
    });
  }

  function formatContextPublishedAt(value) {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
      }).format(date);
    } catch (_error) {
      return date.toLocaleDateString();
    }
  }

  function drawContextTweet(context, contextLayout, assets) {
    const { rect, tweet } = contextLayout;
    context.save();
    roundedRectPath(context, rect.x, rect.y, rect.width, rect.height, 28);
    context.fillStyle = '#ffffff';
    context.fill();
    context.strokeStyle = '#cfd9df';
    context.lineWidth = 3;
    context.stroke();
    context.restore();

    context.textAlign = 'left';
    context.textBaseline = 'alphabetic';
    context.fillStyle = '#536471';
    context.font = `650 24px ${FONT_STACK}`;
    context.fillText(
      contextLayout.kind === 'reply' ? '回复的推文' : '引用推文',
      rect.x + 34,
      contextLayout.labelTop + 22,
    );

    drawAvatarInRect(context, assets.avatarAsset, tweet, contextLayout.avatarRect);

    context.fillStyle = '#0f1419';
    context.font = `700 28px ${FONT_STACK}`;
    const badgeSize = 26;
    const badgeReserve = tweet.isVerified ? badgeSize + 8 : 0;
    const displayName = fitCanvasText(
      context,
      tweet.authorName || tweet.handle || 'X 用户',
      contextLayout.identityWidth - badgeReserve,
    );
    const nameBaselineY = contextLayout.headerTop + 25;
    const nameMetrics = context.measureText(displayName);
    context.fillText(displayName, contextLayout.identityX, nameBaselineY);
    if (tweet.isVerified) {
      drawVerifiedBadge(
        context,
        contextLayout.identityX + nameMetrics.width + 8,
        getInlineBadgeTop(nameBaselineY, badgeSize, nameMetrics, 28),
        badgeSize,
      );
    }

    const contextDate = formatContextPublishedAt(tweet.publishedAt);
    const meta = [tweet.handle, contextDate].filter(Boolean).join(' · ');
    context.fillStyle = '#536471';
    context.font = `400 23px ${FONT_STACK}`;
    context.fillText(
      fitCanvasText(context, meta, contextLayout.identityWidth),
      contextLayout.identityX,
      contextLayout.headerTop + 54,
    );

    context.font = `400 32px ${FONT_STACK}`;
    for (let index = 0; index < contextLayout.textLineRuns.length; index += 1) {
      const runs = contextLayout.textLineRuns[index];
      if (runs.length) {
        drawTweetTextRuns(
          context,
          runs,
          rect.x + 34,
          contextLayout.textTop + (index + 1) * contextLayout.textLineHeight - 8,
        );
      }
    }

    drawTweetMedia(context, tweet, assets.mediaAssets, contextLayout.mediaRects);
  }

  function drawQrModules(context, matrix, rect) {
    const moduleCount = matrix.length;
    if (!moduleCount) return;
    const render = getQrRenderConfig(moduleCount, rect);
    context.fillStyle = '#0f1419';
    for (let row = 0; row < moduleCount; row += 1) {
      let runStart = -1;
      for (let column = 0; column <= moduleCount; column += 1) {
        const isDark = column < moduleCount && matrix[row]?.[column];
        if (isDark && runStart < 0) {
          runStart = column;
        } else if (!isDark && runStart >= 0) {
          context.fillRect(
            render.originX + runStart * render.moduleSize,
            render.originY + row * render.moduleSize,
            (column - runStart) * render.moduleSize,
            render.moduleSize,
          );
          runStart = -1;
        }
      }
    }
  }

  function drawSourceGuide(context, sourceGuide, qrMatrix) {
    if (!sourceGuide || !qrMatrix.length) return;
    const { qrRect } = sourceGuide;
    const textX = getSourceGuideTextX(sourceGuide, qrMatrix.length);
    context.save();

    context.textAlign = 'left';
    context.textBaseline = 'alphabetic';
    context.fillStyle = '#1d9bf0';
    context.font = `700 30px ${FONT_STACK}`;
    context.fillText(sourceGuide.label, textX, sourceGuide.labelBaselineY);

    context.fillStyle = '#536471';
    context.font = `400 23px ${FONT_STACK}`;
    context.fillText(
      fitCanvasText(context, sourceGuide.url, qrRect.x - textX - 36),
      textX,
      sourceGuide.urlBaselineY,
    );

    drawQrModules(context, qrMatrix, qrRect);

    context.restore();
  }

  async function renderShareCard(rawTweet, options = {}) {
    const tweet = normalizeTweetData(rawTweet);
    const measureCanvas = document.createElement('canvas');
    const measureContext = measureCanvas.getContext('2d');
    const loadedAssets = [];
    const loadOptions = {
      concurrency: 3,
      signal: options.signal,
      onAsset: (asset) => loadedAssets.push(asset),
    };
    try {
      throwIfAborted(options.signal);
      const primaryAssets = await loadTweetAssetBundle(tweet, loadOptions);
      const contextAssets = await loadTweetAssetBundle(tweet.context?.tweet, loadOptions);
      throwIfAborted(options.signal);
      const singleMediaAspectRatio = getSingleMediaAspectRatio(primaryAssets.mediaAssets);
      const contextSingleMediaAspectRatio = getSingleMediaAspectRatio(contextAssets.mediaAssets);
      const layout = buildCardLayout(
        tweet,
        (text) => {
          measureContext.font = `400 42px ${FONT_STACK}`;
          return measureContext.measureText(text).width;
        },
        {
          singleMediaAspectRatio,
          contextSingleMediaAspectRatio,
          contextMeasureText: (text) => {
            measureContext.font = `400 32px ${FONT_STACK}`;
            return measureContext.measureText(text).width;
          },
        },
      );
      const qrMatrix = layout.sourceGuide
        ? createQrMatrix(layout.sourceGuide.url)
        : [];
      const renderSize = getCanvasRenderSize(layout.canvasWidth, layout.canvasHeight);
      const canvas = document.createElement('canvas');
      canvas.width = renderSize.width;
      canvas.height = renderSize.height;
      const context = canvas.getContext('2d');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.scale(renderSize.scale, renderSize.scale);
      throwIfAborted(options.signal);

      context.fillStyle = '#f4f7fb';
      context.fillRect(0, 0, layout.canvasWidth, layout.canvasHeight);

      context.save();
      context.shadowColor = 'rgba(25, 39, 52, 0.18)';
      context.shadowBlur = 44;
      context.shadowOffsetY = 18;
      roundedRectPath(context, layout.card.x, layout.card.y, layout.card.width, layout.card.height, 44);
      context.fillStyle = '#ffffff';
      context.fill();
      context.restore();

      roundedRectPath(context, layout.card.x, layout.card.y, layout.card.width, layout.card.height, 44);
      context.strokeStyle = 'rgba(15,20,25,0.08)';
      context.lineWidth = 2;
      context.stroke();

      drawAvatar(context, primaryAssets.avatarAsset, tweet, layout);

      const identityX = layout.contentX + 132;
      const identityWidth = layout.contentWidth - 132 - 100;
      context.textAlign = 'left';
      context.textBaseline = 'alphabetic';
      context.fillStyle = '#0f1419';
      context.font = `700 38px ${FONT_STACK}`;
      const verifiedConfig = getVerifiedBadgeConfig();
      const badgeReserve = tweet.isVerified ? verifiedConfig.size + 10 : 0;
      const displayName = fitCanvasText(
        context,
        tweet.authorName || tweet.handle || 'X 用户',
        identityWidth - badgeReserve,
      );
      const nameBaselineY = layout.headerTop + 43;
      const nameMetrics = context.measureText(displayName);
      context.fillText(displayName, identityX, nameBaselineY);
      if (tweet.isVerified) {
        const badgeX = identityX + nameMetrics.width + 10;
        const badgeY = getInlineBadgeTop(
          nameBaselineY,
          verifiedConfig.size,
          nameMetrics,
          38,
        );
        drawVerifiedBadge(context, badgeX, badgeY);
      }
      context.fillStyle = '#536471';
      context.font = `400 30px ${FONT_STACK}`;
      context.fillText(fitCanvasText(context, tweet.handle, identityWidth), identityX, layout.headerTop + 87);

      drawBrandLogo(
        context,
        layout.brandLogoRect.x,
        layout.brandLogoRect.y,
      );

      context.textAlign = 'left';
      context.textBaseline = 'alphabetic';
      context.font = `400 42px ${FONT_STACK}`;
      for (let index = 0; index < layout.textLineRuns.length; index += 1) {
        const runs = layout.textLineRuns[index];
        if (runs.length) {
          drawTweetTextRuns(
            context,
            runs,
            layout.contentX,
            layout.textTop + (index + 1) * layout.textLineHeight - 10,
          );
        }
      }

      drawTweetMedia(context, tweet, primaryAssets.mediaAssets, layout.mediaRects);

      if (layout.contextLayout) {
        drawContextTweet(context, layout.contextLayout, contextAssets);
      }

      context.strokeStyle = '#eff3f4';
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(layout.contentX, layout.footerTop - 26);
      context.lineTo(layout.contentX + layout.contentWidth, layout.footerTop - 26);
      context.stroke();

      context.fillStyle = '#536471';
      context.font = `400 27px ${FONT_STACK}`;
      context.textAlign = 'left';
      context.fillText(formatPublishedAt(tweet.publishedAt), layout.contentX, layout.footerTop + 25);

      drawSourceGuide(context, layout.sourceGuide, qrMatrix);
      throwIfAborted(options.signal);
      return canvas;
    } finally {
      for (const asset of loadedAssets) asset?.revoke?.();
    }
  }

  function canvasToPngBlob(canvas) {
    return new Promise((resolve, reject) => {
      try {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('浏览器没有生成 PNG 图片'));
        }, 'image/png');
      } catch (error) {
        reject(error);
      }
    });
  }

  function cardFileName(tweet) {
    const id = tweet.statusUrl.match(/\/status\/(\d+)/)?.[1] || String(Date.now());
    const handle = tweet.handle.replace(/^@/, '') || 'post';
    return `x-share-${handle}-${id}.png`;
  }

  function downloadBlob(blob, fileName) {
    const objectUrl = global.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = fileName;
    link.style.display = 'none';
    document.body.append(link);
    link.click();
    link.remove();
    global.setTimeout(() => global.URL.revokeObjectURL(objectUrl), 1000);
  }

  async function copyPngBlob(blob) {
    const ClipboardItemClass = global.ClipboardItem;
    if (!global.navigator?.clipboard?.write || typeof ClipboardItemClass !== 'function') {
      throw new Error('当前浏览器不支持直接复制图片');
    }
    await global.navigator.clipboard.write([
      new ClipboardItemClass({ 'image/png': blob }),
    ]);
  }

  function createShareCardModal(tweet, options = {}) {
    state.modalClose?.();

    const host = document.createElement('div');
    host.setAttribute('data-tsc-modal-host', '');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host{position:fixed;inset:0;z-index:2147483646;font-family:${FONT_STACK};color:#0f1419;color-scheme:light}
        *{box-sizing:border-box}
        button{font:inherit}
        .backdrop{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(15,20,25,.66);backdrop-filter:blur(10px)}
        .modal{display:grid;grid-template-rows:auto minmax(0,1fr) auto;width:min(680px,100%);max-height:min(900px,calc(100dvh - 36px));overflow:hidden;border:1px solid rgba(255,255,255,.38);border-radius:28px;background:#f7f9f9}
        .header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding:22px 24px 18px;background:rgba(255,255,255,.96);border-bottom:1px solid #eff3f4}
        .eyebrow{margin:0 0 4px;color:#1d9bf0;font-size:12px;font-weight:800;letter-spacing:.13em;text-transform:uppercase}
        h2{margin:0;font-size:22px;line-height:1.25;letter-spacing:-.02em}
        .subtitle{margin:6px 0 0;color:#536471;font-size:14px;line-height:1.45}
        .close{flex:0 0 auto;display:grid;place-items:center;width:36px;height:36px;border:0;border-radius:999px;background:#eff3f4;color:#0f1419;cursor:pointer;transition:.16s ease}
        .close:hover{background:#dfe5e8;transform:rotate(4deg)}
        .close:focus-visible,.button:focus-visible{outline:3px solid rgba(29,155,240,.32);outline-offset:2px}
        .preview-shell{min-height:280px;overflow:auto;padding:24px;background:#f4f7fb;overscroll-behavior:contain}
        .preview{display:block;width:100%;height:auto;border-radius:18px}
        .preview[hidden]{display:none}
        .loading{display:grid;place-items:center;align-content:center;gap:16px;min-height:330px;color:#536471;text-align:center}
        .loading[hidden]{display:none}
        .spinner{width:38px;height:38px;border:4px solid rgba(29,155,240,.18);border-top-color:#1d9bf0;border-radius:50%;animation:spin .8s linear infinite}
        .loading p{margin:0;font-size:14px}
        .error{max-width:420px;margin:auto;padding:18px;border:1px solid #ffd4d8;border-radius:16px;background:#fff1f2;color:#8a1c26;line-height:1.55;text-align:left}
        .footer{padding:16px 20px 18px;background:#fff;border-top:1px solid #eff3f4}
        .status{min-height:20px;margin:0 2px 12px;color:#536471;font-size:13px;line-height:1.45}
        .actions{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,.62fr);gap:10px}
        .button{min-height:46px;padding:0 18px;border-radius:999px;font-weight:750;cursor:pointer;transition:transform .15s ease,background .15s ease,border-color .15s ease}
        .button:hover:not(:disabled){transform:translateY(-1px)}
        .button:disabled{cursor:not-allowed;opacity:.48}
        .primary{border:1px solid #0f1419;background:#0f1419;color:#fff}
        .primary:hover:not(:disabled){background:#272c30}
        .secondary{border:1px solid #cfd9df;background:#fff;color:#0f1419}
        .secondary:hover:not(:disabled){background:#f0f4f6;border-color:#b6c2ca}
        @keyframes spin{to{transform:rotate(360deg)}}
        @media(prefers-reduced-motion:reduce){.spinner{animation-duration:1.8s}.close,.button{transition:none}}
      </style>
      <div class="backdrop">
        <section class="modal" role="dialog" aria-modal="true" aria-labelledby="tsc-title">
          <header class="header">
            <div>
              <p class="eyebrow">Share card</p>
              <h2 id="tsc-title">生成推文分享图</h2>
              <p class="subtitle">预览确认后，可直接复制 PNG 或下载到本地。</p>
            </div>
            <button class="close" type="button" aria-label="关闭">✕</button>
          </header>
          <div class="preview-shell">
            <div class="loading">
              <span class="spinner" aria-hidden="true"></span>
              <p>正在整理推文内容和图片…</p>
            </div>
            <img class="preview" alt="生成的推文分享卡片预览" hidden>
          </div>
          <footer class="footer">
            <p class="status" role="status" aria-live="polite">图片只在当前浏览器中生成，不会上传。</p>
            <div class="actions">
              <button class="button primary copy" type="button" disabled>复制图片</button>
              <button class="button secondary download" type="button" disabled>下载 PNG</button>
            </div>
          </footer>
        </section>
      </div>
    `;
    document.body.append(host);

    const backdrop = shadow.querySelector('.backdrop');
    const closeButton = shadow.querySelector('.close');
    const loading = shadow.querySelector('.loading');
    const preview = shadow.querySelector('.preview');
    const status = shadow.querySelector('.status');
    const copyButton = shadow.querySelector('.copy');
    const downloadButton = shadow.querySelector('.download');
    let previewUrl = '';
    let pngBlob = null;
    let closed = false;

    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKeyDown, true);
      if (previewUrl) global.URL.revokeObjectURL(previewUrl);
      host.remove();
      if (state.modalClose === close) state.modalClose = null;
      options.onClose?.();
    }

    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    }

    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close();
    });
    closeButton.addEventListener('click', close);
    document.addEventListener('keydown', onKeyDown, true);
    state.modalClose = close;

    copyButton.addEventListener('click', async () => {
      if (!pngBlob) return;
      copyButton.disabled = true;
      copyButton.textContent = '正在复制…';
      try {
        await copyPngBlob(pngBlob);
        copyButton.textContent = '已复制 ✓';
        status.textContent = '分享图已复制，可以直接粘贴到聊天或文档中。';
      } catch (error) {
        copyButton.textContent = '复制图片';
        status.textContent = `${error?.message || '复制失败'}，请使用“下载 PNG”。`;
      } finally {
        copyButton.disabled = false;
      }
    });

    downloadButton.addEventListener('click', () => {
      if (!pngBlob) return;
      downloadBlob(pngBlob, cardFileName(tweet));
      status.textContent = 'PNG 已开始下载。';
    });

    global.setTimeout(() => closeButton.focus(), 0);

    return {
      close,
      setError(message) {
        if (closed) return;
        loading.innerHTML = `<div class="error"></div>`;
        loading.querySelector('.error').textContent = message;
        status.textContent = '没有生成图片，请关闭后重试。';
      },
      setReady(blob) {
        if (closed) return;
        pngBlob = blob;
        previewUrl = global.URL.createObjectURL(blob);
        preview.src = previewUrl;
        preview.hidden = false;
        loading.hidden = true;
        copyButton.disabled = false;
        downloadButton.disabled = false;
        if (!global.navigator?.clipboard?.write || typeof global.ClipboardItem !== 'function') {
          copyButton.disabled = true;
          status.textContent = '当前浏览器不支持直接复制图片，可以下载 PNG。';
        } else {
          status.textContent = '图片只在当前浏览器中生成，不会上传。';
        }
      },
    };
  }

  async function openShareCard(article) {
    document.dispatchEvent(new global.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    state.renderAbort?.abort();
    const renderAbort = new global.AbortController();
    state.renderAbort = renderAbort;
    const tweet = extractTweetData(article);
    const modal = createShareCardModal(tweet, {
      onClose: () => renderAbort.abort(),
    });

    if (!(tweet.authorName || tweet.handle) || !(tweet.text || tweet.mediaUrls.length)) {
      modal.setError('没有从当前推文读取到足够内容。X 可能刚更新了页面结构，请刷新后重试。');
      renderAbort.abort();
      if (state.renderAbort === renderAbort) state.renderAbort = null;
      return;
    }

    try {
      const canvas = await renderShareCard(tweet, { signal: renderAbort.signal });
      throwIfAborted(renderAbort.signal);
      const blob = await canvasToPngBlob(canvas);
      throwIfAborted(renderAbort.signal);
      modal.setReady(blob);
    } catch (error) {
      if (error?.name !== 'AbortError') {
        modal.setError(`生成分享图失败：${error?.message || '未知错误'}`);
      }
    } finally {
      if (state.renderAbort === renderAbort) state.renderAbort = null;
    }
  }

  function replaceMenuItemLabel(action, label) {
    const showText = global.NodeFilter?.SHOW_TEXT || 4;
    const walker = document.createTreeWalker(action, showText);
    const textNodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeValue?.trim()) textNodes.push(node);
    }
    if (textNodes.length) {
      textNodes[0].nodeValue = label;
      for (const node of textNodes.slice(1)) node.nodeValue = '';
      return;
    }

    const fallback = document.createElement('span');
    fallback.textContent = label;
    action.append(fallback);
  }

  function createShareMenuAction(reference, article, kind = 'share-card') {
    const label = kind === 'cobalt-download' ? '下载视频' : '生成分享图';
    const action = reference.cloneNode(true);
    action.__tscArticle = article;
    action.setAttribute('data-tsc-action', kind);
    action.setAttribute('role', 'menuitem');
    action.setAttribute('tabindex', '0');
    action.setAttribute('aria-label', label);
    action.removeAttribute('data-testid');
    action.removeAttribute('href');
    action.removeAttribute('aria-disabled');
    for (const node of [action, ...action.querySelectorAll('[id], [aria-labelledby], [aria-controls]')]) {
      node.removeAttribute('id');
      node.removeAttribute('aria-labelledby');
      node.removeAttribute('aria-controls');
    }
    for (const child of action.querySelectorAll('[data-testid], [href]')) {
      child.removeAttribute('data-testid');
      child.removeAttribute('href');
    }
    replaceMenuItemLabel(action, label);

    const icon = action.querySelector('svg');
    if (icon) {
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.innerHTML = '<path d="M5 3.75h14A2.25 2.25 0 0 1 21.25 6v12A2.25 2.25 0 0 1 19 20.25H5A2.25 2.25 0 0 1 2.75 18V6A2.25 2.25 0 0 1 5 3.75Zm0 1.5a.75.75 0 0 0-.75.75v8.13l2.69-2.69a1.5 1.5 0 0 1 2.12 0l2.19 2.19 3.69-3.69a1.5 1.5 0 0 1 2.12 0l2.69 2.69V6a.75.75 0 0 0-.75-.75H5Zm14.75 9-3.75-3.75-4.22 4.22a.75.75 0 0 1-1.06 0L8 12l-3.75 3.75V18c0 .414.336.75.75.75h14a.75.75 0 0 0 .75-.75v-3.75ZM8.25 7a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5Z" fill="currentColor"/>';
    }

    if (icon && kind === 'cobalt-download') icon.innerHTML = '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
    action.style.cursor = 'pointer';
    action.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (kind === 'cobalt-download') {
        const url = extractVideoTweetUrl(action.__tscArticle);
        if (url) void cobalt.startCobaltDownload(url);
      } else if (action.__tscArticle) void openShareCard(action.__tscArticle);
    });
    action.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        action.click();
      }
    });
    return action;
  }

  function mountShareMenuActions() {
    state.mountScheduled = false;
    const roleMenus = Array.from(document.querySelectorAll('[role="menu"]'));
    const menus = roleMenus.length
      ? roleMenus
      : Array.from(document.querySelectorAll('[data-testid="Dropdown"]'));

    let mounted = false;
    for (const menu of menus) {
      if (!isTweetShareMenu(menu)) continue;
      const reference = findShareMenuAnchor(menu);
      if (!reference || !reference.parentNode) continue;
      const article = state.activeArticle || menu.querySelector('[data-tsc-action]')?.__tscArticle;
      if (!article?.isConnected) continue;
      const videoUrl = extractVideoTweetUrl(article);
      const nativeDownloads = findNativeVideoDownloadItems(menu);
      for (const native of nativeDownloads) {
        if (videoUrl) native.setAttribute('data-mxga-native-video-download', '');
        else native.removeAttribute('data-mxga-native-video-download');
      }
      for (const kind of ['share-card', 'cobalt-download']) {
        const existing = menu.querySelector(`[data-tsc-action="${kind}"]`);
        // The share-card extractor still requires the classic X content fields.
        if ((kind === 'cobalt-download' && !videoUrl)
          || (kind === 'share-card' && !article.matches('[data-testid="tweet"]'))) {
          existing?.remove();
          continue;
        }
        const anchor = kind === 'cobalt-download' ? nativeDownloads[0] || reference : reference;
        if (existing) {
          existing.__tscArticle = article;
          if (kind === 'cobalt-download' && nativeDownloads.length && existing.nextSibling !== anchor) {
            anchor.parentNode.insertBefore(existing, anchor);
          }
        } else anchor.parentNode.insertBefore(createShareMenuAction(reference, article, kind), anchor);
      }
      mounted = true;
    }
    if (mounted) state.activeArticle = null;
  }

  function scheduleShareMenuMount() {
    if (state.mountScheduled) return;
    if (!state.activeArticle && !document.querySelector('[role="menu"] [data-tsc-action], [data-testid="Dropdown"] [data-tsc-action]')) return;
    state.mountScheduled = true;
    global.requestAnimationFrame(mountShareMenuActions);
  }

  document.addEventListener('click', (event) => {
    const target = event.target instanceof global.Element ? event.target : null;
    const candidateButton = target?.closest?.('button, [role="button"]');
    const shareButton = isTweetShareButton(candidateButton) ? candidateButton : null;
    if (!shareButton) return;
    const article = shareButton.closest?.('article');
    if (!article) { state.activeArticle = null; return; }
    state.activeArticle = article;
    scheduleShareMenuMount();
    global.setTimeout(scheduleShareMenuMount, 80);
  }, true);

  const observer = new global.MutationObserver(scheduleShareMenuMount);
  observer.observe(document.body, { childList: true, subtree: true });
}(typeof globalThis !== 'undefined' ? globalThis : this));
