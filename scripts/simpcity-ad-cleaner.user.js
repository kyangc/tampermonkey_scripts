// ==UserScript==
// @name         SimpCity Ad Cleaner
// @namespace    https://github.com/kyangc/tampermonkey_scripts
// @version      0.1.0
// @description  Remove SimpCity click-ad redirects and noisy banner placements.
// @author       kyangc
// @homepageURL  https://github.com/kyangc/tampermonkey_scripts
// @supportURL   https://github.com/kyangc/tampermonkey_scripts/issues
// @updateURL    https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/simpcity-ad-cleaner.user.js
// @downloadURL  https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/simpcity-ad-cleaner.user.js
// @match        https://simpcity.cr/*
// @match        https://www.simpcity.cr/*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

(function simpcityAdCleaner(global) {
  'use strict';

  const CONFIG = {
    bannerTextMaxLength: 900,
    blockedHostSuffixes: [
      'adnium.com',
      'crakrevenue.com',
      'culinar9sync.com',
      'exoclick.com',
      'juicyads.com',
      'teamskeet.com',
      'theporndude.com',
      'trafficjunky.net',
    ],
    storageCleanDelayMs: 50,
  };

  const state = {
    cleanScheduled: false,
    observer: null,
  };

  const CLICK_EVENT_TYPES = new Set([
    'auxclick',
    'click',
    'mousedown',
    'mouseup',
    'pointerdown',
    'pointerup',
    'touchend',
    'touchstart',
  ]);

  const BANNER_TEXT_PATTERNS = [
    /\bai\s+porn\s+is\s+here\b/i,
    /\bcreate\s+and\s+fap\b/i,
    /\bcreate\s+your\s+ai\s+cum\s+slut\b/i,
    /\bgenerate\s+your\s+ai\s+trash\s+whore\b/i,
    /\btiktok\s+porn\b/i,
    /\b10,?000\+\s+scenes\b/i,
    /\bone\s+price:\s*free\b/i,
    /\bempty\s+your\s+balls\s+with\s+an\s+ai\b/i,
    /\bfree\s+sex\s+cams\b/i,
    /\bbuild\s+your\s+dream\s+fucktoy\b/i,
    /\bultimate\s+adult\s+ai\s+playground\b/i,
  ];

  const AD_CONTAINER_SELECTORS = [
    '.samBannerUnit',
    '.samCodeUnit',
    '.siropuAdsManager',
    '[data-sam-placement]',
    '[id^="samCodeUnit"]',
    '[id^="samBannerUnit"]',
    '[class*="banner" i]',
    '[id*="banner" i]',
    '[class*="advert" i]',
    '[id*="advert" i]',
    '.notice',
    '.node',
    '.node--link',
    '.p-navEl',
    'li',
    'section',
    'article',
    'div',
  ];

  const TEXT_BANNER_CANDIDATE_SELECTOR = [
    '.samBannerUnit',
    '.samCodeUnit',
    '.siropuAdsManager',
    '[data-sam-placement]',
    '[id^="samCodeUnit"]',
    '[id^="samBannerUnit"]',
    '[class*="banner" i]',
    '[id*="banner" i]',
    '[class*="advert" i]',
    '[id*="advert" i]',
    '.notice',
    '.node',
    '.node--link',
    'aside',
    'section',
    'article',
    'li',
    'div',
  ].join(',');

  function normalizeHost(hostname) {
    return String(hostname || '')
      .trim()
      .toLowerCase()
      .replace(/\.+$/, '')
      .replace(/^www\./, '');
  }

  function isBlockedAdHost(hostname) {
    const host = normalizeHost(hostname);
    if (!host) return false;
    return CONFIG.blockedHostSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  }

  function parseUrl(value, baseUrl) {
    if (value == null) return null;
    const text = String(value).trim();
    if (!text) return null;
    try {
      return new URL(text, baseUrl || 'https://simpcity.cr/');
    } catch (_error) {
      return null;
    }
  }

  function isBlockedAdUrl(value, baseUrl) {
    const url = parseUrl(value, baseUrl);
    if (!url) return false;
    if (!/^https?:$/.test(url.protocol)) return false;
    return isBlockedAdHost(url.hostname);
  }

  function normalizeText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isBlockedBannerText(value) {
    const text = normalizeText(value);
    if (!text || text.length > CONFIG.bannerTextMaxLength) return false;
    return BANNER_TEXT_PATTERNS.some((pattern) => pattern.test(text));
  }

  function classifyNavigationTarget(value, baseUrl) {
    if (value == null || String(value).trim() === '') {
      return { blocked: false, reason: 'empty' };
    }
    if (isBlockedAdUrl(value, baseUrl)) {
      return { blocked: true, reason: 'blocked-host' };
    }
    return { blocked: false, reason: 'allowed' };
  }

  function getStyleText() {
    return `
      .sac-hidden,
      .samBannerUnit,
      .samCodeUnit,
      .siropuAdsManager,
      [data-sam-placement],
      [id^="samCodeUnit"],
      [id^="samBannerUnit"],
      a[href*="//tt.culinar9sync.com"],
      a[href*="//culinar9sync.com"],
      a[href*="//theporndude.com"],
      a[href*="//www.theporndude.com"] {
        display: none !important;
      }
    `;
  }

  const core = {
    classifyNavigationTarget,
    getStyleText,
    isBlockedAdHost,
    isBlockedAdUrl,
    isBlockedBannerText,
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
    return pageWindow.location && pageWindow.location.href ? pageWindow.location.href : 'https://simpcity.cr/';
  }

  function hasBlockedHref(element) {
    if (!element || !element.getAttribute) return false;
    const href =
      element.getAttribute('href') ||
      element.getAttribute('src') ||
      element.getAttribute('data-href') ||
      element.getAttribute('data-url') ||
      '';
    return isBlockedAdUrl(href, getLocationHref());
  }

  function hasBlockedAdLink(element) {
    if (!element || !element.querySelector) return false;
    if (hasBlockedHref(element)) return true;
    return Boolean(
      Array.from(element.querySelectorAll('a[href], iframe[src], script[src], img[src]')).some(hasBlockedHref),
    );
  }

  function hasFormControl(element) {
    return Boolean(element && element.querySelector && element.querySelector('input, textarea, select, button'));
  }

  function isSafeRemovalCandidate(element) {
    if (!element || element === document.documentElement || element === document.body || element === document.head) {
      return false;
    }
    if (hasFormControl(element)) return false;

    const text = normalizeText(element.textContent || '');
    if (hasBlockedAdLink(element)) return true;
    return text.length > 0 && text.length <= CONFIG.bannerTextMaxLength && isBlockedBannerText(text);
  }

  function findAdContainer(element) {
    if (!element || !element.closest) return element;

    for (const selector of AD_CONTAINER_SELECTORS) {
      const candidate = element.closest(selector);
      if (isSafeRemovalCandidate(candidate)) return candidate;
    }

    let current = element;
    for (let depth = 0; current && depth < 6; depth += 1) {
      if (isSafeRemovalCandidate(current)) return current;
      current = current.parentElement;
    }

    return element;
  }

  function hideElement(element) {
    if (!element || element.__sacHidden) return false;
    element.__sacHidden = true;
    element.classList.add('sac-hidden');
    element.setAttribute('aria-hidden', 'true');
    element.style.setProperty('display', 'none', 'important');
    return true;
  }

  function removeElement(element) {
    if (!element) return false;
    const target = findAdContainer(element);
    return hideElement(target);
  }

  function cleanLinkedAds(root) {
    if (!root || !root.querySelectorAll) return 0;

    let removed = 0;
    const selector = 'a[href], iframe[src], script[src], img[src], [data-href], [data-url]';
    for (const element of root.querySelectorAll(selector)) {
      if (!hasBlockedHref(element)) continue;
      if (removeElement(element)) removed += 1;
    }
    return removed;
  }

  function cleanTextBanners(root) {
    if (!root || !root.querySelectorAll) return 0;

    let removed = 0;
    for (const element of root.querySelectorAll(TEXT_BANNER_CANDIDATE_SELECTOR)) {
      if (!isSafeRemovalCandidate(element)) continue;
      if (removeElement(element)) removed += 1;
    }
    return removed;
  }

  function cleanInlineHandlers(root) {
    if (!root || !root.querySelectorAll) return 0;

    let cleaned = 0;
    const handlerAttributes = ['onclick', 'onmousedown', 'onmouseup', 'onpointerdown', 'onpointerup', 'ontouchstart'];
    for (const element of root.querySelectorAll(handlerAttributes.map((name) => `[${name}]`).join(','))) {
      const source = handlerAttributes.map((name) => element.getAttribute(name) || '').join('\n');
      if (!source || (!hasBlockedAdLink(element) && !isBlockedBannerText(element.textContent || '') && !hasBlockedCode(source))) {
        continue;
      }
      for (const name of handlerAttributes) {
        element.removeAttribute(name);
      }
      cleaned += 1;
    }
    return cleaned;
  }

  function cleanAds(root = document) {
    cleanInlineHandlers(root);
    cleanLinkedAds(root);
    cleanTextBanners(root);
  }

  function scheduleClean() {
    if (state.cleanScheduled) return;
    state.cleanScheduled = true;
    const run = () => {
      state.cleanScheduled = false;
      cleanAds(document);
    };
    pageWindow.requestAnimationFrame ? pageWindow.requestAnimationFrame(run) : pageWindow.setTimeout(run, 16);
  }

  function getEventPath(event) {
    if (event && typeof event.composedPath === 'function') return event.composedPath();
    const path = [];
    let current = event && event.target;
    while (current) {
      path.push(current);
      current = current.parentElement;
    }
    return path;
  }

  function getElementNavigationTarget(element) {
    if (!element || !element.getAttribute) return '';
    return (
      element.getAttribute('href') ||
      element.getAttribute('src') ||
      element.getAttribute('data-href') ||
      element.getAttribute('data-url') ||
      ''
    );
  }

  function findEventAdTarget(event) {
    for (const node of getEventPath(event)) {
      if (!node || node.nodeType !== 1) continue;
      if (hasBlockedHref(node) || isSafeRemovalCandidate(node)) return node;
      if (node.matches && node.matches('a[href], [data-href], [data-url]')) {
        const target = getElementNavigationTarget(node);
        if (classifyNavigationTarget(target, getLocationHref()).blocked) return node;
      }
    }
    return null;
  }

  function stopAdEvent(event, target) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    removeElement(target);
    scheduleClean();
  }

  function installClickGuard() {
    const guard = (event) => {
      const target = findEventAdTarget(event);
      if (!target) return;
      stopAdEvent(event, target);
    };

    for (const type of CLICK_EVENT_TYPES) {
      document.addEventListener(type, guard, true);
    }
  }

  function installWindowOpenGuard() {
    const nativeOpen = pageWindow.open;
    if (typeof nativeOpen !== 'function' || nativeOpen.__sacGuarded) return;

    function guardedOpen(url) {
      const decision = classifyNavigationTarget(url, getLocationHref());
      if (decision.blocked) {
        scheduleClean();
        return null;
      }
      return nativeOpen.apply(this, arguments);
    }

    Object.defineProperty(guardedOpen, '__sacGuarded', { value: true });
    pageWindow.open = guardedOpen;
  }

  function hasBlockedCode(source) {
    const text = String(source || '').toLowerCase();
    return CONFIG.blockedHostSuffixes.some((host) => {
      const escapedHost = host.replace(/\./g, '\\.');
      const encodedHost = host.replace(/\./g, '\\x2e');
      return text.includes(host) || text.includes(escapedHost) || text.includes(encodedHost);
    });
  }

  function listenerToString(listener) {
    try {
      if (typeof listener === 'function') return Function.prototype.toString.call(listener);
      if (listener && typeof listener.handleEvent === 'function') return Function.prototype.toString.call(listener.handleEvent);
    } catch (_error) {
      return '';
    }
    return '';
  }

  function installEventListenerGuard() {
    const proto = pageWindow.EventTarget && pageWindow.EventTarget.prototype;
    if (!proto || proto.__sacGuarded) return;

    const nativeAddEventListener = proto.addEventListener;
    if (typeof nativeAddEventListener !== 'function') return;

    proto.addEventListener = function guardedAddEventListener(type, listener, options) {
      if (CLICK_EVENT_TYPES.has(String(type)) && hasBlockedCode(listenerToString(listener))) {
        scheduleClean();
        return undefined;
      }
      return nativeAddEventListener.call(this, type, listener, options);
    };

    Object.defineProperty(proto, '__sacGuarded', { value: true });
  }

  function installStyles() {
    if (document.getElementById('sac-ad-cleaner-style')) return;
    const style = document.createElement('style');
    style.id = 'sac-ad-cleaner-style';
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
          if (!node || node.nodeType !== 1) continue;
          cleanAds(node);
        }
        if (mutation.addedNodes.length) scheduleClean();
      }
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function initDomFeatures() {
    installStyles();
    installClickGuard();
    installObserver();
    cleanAds(document);
    pageWindow.setTimeout(scheduleClean, CONFIG.storageCleanDelayMs);
  }

  installWindowOpenGuard();
  installEventListenerGuard();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDomFeatures, { once: true });
  } else {
    initDomFeatures();
  }
})(typeof unsafeWindow !== 'undefined' ? unsafeWindow : typeof window !== 'undefined' ? window : globalThis);
