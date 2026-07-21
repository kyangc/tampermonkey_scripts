import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const require = createRequire(import.meta.url);
const core = require('../scripts/x-tweet-share-card.user.js');
const scriptText = readFileSync(new URL('../scripts/x-tweet-share-card.user.js', import.meta.url), 'utf8');

test('normalizes extracted tweet data into a stable share-card model', () => {
  const tweet = core.normalizeTweetData({
    authorName: '  Ada Lovelace  ',
    handle: ' @ada_dev ',
    text: 'First line\n\nSecond line  ',
    avatarUrl: 'https://pbs.twimg.com/profile_images/avatar_normal.jpg',
    mediaUrls: [
      'https://pbs.twimg.com/media/one.jpg?format=jpg&name=small',
      'https://pbs.twimg.com/media/one.jpg?format=jpg&name=small',
      'https://pbs.twimg.com/media/two.jpg',
      'https://pbs.twimg.com/media/three.jpg',
      'https://pbs.twimg.com/media/four.jpg',
      'https://pbs.twimg.com/media/five.jpg',
    ],
    publishedAt: '2026-07-21T04:05:06.000Z',
    statusUrl: '/ada_dev/status/1234567890',
  });

  assert.deepEqual(tweet, {
    authorName: 'Ada Lovelace',
    handle: '@ada_dev',
    isVerified: false,
    text: 'First line\n\nSecond line',
    avatarUrl: 'https://pbs.twimg.com/profile_images/avatar_400x400.jpg',
    mediaUrls: [
      'https://pbs.twimg.com/media/one.jpg?format=jpg&name=large',
      'https://pbs.twimg.com/media/two.jpg?name=large',
      'https://pbs.twimg.com/media/three.jpg?name=large',
      'https://pbs.twimg.com/media/four.jpg?name=large',
    ],
    publishedAt: '2026-07-21T04:05:06.000Z',
    statusUrl: 'https://x.com/ada_dev/status/1234567890',
    videoPosterUrl: '',
    context: null,
  });
});

test('normalizes a quoted tweet as one complete nested context model', () => {
  const tweet = core.normalizeTweetData({
    authorName: 'Dash',
    handle: '@DashHuang',
    text: 'Outer post',
    context: {
      kind: 'quote',
      tweet: {
        authorName: 'Jing Zhang',
        handle: '@vinjn',
        text: 'Quoted post',
        mediaUrls: [
          'https://pbs.twimg.com/media/quoted-one.jpg?name=small',
          'https://pbs.twimg.com/media/quoted-two.jpg?name=small',
        ],
      },
    },
  });

  assert.equal(tweet.context.kind, 'quote');
  assert.deepEqual(tweet.context.tweet, {
    authorName: 'Jing Zhang',
    handle: '@vinjn',
    isVerified: false,
    text: 'Quoted post',
    avatarUrl: '',
    mediaUrls: [
      'https://pbs.twimg.com/media/quoted-one.jpg?name=large',
      'https://pbs.twimg.com/media/quoted-two.jpg?name=large',
    ],
    publishedAt: '',
    statusUrl: '',
    videoPosterUrl: '',
    context: null,
  });
});

test('wraps mixed-language tweet text without losing explicit blank lines', () => {
  const measureText = (value) => Array.from(value).length;

  assert.deepEqual(
    core.wrapText('分享图 keeps\n\nlayout 🚀', 6, measureText),
    ['分享图', 'keeps', '', 'layout', '🚀'],
  );
  assert.deepEqual(core.wrapText('abcdefgh', 4, measureText), ['abcd', 'efgh']);
});

test('lays out one to four tweet images as a balanced card grid', () => {
  const area = { x: 0, y: 0, width: 1000, height: 600, gap: 12 };

  assert.deepEqual(core.getMediaLayout(1, area), [
    { x: 0, y: 0, width: 1000, height: 600 },
  ]);
  assert.deepEqual(core.getMediaLayout(3, area), [
    { x: 0, y: 0, width: 494, height: 600 },
    { x: 506, y: 0, width: 494, height: 294 },
    { x: 506, y: 306, width: 494, height: 294 },
  ]);
  assert.deepEqual(core.getMediaLayout(4, area), [
    { x: 0, y: 0, width: 494, height: 294 },
    { x: 506, y: 0, width: 494, height: 294 },
    { x: 0, y: 306, width: 494, height: 294 },
    { x: 506, y: 306, width: 494, height: 294 },
  ]);
});

