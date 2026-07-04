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
  assert.deepEqual(core.classifyNavigationTarget('https://simpcity.cr/whats-new/posts/'), {
    blocked: false,
    reason: 'allowed',
  });
  assert.deepEqual(core.classifyNavigationTarget('', 'https://simpcity.cr/'), {
    blocked: false,
    reason: 'empty',
  });
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
