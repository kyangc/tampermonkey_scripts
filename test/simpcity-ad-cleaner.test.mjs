import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const core = require('../scripts/simpcity-ad-cleaner.user.js');

test('blocks known SimpCity ad redirect hosts while allowing forum URLs', () => {
  assert.equal(core.isBlockedAdUrl('https://tt.culinar9sync.com/click?zone=top'), true);
  assert.equal(core.isBlockedAdUrl('https://www.theporndude.com/'), true);
  assert.equal(core.isBlockedAdUrl('https://bucklechemistdensity.com/on.js'), true);
  assert.equal(core.isBlockedAdUrl('https://js.wpadmngr.com/static/adManager.js'), true);
  assert.equal(core.isBlockedAdUrl('https://js.wpushsdk.com/npc/sdk/wpu/npush.m.js'), true);
  assert.equal(core.isBlockedAdUrl('https://nereserv.com/in/dip?site=native-push'), true);
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

test('classifies bottom linked wide banners as removable ad images', () => {
  assert.deepEqual(
    core.classifyImagePlacement({
      height: 90,
      href: 'https://promo.example-game.test/click',
      src: 'https://cdn.example-game.test/banner-300x90.webp',
      top: 3600,
      width: 300,
    }),
    { blocked: true, reason: 'linked-wide-image' },
  );

  assert.deepEqual(
    core.classifyImagePlacement({
      alt: '百位AI女友任你邂逅 开启心动同居 登录即送SSR女友',
      height: 90,
      href: 'https://promo.example-game.test/click',
      src: 'https://cdn.example-game.test/ai-girlfriend.webp',
      top: 3600,
      width: 300,
    }),
    { blocked: true, reason: 'ad-image-text' },
  );
});

test('does not remove broad SimpCity containers just because they contain ad scripts or ad text', () => {
  assert.deepEqual(
    core.classifyContainerRemoval({
      childCount: 7,
      className: 'p-body',
      hasBlockedAdLink: true,
      tagName: 'DIV',
      text: 'Avatar Borders are active and can be found under the Customize Profile page. Info and Links SimpCity News Rules FAQ.',
    }),
    { removable: false, reason: 'blocked-link-broad-site-container' },
  );

  assert.deepEqual(
    core.classifyContainerRemoval({
      childCount: 3,
      className: 'p-header-content',
      hasBlockedAdLink: true,
      tagName: 'DIV',
      text: 'SimpCity header navigation and account controls',
    }),
    { removable: false, reason: 'blocked-link-broad-site-container' },
  );

  assert.deepEqual(
    core.classifyContainerRemoval({
      childCount: 2,
      className: 'block block--category block--category3',
      hasBlockedAdLink: false,
      tagName: 'DIV',
      text: 'Info and Links SimpCity News Rules FAQ Create Your AI Cum Slut Generate your AI Trash Whore.',
    }),
    { removable: false, reason: 'banner-text-broad-site-container' },
  );
});

test('still removes compact ad items and explicit ad containers', () => {
  assert.deepEqual(
    core.classifyContainerRemoval({
      childCount: 1,
      className: 'p-navEl',
      hasBlockedAdLink: true,
      tagName: 'DIV',
      text: 'AI PORN',
    }),
    { removable: true, reason: 'blocked-link-compact' },
  );

  assert.deepEqual(
    core.classifyContainerRemoval({
      childCount: 1,
      className: '',
      hasBlockedAdLink: true,
      tagName: 'SCRIPT',
      text: '',
    }),
    { removable: true, reason: 'blocked-link-compact' },
  );

  assert.deepEqual(
    core.classifyContainerRemoval({
      childCount: 2,
      className: 'samBannerUnit',
      hasBlockedAdLink: true,
      tagName: 'DIV',
      text: '',
    }),
    { removable: true, reason: 'blocked-link-ad-container' },
  );

  assert.deepEqual(
    core.classifyContainerRemoval({
      childCount: 1,
      className: 'node node--id128 node--depth2 node--link',
      hasBlockedAdLink: false,
      tagName: 'DIV',
      text: 'Create Your AI Cum Slut Generate your AI Trash Whore. Virtual chat and calls.',
    }),
    { removable: true, reason: 'banner-text-compact' },
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

test('allows third-party media iframes because embed-page popup guards handle Turbo', () => {
  assert.deepEqual(
    core.classifyFramePlacement({
      className: 'saint-iframe',
      height: 271,
      sandbox: '',
      src: 'https://turbo.cr/embed/QbNWKX4Hmb8CW',
      width: 483,
    }),
    { action: 'allow', reason: 'known-media-frame' },
  );

  assert.deepEqual(
    core.classifyFramePlacement({
      height: 90,
      sandbox: '',
      src: 'https://cdn.example.test/adserver/frame.html?zone_id=72890',
      top: 32,
      width: 728,
    }),
    { action: 'remove', reason: 'likely-ad-url' },
  );

  assert.deepEqual(
    core.classifyFramePlacement({
      className: '',
      height: 90,
      sandbox: '',
      src: '',
      top: 32,
      width: 728,
    }),
    { action: 'remove', reason: 'top-wide-empty-frame' },
  );

  assert.deepEqual(
    core.classifyFramePlacement({
      className: '',
      height: 90,
      id: '__clb-spot_2086797_oqh_2_container',
      sandbox: '',
      src: '',
      top: 4048,
      width: 728,
    }),
    { action: 'remove', reason: 'ad-frame-shell' },
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
});

test('blocks external popups from Turbo embed frames without globally blocking YouTube', () => {
  assert.equal(core.isTurboEmbedUrl('https://turbo.cr/embed/QbNWKX4Hmb8CW'), true);
  assert.equal(core.isTurboEmbedUrl('https://turbo.cr/videos/QbNWKX4Hmb8CW'), false);

  assert.deepEqual(
    core.classifyNavigationTarget('https://www.youtube.com/watch?v=N7zxBYs6U3c'),
    { blocked: false, reason: 'allowed' },
  );

  assert.deepEqual(
    core.classifyEmbeddedFramePopup(
      'https://www.youtube.com/watch?v=N7zxBYs6U3c',
      'https://turbo.cr/embed/QbNWKX4Hmb8CW',
    ),
    { blocked: true, reason: 'external-embed-popup' },
  );

  assert.deepEqual(
    core.classifyEmbeddedFramePopup('/embed/QbNWKX4Hmb8CW', 'https://turbo.cr/embed/QbNWKX4Hmb8CW'),
    { blocked: false, reason: 'same-embed-site' },
  );

  assert.deepEqual(
    core.classifyEmbeddedFramePopup('https://www.youtube.com/watch?v=N7zxBYs6U3c', 'https://simpcity.cr/'),
    { blocked: false, reason: 'not-embed-frame' },
  );
});

test('classifies Turbo embed ad scripts and click shields as removable', () => {
  assert.deepEqual(
    core.classifyTurboEmbedPlacement({
      src: 'https://bucklechemistdensity.com/on.js',
      tagName: 'SCRIPT',
    }),
    { blocked: true, reason: 'blocked-host' },
  );

  assert.deepEqual(
    core.classifyTurboEmbedPlacement({
      src: 'https://js.wpadmngr.com/static/adManager.js',
      tagName: 'SCRIPT',
    }),
    { blocked: true, reason: 'blocked-host' },
  );

  assert.deepEqual(
    core.classifyTurboEmbedPlacement({
      height: 1170,
      position: 'absolute',
      tagName: 'DIV',
      viewportHeight: 1170,
      viewportWidth: 1720,
      width: 1720,
      zIndex: 1001,
    }),
    { blocked: true, reason: 'turbo-click-shield' },
  );

  assert.deepEqual(
    core.classifyTurboEmbedPlacement({
      height: 150,
      position: 'fixed',
      tagName: 'IFRAME',
      viewportHeight: 1170,
      viewportWidth: 1720,
      width: 400,
      zIndex: 2147483647,
    }),
    { blocked: true, reason: 'turbo-floating-ad-frame' },
  );

  assert.deepEqual(
    core.classifyTurboEmbedPlacement({
      className: 'watermark',
      height: 20,
      position: 'absolute',
      tagName: 'DIV',
      text: 'turbo.cr',
      viewportHeight: 1170,
      viewportWidth: 1720,
      width: 82,
      zIndex: 1000,
    }),
    { blocked: false, reason: 'allowed' },
  );
});