test('rounds only the outer corners of X-style multi-image grids', () => {
  assert.deepEqual(core.getMediaTileRadii(2, 0), { topLeft: 22, topRight: 0, bottomRight: 0, bottomLeft: 22 });
  assert.deepEqual(core.getMediaTileRadii(2, 1), { topLeft: 0, topRight: 22, bottomRight: 22, bottomLeft: 0 });
  assert.deepEqual(core.getMediaTileRadii(3, 0), { topLeft: 22, topRight: 0, bottomRight: 0, bottomLeft: 22 });
  assert.deepEqual(core.getMediaTileRadii(3, 1), { topLeft: 0, topRight: 22, bottomRight: 0, bottomLeft: 0 });
  assert.deepEqual(core.getMediaTileRadii(3, 2), { topLeft: 0, topRight: 0, bottomRight: 22, bottomLeft: 0 });
  assert.deepEqual(core.getMediaTileRadii(4, 2), { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 22 });
});

test('uses the same tight X-style gap for the main multi-image grid', () => {
  const layout = core.buildCardLayout(
    { mediaUrls: ['one', 'two', 'three'] },
    (value) => value.length * 20,
  );
  const [left, topRight, bottomRight] = layout.mediaRects;

  assert.equal(topRight.x - (left.x + left.width), 6);
  assert.equal(bottomRight.y - (topRight.y + topRight.height), 6);
});

test('extracts the visible post from an X tweet article without private APIs', () => {
  const statusAnchor = { getAttribute: (name) => name === 'href' ? '/ada_dev/status/1234567890' : null };
  const time = {
    getAttribute: (name) => name === 'datetime' ? '2026-07-21T04:05:06.000Z' : null,
    closest: () => statusAnchor,
  };
  const profileLink = {
    textContent: 'Ada Lovelace',
    getAttribute: (name) => name === 'href' ? '/ada_dev' : null,
  };
  const handleSpan = { textContent: '@ada_dev' };
  const nameBlock = {
    querySelector: (selector) => selector === '[data-testid="icon-verified"]' ? {} : null,
    querySelectorAll: (selector) => selector === 'a[href]' ? [profileLink] : [handleSpan],
  };
  const selectors = new Map([
    ['[data-testid="User-Name"]', nameBlock],
    ['[data-testid="tweetText"]', { innerText: 'A testable share card 🚀' }],
    ['[data-testid="Tweet-User-Avatar"] img[src]', { src: 'https://pbs.twimg.com/profile_images/a_normal.jpg' }],
    ['time[datetime]', time],
  ]);
  const article = {
    querySelector: (selector) => selectors.get(selector) || null,
    querySelectorAll: (selector) => selector === '[data-testid="tweetPhoto"] img[src]'
      ? [
          { src: 'https://pbs.twimg.com/media/one.jpg?name=small' },
          { src: 'https://pbs.twimg.com/media/two.jpg?name=small' },
        ]
      : [],
  };

  assert.deepEqual(core.extractTweetData(article), {
    authorName: 'Ada Lovelace',
    handle: '@ada_dev',
    isVerified: true,
    text: 'A testable share card 🚀',
    avatarUrl: 'https://pbs.twimg.com/profile_images/a_400x400.jpg',
    mediaUrls: [
      'https://pbs.twimg.com/media/one.jpg?name=large',
      'https://pbs.twimg.com/media/two.jpg?name=large',
    ],
    publishedAt: '2026-07-21T04:05:06.000Z',
    statusUrl: 'https://x.com/ada_dev/status/1234567890',
    videoPosterUrl: '',
    context: null,
  });
});

