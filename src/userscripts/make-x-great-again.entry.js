// ==UserScript==
// @name         Make X Great Again (Userscript)
// @namespace    https://github.com/kyangc/tampermonkey_scripts
// @version      0.7.4
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
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.xmlHttpRequest
// @grant        GM.download
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
    const cobalt = normalizeCobaltSyncEvent(value?.cobalt);
    if (value?.cobalt !== undefined && value.cobalt?.v !== 1 && !cobalt) throw new Error('cobalt 同步配置格式无效，已保留本地配置。');
    return { items, schema: 1, ...(cobalt ? { cobalt } : {}) };
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
    return { ...document, items, schema: 1 };
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
    const cobalt = newestCobaltSyncEvent(left.cobalt, right.cobalt);
    return { items, schema: 1, ...(cobalt ? { cobalt } : {}) };
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
    return JSON.stringify({ ...document, items, schema: 1 });
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
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
        method: 'GET',
        url: endpoint + '/v2/snapshot',
      });
      if (fetched?.status !== 200) {
        throw new Error(fetched?.body?.error?.message || '无法读取同步列表。');
      }

      const prepared = options.prepareDocument
        ? await options.prepareDocument(localState.document, normalizeFilterDocument(fetched.body?.document))
        : localState.document;
      let revision = Number(fetched.body?.revision) || 0;
      let document = mergeFilterDocuments(prepared, fetched.body?.document);
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
          url: endpoint + '/v2/snapshot',
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
    normalizeCobaltSyncEvent,
    newestCobaltSyncEvent,
    createCobaltConfigSync,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = core;
    return;
  }

  createMxgaVideoSource(global, typeof unsafeWindow !== 'undefined' ? unsafeWindow : global);
  if (global.document?.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', () => makeXGreatAgainUserscript(global), { once: true });
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
    const cobaltConfigSync = createCobaltConfigSync(gm);
    const filterSynchronizer = createFilterSynchronizer({
      endpoint: FILTER_SYNC_ENDPOINT,
      requestJson,
      prepareDocument: (local, remote) => cobaltConfigSync.prepare(local, remote, state.filterSync.deviceId),
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
        const cobaltApplied = await cobaltConfigSync.apply(document.cobalt);
        scanner.schedule();
        if (!cobaltApplied) filterSyncQueued = true;
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

    document.addEventListener('mxga-cobalt-config-saved', () => {
      void cobaltConfigSync.markChanged().then(() => {
        if (state.filterSync.token) scheduleFilterSync();
      }).catch((error) => { state.filterSyncError = errorMessage(error); render(); });
    });

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
