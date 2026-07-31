// ==UserScript==
// @name         Make X Great Again (Userscript)
// @namespace    https://github.com/kyangc/tampermonkey_scripts
// @version      0.2.1
// @description  Mark public-list spam accounts and generate share cards on X across PC and iOS.
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
// @inject-into  content
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.xmlHttpRequest
// @grant        GM.openInTab
// @connect      x.zuoluo.tv
// @connect      pbs.twimg.com
// @noframes
// ==/UserScript==

// Source entry for tools/build-userscripts.mjs.
// SPDX-License-Identifier: AGPL-3.0-or-later
// Userscript adaptation of https://github.com/foru17/make-x-great-again
// Original project and this derivative are licensed under AGPL-3.0-or-later.
// Modified on 2026-07-21 by kyangc: migrated the extension to a PC/iOS
// userscript, replaced extension background/storage APIs, and omitted X-native actions.

(function makeXGreatAgainUserscript(global) {
  'use strict';

  const CATEGORY_BY_CODE = {
    p: 'porn',
    c: 'crypto',
    g: 'gambling',
    r: 'resource',
    m: 'marketing',
    o: 'other',
  };

  const CATEGORY_ZH = {
    porn: '色情招揽',
    crypto: '币圈投放',
    gambling: '博彩推广',
    resource: '网盘资源',
    marketing: '营销引流',
    other: '其它',
  };

  const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
  const USER_ID_RE = /^\d{1,32}$/;
  const ENTRY_CODE_RE = /^[ps][pcgrmo](?:[ha])?$/;
  const VERSION_RE = /^[A-Za-z0-9._-]{1,128}$/;
  const MAX_LIST_ENTRIES = 250000;
  const MIN_SANE_ENTRIES = 1000;
  const MAX_LITE_BYTES = 25 * 1024 * 1024;
  const MAX_WHITELIST_BYTES = 2 * 1024 * 1024;
  const MAX_META_BYTES = 64 * 1024;
  const SERVICE_BASE = 'https://x.zuoluo.tv';
  const ARTIFACT_PATH_RE = /^\/v1\/artifacts\/[A-Za-z0-9._-]+$/;
  const STORAGE_KEYS = {
    listCache: 'mxga:list-cache:v2',
    listMeta: 'mxga:list-meta:v1',
    listRaw: 'mxga:list-raw:v1',
    whitelist: 'mxga:whitelist:v1',
    settings: 'mxga:settings:v1',
    hidden: 'mxga:hidden:v1',
    syncLock: 'mxga:sync-lock:v1',
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

  function validIdentity(userId, handle) {
    return (
      typeof userId === 'string' &&
      (userId === '' || USER_ID_RE.test(userId)) &&
      typeof handle === 'string' &&
      HANDLE_RE.test(handle)
    );
  }

  function isValidVersion(value) {
    return typeof value === 'string' && VERSION_RE.test(value);
  }

  function sanitizeStoredListMeta(value) {
    if (!value || typeof value !== 'object' || !isValidVersion(value.version)) return null;
    const fetchedAt = Number(value.fetchedAt);
    const count = Number(value.count);
    if (!Number.isFinite(fetchedAt) || fetchedAt <= 0 || !Number.isSafeInteger(count) || count < 0) {
      return null;
    }
    return { version: value.version, fetchedAt, count };
  }

  function sanitizeStoredListCache(value) {
    if (!value || value.schema !== 1 || typeof value.raw !== 'string' || !value.raw) return null;
    const meta = sanitizeStoredListMeta(value.meta);
    if (!meta) return null;
    return { schema: 1, raw: value.raw, meta };
  }

  async function readStoredListSnapshot(storage) {
    const cache = sanitizeStoredListCache(
      await storage.get(STORAGE_KEYS.listCache, null),
    );
    if (cache) return { raw: cache.raw, meta: cache.meta, legacy: false };

    const [raw, meta] = await Promise.all([
      storage.get(STORAGE_KEYS.listRaw, ''),
      storage.get(STORAGE_KEYS.listMeta, null),
    ]);
    return {
      raw: typeof raw === 'string' ? raw : '',
      meta: sanitizeStoredListMeta(meta),
      legacy: true,
    };
  }

  function validateLiteArtifact(raw) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'artifact is not an object' };
    if (raw.schema !== 2 || !Array.isArray(raw.entries)) {
      return { ok: false, error: 'unexpected lite schema' };
    }
    if (raw.entries.length > MAX_LIST_ENTRIES) return { ok: false, error: 'too many entries' };
    if (
      raw.version !== undefined &&
      !isValidVersion(raw.version)
    ) {
      return { ok: false, error: 'invalid version' };
    }
    if (
      raw.count !== undefined &&
      (!Number.isSafeInteger(raw.count) || raw.count !== raw.entries.length)
    ) {
      return { ok: false, error: 'entry count mismatch' };
    }
    for (const row of raw.entries) {
      if (
        !Array.isArray(row) ||
        row.length !== 3 ||
        !validIdentity(row[0], row[1]) ||
        typeof row[2] !== 'string' ||
        !ENTRY_CODE_RE.test(row[2])
      ) {
        return { ok: false, error: 'invalid entry row' };
      }
    }
    return {
      ok: true,
      value: {
        version: raw.version,
        entries: raw.entries,
      },
    };
  }

  function validateWhitelist(raw) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'whitelist is not an object' };
    if (!Array.isArray(raw.list) || raw.list.length > MAX_LIST_ENTRIES) {
      return { ok: false, error: 'invalid whitelist collection' };
    }
    const entries = [];
    for (const row of raw.list) {
      if (!row || typeof row !== 'object') return { ok: false, error: 'invalid whitelist row' };
      const userId = row.x_user_id == null ? '' : row.x_user_id;
      if (!validIdentity(userId, row.handle)) {
        return { ok: false, error: 'invalid whitelist identity' };
      }
      entries.push([userId, row.handle]);
    }
    return { ok: true, value: entries };
  }

  function parseJson(text, label) {
    if (typeof text !== 'string') throw new Error(`${label} response is not text`);
    try {
      return JSON.parse(text);
    } catch (_error) {
      throw new Error(`${label} response is not valid JSON`);
    }
  }

  function createListSynchronizer(options) {
    const requestText = options.requestText;
    const storage = options.storage;
    const now = options.now || Date.now;
    const baseUrl = String(options.baseUrl || SERVICE_BASE).replace(/\/+$/, '');

    async function refreshWhitelist() {
      try {
        const text = await requestText(`${baseUrl}/v1/whitelist`, MAX_WHITELIST_BYTES);
        const validated = validateWhitelist(parseJson(text, 'whitelist'));
        if (!validated.ok) return undefined;
        const previous = await storage.get(STORAGE_KEYS.whitelist, null);
        if (validated.value.length === 0 && previous?.entries?.length > 0) return undefined;
        const stored = {
          fetchedAt: now(),
          count: validated.value.length,
          entries: validated.value,
        };
        await storage.set(STORAGE_KEYS.whitelist, stored);
        return stored;
      } catch (_error) {
        return undefined;
      }
    }

    async function sync(force = false) {
      const refreshedWhitelist = await refreshWhitelist();
      const white = refreshedWhitelist?.count;
      try {
        const metaText = await requestText(`${baseUrl}/v1/list/meta`, MAX_META_BYTES);
        const meta = parseJson(metaText, 'list metadata');
        const metaVersion = isValidVersion(meta?.version) ? meta.version : '';
        const artifactPath = meta?.artifacts?.lite;
        if (!ARTIFACT_PATH_RE.test(artifactPath || '')) {
          return {
            updated: false,
            white,
            whitelistEntries: refreshedWhitelist?.entries,
            error: 'invalid lite artifact path',
          };
        }

        const stored = await readStoredListSnapshot(storage);
        if (!force && stored.meta?.version && metaVersion === stored.meta.version && stored.raw) {
          return {
            updated: false,
            version: stored.meta.version,
            black: stored.meta.count,
            white,
            whitelistEntries: refreshedWhitelist?.entries,
            meta: stored.meta,
          };
        }

        const artifactText = await requestText(`${baseUrl}${artifactPath}`, MAX_LITE_BYTES);
        const validated = validateLiteArtifact(parseJson(artifactText, 'lite artifact'));
        if (!validated.ok) {
          return {
            updated: false,
            white,
            whitelistEntries: refreshedWhitelist?.entries,
            error: validated.error,
          };
        }
        if (validated.value.entries.length < MIN_SANE_ENTRIES) {
          return {
            updated: false,
            white,
            whitelistEntries: refreshedWhitelist?.entries,
            error: `implausibly small list (${validated.value.entries.length})`,
          };
        }

        const nextMeta = {
          version: validated.value.version || metaVersion || `n${validated.value.entries.length}`,
          fetchedAt: now(),
          count: validated.value.entries.length,
        };
        await storage.set(STORAGE_KEYS.listCache, {
          schema: 1,
          raw: artifactText,
          meta: nextMeta,
        });
        return {
          updated: true,
          version: nextMeta.version,
          black: nextMeta.count,
          white,
          whitelistEntries: refreshedWhitelist?.entries,
          artifact: validated.value,
          meta: nextMeta,
        };
      } catch (error) {
        return {
          updated: false,
          white,
          whitelistEntries: refreshedWhitelist?.entries,
          error: errorMessage(error, '名单更新失败'),
        };
      }
    }

    return { sync };
  }

  function normalizeHandle(handle) {
    return typeof handle === 'string' ? handle.replace(/^@/, '').trim().toLowerCase() : '';
  }

  function compareHandles(left, right) {
    if (left === right) return 0;
    return left < right ? -1 : 1;
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

  function decodeEntry(row) {
    if (!Array.isArray(row) || row.length < 3) return null;
    const [userId, handle, code] = row;
    const normalizedHandle = normalizeHandle(handle);
    if (!normalizedHandle || typeof code !== 'string') return null;
    const category = CATEGORY_BY_CODE[code[1]] || 'other';
    return {
      userId: typeof userId === 'string' ? userId : '',
      handle,
      normalizedHandle,
      label: code[0] === 'p' ? 'porn_bot' : 'spam',
      category,
      categoryZh: CATEGORY_ZH[category],
      tier: code[2] === 'h' ? 'confirmed' : 'auto',
    };
  }

  function getAccountPresentation(entry) {
    if (!entry) return null;
    return {
      badgeText: entry.label === 'porn_bot' ? '色情' : '垃圾',
      categoryText: entry.categoryZh,
      tierText: entry.tier === 'confirmed' ? '人工确认' : '自动收录',
      shouldAutoHide: entry.tier === 'confirmed',
      canHideManually: true,
    };
  }

  function getAccountVisibility({ entry, settings, locallyHidden = false } = {}) {
    if (settings?.enabled === false) return 'shown';
    if (locallyHidden) return 'hidden';
    const presentation = getAccountPresentation(entry);
    if (!presentation) return 'shown';
    if (settings?.hideConfirmed !== false && presentation.shouldAutoHide) return 'hidden';
    return 'labeled';
  }

  function consumeBackdropClick(event, backdrop) {
    if (!event || event.target !== backdrop) return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    return true;
  }

  function createAccountIndex(entries, whitelistEntries = []) {
    const rows = Array.isArray(entries) ? entries : [];
    for (const row of rows) {
      if (Array.isArray(row) && typeof row[1] === 'string') row[1] = normalizeHandle(row[1]);
    }
    rows.sort((left, right) => compareHandles(left?.[1] || '', right?.[1] || ''));

    const whitelistIds = new Set();
    const whitelistHandles = new Set();
    for (const row of Array.isArray(whitelistEntries) ? whitelistEntries : []) {
      if (!Array.isArray(row)) continue;
      if (row[0]) whitelistIds.add(String(row[0]));
      const handle = normalizeHandle(row[1]);
      if (handle) whitelistHandles.add(handle);
    }

    function lookup(identity = {}) {
      const userId = identity.userId ? String(identity.userId) : '';
      const handle = normalizeHandle(identity.handle);
      if ((userId && whitelistIds.has(userId)) || (handle && whitelistHandles.has(handle))) return null;

      if (handle) {
        let low = 0;
        let high = rows.length - 1;
        while (low <= high) {
          const middle = (low + high) >> 1;
          const candidate = rows[middle]?.[1] || '';
          if (candidate === handle) return decodeEntry(rows[middle]);
          if (candidate < handle) low = middle + 1;
          else high = middle - 1;
        }
      }

      if (userId) {
        const row = rows.find((candidate) => String(candidate?.[0] || '') === userId);
        if (row) return decodeEntry(row);
      }
      return null;
    }

    return { lookup, size: rows.length };
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

  function findProfileNameBlock(root, handle) {
    if (!root || typeof root.querySelector !== 'function') return null;
    const standardNameBlock = root.querySelector('[data-testid="UserName"]');
    if (standardNameBlock) return standardNameBlock;

    const normalized = normalizeHandle(handle);
    if (!normalized) return null;
    const person = root.querySelector(
      '[itemprop="mainEntity"][itemtype="https://schema.org/Person"]',
    );
    if (!person || typeof person.querySelector !== 'function') return null;
    const additionalName = person.querySelector('meta[itemprop="additionalName"][content]');
    if (normalizeHandle(additionalName?.getAttribute?.('content')) !== normalized) return null;

    for (const candidate of person.querySelectorAll?.('div,span') || []) {
      if (candidate.children?.length > 0) continue;
      if (normalizeHandle(candidate.textContent) !== normalized) continue;
      const mount = candidate.parentElement;
      if (mount && person.contains?.(mount)) return mount;
    }
    return null;
  }

  function sanitizeStoredWhitelist(value) {
    const entries = [];
    for (const row of Array.isArray(value?.entries) ? value.entries : []) {
      if (Array.isArray(row) && row.length === 2 && validIdentity(row[0], row[1])) {
        entries.push([row[0], row[1]]);
      }
    }
    return entries;
  }

  async function readStoredList(storage) {
    const [snapshot, whitelist] = await Promise.all([
      readStoredListSnapshot(storage),
      storage.get(STORAGE_KEYS.whitelist, null),
    ]);
    const { raw, meta: storedMeta } = snapshot;
    const whitelistEntries = sanitizeStoredWhitelist(whitelist);
    if (typeof raw !== 'string' || !raw) {
      return { entries: [], meta: storedMeta, whitelistEntries, error: null };
    }
    try {
      const validated = validateLiteArtifact(parseJson(raw, 'cached lite artifact'));
      if (!validated.ok) {
        return { entries: [], meta: storedMeta, whitelistEntries, error: validated.error };
      }
      if (
        !snapshot.legacy &&
        validated.value.version &&
        validated.value.version !== storedMeta?.version
      ) {
        return {
          entries: [],
          meta: null,
          whitelistEntries,
          error: 'cached list version mismatch',
        };
      }
      if (
        !snapshot.legacy &&
        validated.value.entries.length !== storedMeta?.count
      ) {
        return {
          entries: [],
          meta: null,
          whitelistEntries,
          error: 'cached list count mismatch',
        };
      }
      if (validated.value.entries.length < MIN_SANE_ENTRIES) {
        return {
          entries: [],
          meta: storedMeta,
          whitelistEntries,
          error: 'cached list is implausibly small',
        };
      }
      return {
        entries: validated.value.entries,
        meta: storedMeta,
        whitelistEntries,
        error: null,
      };
    } catch (error) {
      return {
        entries: [],
        meta: storedMeta,
        whitelistEntries,
        error: errorMessage(error, '缓存读取失败'),
      };
    }
  }

  const core = {
    consumeBackdropClick,
    createAccountIndex,
    createHiddenRegistry,
    createListSynchronizer,
    createRequestAdapter,
    decodeEntry,
    errorMessage,
    extractHandleFromHref,
    findProfileNameBlock,
    getAccountPresentation,
    getAccountVisibility,
    normalizeSettings,
    normalizeHandle,
    readStoredList,
    STORAGE_KEYS,
    validateLiteArtifact,
    validateWhitelist,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = core;
    return;
  }

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    hideConfirmed: true,
  });
  const LIST_STALE_MS = 6 * 60 * 60 * 1000;
  const SYNC_LOCK_MS = 5 * 60 * 1000;
  const APPEAL_URL =
    'https://github.com/foru17/make-x-great-again/issues/new?template=appeal.yml';
  const UPSTREAM_URL = 'https://github.com/foru17/make-x-great-again';
  const SOURCE_URL =
    'https://github.com/kyangc/tampermonkey_scripts/blob/main/scripts/make-x-great-again.user.js';

  function normalizeSettings(raw) {
    return {
      enabled: raw?.enabled !== false,
      hideConfirmed: raw?.hideConfirmed !== false,
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

  function createRequestAdapter(gm) {
    if (!gm || typeof gm.xmlHttpRequest !== 'function') {
      throw new Error('当前 userscript 管理器没有提供 GM.xmlHttpRequest');
    }
    return async function requestText(url, maxBytes) {
      let response;
      try {
        response = await gm.xmlHttpRequest({
          method: 'GET',
          url,
          headers: {
            Accept: 'application/json',
            'Cache-Control': 'no-cache',
          },
          responseType: 'text',
          timeout: 60000,
        });
      } catch (error) {
        throw new Error(errorMessage(error, '网络请求失败'));
      }
      if (!response || response.status < 200 || response.status >= 300) {
        throw new Error(response?.status ? `HTTP ${response.status}` : '网络请求失败');
      }
      const text =
        typeof response.responseText === 'string'
          ? response.responseText
          : typeof response.response === 'string'
            ? response.response
            : '';
      if (byteLength(text) > maxBytes) throw new Error('response too large');
      return text;
    };
  }

  function formatCount(value) {
    const count = Number(value) || 0;
    if (count >= 10000) return (count / 10000).toFixed(count >= 100000 ? 1 : 2) + '万';
    return String(count);
  }

  function formatTime(timestamp) {
    const value = Number(timestamp);
    if (!Number.isFinite(value) || value <= 0) return '尚未同步';
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(value));
    } catch (_error) {
      return new Date(value).toLocaleString();
    }
  }

  function runtimeLabel(gm) {
    const handler = gm?.info?.scriptHandler || global.GM_info?.scriptHandler || 'Userscript';
    const touch = Number(global.navigator?.maxTouchPoints || 0) > 0;
    return handler + (touch ? ' · 触屏' : ' · 桌面');
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

  const UI_STYLE = [
    ':host{all:initial;color-scheme:dark;--bg:#0f1419;--panel:#16181c;--soft:#202327;--line:#2f3336;--text:#e7e9ea;--muted:#8b98a5;--blue:#1d9bf0;--danger:#f4212e;--warn:#f59e0b;--ok:#00ba7c;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45}',
    '*{box-sizing:border-box}',
    'button,input{font:inherit}',
    'button{touch-action:manipulation}',
    '[hidden]{display:none!important}',
    '.control{position:fixed;z-index:2147483000;right:max(12px,env(safe-area-inset-right));bottom:max(12px,env(safe-area-inset-bottom));display:flex;align-items:center;gap:7px;min-height:42px;padding:8px 12px;border:1px solid var(--line);border-radius:999px;background:rgba(15,20,25,.94);color:var(--text);box-shadow:0 8px 30px rgba(0,0,0,.35);cursor:pointer;backdrop-filter:blur(12px)}',
    '.control:hover{border-color:#536471;background:#182027}',
    '.control:focus-visible,.button:focus-visible,.icon-button:focus-visible,.badge:focus-visible{outline:2px solid var(--blue);outline-offset:2px}',
    '.dot{width:8px;height:8px;border-radius:50%;background:var(--muted);box-shadow:0 0 0 3px rgba(139,152,165,.14)}',
    '.dot.ready{background:var(--ok);box-shadow:0 0 0 3px rgba(0,186,124,.15)}',
    '.dot.loading{background:var(--blue);animation:pulse 1.2s infinite}',
    '.dot.error{background:var(--warn)}',
    '.control-label{font-weight:750;letter-spacing:.01em}',
    '.control-count{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}',
    '.backdrop{position:fixed;z-index:2147483001;inset:0;background:transparent;cursor:default}',
    '.panel{position:fixed;z-index:2147483002;right:max(12px,env(safe-area-inset-right));bottom:max(64px,calc(env(safe-area-inset-bottom) + 58px));width:min(380px,calc(100vw - 24px));max-height:calc(100vh - 92px);max-height:min(720px,calc(100dvh - 92px));overflow:auto;border:1px solid var(--line);border-radius:20px;background:rgba(22,24,28,.98);color:var(--text);box-shadow:0 18px 60px rgba(0,0,0,.5);overscroll-behavior:contain}',
    '.panel-header{position:sticky;top:0;z-index:1;display:flex;align-items:center;justify-content:space-between;padding:16px 16px 12px;background:rgba(22,24,28,.97);border-bottom:1px solid var(--line);backdrop-filter:blur(12px)}',
    '.panel-title{margin:0;font-size:17px;font-weight:800}',
    '.panel-subtitle{margin:2px 0 0;color:var(--muted);font-size:12px}',
    '.icon-button{display:grid;place-items:center;width:36px;height:36px;border:0;border-radius:999px;background:transparent;color:var(--text);cursor:pointer}',
    '.icon-button:hover{background:var(--soft)}',
    '.panel-body{padding:14px 16px 18px}',
    '.notice{padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:#11161b;color:var(--muted)}',
    '.notice.error{border-color:rgba(245,158,11,.45);color:#fbbf24}',
    '.notice.loading{border-color:rgba(29,155,240,.4);color:#8ecdf8}',
    '.metrics{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0}',
    '.metric{min-width:0;padding:10px 11px;border-radius:12px;background:var(--soft)}',
    '.metric-label{display:block;color:var(--muted);font-size:11px}',
    '.metric-value{display:block;min-width:0;margin-top:3px;font-weight:750;font-variant-numeric:tabular-nums}',
    '[data-role="version"]{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.setting-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 0;border-top:1px solid var(--line)}',
    '.setting-copy strong{display:block;font-size:14px}',
    '.setting-copy span{display:block;margin-top:2px;color:var(--muted);font-size:12px}',
    '.switch{position:relative;display:inline-flex;flex:none;width:46px;height:28px}',
    '.switch input{position:absolute;opacity:0;pointer-events:none}',
    '.switch span{position:absolute;inset:0;border-radius:999px;background:#536471;transition:.2s}',
    '.switch span:after{content:"";position:absolute;width:22px;height:22px;left:3px;top:3px;border-radius:50%;background:white;transition:.2s;box-shadow:0 1px 4px rgba(0,0,0,.3)}',
    '.switch input:checked+span{background:var(--blue)}',
    '.switch input:checked+span:after{transform:translateX(18px)}',
    '.actions{display:flex;gap:8px;margin:12px 0}',
    '.button{min-height:38px;padding:8px 13px;border:1px solid var(--line);border-radius:999px;background:var(--soft);color:var(--text);font-weight:700;cursor:pointer}',
    '.button:hover{border-color:#536471;background:#293038}',
    '.button.primary{border-color:var(--blue);background:var(--blue);color:white}',
    '.button.danger{border-color:rgba(244,33,46,.55);background:rgba(244,33,46,.12);color:#ff7a83}',
    '.button:disabled{opacity:.55;cursor:wait}',
    '.section{margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}',
    '.section-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}',
    '.section-heading h3{margin:0;font-size:14px}',
    '.section-heading span{color:var(--muted);font-size:12px}',
    '.empty{margin:8px 0;color:var(--muted);font-size:12px}',
    '.hidden-list{display:grid;gap:7px;max-height:220px;overflow:auto}',
    '.hidden-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 10px;border-radius:11px;background:var(--soft)}',
    '.hidden-account{min-width:0}',
    '.hidden-account strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.hidden-account span{display:block;color:var(--muted);font-size:11px}',
    '.restore{flex:none;min-height:32px;padding:5px 10px}',
    '.privacy{margin:14px 0 0;color:var(--muted);font-size:11px;line-height:1.6}',
    '.links{display:flex;gap:12px;margin-top:10px}',
    '.link-button{padding:0;border:0;background:none;color:#8ecdf8;cursor:pointer;font-size:12px}',
    '.popover{position:fixed;z-index:2147483004;width:min(320px,calc(100vw - 16px));padding:14px;border:1px solid var(--line);border-radius:16px;background:rgba(22,24,28,.99);color:var(--text);box-shadow:0 16px 48px rgba(0,0,0,.5)}',
    '.popover h3{margin:0;font-size:16px}',
    '.popover-account{margin-top:2px;color:var(--muted);font-size:12px}',
    '.tags{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}',
    '.tag{display:inline-flex;padding:3px 8px;border-radius:999px;background:var(--soft);color:var(--muted);font-size:11px}',
    '.tag.confirmed{background:rgba(244,33,46,.13);color:#ff8991}',
    '.tag.auto{background:rgba(245,158,11,.13);color:#fbbf24}',
    '.popover-copy{margin:8px 0 12px;color:var(--muted);font-size:12px;line-height:1.6}',
    '.popover-actions{display:flex;flex-wrap:wrap;gap:8px}',
    '.toast{position:fixed;z-index:2147483005;left:50%;bottom:max(72px,calc(env(safe-area-inset-bottom) + 68px));transform:translateX(-50%);display:flex;align-items:center;gap:10px;max-width:calc(100vw - 24px);padding:10px 12px;border:1px solid var(--line);border-radius:999px;background:#202327;color:var(--text);box-shadow:0 10px 35px rgba(0,0,0,.45)}',
    '.toast span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.toast button{flex:none;padding:4px 8px;border:0;background:none;color:#8ecdf8;font-weight:750;cursor:pointer}',
    '@keyframes pulse{50%{opacity:.45}}',
    '@media(prefers-color-scheme:light){:host{color-scheme:light;--bg:#fff;--panel:#fff;--soft:#f2f4f5;--line:#d8dee3;--text:#0f1419;--muted:#536471}.control{background:rgba(255,255,255,.95);box-shadow:0 8px 30px rgba(15,20,25,.16)}.control:hover{border-color:#aab4bc;background:#eef1f3}.button:hover,.icon-button:hover{border-color:#aab4bc;background:#e5eaed}.panel,.panel-header,.popover{background:rgba(255,255,255,.98)}.notice{background:#f7f9f9}.toast{background:white}}',
    '@media(max-width:600px),(hover:none){.control{min-height:46px;bottom:max(64px,calc(env(safe-area-inset-bottom) + 56px))}.panel{left:8px;right:8px;bottom:max(118px,calc(env(safe-area-inset-bottom) + 110px));width:auto;max-height:72vh;max-height:min(72dvh,720px);border-radius:20px}.button{min-height:44px}.icon-button{width:42px;height:42px}.popover{left:8px!important;right:8px!important;top:auto!important;bottom:max(8px,env(safe-area-inset-bottom));width:auto;border-radius:20px;padding:16px}.toast{bottom:max(118px,calc(env(safe-area-inset-bottom) + 110px))}}',
    '@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;animation:none!important;transition:none!important}}',
  ].join('\n');

  function createUi(callbacks, environment) {
    const existing = document.getElementById('mxga-userscript-root');
    if (existing) existing.remove();
    const host = document.createElement('div');
    host.id = 'mxga-userscript-root';
    host.style.cssText = 'all:initial;';
    (document.body || document.documentElement).appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = UI_STYLE;
    root.appendChild(style);

    const shell = document.createElement('div');
    shell.innerHTML = [
      '<button class="control" type="button" data-action="toggle-panel" aria-expanded="false" aria-controls="mxga-panel">',
      '<span class="dot" data-role="dot"></span>',
      '<span class="control-label">MXGA</span>',
      '<span class="control-count" data-role="control-count">—</span>',
      '</button>',
      '<div class="backdrop" data-role="backdrop" hidden aria-hidden="true"></div>',
      '<section class="panel" id="mxga-panel" hidden aria-label="Make X Great Again 设置">',
      '<header class="panel-header">',
      '<div><h2 class="panel-title">Make X Great Again</h2><p class="panel-subtitle"></p></div>',
      '<button class="icon-button" type="button" data-action="close-panel" aria-label="关闭">✕</button>',
      '</header>',
      '<div class="panel-body">',
      '<div class="notice" data-role="notice" role="status" aria-live="polite"></div>',
      '<div class="metrics">',
      '<div class="metric"><span class="metric-label">名单账号</span><span class="metric-value" data-role="black-count">0</span></div>',
      '<div class="metric"><span class="metric-label">白名单</span><span class="metric-value" data-role="white-count">0</span></div>',
      '<div class="metric"><span class="metric-label">名单版本</span><span class="metric-value" data-role="version">—</span></div>',
      '<div class="metric"><span class="metric-label">上次同步</span><span class="metric-value" data-role="fetched-at">—</span></div>',
      '</div>',
      '<div class="setting-row">',
      '<div class="setting-copy"><strong>页面标记与本地隐藏</strong><span>关闭时临时恢复页面，隐藏记录仍保留</span></div>',
      '<label class="switch"><input type="checkbox" data-role="enabled" aria-label="启用页面标记与本地隐藏"><span></span></label>',
      '</div>',
      '<div class="setting-row">',
      '<div class="setting-copy"><strong>隐藏明确命中内容</strong><span>关闭后临时显示，手动隐藏记录不变</span></div>',
      '<label class="switch"><input type="checkbox" data-role="hide-confirmed" aria-label="隐藏人工确认账号及其推文"><span></span></label>',
      '</div>',
      '<div class="actions"><button class="button primary" type="button" data-action="sync">立即更新名单</button></div>',
      '<section class="section">',
      '<div class="section-heading"><h3>本地隐藏记录</h3><span data-role="hidden-count">0 个</span></div>',
      '<div class="hidden-list" data-role="hidden-list"></div>',
      '</section>',
      '<p class="privacy">只下载公开名单并在本机匹配；不会上传你浏览的页面、X 账号、命中结果或隐藏记录。人工确认条目可按开关自动隐藏，自动收录条目只做提示；不会执行 X 原生静音或拉黑。</p>',
      '<div class="links"><button class="link-button" type="button" data-action="open-upstream">上游项目 ↗</button><button class="link-button" type="button" data-action="open-source">本脚本源码 ↗</button></div>',
      '</div>',
      '</section>',
      '<section class="popover" data-role="popover" hidden aria-label="账号名单详情"></section>',
      '<div class="toast" data-role="toast" hidden role="status" aria-live="polite"><span data-role="toast-text"></span><button type="button" data-action="undo">撤销</button></div>',
    ].join('');
    root.appendChild(shell);

    const elements = {
      control: root.querySelector('.control'),
      backdrop: root.querySelector('[data-role="backdrop"]'),
      dot: root.querySelector('[data-role="dot"]'),
      controlCount: root.querySelector('[data-role="control-count"]'),
      panel: root.querySelector('.panel'),
      subtitle: root.querySelector('.panel-subtitle'),
      notice: root.querySelector('[data-role="notice"]'),
      blackCount: root.querySelector('[data-role="black-count"]'),
      whiteCount: root.querySelector('[data-role="white-count"]'),
      version: root.querySelector('[data-role="version"]'),
      fetchedAt: root.querySelector('[data-role="fetched-at"]'),
      enabled: root.querySelector('[data-role="enabled"]'),
      hideConfirmed: root.querySelector('[data-role="hide-confirmed"]'),
      sync: root.querySelector('[data-action="sync"]'),
      hiddenCount: root.querySelector('[data-role="hidden-count"]'),
      hiddenList: root.querySelector('[data-role="hidden-list"]'),
      popover: root.querySelector('[data-role="popover"]'),
      toast: root.querySelector('[data-role="toast"]'),
      toastText: root.querySelector('[data-role="toast-text"]'),
    };
    elements.subtitle.textContent = environment;

    let currentPopover = null;
    let popoverTimer = 0;
    let toastTimer = 0;
    let undoHandle = '';

    function setPanel(open) {
      elements.panel.hidden = !open;
      elements.backdrop.hidden = !open;
      elements.control.setAttribute('aria-expanded', String(open));
      if (open) closePopover();
    }

    function cancelPopoverClose() {
      global.clearTimeout(popoverTimer);
    }

    function closePopover() {
      cancelPopoverClose();
      elements.popover.hidden = true;
      elements.popover.replaceChildren();
      currentPopover = null;
      global.removeEventListener('scroll', closePopover, true);
    }

    function schedulePopoverClose() {
      if (!global.matchMedia?.('(hover:hover) and (pointer:fine)').matches) return;
      cancelPopoverClose();
      popoverTimer = global.setTimeout(closePopover, 160);
    }

    function addTextElement(parent, tag, className, text) {
      const element = document.createElement(tag);
      if (className) element.className = className;
      element.textContent = text;
      parent.appendChild(element);
      return element;
    }

    function openPopover(anchor, handle, entry) {
      cancelPopoverClose();
      setPanel(false);
      currentPopover = { handle, entry };
      const presentation = getAccountPresentation(entry);
      const popover = elements.popover;
      popover.replaceChildren();

      const heading = document.createElement('div');
      addTextElement(heading, 'h3', '', presentation.badgeText + '账号提示');
      addTextElement(heading, 'div', 'popover-account', '@' + handle);
      popover.appendChild(heading);

      const tags = document.createElement('div');
      tags.className = 'tags';
      addTextElement(tags, 'span', 'tag', presentation.categoryText);
      addTextElement(
        tags,
        'span',
        'tag ' + (entry.tier === 'confirmed' ? 'confirmed' : 'auto'),
        presentation.tierText,
      );
      popover.appendChild(tags);
      addTextElement(
        popover,
        'p',
        'popover-copy',
        entry.tier === 'confirmed'
          ? '命中人工确认名单。开启自动隐藏时，列表账号和推文不会展示；你也可以在本机手动隐藏或恢复。'
          : '命中自动收录名单。此类条目只做提示，不会自动隐藏；你可以选择在本机隐藏。',
      );

      const actions = document.createElement('div');
      actions.className = 'popover-actions';
      const hide = addTextElement(actions, 'button', 'button danger', '本地隐藏');
      hide.type = 'button';
      hide.dataset.action = 'hide-current';
      const appeal = addTextElement(actions, 'button', 'button', '误判申诉 ↗');
      appeal.type = 'button';
      appeal.dataset.action = 'appeal';
      const close = addTextElement(actions, 'button', 'button', '关闭');
      close.type = 'button';
      close.dataset.action = 'close-popover';
      popover.appendChild(actions);
      popover.hidden = false;

      const mobile = global.matchMedia?.('(max-width:600px),(hover:none)').matches;
      if (!mobile) {
        const anchorRect = anchor.getBoundingClientRect();
        const popRect = popover.getBoundingClientRect();
        const left = Math.min(
          Math.max(8, anchorRect.left),
          Math.max(8, global.innerWidth - popRect.width - 8),
        );
        const below = anchorRect.bottom + 7;
        const top =
          below + popRect.height > global.innerHeight - 8
            ? Math.max(8, anchorRect.top - popRect.height - 7)
            : below;
        popover.style.left = left + 'px';
        popover.style.top = top + 'px';
      } else {
        popover.style.removeProperty('left');
        popover.style.removeProperty('top');
      }
      global.addEventListener('scroll', closePopover, { capture: true, passive: true });
    }

    function renderHidden(records) {
      elements.hiddenList.replaceChildren();
      elements.hiddenCount.textContent = records.length + ' 个';
      if (records.length === 0) {
        addTextElement(elements.hiddenList, 'p', 'empty', '还没有本地隐藏记录。');
        return;
      }
      for (const record of records.slice(0, 30)) {
        const row = document.createElement('div');
        row.className = 'hidden-row';
        const account = document.createElement('div');
        account.className = 'hidden-account';
        addTextElement(account, 'strong', '', '@' + record.handle);
        const details = [record.categoryText, record.tierText, formatTime(record.hiddenAt)]
          .filter(Boolean)
          .join(' · ');
        addTextElement(account, 'span', '', details);
        const restore = addTextElement(row, 'button', 'button restore', '恢复');
        restore.type = 'button';
        restore.dataset.action = 'restore';
        restore.dataset.handle = record.handle;
        row.prepend(account);
        elements.hiddenList.appendChild(row);
      }
    }

    function render(view) {
      const phase = view.syncing ? 'loading' : view.error ? 'error' : view.count > 0 ? 'ready' : '';
      elements.dot.className = 'dot' + (phase ? ' ' + phase : '');
      elements.controlCount.textContent = view.count > 0 ? formatCount(view.count) : '待同步';
      elements.blackCount.textContent = Number(view.count || 0).toLocaleString('zh-CN');
      elements.whiteCount.textContent = Number(view.whitelistCount || 0).toLocaleString('zh-CN');
      const version = view.meta?.version || '—';
      elements.version.textContent = version;
      elements.version.title = version;
      elements.fetchedAt.textContent = formatTime(view.meta?.fetchedAt);
      elements.enabled.checked = view.settings.enabled;
      elements.hideConfirmed.checked = view.settings.hideConfirmed;
      elements.sync.disabled = Boolean(view.syncing);
      elements.sync.textContent = view.syncing ? '正在更新…' : '立即更新名单';
      elements.notice.className = 'notice' + (phase === 'loading' || phase === 'error' ? ' ' + phase : '');
      if (view.syncing) {
        elements.notice.textContent = '正在同步公开名单和官方白名单…';
      } else if (view.error) {
        elements.notice.textContent =
          (view.count > 0 ? '继续使用本地缓存；更新失败：' : '名单尚不可用：') + view.error;
      } else if (view.count > 0) {
        elements.notice.textContent =
          view.settings.hideConfirmed
            ? '本地名单已就绪。人工确认条目自动隐藏，自动收录条目只做提示。'
            : '本地名单已就绪。自动隐藏已临时关闭，命中条目只做提示。';
      } else {
        elements.notice.textContent = '尚未下载名单；首次同步可能需要一些时间。';
      }
      renderHidden(view.hiddenRecords);
    }

    function showUndo(handle) {
      global.clearTimeout(toastTimer);
      undoHandle = normalizeHandle(handle);
      elements.toastText.textContent = '已在本机隐藏 @' + undoHandle;
      elements.toast.hidden = false;
      toastTimer = global.setTimeout(() => {
        elements.toast.hidden = true;
        undoHandle = '';
      }, 5000);
    }

    elements.popover.addEventListener('mouseenter', cancelPopoverClose);
    elements.popover.addEventListener('mouseleave', schedulePopoverClose);
    root.addEventListener('click', (event) => {
      if (consumeBackdropClick(event, elements.backdrop)) {
        setPanel(false);
        return;
      }
      const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
      const action = target?.dataset.action;
      if (!action) return;
      if (action === 'toggle-panel') setPanel(elements.panel.hidden);
      else if (action === 'close-panel') setPanel(false);
      else if (action === 'close-popover') closePopover();
      else if (action === 'sync') callbacks.onSync();
      else if (action === 'restore') callbacks.onRestore(target.dataset.handle || '');
      else if (action === 'hide-current' && currentPopover) {
        const selected = currentPopover;
        closePopover();
        callbacks.onHide(selected.handle, selected.entry);
      } else if (action === 'appeal') callbacks.onAppeal();
      else if (action === 'undo' && undoHandle) {
        const handle = undoHandle;
        global.clearTimeout(toastTimer);
        elements.toast.hidden = true;
        undoHandle = '';
        callbacks.onRestore(handle);
      } else if (action === 'open-upstream') callbacks.onOpenUrl(UPSTREAM_URL);
      else if (action === 'open-source') callbacks.onOpenUrl(SOURCE_URL);
    });
    elements.enabled.addEventListener('change', () => {
      callbacks.onEnabledChange(elements.enabled.checked);
    });
    elements.hideConfirmed.addEventListener('change', () => {
      callbacks.onHideConfirmedChange(elements.hideConfirmed.checked);
    });

    return {
      cancelPopoverClose,
      closePopover,
      openPopover,
      render,
      schedulePopoverClose,
      showUndo,
    };
  }

  function handleFromNameBlock(nameBlock) {
    if (!(nameBlock instanceof Element)) return null;
    for (const anchor of nameBlock.querySelectorAll('a[href]')) {
      const handle = extractHandleFromHref(anchor.getAttribute('href') || '');
      if (handle) return handle;
    }
    return null;
  }

  const ACCOUNT_CONTENT_SELECTOR =
    'article[data-testid="tweet"], [data-testid="UserCell"]';

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

  function clearBadgeMounts(scope = document) {
    for (const mount of scope.querySelectorAll('[data-mxga-userscript-badge]')) mount.remove();
  }

  function createBadgeMount(handle, entry, ui) {
    const normalized = normalizeHandle(handle);
    const presentation = getAccountPresentation(entry);
    const host = document.createElement('span');
    host.dataset.mxgaUserscriptBadge = '1';
    host.dataset.mxgaUserscriptHandle = normalized;
    host.dataset.mxgaUserscriptEntry =
      entry.label + ':' + entry.category + ':' + entry.tier;
    host.dataset.mxgaTier = entry.tier;
    host.style.cssText =
      'display:inline-flex;align-items:center;align-self:center;vertical-align:middle;flex:none;margin-left:4px;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = [
      ':host{display:inline-flex;color-scheme:light dark}',
      'button{display:inline-flex;align-items:center;gap:4px;min-height:24px;padding:2px 7px;border:1px solid var(--mxga-badge-border);border-radius:999px;background:var(--mxga-badge-bg);color:var(--mxga-badge-text);font:700 11px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;white-space:nowrap;cursor:pointer;touch-action:manipulation}',
      'button:hover{filter:brightness(1.12)}',
      'button:focus-visible{outline:2px solid #1d9bf0;outline-offset:2px}',
      '.mark{font-size:10px}',
      '@media(prefers-color-scheme:light){button{color:#996300}:host([data-mxga-tier="confirmed"]) button{color:#c91928}}',
      '@media(max-width:600px),(hover:none){button{min-height:28px;padding:3px 8px}}',
    ].join('\n');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'badge';
    button.style.setProperty(
      '--mxga-badge-bg',
      entry.tier === 'confirmed' ? 'rgba(244,33,46,.15)' : 'rgba(245,158,11,.15)',
    );
    button.style.setProperty(
      '--mxga-badge-border',
      entry.tier === 'confirmed' ? 'rgba(244,33,46,.55)' : 'rgba(245,158,11,.55)',
    );
    button.style.setProperty(
      '--mxga-badge-text',
      entry.tier === 'confirmed' ? '#ff6670' : '#d99600',
    );
    button.setAttribute(
      'aria-label',
      'MXGA：' +
        presentation.badgeText +
        '，' +
        presentation.categoryText +
        '，' +
        presentation.tierText +
        '。点击查看详情',
    );
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = '◆';
    const label = document.createElement('span');
    label.textContent = presentation.badgeText;
    button.append(mark, label);
    shadow.append(style, button);

    const open = () => ui.openPopover(host, normalized, entry);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      open();
    });
    button.addEventListener('mouseenter', () => {
      if (global.matchMedia?.('(hover:hover) and (pointer:fine)').matches) open();
    });
    button.addEventListener('mouseleave', ui.schedulePopoverClose);
    button.addEventListener('focus', open);
    button.addEventListener('blur', ui.schedulePopoverClose);
    host.addEventListener('mouseenter', ui.cancelPopoverClose);
    return host;
  }

  function mountOrUpdateBadge(nameBlock, handle, entry, ui) {
    const normalized = normalizeHandle(handle);
    const entryKey = entry.label + ':' + entry.category + ':' + entry.tier;
    const existing = nameBlock.querySelector(':scope > [data-mxga-userscript-badge]');
    if (
      existing &&
      existing.dataset.mxgaUserscriptHandle === normalized &&
      existing.dataset.mxgaUserscriptEntry === entryKey
    ) {
      return;
    }
    existing?.remove();
    nameBlock.appendChild(createBadgeMount(normalized, entry, ui));
  }

  function createScanner(state, ui) {
    let scheduled = false;

    function processContentItem(item) {
      const nameBlock = item.querySelector('[data-testid="User-Name"]');
      const handle = handleFromNameBlock(nameBlock);
      if (!nameBlock || !handle) return;
      const normalized = normalizeHandle(handle);
      const cell = cellForContent(item);
      const entry = state.index.lookup({ handle: normalized });
      const visibility = getAccountVisibility({
        entry,
        settings: state.settings,
        locallyHidden: state.hidden.has(normalized),
      });

      if (visibility === 'hidden') {
        clearBadgeMounts(nameBlock);
        hideContentLocally(item, normalized);
        return;
      }
      revealCell(cell);

      if (visibility === 'labeled') mountOrUpdateBadge(nameBlock, normalized, entry, ui);
      else clearBadgeMounts(nameBlock);
    }

    function processProfile() {
      const firstSegment = global.location.pathname.split('/').filter(Boolean)[0] || '';
      const handle = extractHandleFromHref('/' + firstSegment);
      const nameBlock = findProfileNameBlock(document, handle);
      if (!nameBlock) return;
      if (!state.settings.enabled || !handle) {
        clearBadgeMounts(nameBlock);
        return;
      }
      const entry = state.index.lookup({ handle });
      if (entry) mountOrUpdateBadge(nameBlock, handle, entry, ui);
      else clearBadgeMounts(nameBlock);
    }

    function scan() {
      scheduled = false;
      if (!state.settings.enabled) {
        clearBadgeMounts();
        revealAllUserscriptHidden();
        return;
      }
      for (const item of document.querySelectorAll(ACCOUNT_CONTENT_SELECTOR)) {
        processContentItem(item);
      }
      processProfile();
    }

    function schedule() {
      if (scheduled) return;
      scheduled = true;
      global.setTimeout(scan, 80);
    }

    function hideVisible(handle) {
      const normalized = normalizeHandle(handle);
      for (const item of document.querySelectorAll(ACCOUNT_CONTENT_SELECTOR)) {
        const nameBlock = item.querySelector('[data-testid="User-Name"]');
        if (normalizeHandle(handleFromNameBlock(nameBlock)) !== normalized) continue;
        clearBadgeMounts(nameBlock);
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

  async function bootstrap() {
    const gm = typeof GM === 'object' && GM ? GM : global.GM;
    const storage = createStorageAdapter(gm);
    const requestText = createRequestAdapter(gm);
    const synchronizer = createListSynchronizer({ requestText, storage });
    const [storedSettings, storedHidden, cached] = await Promise.all([
      storage.get(STORAGE_KEYS.settings, DEFAULT_SETTINGS),
      storage.get(STORAGE_KEYS.hidden, []),
      readStoredList(storage),
    ]);

    const state = {
      settings: normalizeSettings(storedSettings),
      hidden: createHiddenRegistry(storedHidden),
      entries: cached.entries,
      whitelistEntries: cached.whitelistEntries,
      whitelistCount: cached.whitelistEntries.length,
      meta: cached.meta,
      index: createAccountIndex(cached.entries, cached.whitelistEntries),
      syncing: false,
      error: cached.error,
    };

    let scanner;
    let ui;
    let syncPromise = null;
    const lockOwner =
      Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

    function render() {
      ui.render({
        count: state.index.size,
        whitelistCount: state.whitelistCount,
        meta: state.meta,
        settings: state.settings,
        hiddenRecords: state.hidden.list(),
        syncing: state.syncing,
        error: state.error,
      });
    }

    async function persistHidden() {
      try {
        await storage.set(STORAGE_KEYS.hidden, state.hidden.list());
      } catch (error) {
        state.error = '隐藏记录保存失败：' + errorMessage(error);
        render();
      }
    }

    async function restoreHandle(handle) {
      if (!state.hidden.restore(handle)) return;
      scanner.restoreVisible(handle);
      render();
      await persistHidden();
    }

    async function hideHandle(handle, entry) {
      const presentation = getAccountPresentation(entry);
      if (!presentation || !state.hidden.hide(handle, presentation)) return;
      scanner.hideVisible(handle);
      ui.showUndo(handle);
      render();
      await persistHidden();
    }

    async function updateSettings(patch) {
      state.settings = normalizeSettings({ ...state.settings, ...patch });
      render();
      scanner.schedule();
      try {
        await storage.set(STORAGE_KEYS.settings, state.settings);
      } catch (error) {
        state.error = '设置保存失败：' + errorMessage(error);
        render();
      }
    }

    async function acquireSyncLock() {
      const now = Date.now();
      const existing = await storage.get(STORAGE_KEYS.syncLock, null);
      if (
        existing?.owner &&
        existing.owner !== lockOwner &&
        Number(existing.expiresAt) > now
      ) {
        return false;
      }
      const mine = { owner: lockOwner, expiresAt: now + SYNC_LOCK_MS };
      await storage.set(STORAGE_KEYS.syncLock, mine);
      const confirmed = await storage.get(STORAGE_KEYS.syncLock, null);
      return confirmed?.owner === lockOwner;
    }

    async function releaseSyncLock() {
      const current = await storage.get(STORAGE_KEYS.syncLock, null);
      if (current?.owner === lockOwner) await storage.delete(STORAGE_KEYS.syncLock);
    }

    function rebuildIndex() {
      state.index = createAccountIndex(state.entries, state.whitelistEntries);
      state.whitelistCount = state.whitelistEntries.length;
    }

    async function reloadStoredState(options = {}) {
      const [settings, hiddenRecords, storedSnapshot, storedWhitelist] = await Promise.all([
        storage.get(STORAGE_KEYS.settings, state.settings),
        storage.get(STORAGE_KEYS.hidden, state.hidden.list()),
        readStoredListSnapshot(storage),
        storage.get(STORAGE_KEYS.whitelist, null),
      ]);
      state.settings = normalizeSettings(settings);
      state.hidden = createHiddenRegistry(hiddenRecords);
      const safeStoredMeta = storedSnapshot.meta;
      const nextWhitelist = sanitizeStoredWhitelist(storedWhitelist);
      const listChanged =
        options.forceList ||
        (!state.meta && safeStoredMeta) ||
        (safeStoredMeta?.version && safeStoredMeta.version !== state.meta?.version);
      if (listChanged) {
        const next = await readStoredList(storage);
        state.entries = next.entries;
        state.meta = next.meta;
        state.whitelistEntries = next.whitelistEntries;
        state.error = next.error;
      } else {
        state.meta = safeStoredMeta || state.meta;
        if (nextWhitelist.length > 0 || state.whitelistEntries.length === 0) {
          state.whitelistEntries = nextWhitelist;
        }
      }
      rebuildIndex();
      render();
      scanner.schedule();
    }

    async function performSync(force) {
      state.syncing = true;
      state.error = null;
      render();
      let locked = false;
      try {
        locked = await acquireSyncLock();
        if (!locked) {
          global.setTimeout(() => {
            void reloadStoredState({ forceList: state.index.size === 0 });
          }, 12000);
          return;
        }
        const result = await synchronizer.sync(force);
        if (Array.isArray(result.whitelistEntries)) {
          state.whitelistEntries = result.whitelistEntries;
        }
        if (result.artifact?.entries) {
          state.entries = result.artifact.entries;
        } else if (state.entries.length === 0) {
          const next = await readStoredList(storage);
          state.entries = next.entries;
          state.meta = next.meta;
          if (!Array.isArray(result.whitelistEntries)) {
            state.whitelistEntries = next.whitelistEntries;
          }
        }
        state.meta = result.meta || state.meta;
        rebuildIndex();
        state.error = result.error || null;
      } catch (error) {
        state.error = errorMessage(error, '名单更新失败');
      } finally {
        if (locked) {
          try {
            await releaseSyncLock();
          } catch (_error) {
            // An expired lock is harmless; another page can take over later.
          }
        }
        state.syncing = false;
        render();
        scanner.schedule();
      }
    }

    function syncNow(force) {
      if (!syncPromise) {
        syncPromise = performSync(force).finally(() => {
          syncPromise = null;
        });
      }
      return syncPromise;
    }

    ui = createUi(
      {
        onAppeal: () => openExternal(gm, APPEAL_URL),
        onEnabledChange: (enabled) => {
          void updateSettings({ enabled });
        },
        onHideConfirmedChange: (hideConfirmed) => {
          void updateSettings({ hideConfirmed });
        },
        onHide: (handle, entry) => {
          void hideHandle(handle, entry);
        },
        onOpenUrl: (url) => openExternal(gm, url),
        onRestore: (handle) => {
          void restoreHandle(handle);
        },
        onSync: () => {
          void syncNow(true);
        },
      },
      runtimeLabel(gm),
    );
    scanner = createScanner(state, ui);
    render();
    scanner.scan();

    const observer = new MutationObserver(scanner.schedule);
    observer.observe(document.body || document.documentElement, {
      attributes: true,
      attributeFilter: ['href'],
      childList: true,
      subtree: true,
    });
    global.addEventListener('popstate', scanner.schedule, { passive: true });
    global.addEventListener('pageshow', scanner.schedule, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void reloadStoredState();
    });
    global.setInterval(scanner.schedule, 2500);

    const fetchedAt = Number(state.meta?.fetchedAt || 0);
    if (state.index.size === 0 || !fetchedAt || Date.now() - fetchedAt > LIST_STALE_MS) {
      void syncNow(false);
    }
  }

  void bootstrap().catch((error) => {
    console.error('[MXGA Userscript] startup failed', error);
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);

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
      return currentIndex > 0 ? articles[currentIndex - 1] : null;
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
    if (element.getAttribute('data-testid') === 'share') return true;
    const label = String(element.getAttribute('aria-label') || '').trim();
    return /^(?:share post|分享帖子|分享貼文|ポストを共有|게시물 공유하기|partager le post|compartir post|post teilen|condividi post|compartilhar post)$/i.test(label);
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
      [data-tsc-action="share-card"] {
        transition: background-color 0.15s ease;
      }
      [data-tsc-action="share-card"]:hover,
      [data-tsc-action="share-card"]:focus-visible {
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
    extractVideoPosterUrl,
    findShareMenuAnchor,
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
    normalizeTweetData,
    wrapTweetTextRuns,
    wrapText,
  };

  if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, core);
  }

  if (!global || !global.document) return;

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

  function requestImageBlob(url) {
    const gmApi = typeof GM !== 'undefined' ? GM : global.GM;
    if (!gmApi || typeof gmApi.xmlHttpRequest !== 'function') {
      return Promise.reject(new Error('GM.xmlHttpRequest unavailable'));
    }

    return new Promise((resolve, reject) => {
      gmApi.xmlHttpRequest({
        method: 'GET',
        url,
        responseType: 'blob',
        timeout: 20000,
        anonymous: true,
        onload: (response) => {
          const blob = response && response.response;
          if (response.status >= 200 && response.status < 300 && blob instanceof Blob) {
            resolve(blob);
          } else {
            reject(new Error(`图片请求失败（HTTP ${response.status || 0}）`));
          }
        },
        onerror: () => reject(new Error('图片请求失败')),
        onabort: () => reject(new Error('图片请求已取消')),
        ontimeout: () => reject(new Error('图片请求超时')),
      });
    });
  }

  async function fetchImageBlob(url) {
    try {
      return await requestImageBlob(url);
    } catch (gmError) {
      if (typeof global.fetch !== 'function') throw gmError;
      const response = await global.fetch(url, { credentials: 'omit', mode: 'cors' });
      if (!response.ok) throw new Error(`图片请求失败（HTTP ${response.status}）`);
      return response.blob();
    }
  }

  function decodeImageSource(src, revoke = null) {
    return new Promise((resolve, reject) => {
      const image = new global.Image();
      image.decoding = 'async';
      image.onload = () => resolve({ image, revoke });
      image.onerror = () => {
        if (revoke) revoke();
        reject(new Error('图片解码失败'));
      };
      image.src = src;
    });
  }

  async function loadImageAsset(url) {
    try {
      const blob = await fetchImageBlob(url);
      const objectUrl = global.URL.createObjectURL(blob);
      return await decodeImageSource(objectUrl, () => global.URL.revokeObjectURL(objectUrl));
    } catch (_error) {
      const image = new global.Image();
      image.crossOrigin = 'anonymous';
      return new Promise((resolve, reject) => {
        image.onload = () => resolve({ image, revoke: null });
        image.onerror = () => reject(new Error('图片加载失败'));
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

  async function loadTweetAssetBundle(tweet) {
    if (!tweet) return { avatarAsset: null, mediaAssets: [], loaded: [] };
    const assetUrls = [tweet.avatarUrl, ...tweet.mediaUrls].filter(Boolean);
    const loaded = await Promise.all(assetUrls.map((url) => loadImageAsset(url).catch(() => null)));
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

  async function renderShareCard(rawTweet) {
    const tweet = normalizeTweetData(rawTweet);
    const measureCanvas = document.createElement('canvas');
    const measureContext = measureCanvas.getContext('2d');
    const [primaryAssets, contextAssets] = await Promise.all([
      loadTweetAssetBundle(tweet),
      loadTweetAssetBundle(tweet.context?.tweet),
    ]);
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
    const canvas = document.createElement('canvas');
    canvas.width = layout.canvasWidth;
    canvas.height = layout.canvasHeight;
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';

    try {
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
    } finally {
      for (const asset of [...primaryAssets.loaded, ...contextAssets.loaded]) asset?.revoke?.();
    }

    return canvas;
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

  function createShareCardModal(tweet) {
    state.modalClose?.();

    const host = document.createElement('div');
    host.setAttribute('data-tsc-modal-host', '');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host{position:fixed;inset:0;z-index:2147483646;font-family:${FONT_STACK};color:#0f1419;color-scheme:light}
        *{box-sizing:border-box}
        button{font:inherit}
        .backdrop{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:max(18px,env(safe-area-inset-top)) max(18px,env(safe-area-inset-right)) max(18px,env(safe-area-inset-bottom)) max(18px,env(safe-area-inset-left));background:rgba(15,20,25,.66);backdrop-filter:blur(10px)}
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
        @media(max-width:520px){.backdrop{padding:0;align-items:flex-end}.modal{max-height:94dvh;border-radius:26px 26px 0 0}.header{padding:19px 18px 15px}.preview-shell{padding:16px}.footer{padding:14px 16px max(16px,env(safe-area-inset-bottom))}.actions{grid-template-columns:1fr}.subtitle{font-size:13px}}
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
    const tweet = extractTweetData(article);
    const modal = createShareCardModal(tweet);

    if (!(tweet.authorName || tweet.handle) || !(tweet.text || tweet.mediaUrls.length)) {
      modal.setError('没有从当前推文读取到足够内容。X 可能刚更新了页面结构，请刷新后重试。');
      return;
    }

    try {
      const canvas = await renderShareCard(tweet);
      const blob = await canvasToPngBlob(canvas);
      modal.setReady(blob);
    } catch (error) {
      modal.setError(`生成分享图失败：${error?.message || '未知错误'}`);
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

  function createShareMenuAction(reference, article) {
    const action = reference.cloneNode(true);
    action.__tscArticle = article;
    action.setAttribute('data-tsc-action', 'share-card');
    action.setAttribute('role', 'menuitem');
    action.setAttribute('tabindex', '0');
    action.setAttribute('aria-label', '生成分享图');
    action.removeAttribute('data-testid');
    action.removeAttribute('href');
    action.removeAttribute('aria-disabled');
    for (const child of action.querySelectorAll('[data-testid], [href]')) {
      child.removeAttribute('data-testid');
      child.removeAttribute('href');
    }
    replaceMenuItemLabel(action, '生成分享图');

    const icon = action.querySelector('svg');
    if (icon) {
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.innerHTML = '<path d="M5 3.75h14A2.25 2.25 0 0 1 21.25 6v12A2.25 2.25 0 0 1 19 20.25H5A2.25 2.25 0 0 1 2.75 18V6A2.25 2.25 0 0 1 5 3.75Zm0 1.5a.75.75 0 0 0-.75.75v8.13l2.69-2.69a1.5 1.5 0 0 1 2.12 0l2.19 2.19 3.69-3.69a1.5 1.5 0 0 1 2.12 0l2.69 2.69V6a.75.75 0 0 0-.75-.75H5Zm14.75 9-3.75-3.75-4.22 4.22a.75.75 0 0 1-1.06 0L8 12l-3.75 3.75V18c0 .414.336.75.75.75h14a.75.75 0 0 0 .75-.75v-3.75ZM8.25 7a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5Z" fill="currentColor"/>';
    }

    action.style.cursor = 'pointer';
    action.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (action.__tscArticle) void openShareCard(action.__tscArticle);
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
    if (!state.activeArticle) return;

    const roleMenus = Array.from(document.querySelectorAll('[role="menu"]'));
    const menus = roleMenus.length
      ? roleMenus
      : Array.from(document.querySelectorAll('[data-testid="Dropdown"]'));

    let mounted = false;
    for (const menu of menus) {
      if (!isTweetShareMenu(menu)) continue;
      const existing = menu.querySelector('[data-tsc-action="share-card"]');
      if (existing) {
        existing.__tscArticle = state.activeArticle;
        mounted = true;
        continue;
      }
      const reference = findShareMenuAnchor(menu);
      if (!reference || !reference.parentNode) continue;
      reference.parentNode.insertBefore(createShareMenuAction(reference, state.activeArticle), reference);
      mounted = true;
    }
    if (mounted) state.activeArticle = null;
  }

  function scheduleShareMenuMount() {
    if (!state.activeArticle || state.mountScheduled) return;
    state.mountScheduled = true;
    global.requestAnimationFrame(mountShareMenuActions);
  }

  document.addEventListener('click', (event) => {
    const target = event.target instanceof global.Element ? event.target : null;
    const candidateButton = target?.closest?.('button, [role="button"]');
    const shareButton = isTweetShareButton(candidateButton) ? candidateButton : null;
    const article = shareButton?.closest?.('article[data-testid="tweet"]');
    if (!article) return;
    state.activeArticle = article;
    scheduleShareMenuMount();
    global.setTimeout(scheduleShareMenuMount, 80);
  }, true);

  const observer = new global.MutationObserver(scheduleShareMenuMount);
  observer.observe(document.body, { childList: true, subtree: true });
}(typeof globalThis !== 'undefined' ? globalThis : this));