test('extracts an X quoted tweet without mixing its text or images into the outer tweet', () => {
  const textNode = (text, quoteRoot = null) => ({
    innerText: text,
    textContent: text,
    closest: (selector) => selector === '[role="link"]' ? quoteRoot : null,
  });
  const profileLink = (name, handle) => ({
    textContent: name,
    getAttribute: (attribute) => attribute === 'href' ? `/${handle}` : null,
  });
  const nameBlock = (name, handle, quoteRoot = null) => ({
    closest: (selector) => selector === '[role="link"]' ? quoteRoot : null,
    querySelector: () => null,
    querySelectorAll: (selector) => selector === 'a[href]'
      ? [profileLink(name, handle)]
      : [{ textContent: `@${handle}` }],
  });
  const mainPhoto = { src: 'https://pbs.twimg.com/media/main.jpg' };
  const quotePhoto = { src: 'https://pbs.twimg.com/media/quote.jpg' };
  const quoteRoot = {
    contains: (node) => [quoteRoot.name, quoteRoot.text, quoteRoot.avatar, quotePhoto].includes(node),
    querySelector: (selector) => ({
      '[data-testid="User-Name"]': quoteRoot.name,
      '[data-testid="tweetText"]': quoteRoot.text,
      '[data-testid="Tweet-User-Avatar"] img[src]': quoteRoot.avatar,
    }[selector] || null),
    querySelectorAll: (selector) => ({
      '[data-testid="User-Name"], [data-testid="UserName"]': [quoteRoot.name],
      '[data-testid="tweetText"]': [quoteRoot.text],
      '[data-testid="tweetPhoto"] img[src]': [quotePhoto],
      'time[datetime]': [],
    }[selector] || []),
  };
  quoteRoot.name = nameBlock('Jing Zhang', 'vinjn', quoteRoot);
  quoteRoot.text = textNode('Quoted post with image', quoteRoot);
  quoteRoot.avatar = { src: 'https://pbs.twimg.com/profile_images/quote_normal.jpg' };

  const mainName = nameBlock('Dash', 'DashHuang');
  const mainText = textNode('Outer post');
  const article = {
    querySelector: (selector) => ({
      '[data-testid="User-Name"]': mainName,
      '[data-testid="tweetText"]': mainText,
      '[data-testid="Tweet-User-Avatar"] img[src]': { src: 'https://pbs.twimg.com/profile_images/main_normal.jpg' },
    }[selector] || null),
    querySelectorAll: (selector) => ({
      '[data-testid="User-Name"], [data-testid="UserName"]': [mainName, quoteRoot.name],
      '[data-testid="tweetText"]': [mainText, quoteRoot.text],
      '[data-testid="tweetPhoto"] img[src]': [mainPhoto, quotePhoto],
      'time[datetime]': [],
    }[selector] || []),
  };

  const extracted = core.extractTweetData(article);
  assert.equal(extracted.text, 'Outer post');
  assert.deepEqual(extracted.mediaUrls, ['https://pbs.twimg.com/media/main.jpg?name=large']);
  assert.equal(extracted.context.kind, 'quote');
  assert.equal(extracted.context.tweet.authorName, 'Jing Zhang');
  assert.equal(extracted.context.tweet.text, 'Quoted post with image');
  assert.deepEqual(extracted.context.tweet.mediaUrls, ['https://pbs.twimg.com/media/quote.jpg?name=large']);
});

