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
  });
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

test('gives the injected share-menu item a theme-aware hover and focus background', () => {
  const styleText = core.getShareMenuStyleText();

  assert.match(styleText, /\[data-tsc-action="share-card"\]:hover/);
  assert.match(styleText, /\[data-tsc-action="share-card"\]:focus-visible/);
  assert.match(styleText, /color-mix\(in srgb,currentColor 12%,transparent\)/);
});

test('does not render clipped outer shadows around the share poster or modal', () => {
  assert.doesNotMatch(scriptText, /context\.shadowColor\s*=/);
  assert.doesNotMatch(scriptText, /\.modal\{[^}]*box-shadow:/s);
  assert.doesNotMatch(scriptText, /\.preview\{[^}]*box-shadow:/s);
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
