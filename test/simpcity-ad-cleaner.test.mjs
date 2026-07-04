import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const core = require('../scripts/simpcity-ad-cleaner.user.js');

test('blocks known SimpCity ad redirect hosts while allowing forum URLs', () => {
  assert.equal(core.isBlockedAdUrl('https://tt.culinar9sync.com/click?zone=top'), true);
  assert.equal(core.isBlockedAdUrl('https://www.theporndude.com/'), true);
  assert.equal(core.isBlockedAdUrl('https://goonbox.cr/'), false);
  assert.equal(core.isBlockedAdUrl('https://simpcity.cr/forums/requests.1/'), false);
  assert.equal(core.isBlockedAdUrl('/threads/example.123/', 'https://simpcity.cr/'), false);
});

test('identifies ad-like banner text without matching normal site notices', () => {
  assert.equal(core.isBlockedBannerText('AI PORN IS HERE. CREATE AND FAP. TRY NOW'), true);
  assert.equal(core.isBlockedBannerText('Create Your AI Cum Slut Generate your AI Trash Whore'), true);
  assert.equal(core.isBlockedBannerText('10,000+ Scenes. One Price: FREE. All HD. All TeamSkeet.'), true);
  assert.equal(core.isBlockedBannerText('jpg6.su has now been replaced with GoonBox.cr'), false);
  assert.equal(core.isBlockedBannerText("We're aware that TURBO and Filester are currently not working."), false);
});

test('decides whether a popup/navigation target should be blocked', () => {
  assert.deepEqual(core.classifyNavigationTarget('https://tt.culinar9sync.com/promo'), {
    blocked: true,
    reason: 'blocked-host',
  });
  assert.deepEqual(core.classifyNavigationTarget('https://adv.example.test/click?zone=123'), {
    blocked: true,
    reason: 'likely-ad-url',
  });
  assert.deepEqual(core.classifyNavigationTarget('https://cdn.example.test/popunder?zone=123'), {
    blocked: true,
    reason: 'likely-ad-url',
  });
  assert.deepEqual(core.classifyNavigationTarget('https://simpcity.cr/whats-new/posts/'), {
    blocked: false,
    reason: 'allowed',
  });
  assert.deepEqual(core.classifyNavigationTarget('https://pixhost.to/show/123/example'), {
    blocked: false,
    reason: 'allowed',
  });
  assert.deepEqual(core.classifyNavigationTarget('https://example.com/article?utm_campaign=forum'), {
    blocked: false,
    reason: 'allowed',
  });
  assert.deepEqual(core.classifyNavigationTarget('https://www.youtube.com/watch?v=N7zxBYs6U3c'), {
    blocked: false,
    reason: 'allowed',
  });
  assert.deepEqual(core.classifyNavigationTarget('', 'https://simpcity.cr/'), {
    blocked: false,
    reason: 'empty',
  });
});

test('isolates real link clicks from site-level ad hooks while preserving overlays', () => {
  assert.deepEqual(
    core.classifyClickNavigation({
      href: 'https://simpcity.cr/threads/example.123/',
    }),
    { action: 'isolate', reason: 'real-link' },
  );
  assert.deepEqual(
    core.classifyClickNavigation({
      dataXfClick: 'overlay',
      href: 'https://adv.example.test/click?zone=123',
    }),
    { action: 'block', reason: 'likely-ad-url' },
  );
  assert.deepEqual(
    core.classifyClickNavigation({
      dataXfClick: 'overlay',
      href: 'https://simpcity.cr/login/',
    }),
    { action: 'allow', reason: 'scripted-link' },
  );
  assert.deepEqual(
    core.classifyClickNavigation({
      href: '#top',
    }),
    { action: 'allow', reason: 'same-page-or-script' },
  );
});

test('classifies top-of-page wide game banners as removable ad images', () => {
  assert.deepEqual(
    core.classifyImagePlacement({
      alt: '海贼王 最邂逅的海洋 开启性爱梦想冒险之旅',
      height: 90,
      href: 'https://promo.example-game.test/click',
      src: 'https://cdn.example-game.test/op-banner.webp',
      top: 36,
      width: 300,
    }),
    { blocked: true, reason: 'ad-image-text' },
  );

  assert.deepEqual(
    core.classifyImagePlacement({
      height: 90,
      href: 'https://promo.example-game.test/click',
      src: 'https://cdn.example-game.test/banner-300x90.webp',
      top: 42,
      width: 300,
    }),
    { blocked: true, reason: 'top-wide-linked-image' },
  );

  assert.deepEqual(
    core.classifyImagePlacement({
      height: 480,
      href: 'https://simpcity.cr/threads/example.123/',
      alt: '18+ forum attachment',
      src: 'https://simpcity.cr/attachments/example.jpg',
      top: 820,
      width: 720,
    }),
    { blocked: false, reason: 'allowed' },
  );
});

test('classifies top-of-page background image banners as removable ads', () => {
  assert.deepEqual(
    core.classifyVisualBannerPlacement({
      backgroundImage: 'url("https://ads.example.test/javhd-watch-now-728x90.jpg")',
      height: 90,
      href: 'https://promo.example.test/click',
      text: 'JAV HD WATCH NOW',
      top: 32,
      width: 728,
    }),
    { blocked: true, reason: 'ad-visual-text' },
  );

  assert.deepEqual(
    core.classifyVisualBannerPlacement({
      backgroundImage: 'url("https://simpcity.cr/styles/logo.png")',
      height: 80,
      href: 'https://simpcity.cr/',
      text: 'SimpCity Forums',
      top: 24,
      width: 360,
    }),
    { blocked: false, reason: 'allowed' },
  );

  assert.deepEqual(
    core.classifyVisualBannerPlacement({
      height: 90,
      src: 'https://cdn.example.test/adserver/frame.html?zone_id=72890',
      top: 32,
      width: 728,
    }),
    { blocked: true, reason: 'likely-ad-url' },
  );

  assert.deepEqual(
    core.classifyVisualBannerPlacement({
      backgroundImage: 'url("https://simpcity.cr/data/banners/6f2a9.jpg")',
      height: 90,
      top: 32,
      width: 728,
    }),
    { blocked: true, reason: 'top-wide-background' },
  );
});

test('sandboxes third-party media iframes without allowing popups', () => {
  assert.deepEqual(
    core.classifyFramePlacement({
      className: 'saint-iframe',
      height: 271,
      sandbox: '',
      src: 'https://turbo.cr/embed/QbNWKX4Hmb8CW',
      width: 483,
    }),
    { action: 'sandbox', reason: 'third-party-media-frame' },
  );

  assert.deepEqual(
    core.classifyFramePlacement({
      height: 90,
      sandbox: '',
      src: 'https://cdn.example.test/adserver/frame.html?zone_id=72890',
      width: 728,
    }),
    { action: 'remove', reason: 'likely-ad-url' },
  );

  assert.deepEqual(
    core.classifyFramePlacement({
      height: 120,
      sandbox: '',
      src: 'https://simpcity.cr/embed/local',
      width: 320,
    }),
    { action: 'allow', reason: 'same-site' },
  );

  assert.equal(core.getMediaFrameSandboxValue().includes('allow-scripts'), true);
  assert.equal(core.getMediaFrameSandboxValue().includes('allow-same-origin'), true);
  assert.equal(core.getMediaFrameSandboxValue().includes('allow-popups'), false);
  assert.equal(core.getMediaFrameSandboxValue().includes('allow-top-navigation'), false);
});