test('extracts the preceding parent tweet when sharing a reply from its conversation page', () => {
  const makeArticle = ({ name, handle, text, statusId }) => {
    const statusAnchor = {
      getAttribute: (attribute) => attribute === 'href' ? `/${handle}/status/${statusId}` : null,
    };
    const time = {
      getAttribute: (attribute) => attribute === 'datetime' ? '2026-07-21T04:05:06.000Z' : null,
      closest: () => statusAnchor,
    };
    const nameBlock = {
      closest: () => null,
      querySelector: () => null,
      querySelectorAll: (selector) => selector === 'a[href]'
        ? [{ textContent: name, getAttribute: () => `/${handle}` }]
        : [{ textContent: `@${handle}` }],
    };
    const tweetText = { innerText: text, textContent: text, closest: () => null };
    return {
      querySelector: (selector) => ({
        '[data-testid="User-Name"]': nameBlock,
        '[data-testid="tweetText"]': tweetText,
        'time[datetime]': time,
      }[selector] || null),
      querySelectorAll: (selector) => ({
        '[data-testid="User-Name"], [data-testid="UserName"]': [nameBlock],
        '[data-testid="tweetText"]': [tweetText],
        'time[datetime]': [time],
      }[selector] || []),
    };
  };

  const parent = makeArticle({
    name: 'Original Author',
    handle: 'original',
    text: 'The complete parent post',
    statusId: '111',
  });
  const reply = makeArticle({
    name: 'Reply Author',
    handle: 'reply_author',
    text: 'My reply',
    statusId: '222',
  });
  const ownerDocument = {
    querySelectorAll: (selector) => selector === 'article[data-testid="tweet"]'
      ? [parent, reply]
      : [],
  };
  parent.ownerDocument = ownerDocument;
  reply.ownerDocument = ownerDocument;

  const extracted = core.extractTweetData(reply, {
    pageUrl: 'https://x.com/reply_author/status/222',
  });

  assert.equal(extracted.context.kind, 'reply');
  assert.equal(extracted.context.tweet.authorName, 'Original Author');
  assert.equal(extracted.context.tweet.text, 'The complete parent post');
  assert.equal(extracted.context.tweet.statusUrl, 'https://x.com/original/status/111');

  const extractedFromRootConversation = core.extractTweetData(reply, {
    pageUrl: 'https://x.com/original/status/111',
  });
  assert.equal(extractedFromRootConversation.context.kind, 'reply');
  assert.equal(extractedFromRootConversation.context.tweet.statusUrl, 'https://x.com/original/status/111');
});

test('uses the visible X video poster as card media and ignores profile images', () => {
  const posterUrl = 'https://pbs.twimg.com/amplify_video_thumb/123/img/poster.jpg';
  const video = {
    poster: posterUrl,
    getAttribute: (name) => name === 'poster' ? posterUrl : null,
  };
  const posterPlayer = {
    querySelector: (selector) => selector === 'video[poster]' ? video : null,
    querySelectorAll: () => [],
  };
  const fallbackPlayer = {
    querySelector: () => null,
    querySelectorAll: (selector) => selector === 'img[src]'
      ? [
          { src: 'https://pbs.twimg.com/profile_images/456/avatar_mini.jpg' },
          { src: 'https://pbs.twimg.com/ext_tw_video_thumb/123/pu/img/fallback.jpg' },
        ]
      : [],
  };
  const articleWithPlayer = (player) => ({
    querySelector: (selector) => selector === '[data-testid="videoPlayer"]' ? player : null,
  });

  assert.equal(core.extractVideoPosterUrl(articleWithPlayer(posterPlayer)), posterUrl);
  assert.equal(
    core.extractVideoPosterUrl(articleWithPlayer(fallbackPlayer)),
    'https://pbs.twimg.com/ext_tw_video_thumb/123/pu/img/fallback.jpg',
  );

  assert.deepEqual(core.normalizeTweetData({ videoPosterUrl: posterUrl }), {
    authorName: '',
    handle: '',
    isVerified: false,
    text: '',
    avatarUrl: '',
    mediaUrls: ['https://pbs.twimg.com/amplify_video_thumb/123/img/poster.jpg?name=large'],
    publishedAt: '',
    statusUrl: '',
    videoPosterUrl: 'https://pbs.twimg.com/amplify_video_thumb/123/img/poster.jpg?name=large',
    context: null,
  });
});

