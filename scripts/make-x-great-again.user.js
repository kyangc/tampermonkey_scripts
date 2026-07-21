// ==UserScript==
// @name         Make X Great Again (Userscript)
// @namespace    https://github.com/kyangc/tampermonkey_scripts
// @version      0.1.2
// @description  Mark public-list spam accounts on X and hide them locally on PC and iOS.
// @author       kyangc
// @license      AGPL-3.0-or-later
// @source       https://github.com/foru17/make-x-great-again
// @homepageURL  https://github.com/kyangc/tampermonkey_scripts
// @supportURL   https://github.com/kyangc/tampermonkey_scripts/issues
// @updateURL    https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/make-x-great-again.user.js
// @downloadURL  https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/make-x-great-again.user.js
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-idle
// @inject-into  content
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.xmlHttpRequest
// @grant        GM.openInTab
// @connect      x.zuoluo.tv
// @noframes
// ==/UserScript==

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

        const storedMeta = sanitizeStoredListMeta(
          await storage.get(STORAGE_KEYS.listMeta, null),
        );
        const storedRaw = await storage.get(STORAGE_KEYS.listRaw, '');
        if (!force && storedMeta?.version && metaVersion === storedMeta.version && storedRaw) {
          return {
            updated: false,
            version: storedMeta.version,
            black: storedMeta.count,
            white,
            whitelistEntries: refreshedWhitelist?.entries,
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
        await storage.set(STORAGE_KEYS.listRaw, artifactText);
        await storage.set(STORAGE_KEYS.listMeta, nextMeta);
        return {
          updated: true,
          version: nextMeta.version,
          black: nextMeta.count,
          white,
          whitelistEntries: refreshedWhitelist?.entries,
          artifact: validated.value,
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
      shouldAutoHide: false,
      canHideManually: true,
    };
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

  const core = {
    createAccountIndex,
    createHiddenRegistry,
    createListSynchronizer,
    createRequestAdapter,
    decodeEntry,
    errorMessage,
    extractHandleFromHref,
    findProfileNameBlock,
    getAccountPresentation,
    normalizeHandle,
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
    const [raw, meta, whitelist] = await Promise.all([
      storage.get(STORAGE_KEYS.listRaw, ''),
      storage.get(STORAGE_KEYS.listMeta, null),
      storage.get(STORAGE_KEYS.whitelist, null),
    ]);
    const whitelistEntries = sanitizeStoredWhitelist(whitelist);
    const storedMeta = sanitizeStoredListMeta(meta);
    if (typeof raw !== 'string' || !raw) {
      return { entries: [], meta: storedMeta, whitelistEntries, error: null };
    }
    try {
      const validated = validateLiteArtifact(parseJson(raw, 'cached lite artifact'));
      if (!validated.ok) {
        return { entries: [], meta: storedMeta, whitelistEntries, error: validated.error };
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
    '.metric{padding:10px 11px;border-radius:12px;background:var(--soft)}',
    '.metric-label{display:block;color:var(--muted);font-size:11px}',
    '.metric-value{display:block;margin-top:3px;font-weight:750;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}',
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
      '<div class="actions"><button class="button primary" type="button" data-action="sync">立即更新名单</button></div>',
      '<section class="section">',
      '<div class="section-heading"><h3>本地隐藏记录</h3><span data-role="hidden-count">0 个</span></div>',
      '<div class="hidden-list" data-role="hidden-list"></div>',
      '</section>',
      '<p class="privacy">只下载公开名单并在本机匹配；不会上传你浏览的页面、X 账号、命中结果或隐藏记录。首版不执行 X 原生静音/拉黑，也不会自动隐藏任何名单账号。</p>',
      '<div class="links"><button class="link-button" type="button" data-action="open-upstream">上游项目 ↗</button><button class="link-button" type="button" data-action="open-source">本脚本源码 ↗</button></div>',
      '</div>',
      '</section>',
      '<section class="popover" data-role="popover" hidden aria-label="账号名单详情"></section>',
      '<div class="toast" data-role="toast" hidden role="status" aria-live="polite"><span data-role="toast-text"></span><button type="button" data-action="undo">撤销</button></div>',
    ].join('');
    root.appendChild(shell);

    const elements = {
      control: root.querySelector('.control'),
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
        '命中 MXGA 公共名单。本脚本只做提示；是否隐藏由你决定，操作只影响本机网页并可随时恢复。',
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
      elements.version.textContent = view.meta?.version || '—';
      elements.fetchedAt.textContent = formatTime(view.meta?.fetchedAt);
      elements.enabled.checked = view.settings.enabled;
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
          '本地名单已就绪。自动收录与人工确认条目均只提示，不会自动隐藏。';
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

  function cellForArticle(article) {
    const cell = article.closest('[data-testid="cellInnerDiv"]') || article;
    return cell instanceof HTMLElement ? cell : null;
  }

  function hideArticleLocally(article, handle) {
    const cell = cellForArticle(article);
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

    function processArticle(article) {
      const nameBlock = article.querySelector('[data-testid="User-Name"]');
      const handle = handleFromNameBlock(nameBlock);
      if (!nameBlock || !handle) return;
      const normalized = normalizeHandle(handle);
      const cell = cellForArticle(article);

      if (!state.settings.enabled) {
        clearBadgeMounts(nameBlock);
        revealCell(cell);
        return;
      }

      if (state.hidden.has(normalized)) {
        clearBadgeMounts(nameBlock);
        hideArticleLocally(article, normalized);
        return;
      }
      revealCell(cell);

      const entry = state.index.lookup({ handle: normalized });
      if (entry) mountOrUpdateBadge(nameBlock, normalized, entry, ui);
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
      for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
        processArticle(article);
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
      for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
        const nameBlock = article.querySelector('[data-testid="User-Name"]');
        if (normalizeHandle(handleFromNameBlock(nameBlock)) !== normalized) continue;
        clearBadgeMounts(nameBlock);
        hideArticleLocally(article, normalized);
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

    async function setEnabled(enabled) {
      state.settings = normalizeSettings({ ...state.settings, enabled });
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
      const [settings, hiddenRecords, storedMeta, storedWhitelist] = await Promise.all([
        storage.get(STORAGE_KEYS.settings, state.settings),
        storage.get(STORAGE_KEYS.hidden, state.hidden.list()),
        storage.get(STORAGE_KEYS.listMeta, state.meta),
        storage.get(STORAGE_KEYS.whitelist, null),
      ]);
      state.settings = normalizeSettings(settings);
      state.hidden = createHiddenRegistry(hiddenRecords);
      const safeStoredMeta = sanitizeStoredListMeta(storedMeta);
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
        state.meta =
          sanitizeStoredListMeta(await storage.get(STORAGE_KEYS.listMeta, state.meta)) ||
          state.meta;
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
          void setEnabled(enabled);
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
