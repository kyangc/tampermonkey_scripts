// ==UserScript==
// @name         X Tweet Share Card
// @namespace    https://github.com/kyangc/tampermonkey_scripts
// @version      0.3.2
// @description  Generate a polished, copyable image card from an X post's share menu.
// @author       kyangc
// @homepageURL  https://github.com/kyangc/tampermonkey_scripts
// @supportURL   https://github.com/kyangc/tampermonkey_scripts/issues
// @updateURL    https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/x-tweet-share-card.user.js
// @downloadURL  https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/x-tweet-share-card.user.js
// @match        https://x.com/*
// @match        https://twitter.com/*
// @require      https://raw.githubusercontent.com/kazuhikoarase/qrcode-generator/js2.0.4/js/dist/qrcode.js#sha256-eeyG+ChWAFsciHkFz8z8++w4Icphx/1alS+qX3ePeRw=
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
            textX: rect.x,
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
    context.save();

    context.textAlign = 'left';
    context.textBaseline = 'alphabetic';
    context.fillStyle = '#1d9bf0';
    context.font = `700 30px ${FONT_STACK}`;
    context.fillText(sourceGuide.label, sourceGuide.textX, sourceGuide.labelBaselineY);

    context.fillStyle = '#536471';
    context.font = `400 23px ${FONT_STACK}`;
    context.fillText(
      fitCanvasText(context, sourceGuide.url, qrRect.x - sourceGuide.textX - 36),
      sourceGuide.textX,
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
