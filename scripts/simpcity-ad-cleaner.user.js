// ==UserScript==
// @name         SimpCity Ad Cleaner
// @namespace    https://github.com/kyangc/tampermonkey_scripts
// @version      0.1.8
// @description  Remove SimpCity click-ad redirects and noisy banner placements.
// @author       kyangc
// @homepageURL  https://github.com/kyangc/tampermonkey_scripts
// @supportURL   https://github.com/kyangc/tampermonkey_scripts/issues
// @updateURL    https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/simpcity-ad-cleaner.user.js
// @downloadURL  https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/simpcity-ad-cleaner.user.js
// @match        https://simpcity.cr/*
// @match        https://www.simpcity.cr/*
// @match        https://turbo.cr/embed/*
// @match        https://www.turbo.cr/embed/*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

(function simpcityAdCleaner(global) {
  'use strict';

  const CONFIG = {
    bannerTextMaxLength: 900,
    blockedHostSuffixes: [
      'adnium.com',
      'bookmsg.com',
      'bucklechemistdensity.com',
      'clickadu.net',
      'crakrevenue.com',
      'culinar9sync.com',
      'dasdaily.com',
      'e36c33c4d2.com',
      'exoclick.com',
      'juicyads.com',
      'nereserv.com',
      'teamskeet.com',
      'theporndude.com',
      'trafficjunky.net',
      'twinrdengine.com',
      'wpadmngr.com',
      'wpushsdk.com',
    ],
    mediaFrameHostSuffixes: ['turbo.cr'],
    topBannerMaxTop: 220,
    wideBannerMaxHeight: 160,
    wideBannerMinAspectRatio: 2.2,
    wideBackgroundMinWidth: 600,
    wideBannerMinHeight: 40,
    wideBannerMinWidth: 220,
    storageCleanDelayMs: 50,
  };

  const state = {
    clickGuardInstalled: false,
    cleanScheduled: false,
    embeddedCleanScheduled: false,
    embeddedFrameGuardInstalled: false,
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

  const IMAGE_BANNER_PATTERNS = [
    /18\+/i,
    /\bjav\s*hd\b/i,
    /\bjavhd\b/i,
    /\bclick[-_ ]?ad\b/i,
    /\bporn[-_ ]?game\b/i,
    /\bwatch\s+now\b/i,
    /全次元/,
    /成人/,
    /开始游戏/,
    /开启.*冒险/,
    /手[游遊]/,
    /海贼王/,
    /海賊王/,
    /脱衣/,
    /邂逅.*海洋/,
    /AI女友/i,
    /SSR女友/i,
    /登录即送/,
    /互[动動]剧情/,
    /沉浸/,
  ];

  const LIKELY_AD_NAVIGATION_PATTERNS = [
    /(^|[./?&=_-])ad(?:s|v|vert|server|network|sterra)?($|[./?&=_-])/i,
    /(^|[./?&=_-])advert(?:ise|ising|isement)?($|[./?&=_-])/i,
    /(^|[./?&=_-])click(?:id|tag)?($|[./?&=_-])/i,
    /(^|[./?&=_-])pop(?:up|under)?($|[./?&=_-])/i,
    /(^|[./?&=_-])promo(?:tion)?($|[./?&=_-])/i,
    /[?&]zone_?id=/i,
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

  const BROAD_SITE_CONTAINER_PATTERN =
    /(?:^|\s)(?:block(?:--category|-body|-container)?|hScroller(?:-scroll)?|p-body(?:-[\w-]+)?|p-header(?:-[\w-]+)?|p-nav|p-nav-scroller)(?=\s|$)/i;
  const EXPLICIT_AD_CONTAINER_PATTERN =
    /(?:^|[\s_-])(?:__clb-spot|ad|ads|advert|banner|samBannerUnit|samCodeUnit|siropuAdsManager)(?:$|[\s_-])/i;
  const REMOVABLE_RESOURCE_TAGS = new Set(['A', 'IFRAME', 'IMG', 'SCRIPT']);

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

  function isBlockedImageText(value) {
    const text = normalizeText(value);
    if (!text || text.length > CONFIG.bannerTextMaxLength) return false;
    return IMAGE_BANNER_PATTERNS.some((pattern) => pattern.test(text));
  }

  function getContainerIdentityText(candidate) {
    return normalizeText(
      [
        candidate && candidate.ariaLabel,
        candidate && candidate.className,
        candidate && candidate.dataSamPlacement,
        candidate && candidate.id,
        candidate && candidate.tagName,
        candidate && candidate.title,
      ].join(' '),
    );
  }

  function isExplicitAdContainer(candidate) {
    const identity = getContainerIdentityText(candidate);
    return Boolean(
      identity &&
        (EXPLICIT_AD_CONTAINER_PATTERN.test(identity) ||
          (candidate && candidate.dataSamPlacement) ||
          /\bsam(?:Banner|Code)Unit/i.test(identity)),
    );
  }

  function isBroadSiteContainer(candidate) {
    const identity = getContainerIdentityText(candidate);
    return Boolean(identity && BROAD_SITE_CONTAINER_PATTERN.test(identity));
  }

  function isCompactRemovalCandidate(candidate, text) {
    const tagName = String((candidate && candidate.tagName) || '').toUpperCase();
    if (REMOVABLE_RESOURCE_TAGS.has(tagName)) return true;

    const childCount = toFiniteNumber(candidate && candidate.childCount);
    const textLength = normalizeText(text).length;
    return childCount <= 2 && textLength <= CONFIG.bannerTextMaxLength;
  }

  function classifyContainerRemoval(candidate) {
    if (!candidate || typeof candidate !== 'object') return { removable: false, reason: 'empty' };
    if (candidate.isRoot) return { removable: false, reason: 'protected-root' };
    if (candidate.hasFormControl) return { removable: false, reason: 'form-control' };

    const text = normalizeText(candidate.text || '');
    const hasBlockedLink = Boolean(candidate.hasBlockedAdLink);
    const hasBlockedText =
      text.length > 0 && text.length <= CONFIG.bannerTextMaxLength && isBlockedBannerText(text);

    if (isExplicitAdContainer(candidate)) {
      if (hasBlockedLink) return { removable: true, reason: 'blocked-link-ad-container' };
      if (hasBlockedText) return { removable: true, reason: 'banner-text-ad-container' };
    }

    if (isBroadSiteContainer(candidate)) {
      if (hasBlockedLink) return { removable: false, reason: 'blocked-link-broad-site-container' };
      if (hasBlockedText) return { removable: false, reason: 'banner-text-broad-site-container' };
    }

    if (hasBlockedLink) {
      if (isCompactRemovalCandidate(candidate, text)) return { removable: true, reason: 'blocked-link-compact' };
      return { removable: false, reason: 'blocked-link-generic-container' };
    }

    if (hasBlockedText) {
      if (isCompactRemovalCandidate(candidate, text)) return { removable: true, reason: 'banner-text-compact' };
      return { removable: false, reason: 'banner-text-generic-container' };
    }

    return { removable: false, reason: 'allowed' };
  }

  function toFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function isSameSiteUrl(value, baseUrl) {
    const url = parseUrl(value, baseUrl);
    if (!url || !/^https?:$/.test(url.protocol)) return false;
    const host = normalizeHost(url.hostname);
    const baseHost = normalizeHost((parseUrl(baseUrl || 'https://simpcity.cr/') || {}).hostname);
    return host === baseHost || host === 'simpcity.cr';
  }

  function isExternalHttpUrl(value, baseUrl) {
    const url = parseUrl(value, baseUrl);
    if (!url || !/^https?:$/.test(url.protocol)) return false;
    return !isSameSiteUrl(url.href, baseUrl);
  }

  function isSamePageHashUrl(url, baseUrl) {
    const base = parseUrl(baseUrl || 'https://simpcity.cr/');
    if (!url || !base) return false;
    return (
      normalizeHost(url.hostname) === normalizeHost(base.hostname) &&
      url.pathname === base.pathname &&
      url.search === base.search &&
      Boolean(url.hash)
    );
  }

  function isLikelyAdNavigationUrl(value, baseUrl) {
    const url = parseUrl(value, baseUrl);
    if (!url || !/^https?:$/.test(url.protocol) || !isExternalHttpUrl(url.href, baseUrl)) return false;
    const text = `${normalizeHost(url.hostname)}${url.pathname}${url.search}`.toLowerCase();
    return LIKELY_AD_NAVIGATION_PATTERNS.some((pattern) => pattern.test(text));
  }

  function getImageMetric(image, keys) {
    for (const key of keys) {
      const value = image && image[key];
      const number = toFiniteNumber(value);
      if (number > 0) return number;
    }
    return 0;
  }

  function getImageSearchText(image) {
    return normalizeText(
      [
        image && image.alt,
        image && image.title,
        image && image.ariaLabel,
        image && image.src,
        image && image.href,
      ].join(' '),
    );
  }

  function extractCssUrls(value) {
    const text = String(value || '');
    const urls = [];
    const pattern = /url\((?:"([^"]+)"|'([^']+)'|([^'")]+))\)/gi;
    let match = pattern.exec(text);
    while (match) {
      urls.push((match[1] || match[2] || match[3] || '').trim());
      match = pattern.exec(text);
    }
    return urls.filter(Boolean);
  }

  function isWideBannerShape(image) {
    const width = getImageMetric(image, ['width', 'clientWidth', 'naturalWidth', 'offsetWidth']);
    const height = getImageMetric(image, ['height', 'clientHeight', 'naturalHeight', 'offsetHeight']);
    if (!width || !height) return false;
    return (
      width >= CONFIG.wideBannerMinWidth &&
      height >= CONFIG.wideBannerMinHeight &&
      height <= CONFIG.wideBannerMaxHeight &&
      width / height >= CONFIG.wideBannerMinAspectRatio
    );
  }

  function classifyImagePlacement(image, baseUrl) {
    if (!image || typeof image !== 'object') return { blocked: false, reason: 'empty' };

    const hasTopMetric = Object.prototype.hasOwnProperty.call(image, 'top') && image.top != null && image.top !== '';
    const top = toFiniteNumber(image.top);
    const isTopPlacement = hasTopMetric && top >= 0 && top <= CONFIG.topBannerMaxTop;
    const hasOffSiteLink = isExternalHttpUrl(image.href, baseUrl);
    const hasOffSiteTarget = isExternalHttpUrl(image.href, baseUrl) || isExternalHttpUrl(image.src, baseUrl);
    const isWideBanner = isWideBannerShape(image);

    if (isBlockedImageText(getImageSearchText(image)) && (isTopPlacement || (isWideBanner && hasOffSiteTarget))) {
      return { blocked: true, reason: 'ad-image-text' };
    }

    if (isBlockedAdUrl(image.href, baseUrl) || isBlockedAdUrl(image.src, baseUrl)) {
      return { blocked: true, reason: 'blocked-host' };
    }

    if (isTopPlacement && isWideBanner && hasOffSiteTarget) {
      return { blocked: true, reason: 'top-wide-linked-image' };
    }

    if (isWideBanner && hasOffSiteLink) {
      return { blocked: true, reason: 'linked-wide-image' };
    }

    return { blocked: false, reason: 'allowed' };
  }

  function getVisualSearchText(placement) {
    return normalizeText(
      [
        placement && placement.ariaLabel,
        placement && placement.backgroundImage,
        placement && placement.href,
        placement && placement.src,
        placement && placement.text,
        placement && placement.title,
      ].join(' '),
    );
  }

  function getVisualAssetUrls(placement) {
    return [
      placement && placement.href,
      placement && placement.src,
      ...extractCssUrls(placement && placement.backgroundImage),
    ].filter(Boolean);
  }

  function classifyVisualBannerPlacement(placement, baseUrl) {
    if (!placement || typeof placement !== 'object') return { blocked: false, reason: 'empty' };

    const hasTopMetric =
      Object.prototype.hasOwnProperty.call(placement, 'top') && placement.top != null && placement.top !== '';
    const top = toFiniteNumber(placement.top);
    const isTopPlacement = hasTopMetric && top >= 0 && top <= CONFIG.topBannerMaxTop;
    const isWideBanner = isWideBannerShape(placement);
    const assetUrls = getVisualAssetUrls(placement);
    const hasOffSiteTarget = assetUrls.some((url) => isExternalHttpUrl(url, baseUrl));

    if (isBlockedImageText(getVisualSearchText(placement)) && (isTopPlacement || (isWideBanner && hasOffSiteTarget))) {
      return { blocked: true, reason: 'ad-visual-text' };
    }

    for (const url of assetUrls) {
      const decision = classifyNavigationTarget(url, baseUrl);
      if (decision.blocked) return decision;
    }

    const width = getImageMetric(placement, ['width', 'clientWidth', 'naturalWidth', 'offsetWidth']);
    if (
      isTopPlacement &&
      isWideBanner &&
      placement.backgroundImage &&
      (hasOffSiteTarget || width >= CONFIG.wideBackgroundMinWidth)
    ) {
      return { blocked: true, reason: 'top-wide-background' };
    }

    return { blocked: false, reason: 'allowed' };
  }

  function isKnownMediaFrameHost(value, baseUrl) {
    const url = parseUrl(value, baseUrl);
    if (!url || !/^https?:$/.test(url.protocol)) return false;
    const host = normalizeHost(url.hostname);
    return CONFIG.mediaFrameHostSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  }

  function isTurboEmbedUrl(value) {
    const url = parseUrl(value, 'https://turbo.cr/');
    if (!url || !/^https?:$/.test(url.protocol)) return false;
    return isKnownMediaFrameHost(url.href) && /^\/embed(?:\/|$)/i.test(url.pathname);
  }

  function isMediaFrameShape(frame) {
    const width = getImageMetric(frame, ['width', 'clientWidth', 'offsetWidth']);
    const height = getImageMetric(frame, ['height', 'clientHeight', 'offsetHeight']);
    return width >= 280 && height >= 150;
  }

  function isEmptyFrameSrc(frame) {
    const src = String((frame && frame.src) || '').trim();
    return !src || src === 'about:blank';
  }

  function isTopWideEmptyFrame(frame) {
    if (!isEmptyFrameSrc(frame)) return false;

    const hasTopMetric = Object.prototype.hasOwnProperty.call(frame, 'top') && frame.top != null && frame.top !== '';
    const top = toFiniteNumber(frame && frame.top);
    const width = getImageMetric(frame, ['width', 'clientWidth', 'offsetWidth']);
    const height = getImageMetric(frame, ['height', 'clientHeight', 'offsetHeight']);
    return (
      hasTopMetric &&
      top >= 0 &&
      top <= CONFIG.topBannerMaxTop &&
      width >= CONFIG.wideBackgroundMinWidth &&
      height >= CONFIG.wideBannerMinHeight &&
      height <= CONFIG.wideBannerMaxHeight &&
      width / height >= CONFIG.wideBannerMinAspectRatio
    );
  }

  function getFrameSearchText(frame) {
    return normalizeText(
      [
        frame && frame.ariaLabel,
        frame && frame.className,
        frame && frame.id,
        frame && frame.name,
        frame && frame.src,
        frame && frame.title,
      ].join(' '),
    );
  }

  function isAdFrameShell(frame) {
    if (!isEmptyFrameSrc(frame) || !isWideBannerShape(frame)) return false;
    return /(?:^|[\s_-])(?:__clb-spot|ad|ads|advert|banner|sam)(?:$|[\s_-])/i.test(getFrameSearchText(frame));
  }

  function classifyFramePlacement(frame, baseUrl) {
    if (!frame || typeof frame !== 'object') return { action: 'allow', reason: 'empty' };
    const src = String(frame.src || '').trim();
    if (isTopWideEmptyFrame(frame)) return { action: 'remove', reason: 'top-wide-empty-frame' };
    if (isAdFrameShell(frame)) return { action: 'remove', reason: 'ad-frame-shell' };
    if (!src) return { action: 'allow', reason: 'empty' };

    const navigation = classifyNavigationTarget(src, baseUrl);
    if (navigation.blocked) return { action: 'remove', reason: navigation.reason };

    if (isSameSiteUrl(src, baseUrl || 'https://simpcity.cr/')) return { action: 'allow', reason: 'same-site' };

    const className = String(frame.className || '');
    if (isKnownMediaFrameHost(src, baseUrl)) return { action: 'allow', reason: 'known-media-frame' };
    if (/\b(?:embed|media|player|saint-iframe|video)\b/i.test(className) || isMediaFrameShape(frame)) {
      return { action: 'allow', reason: 'third-party-media-frame' };
    }

    return { action: 'allow', reason: 'external-frame' };
  }

  function getImagePlacement(image) {
    if (!image || !image.getAttribute) return {};
    const rect = typeof image.getBoundingClientRect === 'function' ? image.getBoundingClientRect() : {};
    const link = image.closest ? image.closest('a[href], [data-href], [data-url]') : null;
    return {
      alt: image.getAttribute('alt') || '',
      ariaLabel: image.getAttribute('aria-label') || '',
      clientHeight: image.clientHeight,
      clientWidth: image.clientWidth,
      height: rect.height || image.height,
      href:
        (link &&
          (link.getAttribute('href') || link.getAttribute('data-href') || link.getAttribute('data-url') || '')) ||
        '',
      naturalHeight: image.naturalHeight,
      naturalWidth: image.naturalWidth,
      src: image.currentSrc || image.getAttribute('src') || '',
      title: image.getAttribute('title') || '',
      top: rect.top,
      width: rect.width || image.width,
    };
  }

  function classifyNavigationTarget(value, baseUrl) {
    if (value == null || String(value).trim() === '') {
      return { blocked: false, reason: 'empty' };
    }
    if (isBlockedAdUrl(value, baseUrl)) {
      return { blocked: true, reason: 'blocked-host' };
    }
    if (isLikelyAdNavigationUrl(value, baseUrl)) {
      return { blocked: true, reason: 'likely-ad-url' };
    }
    return { blocked: false, reason: 'allowed' };
  }

  function classifyEmbeddedFramePopup(value, frameUrl) {
    if (!isTurboEmbedUrl(frameUrl)) return { blocked: false, reason: 'not-embed-frame' };
    if (value == null || String(value).trim() === '') return { blocked: true, reason: 'empty-embed-popup' };

    const url = parseUrl(value, frameUrl);
    if (!url) return { blocked: true, reason: 'invalid-embed-popup' };
    if (!/^https?:$/.test(url.protocol)) return { blocked: true, reason: 'non-http-embed-popup' };
    if (isKnownMediaFrameHost(url.href, frameUrl)) return { blocked: false, reason: 'same-embed-site' };

    return { blocked: true, reason: 'external-embed-popup' };
  }

  function classifyTurboEmbedPlacement(placement, baseUrl) {
    if (!placement || typeof placement !== 'object') return { blocked: false, reason: 'empty' };

    const tagName = String(placement.tagName || '').toUpperCase();
    const src = String(placement.src || '').trim();
    const href = String(placement.href || '').trim();
    const resourceUrl = src || href;
    if (resourceUrl) {
      const navigation = classifyNavigationTarget(resourceUrl, baseUrl || 'https://turbo.cr/embed/');
      if (navigation.blocked) return navigation;
    }

    const width = getImageMetric(placement, ['width', 'clientWidth', 'offsetWidth']);
    const height = getImageMetric(placement, ['height', 'clientHeight', 'offsetHeight']);
    const viewportWidth = toFiniteNumber(placement.viewportWidth);
    const viewportHeight = toFiniteNumber(placement.viewportHeight);
    const zIndex = toFiniteNumber(placement.zIndex);
    const position = String(placement.position || '').toLowerCase();
    const isLayered = position === 'fixed' || position === 'absolute' || position === 'sticky';
    const coversViewport =
      viewportWidth > 0 &&
      viewportHeight > 0 &&
      width >= viewportWidth * 0.75 &&
      height >= viewportHeight * 0.75;

    if (tagName === 'IFRAME' && isLayered && zIndex >= 1000 && width >= 250 && height >= 80) {
      return { blocked: true, reason: 'turbo-floating-ad-frame' };
    }

    if (tagName !== 'VIDEO' && isLayered && zIndex >= 1001 && coversViewport) {
      return { blocked: true, reason: 'turbo-click-shield' };
    }

    if (tagName !== 'VIDEO' && position === 'fixed' && zIndex >= 100000 && width >= 250 && height >= 80) {
      return { blocked: true, reason: 'turbo-floating-ad' };
    }

    return { blocked: false, reason: 'allowed' };
  }

  function classifyClickNavigation(link, baseUrl) {
    const href = link && link.href != null ? String(link.href).trim() : '';
    if (!href) return { action: 'allow', reason: 'empty' };

    const url = parseUrl(href, baseUrl || 'https://simpcity.cr/');
    if (!url || !/^https?:$/.test(url.protocol) || isSamePageHashUrl(url, baseUrl || 'https://simpcity.cr/')) {
      return { action: 'allow', reason: 'same-page-or-script' };
    }

    const navigation = classifyNavigationTarget(url.href, baseUrl);
    if (navigation.blocked) {
      return { action: 'block', reason: navigation.reason };
    }

    if (link && link.dataXfClick) {
      return { action: 'allow', reason: 'scripted-link' };
    }

    return { action: 'isolate', reason: 'real-link' };
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
    classifyClickNavigation,
    classifyContainerRemoval,
    classifyNavigationTarget,
    classifyImagePlacement,
    classifyVisualBannerPlacement,
    classifyFramePlacement,
    classifyEmbeddedFramePopup,
    classifyTurboEmbedPlacement,
    getStyleText,
    isBlockedAdHost,
    isBlockedAdUrl,
    isBlockedBannerText,
    isBlockedImageText,
    isLikelyAdNavigationUrl,
    isTurboEmbedUrl,
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

  function isEmbeddedFramePage() {
    return isTurboEmbedUrl(getLocationHref());
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

  function getContainerRemovalCandidate(element) {
    if (!element || !element.getAttribute) return {};
    return {
      ariaLabel: element.getAttribute('aria-label') || '',
      childCount: element.children ? element.children.length : 0,
      className: element.getAttribute('class') || '',
      dataSamPlacement: element.getAttribute('data-sam-placement') || '',
      hasBlockedAdLink: hasBlockedAdLink(element),
      hasFormControl: hasFormControl(element),
      id: element.getAttribute('id') || '',
      isRoot: element === document.documentElement || element === document.body || element === document.head,
      tagName: element.tagName || '',
      text: element.textContent || '',
      title: element.getAttribute('title') || '',
    };
  }

  function isSafeRemovalCandidate(element) {
    return classifyContainerRemoval(getContainerRemovalCandidate(element)).removable;
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

  function cleanImageBanners(root) {
    if (!root || !root.querySelectorAll) return 0;

    let removed = 0;
    for (const image of root.querySelectorAll('img, picture img')) {
      const decision = classifyImagePlacement(getImagePlacement(image), getLocationHref());
      if (!decision.blocked) continue;
      if (removeElement(image)) removed += 1;
    }
    return removed;
  }

  function getElementBackgroundImage(element) {
    const inlineBackground = element && element.style ? element.style.backgroundImage : '';
    if (inlineBackground && inlineBackground !== 'none') return inlineBackground;
    try {
      const style = pageWindow.getComputedStyle ? pageWindow.getComputedStyle(element) : null;
      return style && style.backgroundImage && style.backgroundImage !== 'none' ? style.backgroundImage : '';
    } catch (_error) {
      return '';
    }
  }

  function getVisualBannerPlacement(element) {
    if (!element || !element.getAttribute) return {};
    const rect = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : {};
    const link = element.closest ? element.closest('a[href], [data-href], [data-url]') : null;
    return {
      ariaLabel: element.getAttribute('aria-label') || '',
      backgroundImage: getElementBackgroundImage(element),
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
      height: rect.height || element.offsetHeight,
      href:
        (link &&
          (link.getAttribute('href') || link.getAttribute('data-href') || link.getAttribute('data-url') || '')) ||
        element.getAttribute('href') ||
        element.getAttribute('data-href') ||
        element.getAttribute('data-url') ||
        '',
      src: element.getAttribute('src') || '',
      text: element.textContent || '',
      title: element.getAttribute('title') || '',
      top: rect.top,
      width: rect.width || element.offsetWidth,
    };
  }

  function cleanVisualBanners(root) {
    if (!root || !root.querySelectorAll) return 0;

    let removed = 0;
    const selector = [
      'a[href]',
      '[data-href]',
      '[data-url]',
      '[style*="background" i]',
      '[class*="banner" i]',
      '[id*="banner" i]',
      '[class*="advert" i]',
      '[id*="advert" i]',
      'iframe[src]',
    ].join(',');

    for (const element of root.querySelectorAll(selector)) {
      const decision = classifyVisualBannerPlacement(getVisualBannerPlacement(element), getLocationHref());
      if (!decision.blocked) continue;
      if (removeElement(element)) removed += 1;
    }
    return removed;
  }

  function getFramePlacement(frame) {
    if (!frame || !frame.getAttribute) return {};
    return {
      ariaLabel: frame.getAttribute('aria-label') || '',
      className: frame.getAttribute('class') || '',
      height: frame.height || frame.clientHeight || frame.offsetHeight,
      id: frame.getAttribute('id') || '',
      name: frame.getAttribute('name') || '',
      sandbox: frame.getAttribute('sandbox') || '',
      src: frame.getAttribute('src') || '',
      title: frame.getAttribute('title') || '',
      top: typeof frame.getBoundingClientRect === 'function' ? frame.getBoundingClientRect().top : null,
      width: frame.width || frame.clientWidth || frame.offsetWidth,
    };
  }

  function cleanFramePopups(root) {
    if (!root || !root.querySelectorAll) return 0;

    let cleaned = 0;
    for (const frame of root.querySelectorAll('iframe')) {
      const decision = classifyFramePlacement(getFramePlacement(frame), getLocationHref());
      if (decision.action === 'remove') {
        if (removeElement(frame)) cleaned += 1;
        continue;
      }
    }
    return cleaned;
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
    cleanImageBanners(root);
    cleanVisualBanners(root);
    cleanFramePopups(root);
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

  function getElementNavigationInfo(element) {
    if (!element || !element.getAttribute) return { href: '' };
    return {
      dataXfClick: element.getAttribute('data-xf-click') || '',
      href: getElementNavigationTarget(element),
    };
  }

  function getTurboEmbedPlacement(element) {
    if (!element || !element.getAttribute) return {};
    const rect = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : {};
    let style = {};
    try {
      style = pageWindow.getComputedStyle ? pageWindow.getComputedStyle(element) : {};
    } catch (_error) {
      style = {};
    }

    return {
      className: element.getAttribute('class') || '',
      height: rect.height || element.offsetHeight,
      href: element.getAttribute('href') || '',
      id: element.getAttribute('id') || '',
      position: style.position || '',
      src: element.getAttribute('src') || '',
      tagName: element.tagName || '',
      text: element.textContent || '',
      viewportHeight: pageWindow.innerHeight || 0,
      viewportWidth: pageWindow.innerWidth || 0,
      width: rect.width || element.offsetWidth,
      zIndex: style.zIndex || '',
    };
  }

  function isBlockedTurboEmbedElement(element) {
    return classifyTurboEmbedPlacement(getTurboEmbedPlacement(element), getLocationHref()).blocked;
  }

  function neutralizeTurboEmbedElement(element) {
    if (!element || element === document.documentElement || element === document.body || element === document.head) {
      return false;
    }
    if (element.__sacTurboBlocked) return false;
    element.__sacTurboBlocked = true;

    if (element.tagName === 'SCRIPT') {
      try {
        element.type = 'application/x-simp-city-ad-cleaner-blocked';
      } catch (_error) {
        // Ignore read-only script type edge cases.
      }
    }

    if (element.tagName === 'IFRAME') {
      try {
        element.setAttribute('src', 'about:blank');
      } catch (_error) {
        // Ignore detached or locked frame edge cases.
      }
    }

    if (element.parentNode) {
      element.parentNode.removeChild(element);
      return true;
    }

    if (element.style) {
      element.style.setProperty('display', 'none', 'important');
      element.style.setProperty('pointer-events', 'none', 'important');
      return true;
    }

    return false;
  }

  function cleanTurboEmbedAds(root = document) {
    if (!root || !root.querySelectorAll) return 0;

    let cleaned = 0;
    const selector = [
      'script[src]',
      'iframe',
      'a[href]',
      'div',
      'section',
      'ins',
      '[src]',
      '[href]',
    ].join(',');

    const candidates = root.matches && root.matches(selector) ? [root, ...root.querySelectorAll(selector)] : root.querySelectorAll(selector);
    for (const element of candidates) {
      if (!isBlockedTurboEmbedElement(element)) continue;
      if (neutralizeTurboEmbedElement(element)) cleaned += 1;
    }
    return cleaned;
  }

  function scheduleTurboEmbedClean() {
    if (state.embeddedCleanScheduled) return;
    state.embeddedCleanScheduled = true;
    const run = () => {
      state.embeddedCleanScheduled = false;
      cleanTurboEmbedAds(document);
    };
    pageWindow.requestAnimationFrame ? pageWindow.requestAnimationFrame(run) : pageWindow.setTimeout(run, 16);
  }

  function classifyTurboResourceUrl(value) {
    return classifyTurboEmbedPlacement({ src: value, tagName: 'SCRIPT' }, getLocationHref());
  }

  function installTurboEmbedResourceGuards() {
    const elementProto = pageWindow.Element && pageWindow.Element.prototype;
    if (elementProto && !elementProto.__sacTurboSetAttributeGuarded) {
      const nativeSetAttribute = elementProto.setAttribute;
      if (typeof nativeSetAttribute === 'function') {
        elementProto.setAttribute = function guardedSetAttribute(name, value) {
          const attrName = String(name || '').toLowerCase();
          if ((attrName === 'src' || attrName === 'href') && classifyTurboResourceUrl(value).blocked) {
            nativeSetAttribute.call(this, `data-sac-blocked-${attrName}`, String(value || ''));
            scheduleTurboEmbedClean();
            return undefined;
          }
          return nativeSetAttribute.apply(this, arguments);
        };
        Object.defineProperty(elementProto, '__sacTurboSetAttributeGuarded', { value: true });
      }
    }

    const nodeProto = pageWindow.Node && pageWindow.Node.prototype;
    if (nodeProto && !nodeProto.__sacTurboInsertionGuarded) {
      for (const method of ['appendChild', 'insertBefore', 'replaceChild']) {
        const native = nodeProto[method];
        if (typeof native !== 'function') continue;
        nodeProto[method] = function guardedNodeInsert(node) {
          if (node && node.nodeType === 1 && isBlockedTurboEmbedElement(node)) {
            neutralizeTurboEmbedElement(node);
            scheduleTurboEmbedClean();
            return node;
          }
          return native.apply(this, arguments);
        };
      }
      Object.defineProperty(nodeProto, '__sacTurboInsertionGuarded', { value: true });
    }

    guardTurboUrlProperty(pageWindow.HTMLScriptElement && pageWindow.HTMLScriptElement.prototype, 'src', 'SCRIPT');
    guardTurboUrlProperty(pageWindow.HTMLIFrameElement && pageWindow.HTMLIFrameElement.prototype, 'src', 'IFRAME');
    guardTurboUrlProperty(pageWindow.HTMLAnchorElement && pageWindow.HTMLAnchorElement.prototype, 'href', 'A');
    installTurboNetworkGuards();
  }

  function guardTurboUrlProperty(proto, property, tagName) {
    if (!proto || proto[`__sacTurbo${property}Guarded`]) return;
    const descriptor = Object.getOwnPropertyDescriptor(proto, property);
    if (!descriptor || typeof descriptor.set !== 'function' || !descriptor.configurable) return;

    try {
      Object.defineProperty(proto, property, {
        configurable: true,
        get: descriptor.get
          ? function guardedTurboUrlGetter() {
              return descriptor.get.call(this);
            }
          : undefined,
        set(value) {
          const placement = { tagName };
          placement[property] = value;
          if (classifyTurboEmbedPlacement(placement, getLocationHref()).blocked) {
            this.setAttribute(`data-sac-blocked-${property}`, String(value || ''));
            scheduleTurboEmbedClean();
            return undefined;
          }
          return descriptor.set.call(this, value);
        },
      });
      Object.defineProperty(proto, `__sacTurbo${property}Guarded`, { value: true });
    } catch (_error) {
      // Some DOM prototypes are not configurable in all browsers.
    }
  }

  function installTurboNetworkGuards() {
    const nativeFetch = pageWindow.fetch;
    if (typeof nativeFetch === 'function' && !nativeFetch.__sacTurboGuarded) {
      function guardedTurboFetch(input) {
        const url = typeof input === 'string' ? input : input && input.url;
        if (classifyTurboResourceUrl(url).blocked) {
          scheduleTurboEmbedClean();
          return Promise.reject(new TypeError('Blocked by SimpCity Ad Cleaner'));
        }
        return nativeFetch.apply(this, arguments);
      }
      Object.defineProperty(guardedTurboFetch, '__sacTurboGuarded', { value: true });
      pageWindow.fetch = guardedTurboFetch;
    }

    const xhrProto = pageWindow.XMLHttpRequest && pageWindow.XMLHttpRequest.prototype;
    if (xhrProto && !xhrProto.__sacTurboGuarded) {
      const nativeOpen = xhrProto.open;
      const nativeSend = xhrProto.send;
      if (typeof nativeOpen === 'function' && typeof nativeSend === 'function') {
        xhrProto.open = function guardedTurboXhrOpen(method, url) {
          this.__sacTurboBlocked = classifyTurboResourceUrl(url).blocked;
          if (this.__sacTurboBlocked) {
            scheduleTurboEmbedClean();
            return nativeOpen.call(this, method, 'about:blank');
          }
          return nativeOpen.apply(this, arguments);
        };
        xhrProto.send = function guardedTurboXhrSend() {
          if (this.__sacTurboBlocked) {
            try {
              this.abort();
            } catch (_error) {
              // Ignore XHR state edge cases.
            }
            return undefined;
          }
          return nativeSend.apply(this, arguments);
        };
        Object.defineProperty(xhrProto, '__sacTurboGuarded', { value: true });
      }
    }

    const nativeBeacon = pageWindow.navigator && pageWindow.navigator.sendBeacon;
    if (typeof nativeBeacon === 'function' && !nativeBeacon.__sacTurboGuarded) {
      function guardedTurboBeacon(url) {
        if (classifyTurboResourceUrl(url).blocked) {
          scheduleTurboEmbedClean();
          return false;
        }
        return nativeBeacon.apply(this, arguments);
      }
      Object.defineProperty(guardedTurboBeacon, '__sacTurboGuarded', { value: true });
      try {
        pageWindow.navigator.sendBeacon = guardedTurboBeacon;
      } catch (_error) {
        // Ignore read-only navigator implementations.
      }
    }
  }

  function installTurboEmbedObserver() {
    const NativeMutationObserver =
      pageWindow.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    if (!document.documentElement || typeof NativeMutationObserver !== 'function') return;

    const observer = new NativeMutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!node || node.nodeType !== 1) continue;
          cleanTurboEmbedAds(node);
        }
      }
      scheduleTurboEmbedClean();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href', 'style', 'class'] });
  }

  function installEmbeddedFramePopupGuard() {
    if (state.embeddedFrameGuardInstalled) return;
    state.embeddedFrameGuardInstalled = true;

    installTurboEmbedResourceGuards();
    installTurboEmbedObserver();
    cleanTurboEmbedAds(document);
    pageWindow.setTimeout(scheduleTurboEmbedClean, 0);
    pageWindow.setTimeout(scheduleTurboEmbedClean, CONFIG.storageCleanDelayMs);
    let cleanPasses = 0;
    const cleanInterval = pageWindow.setInterval(() => {
      cleanPasses += 1;
      cleanTurboEmbedAds(document);
      if (cleanPasses >= 80) pageWindow.clearInterval(cleanInterval);
    }, 250);

    const nativeOpen = pageWindow.open;
    if (typeof nativeOpen === 'function' && !nativeOpen.__sacEmbeddedGuarded) {
      function guardedEmbeddedOpen(url) {
        const decision = classifyEmbeddedFramePopup(url, getLocationHref());
        if (decision.blocked) return null;
        return nativeOpen.apply(this, arguments);
      }

      Object.defineProperty(guardedEmbeddedOpen, '__sacEmbeddedGuarded', { value: true });
      pageWindow.open = guardedEmbeddedOpen;
    }

    const location = pageWindow.location;
    if (location && !location.__sacEmbeddedGuarded) {
      for (const method of ['assign', 'replace']) {
        const native = location[method];
        if (typeof native !== 'function') continue;

        try {
          Object.defineProperty(location, method, {
            configurable: true,
            value(url) {
              const decision = classifyEmbeddedFramePopup(url, getLocationHref());
              if (decision.blocked) return undefined;
              return native.call(this, url);
            },
          });
        } catch (_error) {
          // Location methods are often non-configurable; click and window.open guards still cover popup paths.
        }
      }

      try {
        Object.defineProperty(location, '__sacEmbeddedGuarded', { value: true });
      } catch (_error) {
        // Ignore non-extensible Location objects.
      }
    }

    const anchorProto = pageWindow.HTMLAnchorElement && pageWindow.HTMLAnchorElement.prototype;
    if (anchorProto && !anchorProto.__sacEmbeddedGuarded && typeof anchorProto.click === 'function') {
      const nativeClick = anchorProto.click;
      anchorProto.click = function guardedEmbeddedAnchorClick() {
        const decision = classifyEmbeddedFramePopup(getElementNavigationTarget(this), getLocationHref());
        if (decision.blocked) return undefined;
        return nativeClick.apply(this, arguments);
      };
      Object.defineProperty(anchorProto, '__sacEmbeddedGuarded', { value: true });
    }
  }

  function findEventNavigationDecision(event) {
    for (const node of getEventPath(event)) {
      if (!node || node.nodeType !== 1) continue;
      if (hasBlockedHref(node) || isSafeRemovalCandidate(node)) {
        return { action: 'block', reason: 'blocked-target', target: node };
      }
      if (node.matches && node.matches('a[href], [data-href], [data-url]')) {
        const decision = classifyClickNavigation(getElementNavigationInfo(node), getLocationHref());
        if (decision.action !== 'allow') return { ...decision, target: node };
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

  function isolateLinkEvent(event) {
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    scheduleClean();
  }

  function installClickGuard() {
    if (state.clickGuardInstalled) return;
    state.clickGuardInstalled = true;

    const guard = (event) => {
      const decision = findEventNavigationDecision(event);
      if (!decision) return;
      if (decision.action === 'block') {
        stopAdEvent(event, decision.target);
        return;
      }
      if (decision.action === 'isolate') {
        isolateLinkEvent(event);
      }
    };

    for (const target of [pageWindow, document]) {
      for (const type of CLICK_EVENT_TYPES) {
        target.addEventListener(type, guard, true);
      }
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

  function installLocationGuard() {
    const location = pageWindow.location;
    if (!location || location.__sacGuarded) return;

    for (const method of ['assign', 'replace']) {
      const native = location[method];
      if (typeof native !== 'function') continue;

      try {
        Object.defineProperty(location, method, {
          configurable: true,
          value(url) {
            const decision = classifyNavigationTarget(url, getLocationHref());
            if (decision.blocked) {
              scheduleClean();
              return undefined;
            }
            return native.call(this, url);
          },
        });
      } catch (_error) {
        // Some browsers expose Location methods as non-configurable; click isolation still handles user clicks.
      }
    }

    try {
      Object.defineProperty(location, '__sacGuarded', { value: true });
    } catch (_error) {
      // Ignore non-extensible Location objects.
    }
  }

  function installAnchorClickGuard() {
    const proto = pageWindow.HTMLAnchorElement && pageWindow.HTMLAnchorElement.prototype;
    if (!proto || proto.__sacGuarded || typeof proto.click !== 'function') return;

    const nativeClick = proto.click;
    proto.click = function guardedAnchorClick() {
      const decision = classifyClickNavigation(getElementNavigationInfo(this), getLocationHref());
      if (decision.action === 'block') {
        removeElement(this);
        scheduleClean();
        return undefined;
      }
      return nativeClick.apply(this, arguments);
    };

    Object.defineProperty(proto, '__sacGuarded', { value: true });
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

  if (isEmbeddedFramePage()) {
    installEmbeddedFramePopupGuard();
    return;
  }

  installWindowOpenGuard();
  installLocationGuard();
  installAnchorClickGuard();
  installEventListenerGuard();
  installClickGuard();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDomFeatures, { once: true });
  } else {
    initDomFeatures();
  }
})(typeof unsafeWindow !== 'undefined' ? unsafeWindow : typeof window !== 'undefined' ? window : globalThis);