test('grows the share card around wrapped text before placing tweet media', () => {
  const measureText = (value) => Array.from(value).length * 42;
  const base = {
    authorName: 'Ada',
    handle: '@ada',
    mediaUrls: ['one', 'two'],
  };
  const short = core.buildCardLayout({ ...base, text: 'Short post' }, measureText);
  const long = core.buildCardLayout({
    ...base,
    text: 'This post intentionally contains enough text to wrap across several card lines. '.repeat(5),
  }, measureText);

  assert.equal(short.canvasWidth, 1200);
  assert.equal(short.mediaRects.length, 2);
  assert.ok(long.textLines.length > short.textLines.length);
  assert.ok(long.mediaRects[0].y > short.mediaRects[0].y);
  assert.ok(long.canvasHeight > short.canvasHeight);
  assert.ok(long.mediaRects.every((rect) => rect.x >= long.card.x));
  assert.ok(long.mediaRects.every((rect) => rect.x + rect.width <= long.card.x + long.card.width));
});

test('lays out a complete nested tweet with its own X-style media grid', () => {
  const measureText = (value) => Array.from(value).length * 20;
  const nestedText = `${'Quoted context stays complete. '.repeat(70)}THE_END`;
  const tweet = core.normalizeTweetData({
    authorName: 'Outer',
    handle: '@outer',
    text: 'Outer text',
    context: {
      kind: 'quote',
      tweet: {
        authorName: 'Quoted',
        handle: '@quoted',
        text: nestedText,
        mediaUrls: ['one', 'two', 'three'],
      },
    },
  });

  const withoutContext = core.buildCardLayout({ ...tweet, context: null }, measureText);
  const layout = core.buildCardLayout(tweet, measureText);

  assert.equal(layout.contextLayout.kind, 'quote');
  assert.equal(layout.contextLayout.textLines.at(-1).endsWith('THE_END'), true);
  assert.equal(layout.contextLayout.mediaRects.length, 3);
  assert.ok(layout.contextLayout.mediaRects[0].height > layout.contextLayout.mediaRects[1].height);
  assert.equal(layout.contextLayout.mediaRects[1].x, layout.contextLayout.mediaRects[2].x);
  assert.ok(layout.contextLayout.mediaRects[1].y < layout.contextLayout.mediaRects[2].y);
  assert.ok(layout.contextLayout.rect.y > layout.textTop);
  assert.ok(layout.canvasHeight > withoutContext.canvasHeight);
});

test('preserves the full aspect ratio of a single tall tweet image', () => {
  const measureText = (value) => Array.from(value).length * 42;
  const tweet = { text: 'Tall image', mediaUrls: ['one'] };

  const portrait = core.buildCardLayout(tweet, measureText, { singleMediaAspectRatio: 3 });
  const extreme = core.buildCardLayout(tweet, measureText, { singleMediaAspectRatio: 20 });

  assert.equal(portrait.mediaRects[0].height / portrait.mediaRects[0].width, 3);
  assert.ok(portrait.mediaRects[0].height > 600);
  assert.equal(extreme.mediaRects[0].height / extreme.mediaRects[0].width, 20);
  assert.equal(extreme.mediaRects[0].width, extreme.contentWidth);
  assert.equal(extreme.mediaRects[0].height, extreme.contentWidth * 20);
  assert.equal(extreme.mediaRects[0].x, extreme.contentX);
});

test('renders single images in full and gives every media cell a visible border', () => {
  assert.deepEqual(core.getMediaRenderConfig(1), {
    borderColor: '#cfd9df',
    borderWidth: 3,
    fit: 'contain',
  });
  assert.deepEqual(core.getMediaRenderConfig(4), {
    borderColor: '#cfd9df',
    borderWidth: 3,
    fit: 'cover',
  });
});

test('centers a readable play mark over video poster media', () => {
  const overlay = core.getVideoPlayOverlayLayout({ x: 100, y: 200, width: 1000, height: 600 });

  assert.equal(overlay.centerX, 600);
  assert.equal(overlay.centerY, 500);
  assert.equal(overlay.diameter, 108);
  assert.ok(overlay.triangle[0].x > overlay.centerX - overlay.diameter / 4);
});

test('uses the current official X and verified glyphs at card-friendly sizes', () => {
  const xLogo = core.getBrandLogoConfig();
  const verified = core.getVerifiedBadgeConfig();

  assert.equal(xLogo.size, 58);
  assert.equal(xLogo.viewBoxSize, 24);
  assert.match(xLogo.path, /^M21\.742 21\.75/);
  assert.equal(verified.size, 32);
  assert.equal(verified.viewBoxSize, 22);
  assert.match(verified.path, /^M20\.396 11/);
});

