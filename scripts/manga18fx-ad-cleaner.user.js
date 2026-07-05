// ==UserScript==
// @name         Manga18fx Ad Cleaner
// @namespace    https://github.com/kyangc/tampermonkey_scripts
// @version      0.1.0
// @description  Hide Manga18fx banner ad slots, floating ads, and anti-adblock prompts.
// @author       kyangc
// @homepageURL  https://github.com/kyangc/tampermonkey_scripts
// @supportURL   https://github.com/kyangc/tampermonkey_scripts/issues
// @updateURL    https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/manga18fx-ad-cleaner.user.js
// @downloadURL  https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/manga18fx-ad-cleaner.user.js
// @match        https://manga18fx.com/*
// @match        https://www.manga18fx.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function manga18fxAdCleaner(global) {
  'use strict';

  const CONFIG = {
    blockedHostSuffixes: [
      'crwdcntrl.net',
      'dtscdn.com',
      'dtscout.com',
      'histats.com',
      'magsrv.com',
      'mrktmtrcs.net',
      'similesgleby.com',
    ],
    earlyCleanDelaysMs: [0, 50, 250, 1000, 2500, 6000],
    floatingMinHeight: 80,
    floatingMinWidth: 240,
    highZIndex: 1000,
    mangaSiteHostSuffix: 'manga18fx.com',
  };

  const state = {
    appendGuardInstalled: false,
    cleanScheduled: false,
    observer: null,
    windowOpenGuardInstalled: false,
  };

  const CLEAN_SELECTOR = [
    '.kadx',
    '[id^="kadx_"]',
    '[id^="bn_"]',
    'ins[data-zoneid]',
    '#detect_modal',
    '.modal-backdrop',
    '[id*="exo-video-slider" i]',
    '[id*="exo" i]',
    '[class*="exo" i]',
    'iframe',
    'script',
  ].join(',');

  const FLOATING_SCAN_SELECTOR = [
    'body > div',
    'body > iframe',
    'body > ins',
    'body [id*="exo" i]',
    'body [class*="exo" i]',
  ].join(',');

  function normalizeHost(hostname) {
    return String(hostname || '')
      .trim()
      .toLowerCase()
      .replace(/\.+$/, '')
      .replace(/^www\./, '');
  }

  function parseUrl(value, baseUrl) {
    if (value == null) return null;
    const text = String(value).trim();
    if (!text) return null;
    try {
      return new URL(text, baseUrl || 'https://manga18fx.com/');
    } catch (_error) {
      return null;
    }
  }

  function isManga18fxHost(hostname) {
    const host = normalizeHost(hostname);
    return host === CONFIG.mangaSiteHostSuffix || host.endsWith(`.${CONFIG.mangaSiteHostSuffix}`);
  }

  function isBlockedAdHost(hostname) {
    const host = normalizeHost(hostname);
    if (!host || isManga18fxHost(host)) return false;
    return CONFIG.blockedHostSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  }

  function isBlockedAdUrl(value, baseUrl) {
    const url = parseUrl(value, baseUrl);
    if (!url || !/^https?:$/.test(url.protocol)) return false;
    return isBlockedAdHost(url.hostname);
  }

  function normalizeText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function toFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function getIdentityText(placement) {
    return normalizeText(
      [
        placement && placement.ariaLabel,
        placement && placement.className,
        placement && placement.id,
        placement && placement.name,
        placement && placement.title,
      ].join(' '),
    );
  }

  function getPlacementText(placement) {
    return normalizeText(
      [
        getIdentityText(placement),
        placement && placement.href,
        placement && placement.src,
        placement && placement.text,
      ].join(' '),
    );
  }

  function getResourceUrls(placement) {
    return [
      placement && placement.href,
      placement && placement.src,
      placement && placement.dataHref,
      placement && placement.dataSrc,
    ].filter(Boolean);
  }

  function isAdSlot(placement) {
    const tagName = String((placement && placement.tagName) || '').toUpperCase();
    const id = String((placement && placement.id) || '');
    const className = String((placement && placement.className) || '');
    return (
      /\bkadx(?:\b|-|_)/i.test(className) ||
      /^kadx(?:_|$)/i.test(id) ||
      /^bn_/i.test(id) ||
      (tagName === 'INS' && Boolean(placement && placement.dataZoneid))
    );
  }

  function isAdblockPrompt(placement) {
    const id = String((placement && placement.id) || '');
    const text = normalizeText(placement && placement.text);
    return id === 'detect_modal' || /\bare you using an adblock\?/i.test(text);
  }

  function isAgeGate(placement) {
    return String((placement && placement.id) || '') === 'adult_modal';
  }

  function isAdblockBackdrop(placement) {
    const className = String((placement && placement.className) || '');
    return /(?:^|\s)modal-backdrop(?:\s|$)/i.test(className);
  }

  function isInlineAdProviderScript(placement) {
    const tagName = String((placement && placement.tagName) || '').toUpperCase();
    if (tagName !== 'SCRIPT') return false;
    const text = normalizeText(placement && placement.text);
    return (
      /\(AdProvider\s*=\s*window\.AdProvider\s*\|\|/.test(text) ||
      /_Hasync\.push\(\['Histats\./.test(text)
    );
  }

  function isAllowedFloatingUi(placement) {
    const id = String((placement && placement.id) || '');
    const className = String((placement && placement.className) || '');
    if (id === 'back_to_top' || id === 'search-result') return true;
    if (/\b(?:live-search-result|genre-menu|sub-menu)\b/i.test(className)) return true;
    return false;
  }

  function isLayered(placement) {
    const position = String((placement && placement.position) || '').toLowerCase();
    return position === 'fixed' || position === 'absolute' || position === 'sticky';
  }

  function getZIndex(placement) {
    return toFiniteNumber(placement && placement.zIndex);
  }

  function coversViewport(placement) {
    const width = toFiniteNumber(placement && placement.width);
    const height = toFiniteNumber(placement && placement.height);
    const viewportWidth = toFiniteNumber(placement && placement.viewportWidth);
    const viewportHeight = toFiniteNumber(placement && placement.viewportHeight);
    return (
      viewportWidth > 0 &&
      viewportHeight > 0 &&
      width >= viewportWidth * 0.75 &&
      height >= viewportHeight * 0.75
    );
  }

  function isFloatingAdIdentity(placement) {
    const text = getPlacementText(placement);
    return /\bexo(?:_|-|video|close)|exo-video-slider|magsrv|ad-provider|similesgleby|dtscout\b/i.test(text);
  }

  function isExoAdElement(placement) {
    const identity = getIdentityText(placement);
    const text = normalizeText(placement && placement.text);
    return (
      /(?:^|[\s_-])exo(?:$|[\s_-])|exo-video-slider|_exo_|exo_(?:wrapper|close|progressbar)/i.test(identity) ||
      /#\w+_video_container|ourdream\.ai|View More/i.test(text)
    );
  }

  function isFloatingAd(placement) {
    if (!isLayered(placement) || getZIndex(placement) < CONFIG.highZIndex) return false;
    if (isAllowedFloatingUi(placement) || isAgeGate(placement)) return false;

    const width = toFiniteNumber(placement && placement.width);
    const height = toFiniteNumber(placement && placement.height);
    if (coversViewport(placement)) return true;
    return width >= CONFIG.floatingMinWidth && height >= CONFIG.floatingMinHeight && isFloatingAdIdentity(placement);
  }

  function classifyPlacement(placement, baseUrl) {
    if (!placement || typeof placement !== 'object') return { action: 'allow', reason: 'empty' };
    if (isAgeGate(placement)) return { action: 'allow', reason: 'age-gate' };
    if (isAdblockPrompt(placement)) return { action: 'remove', reason: 'adblock-modal' };
    if (isAdblockBackdrop(placement)) return { action: 'remove', reason: 'adblock-backdrop' };
    if (isAdSlot(placement)) {
      const tagName = String(placement.tagName || '').toUpperCase();
      return { action: 'remove', reason: tagName === 'INS' ? 'ad-zone' : 'ad-slot' };
    }
    if (getResourceUrls(placement).some((url) => isBlockedAdUrl(url, baseUrl))) {
      return { action: 'remove', reason: 'blocked-url' };
    }
    if (isInlineAdProviderScript(placement)) return { action: 'remove', reason: 'ad-provider-inline' };
    if (isAllowedFloatingUi(placement)) return { action: 'allow', reason: 'allowed-floating-ui' };
    if (isFloatingAd(placement)) {
      return { action: 'remove', reason: coversViewport(placement) ? 'click-shield' : 'floating-ad' };
    }
    if (isExoAdElement(placement)) return { action: 'remove', reason: 'exo-ad' };
    return { action: 'allow', reason: 'allowed' };
  }

  function getStyleText() {
    return `
      .m18fx-ad-cleaner-hidden,
      .kadx,
      [id^="kadx_"],
      [id^="bn_"],
      ins[data-zoneid],
      #detect_modal,
      .modal-backdrop,
      [id*="exo-video-slider" i],
      [id*="exo"][style*="position: fixed" i],
      [class*="exo"][style*="position: fixed" i],
      iframe[src*="//t.dtscout.com"],
      iframe[src*="//tags.crwdcntrl.net"],
      iframe[src*="//s10.histats.com"] {
        display: none !important;
        opacity: 0 !important;
        pointer-events: none !important;
        visibility: hidden !important;
      }
    `;
  }

  const core = {
    classifyPlacement,
    getStyleText,
    isBlockedAdHost,
    isBlockedAdUrl,
    isManga18fxHost,
    normalizeHost,
    normalizeText,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = core;
  }

  if (!global || !global.document) return;

  const pageWindow = global;
  const document = pageWindow.document;

  function getLocationHref() {
    return pageWindow.location && pageWindow.location.href ? pageWindow.location.href : 'https://manga18fx.com/';
  }

  function getElementPlacement(element) {
    const rect = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : {};
    const style =
      typeof pageWindow.getComputedStyle === 'function'
        ? pageWindow.getComputedStyle(element)
        : { position: '', zIndex: '' };

    return {
      ariaLabel: element.getAttribute('aria-label') || '',
      className: String(element.className || ''),
      dataHref: element.getAttribute('data-href') || '',
      dataSrc: element.getAttribute('data-src') || '',
      dataZoneid: element.getAttribute('data-zoneid') || '',
      height: rect.height || element.offsetHeight || 0,
      href: element.getAttribute('href') || '',
      id: element.id || '',
      name: element.getAttribute('name') || '',
      position: style.position,
      src: element.currentSrc || element.getAttribute('src') || '',
      tagName: element.tagName,
      text: (element.textContent || '').slice(0, 2000),
      title: element.getAttribute('title') || '',
      viewportHeight: pageWindow.innerHeight || 0,
      viewportWidth: pageWindow.innerWidth || 0,
      width: rect.width || element.offsetWidth || 0,
      zIndex: style.zIndex,
    };
  }

  function removeElement(element) {
    if (!element || !element.parentNode) return false;
    element.classList && element.classList.add('m18fx-ad-cleaner-hidden');
    element.remove();
    return true;
  }

  function cleanElement(element) {
    if (!element || element.nodeType !== 1) return false;
    const decision = classifyPlacement(getElementPlacement(element), getLocationHref());
    if (decision.action !== 'remove') return false;
    return removeElement(element);
  }

  function queryAll(root, selector) {
    if (!root) return [];
    const nodes = [];
    if (root.nodeType === 1 && root.matches && root.matches(selector)) nodes.push(root);
    if (root.querySelectorAll) nodes.push(...root.querySelectorAll(selector));
    return nodes;
  }

  function setAdblockQuietCookie() {
    try {
      document.cookie = 'modal-enable=2; path=/; max-age=3600; SameSite=Lax';
    } catch (_error) {
      // Cookie access can be unavailable in synthetic test documents.
    }
  }

  function cleanAds(root) {
    if (!document.documentElement) return;
    setAdblockQuietCookie();

    for (const element of queryAll(root || document, CLEAN_SELECTOR)) {
      cleanElement(element);
    }

    const scanRoot = document.body || document.documentElement;
    for (const element of queryAll(scanRoot, FLOATING_SCAN_SELECTOR)) {
      cleanElement(element);
    }
  }

  function scheduleClean() {
    if (state.cleanScheduled) return;
    state.cleanScheduled = true;
    pageWindow.setTimeout(() => {
      state.cleanScheduled = false;
      cleanAds(document);
    }, 0);
  }

  function shouldBlockInsertedNode(node) {
    if (!node || node.nodeType !== 1) return false;
    const decision = classifyPlacement(getElementPlacement(node), getLocationHref());
    return decision.action === 'remove';
  }

  function installAppendGuard() {
    const proto = pageWindow.Element && pageWindow.Element.prototype;
    if (!proto || state.appendGuardInstalled) return;

    const nativeAppendChild = proto.appendChild;
    const nativeInsertBefore = proto.insertBefore;

    if (typeof nativeAppendChild === 'function') {
      proto.appendChild = function guardedAppendChild(node) {
        if (shouldBlockInsertedNode(node)) {
          scheduleClean();
          return node;
        }
        return nativeAppendChild.call(this, node);
      };
    }

    if (typeof nativeInsertBefore === 'function') {
      proto.insertBefore = function guardedInsertBefore(node, child) {
        if (shouldBlockInsertedNode(node)) {
          scheduleClean();
          return node;
        }
        return nativeInsertBefore.call(this, node, child);
      };
    }

    state.appendGuardInstalled = true;
  }

  function installWindowOpenGuard() {
    if (state.windowOpenGuardInstalled || typeof pageWindow.open !== 'function') return;
    const nativeOpen = pageWindow.open;

    pageWindow.open = function guardedWindowOpen(url, target, features) {
      if (isBlockedAdUrl(url, getLocationHref())) {
        scheduleClean();
        return null;
      }
      return nativeOpen.call(this, url, target, features);
    };

    state.windowOpenGuardInstalled = true;
  }

  function installStyles() {
    if (document.getElementById('m18fx-ad-cleaner-style')) return;
    const style = document.createElement('style');
    style.id = 'm18fx-ad-cleaner-style';
    style.textContent = getStyleText();
    (document.head || document.documentElement).appendChild(style);
  }

  function installObserver() {
    const NativeMutationObserver =
      pageWindow.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    if (state.observer || !document.documentElement || typeof NativeMutationObserver !== 'function') return;

    state.observer = new NativeMutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          cleanElement(node);
          if (node && node.nodeType === 1) {
            for (const element of queryAll(node, CLEAN_SELECTOR)) cleanElement(element);
          }
        }
      }
      scheduleClean();
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function initDomCleaning() {
    installStyles();
    installObserver();
    cleanAds(document);
    for (const delay of CONFIG.earlyCleanDelaysMs) {
      pageWindow.setTimeout(() => cleanAds(document), delay);
    }
  }

  installAppendGuard();
  installWindowOpenGuard();
  installStyles();
  installObserver();
  cleanAds(document);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDomCleaning, { once: true });
  } else {
    initDomCleaning();
  }
})(typeof window !== 'undefined' ? window : globalThis);
