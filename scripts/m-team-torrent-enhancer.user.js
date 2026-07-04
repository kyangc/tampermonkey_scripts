// ==UserScript==
// @name         M-Team Torrent List Enhancer
// @namespace    https://github.com/kyangc/tampermonkey_scripts
// @version      0.1.7
// @description  Highlight new hot M-Team torrents and dim viewed torrent rows.
// @author       kyangc
// @homepageURL  https://github.com/kyangc/tampermonkey_scripts
// @supportURL   https://github.com/kyangc/tampermonkey_scripts/issues
// @updateURL    https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/m-team-torrent-enhancer.user.js
// @downloadURL  https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/m-team-torrent-enhancer.user.js
// @match        https://kp.m-team.cc/*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

(function mTeamTorrentEnhancer(global) {
  'use strict';

  const CONFIG = {
    hotMinScore: 0.45,
    hotFullScoreDays: 2,
    hotCutoffDays: 30,
    hotSeederScale: 1500,
    hotLeecherScale: 200,
    hotCommentScale: 50,
    hotWeights: {
      recency: 0.35,
      seeders: 0.25,
      leechers: 0.25,
      comments: 0.15,
    },
    maxViewedEntries: 4000,
    viewedStorageKey: 'm-team:torrent-enhancer:viewed:v1',
    viewedOverlayAlpha: 0.18,
  };

  const DAY_MS = 24 * 60 * 60 * 1000;
  const state = {
    enhanceScheduled: false,
    observer: null,
    torrentsById: new Map(),
    viewedStore: null,
  };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function round(value, places = 3) {
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
  }

  function toNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value !== 'string') return 0;
    const parsed = Number(value.replace(/,/g, '').trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function parseTimestamp(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string' || !value.trim()) return null;

    const text = value.trim();
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (match) {
      const [, year, month, day, hour, minute, second = '0'] = match;
      const date = new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
      );
      const time = date.getTime();
      return Number.isFinite(time) ? time : null;
    }

    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function extractSearchItems(payload) {
    if (!payload || typeof payload !== 'object') return [];
    const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
    const items = data.data || data.list || data.records || data.torrents;
    if (!Array.isArray(items)) return [];
    return items.filter((item) => item && item.id != null);
  }

  function computeHotnessScore(torrent, now = Date.now()) {
    const status = (torrent && torrent.status) || {};
    const createdAt = parseTimestamp(
      torrent && (torrent.createdDate || torrent.createdAt || torrent.addedDate || status.createdDate),
    );

    if (!createdAt) {
      return {
        activityScore: 0,
        ageDays: null,
        alpha: 0,
        comments: 0,
        completed: 0,
        leechers: 0,
        score: 0,
        seeders: 0,
      };
    }

    const ageDays = Math.max(0, (now - createdAt) / DAY_MS);
    const seeders = toNumber(status.seeders ?? torrent.seeders);
    const leechers = toNumber(status.leechers ?? torrent.leechers);
    const completed = toNumber(status.timesCompleted ?? torrent.timesCompleted ?? torrent.completed);
    const comments = toNumber(status.comments ?? torrent.comments);

    const isInsideNewHotWindow = ageDays <= CONFIG.hotCutoffDays;
    const recencyScore =
      !isInsideNewHotWindow
        ? 0
        : ageDays <= CONFIG.hotFullScoreDays
          ? 1
          : 1 - (ageDays - CONFIG.hotFullScoreDays) / (CONFIG.hotCutoffDays - CONFIG.hotFullScoreDays);
    const seederScore = clamp(Math.log1p(seeders) / Math.log1p(CONFIG.hotSeederScale), 0, 1);
    const leecherScore = clamp(Math.log1p(leechers) / Math.log1p(CONFIG.hotLeecherScale), 0, 1);
    const commentScore = clamp(Math.log1p(comments) / Math.log1p(CONFIG.hotCommentScale), 0, 1);
    const { hotWeights: weights } = CONFIG;
    const weightedScore = clamp(
      recencyScore * weights.recency +
        seederScore * weights.seeders +
        leecherScore * weights.leechers +
        commentScore * weights.comments,
      0,
      1,
    );
    const score = isInsideNewHotWindow ? weightedScore : 0;
    const alpha = score < CONFIG.hotMinScore ? 0 : clamp(0.1 + score * 0.38, 0.14, 0.48);

    return {
      ageDays: round(ageDays, 2),
      alpha: round(alpha),
      comments,
      completed,
      leechers,
      scores: {
        comments: round(commentScore),
        leechers: round(leecherScore),
        recency: round(recencyScore),
        seeders: round(seederScore),
      },
      score: round(score),
      seeders,
      weights: { ...weights },
    };
  }

  function computeRowVisualState(torrent, viewed = false, now = Date.now()) {
    const hotness = computeHotnessScore(torrent, now);
    const hotAlpha = hotness.alpha;
    const hotBorderAlpha = hotAlpha ? Math.min(hotAlpha + 0.24, 0.76) : 0;

    return {
      hot: hotAlpha > 0,
      hotness,
      renderInlineBadge: false,
      viewed: Boolean(viewed),
      cssVars: {
        '--mte-hot-alpha': hotAlpha.toFixed(3),
        '--mte-hot-border-alpha': hotBorderAlpha.toFixed(3),
        '--mte-viewed-alpha': viewed ? String(CONFIG.viewedOverlayAlpha) : '0',
      },
    };
  }

  function getTorrentIdFromUrl(href) {
    if (!href) return null;
    try {
      const url = new URL(String(href), 'https://kp.m-team.cc');
      const match = url.pathname.match(/^\/detail\/(\d+)/);
      return match ? match[1] : null;
    } catch (_error) {
      const match = String(href).match(/\/detail\/(\d+)/);
      return match ? match[1] : null;
    }
  }

  function normalizeViewedStore(store) {
    if (!store || typeof store !== 'object') return {};
    const normalized = {};
    for (const [id, timestamp] of Object.entries(store)) {
      const time = Number(timestamp);
      if (/^\d+$/.test(id) && Number.isFinite(time)) normalized[id] = time;
    }
    return normalized;
  }

  function pruneViewedStore(store, options = {}) {
    const maxEntries = options.maxEntries ?? CONFIG.maxViewedEntries;
    const entries = Object.entries(normalizeViewedStore(store)).sort((a, b) => b[1] - a[1]);
    return Object.fromEntries(entries.slice(0, maxEntries));
  }

  function markViewedInStore(store, id, timestamp = Date.now(), options = {}) {
    if (!id) return pruneViewedStore(store, options);
    const next = normalizeViewedStore(store);
    next[String(id)] = Number(timestamp) || Date.now();
    return pruneViewedStore(next, options);
  }

  function isViewedInStore(store, id) {
    if (!id || !store || typeof store !== 'object') return false;
    return Object.prototype.hasOwnProperty.call(store, String(id));
  }

  function getRouteUpdate(url) {
    return {
      shouldRefreshRows: true,
      viewedId: getTorrentIdFromUrl(url),
    };
  }

  function getStyleText() {
    return `
      tr.mte-row {
        --mte-hot-alpha: 0;
        --mte-hot-border-alpha: 0;
        --mte-viewed-alpha: 0;
      }

      tr.mte-row > td {
        background:
          linear-gradient(rgba(82, 87, 101, var(--mte-viewed-alpha)), rgba(82, 87, 101, var(--mte-viewed-alpha))),
          linear-gradient(rgba(255, 64, 48, var(--mte-hot-alpha)), rgba(255, 64, 48, var(--mte-hot-alpha))) !important;
        background-clip: padding-box;
      }

      tr.mte-hot-row > td:first-child {
        box-shadow: inset 5px 0 0 rgba(220, 25, 25, var(--mte-hot-border-alpha));
      }

      tr.mte-viewed-row a[href*="/detail/"] {
        opacity: 0.78;
      }
    `;
  }

  const core = {
    computeHotnessScore,
    computeRowVisualState,
    extractSearchItems,
    getTorrentIdFromUrl,
    getRouteUpdate,
    getStyleText,
    isViewedInStore,
    markViewedInStore,
    parseTimestamp,
    pruneViewedStore,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = core;
  }

  if (!global || !global.document) return;

  const pageWindow = global;
  const document = pageWindow.document;

  function isSearchApiUrl(url) {
    if (!url) return false;
    try {
      return new URL(String(url), pageWindow.location.href).pathname.endsWith('/api/torrent/search');
    } catch (_error) {
      return String(url).includes('/api/torrent/search');
    }
  }

  function getViewedStore() {
    if (state.viewedStore) return state.viewedStore;
    try {
      state.viewedStore = normalizeViewedStore(
        JSON.parse(pageWindow.localStorage.getItem(CONFIG.viewedStorageKey) || '{}'),
      );
    } catch (_error) {
      state.viewedStore = {};
    }
    return state.viewedStore;
  }

  function saveViewedStore(store) {
    state.viewedStore = pruneViewedStore(store);
    try {
      pageWindow.localStorage.setItem(CONFIG.viewedStorageKey, JSON.stringify(state.viewedStore));
    } catch (_error) {
      // Ignore storage quota or private-mode failures; row styling still works for this page session.
    }
  }

  function markViewed(id) {
    if (!id) return;
    saveViewedStore(markViewedInStore(getViewedStore(), id));
    scheduleEnhance();
  }

  function handleSearchPayload(payload) {
    const items = extractSearchItems(payload);
    if (!items.length) return;

    for (const item of items) {
      state.torrentsById.set(String(item.id), item);
    }
    scheduleEnhance();
  }

  function installFetchHook() {
    const nativeFetch = pageWindow.fetch;
    if (typeof nativeFetch !== 'function' || nativeFetch.__mteEnhanced) return;

    function enhancedFetch(input, init) {
      const requestUrl = typeof input === 'string' ? input : input && input.url;
      return nativeFetch.call(this, input, init).then((response) => {
        const responseUrl = response && response.url ? response.url : requestUrl;
        if (response && isSearchApiUrl(responseUrl)) {
          response
            .clone()
            .json()
            .then(handleSearchPayload)
            .catch(() => {});
        }
        return response;
      });
    }

    Object.defineProperty(enhancedFetch, '__mteEnhanced', { value: true });
    pageWindow.fetch = enhancedFetch;
  }

  function installXhrHook() {
    const NativeXHR = pageWindow.XMLHttpRequest;
    const proto = NativeXHR && NativeXHR.prototype;
    if (!proto || proto.__mteEnhanced) return;

    const nativeOpen = proto.open;
    const nativeSend = proto.send;

    proto.open = function enhancedOpen(method, url) {
      this.__mteRequestUrl = url;
      return nativeOpen.apply(this, arguments);
    };

    proto.send = function enhancedSend() {
      this.addEventListener(
        'loadend',
        () => {
          const url = this.responseURL || this.__mteRequestUrl;
          if (!isSearchApiUrl(url)) return;

          try {
            const responseType = this.responseType || 'text';
            if (responseType === 'json') {
              handleSearchPayload(this.response);
            } else if (responseType === 'text' || responseType === '') {
              handleSearchPayload(JSON.parse(this.responseText));
            }
          } catch (_error) {
            // Non-JSON or unavailable response bodies are ignored.
          }
        },
        { once: true },
      );

      return nativeSend.apply(this, arguments);
    };

    Object.defineProperty(proto, '__mteEnhanced', { value: true });
  }

  function installNetworkHooks() {
    installFetchHook();
    installXhrHook();
  }

  function installStyles() {
    if (document.getElementById('mte-torrent-enhancer-style')) return;
    const style = document.createElement('style');
    style.id = 'mte-torrent-enhancer-style';
    style.textContent = getStyleText();
    (document.head || document.documentElement).appendChild(style);
  }

  function parseRowFallback(row, id) {
    const cells = Array.from(row.cells || []);
    return {
      createdDate: cells[2]?.querySelector('[title]')?.getAttribute('title') || null,
      id,
      status: {
        comments: toNumber(cells[1]?.textContent || ''),
        leechers: toNumber(cells[5]?.textContent || ''),
        seeders: toNumber(cells[4]?.textContent || ''),
      },
    };
  }

  function getTorrentForRow(id, row) {
    return state.torrentsById.get(String(id)) || parseRowFallback(row, id);
  }

  function isAdultBrowsePage() {
    return pageWindow.location.pathname === '/browse/adult';
  }

  function removeHotBadge(row) {
    row.querySelectorAll('.mte-hot-badge').forEach((badge) => badge.remove());
  }

  function enhanceRow(row, id) {
    const torrent = getTorrentForRow(id, row);
    const viewed = isViewedInStore(getViewedStore(), id);
    const visualState = computeRowVisualState(torrent, viewed);

    row.classList.add('mte-row');
    row.classList.toggle('mte-hot-row', visualState.hot);
    row.classList.toggle('mte-viewed-row', viewed);
    row.dataset.mteTorrentId = id;
    for (const [name, value] of Object.entries(visualState.cssVars)) {
      row.style.setProperty(name, value);
    }
    if (visualState.hot) {
      const hotness = visualState.hotness;
      row.title = [
        `新热指数 ${Math.round(hotness.score * 100)}`,
        `发布 ${hotness.ageDays ?? '?'} 天`,
        `做种 ${hotness.seeders}`,
        `下载 ${hotness.leechers}`,
        `完成 ${hotness.completed}`,
      ].join(' / ');
    } else if (row.title && row.title.startsWith('新热指数 ')) {
      row.removeAttribute('title');
    }
    removeHotBadge(row);
  }

  function enhanceAllRows() {
    state.enhanceScheduled = false;
    installStyles();
    if (!isAdultBrowsePage()) return;

    const rows = new Set();
    for (const link of document.querySelectorAll('table a[href*="/detail/"]')) {
      const id = getTorrentIdFromUrl(link.getAttribute('href') || link.href);
      const row = link.closest('tr');
      if (!id || !row || rows.has(row) || !row.cells || row.cells.length < 6) continue;
      rows.add(row);
      enhanceRow(row, id);
    }
  }

  function scheduleEnhance() {
    if (state.enhanceScheduled) return;
    state.enhanceScheduled = true;
    pageWindow.requestAnimationFrame
      ? pageWindow.requestAnimationFrame(enhanceAllRows)
      : pageWindow.setTimeout(enhanceAllRows, 16);
  }

  function markCurrentDetailUrl() {
    const { viewedId } = getRouteUpdate(pageWindow.location.href);
    markViewed(viewedId);
  }

  function installActivationTracking() {
    const track = (event) => {
      if (event.type === 'keydown' && event.key !== 'Enter') return;
      const target = event.target;
      const link = target && target.closest ? target.closest('a[href*="/detail/"]') : null;
      if (!link) return;
      markViewed(getTorrentIdFromUrl(link.getAttribute('href') || link.href));
    };

    document.addEventListener('click', track, true);
    document.addEventListener('auxclick', track, true);
    document.addEventListener('keydown', track, true);
  }

  function installRouteTracking() {
    const notify = () => {
      pageWindow.setTimeout(() => {
        const routeUpdate = getRouteUpdate(pageWindow.location.href);
        if (routeUpdate.viewedId) markViewed(routeUpdate.viewedId);
        if (routeUpdate.shouldRefreshRows) scheduleEnhance();
      }, 0);
      pageWindow.setTimeout(scheduleEnhance, 350);
    };

    for (const method of ['pushState', 'replaceState']) {
      const native = pageWindow.history && pageWindow.history[method];
      if (typeof native !== 'function' || native.__mteEnhanced) continue;

      const wrapped = function wrappedHistoryMethod() {
        const result = native.apply(this, arguments);
        notify();
        return result;
      };
      Object.defineProperty(wrapped, '__mteEnhanced', { value: true });
      pageWindow.history[method] = wrapped;
    }

    pageWindow.addEventListener('popstate', notify);
  }

  function installStorageTracking() {
    pageWindow.addEventListener('storage', (event) => {
      if (event.key !== CONFIG.viewedStorageKey) return;
      state.viewedStore = null;
      scheduleEnhance();
    });
  }

  function installObserver() {
    if (state.observer || !document.documentElement) return;
    state.observer = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => mutation.addedNodes.length || mutation.removedNodes.length)) {
        scheduleEnhance();
      }
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
    scheduleEnhance();
  }

  function initDomFeatures() {
    installStyles();
    installActivationTracking();
    installObserver();
    markCurrentDetailUrl();
  }

  installNetworkHooks();
  installRouteTracking();
  installStorageTracking();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDomFeatures, { once: true });
  } else {
    initDomFeatures();
  }
})(typeof unsafeWindow !== 'undefined' ? unsafeWindow : typeof window !== 'undefined' ? window : globalThis);