test('vertically centers the X logo against the main avatar', () => {
  const layout = core.buildCardLayout({ text: 'Aligned header' }, (value) => value.length * 20);
  const avatarCenter = layout.avatarRect.y + layout.avatarRect.height / 2;
  const logoCenter = layout.brandLogoRect.y + layout.brandLogoRect.height / 2;

  assert.equal(logoCenter, avatarCenter);
});

test('gives the injected share-menu item a theme-aware hover and focus background', () => {
  const styleText = core.getShareMenuStyleText();

  assert.match(styleText, /\[data-tsc-action="share-card"\]:hover/);
  assert.match(styleText, /\[data-tsc-action="share-card"\]:focus-visible/);
  assert.match(styleText, /color-mix\(in srgb,currentColor 12%,transparent\)/);
});

test('restores the content-card shadow while keeping the modal and preview shadow-free', () => {
  assert.match(scriptText, /context\.shadowColor\s*=\s*'rgba\(25, 39, 52, 0\.18\)'/);
  assert.match(scriptText, /context\.shadowBlur\s*=\s*44/);
  assert.match(scriptText, /context\.shadowOffsetY\s*=\s*18/);
  assert.doesNotMatch(scriptText, /\.modal\{[^}]*box-shadow:/s);
  assert.doesNotMatch(scriptText, /\.preview\{[^}]*box-shadow:/s);
});

test('uses flat solid backgrounds outside the share card', () => {
  assert.doesNotMatch(scriptText, /createLinearGradient\(0,\s*0,\s*layout\.canvasWidth/);
  assert.doesNotMatch(scriptText, /\.preview-shell\{[^}]*background:linear-gradient/s);
  assert.doesNotMatch(scriptText, /globalAlpha\s*=\s*0\.55/);
  assert.match(scriptText, /context\.fillStyle\s*=\s*'#f4f7fb';/);
  assert.match(scriptText, /\.preview-shell\{[^}]*background:#f4f7fb/s);
});

test('recognizes only the native X tweet share menu as an injection target', () => {
  const shareMenu = {
    querySelector: (selector) => selector.includes('copyLinkToTweet') ? {} : null,
    querySelectorAll: () => [{ getAttribute: () => 'copyLinkToTweet' }],
  };
  const unrelatedMenu = {
    querySelector: () => null,
    querySelectorAll: () => [{ getAttribute: () => 'block' }],
  };

  assert.equal(core.isTweetShareMenu(shareMenu), true);
  assert.equal(core.isTweetShareMenu(unrelatedMenu), false);
  assert.equal(core.isTweetShareMenu(null), false);
});

test('finds the current localized copy-link item used to mount the share-card action', () => {
  const copyLinkItem = { textContent: '复制链接', getAttribute: () => null };
  const menu = {
    querySelector: () => null,
    querySelectorAll: () => [
      { textContent: '通过聊天发送', getAttribute: () => null },
      copyLinkItem,
      { textContent: '帖子分享途径…', getAttribute: () => null },
    ],
  };

  assert.equal(core.findShareMenuAnchor(menu), copyLinkItem);
  assert.equal(core.isTweetShareMenu(menu), true);
});

test('recognizes current localized X share buttons even without a data-testid', () => {
  const element = (testId, ariaLabel) => ({
    getAttribute: (name) => name === 'data-testid' ? testId : name === 'aria-label' ? ariaLabel : null,
  });

  assert.equal(core.isTweetShareButton(element('share', null)), true);
  assert.equal(core.isTweetShareButton(element(null, '分享帖子')), true);
  assert.equal(core.isTweetShareButton(element(null, 'Share post')), true);
  assert.equal(core.isTweetShareButton(element(null, '更多')), false);
});

test('hides the loading layer after the generated preview becomes ready', () => {
  assert.match(scriptText, /\.loading\[hidden\]\{display:none\}/);
});
