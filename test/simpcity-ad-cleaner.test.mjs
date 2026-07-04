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
