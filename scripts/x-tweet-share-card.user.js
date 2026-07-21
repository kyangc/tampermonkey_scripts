// ==UserScript==
// @name         X Tweet Share Card
// @namespace    https://github.com/kyangc/tampermonkey_scripts
// @version      0.1.1
// @description  Generate a polished, copyable image card from an X post's share menu.
// @author       kyangc
// @homepageURL  https://github.com/kyangc/tampermonkey_scripts
// @supportURL   https://github.com/kyangc/tampermonkey_scripts/issues
// @updateURL    https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/x-tweet-share-card.user.js
// @downloadURL  https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/x-tweet-share-card.user.js
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-idle
// @inject-into  content
// @grant        GM.xmlHttpRequest
// @connect      pbs.twimg.com
// @noframes
// ==/UserScript==

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

  function normalizeTweetData(value = {}) {
    const mediaUrls = [];
    for (const rawUrl of Array.isArray(value.mediaUrls) ? value.mediaUrls : []) {
      const url = normalizeMediaUrl(rawUrl);
      if (url && !mediaUrls.includes(url)) mediaUrls.push(url);
      if (mediaUrls.length === 4) break;
    }

    const rawHandle = String(value.handle || '').trim().replace(/^@+/, '');
    const handle = /^[A-Za-z0-9_]{1,15}$/.test(rawHandle) ? `@${rawHandle}` : '';
    const publishedAt = Number.isFinite(Date.parse(value.publishedAt || ''))
      ? new Date(value.publishedAt).toISOString()
      : '';

    return {
      authorName: String(value.authorName || '').trim(),
      handle,
      text: String(value.text || '').trim(),
      avatarUrl: normalizeAvatarUrl(value.avatarUrl),
      mediaUrls,
      publishedAt,
      statusUrl: normalizeStatusUrl(value.statusUrl),
    };
  }

  function wrapText(value, maxWidth, measureText) {
    const text = String(value || '');
    if (!text) return [];
    if (!(maxWidth > 0) || typeof measureText !== 'function') return [text];

    const lines = [];
    for (const paragraph of text.split('\n')) {
      if (!paragraph) {
        lines.push('');
        continue;
      }

      const tokens = paragraph.match(/\s+|[^\s]+/gu) || [];
      let line = '';

      for (const token of tokens) {
        if (/^\s+$/u.test(token)) {
          if (line && !line.endsWith(' ')) line += ' ';
          continue;
        }

        const candidate = `${line}${token}`;
        if (!line || measureText(candidate) <= maxWidth) {
          if (measureText(candidate) <= maxWidth) {
            line = candidate;
            continue;
          }
        }

        if (line.trimEnd()) lines.push(line.trimEnd());
        line = '';

        for (const grapheme of Array.from(token)) {
          const next = `${line}${grapheme}`;
          if (line && measureText(next) > maxWidth) {
            lines.push(line);
            line = grapheme;
          } else {
            line = next;
          }
        }
      }

      if (line.trimEnd()) lines.push(line.trimEnd());
    }

    return lines;
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

  function extractTweetData(article) {
    if (!article || typeof article.querySelector !== 'function') return normalizeTweetData();

    const nameBlock = article.querySelector('[data-testid="User-Name"]')
      || article.querySelector('[data-testid="UserName"]');
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

    const textNode = article.querySelector('[data-testid="tweetText"]');
    const avatar = article.querySelector('[data-testid="Tweet-User-Avatar"] img[src]');
    const time = article.querySelector('time[datetime]');
    const statusAnchor = time && typeof time.closest === 'function'
      ? time.closest('a[href*="/status/"]')
      : article.querySelector('a[href*="/status/"]');
    const mediaNodes = typeof article.querySelectorAll === 'function'
      ? Array.from(article.querySelectorAll('[data-testid="tweetPhoto"] img[src]'))
      : [];

    return normalizeTweetData({
      authorName,
      handle: handleText || (handleFromHref ? handleFromHref[1] : ''),
      text: textNode ? (textNode.innerText || textNode.textContent || '') : '',
      avatarUrl: avatar ? (avatar.currentSrc || avatar.src || avatar.getAttribute?.('src') || '') : '',
      mediaUrls: mediaNodes.map((node) => node.currentSrc || node.src || node.getAttribute?.('src') || ''),
      publishedAt: time?.getAttribute?.('datetime') || '',
      statusUrl: statusAnchor?.getAttribute?.('href') || '',
    });
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
    const textTop = headerTop + headerHeight + 42;
    const textLineHeight = 58;
    const allTextLines = wrapText(tweet?.text || '', contentWidth, measureText);
    const textLines = allTextLines.length > 48
      ? [...allTextLines.slice(0, 47), `${allTextLines[47].replace(/[\s…]+$/u, '')}…`]
      : allTextLines;
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
      gap: 12,
    });
    const contentBottom = mediaCount ? mediaTop + mediaHeight : textTop + textHeight;
    const footerTop = contentBottom + 56;
    const footerHeight = 38;
    const cardBottom = footerTop + footerHeight + padding;
    card.height = cardBottom - card.y;

    return {
      canvasWidth,
      canvasHeight: cardBottom + outerMargin,
      card,
      contentX,
      contentWidth,
      footerTop,
      headerTop,
      mediaRects,
      textLineHeight,
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

  const core = {
    buildCardLayout,
    extractTweetData,
    findShareMenuAnchor,
    getMediaLayout,
    getMediaRenderConfig,
    isTweetShareButton,
    isTweetShareMenu,
    normalizeTweetData,
    wrapText,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = core;
  }

  if (!global || !global.document) return;

  const document = global.document;
  const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
  const state = {
    activeArticle: null,
    mountScheduled: false,
    modalClose: null,
  };

  function roundedRectPath(context, x, y, width, height, radius) {
    const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
    context.beginPath();
    context.moveTo(x + safeRadius, y);
    context.arcTo(x + width, y, x + width, y + height, safeRadius);
    context.arcTo(x + width, y + height, x, y + height, safeRadius);
    context.arcTo(x, y + height, x, y, safeRadius);
    context.arcTo(x, y, x + width, y, safeRadius);
    context.closePath();
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

  function drawMediaBorder(context, rect, config) {
    const inset = config.borderWidth / 2;
    context.save();
    roundedRectPath(
      context,
      rect.x + inset,
      rect.y + inset,
      rect.width - config.borderWidth,
      rect.height - config.borderWidth,
      22 - inset,
    );
    context.strokeStyle = config.borderColor;
    context.lineWidth = config.borderWidth;
    context.stroke();
    context.restore();
  }

  function drawAvatar(context, asset, tweet, layout) {
    const rect = {
      x: layout.contentX,
      y: layout.headerTop,
      width: 104,
      height: 104,
    };

    context.save();
    roundedRectPath(context, rect.x, rect.y, rect.width, rect.height, 52);
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
      context.font = `700 46px ${FONT_STACK}`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(Array.from(tweet.authorName || tweet.handle || 'X')[0] || 'X', rect.x + 52, rect.y + 54);
    }
    context.restore();

    context.save();
    context.strokeStyle = 'rgba(15, 20, 25, 0.08)';
    context.lineWidth = 2;
    roundedRectPath(context, rect.x, rect.y, rect.width, rect.height, 52);
    context.stroke();
    context.restore();
  }

  function drawMediaPlaceholder(context, rect) {
    context.save();
    roundedRectPath(context, rect.x, rect.y, rect.width, rect.height, 22);
    context.fillStyle = '#eff3f4';
    context.fill();
    context.fillStyle = '#8b98a5';
    context.font = `600 30px ${FONT_STACK}`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('图片暂不可用', rect.x + rect.width / 2, rect.y + rect.height / 2);
    context.restore();
  }

  async function renderShareCard(rawTweet) {
    const tweet = normalizeTweetData(rawTweet);
    const measureCanvas = document.createElement('canvas');
    const measureContext = measureCanvas.getContext('2d');
    measureContext.font = `400 42px ${FONT_STACK}`;
    const assetUrls = [tweet.avatarUrl, ...tweet.mediaUrls].filter(Boolean);
    const loaded = await Promise.all(assetUrls.map((url) => loadImageAsset(url).catch(() => null)));
    let loadedIndex = 0;
    const avatarAsset = tweet.avatarUrl ? loaded[loadedIndex++] : null;
    const mediaAssets = tweet.mediaUrls.map(() => loaded[loadedIndex++] || null);
    const singleMediaImage = mediaAssets.length === 1 ? mediaAssets[0]?.image : null;
    const singleMediaAspectRatio = singleMediaImage
      ? (singleMediaImage.naturalHeight || singleMediaImage.height)
        / (singleMediaImage.naturalWidth || singleMediaImage.width)
      : undefined;
    const layout = buildCardLayout(
      tweet,
      (text) => measureContext.measureText(text).width,
      { singleMediaAspectRatio },
    );
    const canvas = document.createElement('canvas');
    canvas.width = layout.canvasWidth;
    canvas.height = layout.canvasHeight;
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';

    try {
      const background = context.createLinearGradient(0, 0, layout.canvasWidth, layout.canvasHeight);
      background.addColorStop(0, '#dff2ff');
      background.addColorStop(0.5, '#f4f7fb');
      background.addColorStop(1, '#eee9ff');
      context.fillStyle = background;
      context.fillRect(0, 0, layout.canvasWidth, layout.canvasHeight);

      context.save();
      context.globalAlpha = 0.55;
      context.fillStyle = '#ffffff';
      context.beginPath();
      context.arc(1080, 76, 250, 0, Math.PI * 2);
      context.fill();
      context.restore();

      context.save();
      context.shadowColor = 'rgba(25, 39, 52, 0.18)';
      context.shadowBlur = 44;
      context.shadowOffsetY = 18;
      roundedRectPath(context, layout.card.x, layout.card.y, layout.card.width, layout.card.height, 44);
      context.fillStyle = '#ffffff';
      context.fill();
      context.restore();

      drawAvatar(context, avatarAsset, tweet, layout);

      const identityX = layout.contentX + 132;
      const identityWidth = layout.contentWidth - 132 - 100;
      context.textAlign = 'left';
      context.textBaseline = 'alphabetic';
      context.fillStyle = '#0f1419';
      context.font = `700 38px ${FONT_STACK}`;
      context.fillText(fitCanvasText(context, tweet.authorName || tweet.handle || 'X 用户', identityWidth), identityX, layout.headerTop + 43);
      context.fillStyle = '#536471';
      context.font = `400 30px ${FONT_STACK}`;
      context.fillText(fitCanvasText(context, tweet.handle, identityWidth), identityX, layout.headerTop + 87);

      context.fillStyle = '#0f1419';
      context.font = `800 44px ${FONT_STACK}`;
      context.textAlign = 'right';
      context.fillText('X', layout.contentX + layout.contentWidth, layout.headerTop + 48);

      context.textAlign = 'left';
      context.textBaseline = 'alphabetic';
      context.fillStyle = '#0f1419';
      context.font = `400 42px ${FONT_STACK}`;
      for (let index = 0; index < layout.textLines.length; index += 1) {
        const line = layout.textLines[index];
        if (line) context.fillText(line, layout.contentX, layout.textTop + (index + 1) * layout.textLineHeight - 10);
      }

      const mediaRenderConfig = getMediaRenderConfig(layout.mediaRects.length);
      layout.mediaRects.forEach((rect, index) => {
        const asset = mediaAssets[index];
        if (asset?.image && mediaRenderConfig.fit === 'contain') {
          drawImageContain(context, asset.image, rect, 22);
        } else if (asset?.image) {
          drawImageCover(context, asset.image, rect, 22);
        } else {
          drawMediaPlaceholder(context, rect);
        }
        drawMediaBorder(context, rect, mediaRenderConfig);
      });

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
      context.textAlign = 'right';
      context.font = `600 25px ${FONT_STACK}`;
      context.fillText('X · SHARE CARD', layout.contentX + layout.contentWidth, layout.footerTop + 25);
    } finally {
      for (const asset of loaded) asset?.revoke?.();
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
        .modal{display:grid;grid-template-rows:auto minmax(0,1fr) auto;width:min(680px,100%);max-height:min(900px,calc(100dvh - 36px));overflow:hidden;border:1px solid rgba(255,255,255,.38);border-radius:28px;background:#f7f9f9;box-shadow:0 28px 90px rgba(0,0,0,.36)}
        .header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding:22px 24px 18px;background:rgba(255,255,255,.96);border-bottom:1px solid #eff3f4}
        .eyebrow{margin:0 0 4px;color:#1d9bf0;font-size:12px;font-weight:800;letter-spacing:.13em;text-transform:uppercase}
        h2{margin:0;font-size:22px;line-height:1.25;letter-spacing:-.02em}
        .subtitle{margin:6px 0 0;color:#536471;font-size:14px;line-height:1.45}
        .close{flex:0 0 auto;display:grid;place-items:center;width:36px;height:36px;border:0;border-radius:999px;background:#eff3f4;color:#0f1419;cursor:pointer;transition:.16s ease}
        .close:hover{background:#dfe5e8;transform:rotate(4deg)}
        .close:focus-visible,.button:focus-visible{outline:3px solid rgba(29,155,240,.32);outline-offset:2px}
        .preview-shell{min-height:280px;overflow:auto;padding:24px;background:linear-gradient(135deg,#eef8ff 0%,#f7f9f9 48%,#f4efff 100%);overscroll-behavior:contain}
        .preview{display:block;width:100%;height:auto;border-radius:18px;box-shadow:0 12px 36px rgba(15,20,25,.16)}
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
