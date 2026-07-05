import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const core = require('../scripts/manga18fx-ad-cleaner.user.js');

test('blocks Manga18fx ad and tracking script hosts while allowing site assets', () => {
  assert.equal(core.isBlockedAdUrl('https://a.magsrv.com/ad-provider.js'), true);
  assert.equal(core.isBlockedAdUrl('https://mn.similesgleby.com/gZKC7T4ZwAj/65051'), true);
  assert.equal(core.isBlockedAdUrl('https://s10.histats.com/js15_as.js'), true);
  assert.equal(core.isBlockedAdUrl('https://e.dtscout.com/e/?pid=5200'), true);
  assert.equal(core.isBlockedAdUrl('https://p.mrktmtrcs.net/mm.js'), true);
  assert.equal(core.isBlockedAdUrl('https://tags.crwdcntrl.net/lt/c/3825/lt.min.js'), true);
  assert.equal(core.isBlockedAdUrl('https://manga18fx.com/js/script-v1.js'), false);
  assert.equal(core.isBlockedAdUrl('https://img01.manga18fx.com/online/5753/11/1-967.jpg'), false);
  assert.equal(core.isBlockedAdUrl('https://www.facebook.com/manga18fx'), false);
});

test('classifies static Manga18fx banner ad slots as removable', () => {
  assert.deepEqual(
    core.classifyPlacement({
      className: 'kadx',
      id: 'kadx_index_1',
      tagName: 'DIV',
    }),
    { action: 'remove', reason: 'ad-slot' },
  );

  assert.deepEqual(
    core.classifyPlacement({
      className: 'kadx-item',
      id: 'bn_tleft',
      tagName: 'DIV',
    }),
    { action: 'remove', reason: 'ad-slot' },
  );

  assert.deepEqual(
    core.classifyPlacement({
      dataZoneid: '5959510',
      tagName: 'INS',
    }),
    { action: 'remove', reason: 'ad-zone' },
  );
});

test('removes adblock prompts but does not bypass the adult confirmation modal', () => {
  assert.deepEqual(
    core.classifyPlacement({
      className: 'custom-modal fade custom-modal',
      id: 'detect_modal',
      tagName: 'DIV',
      text: 'Are You Using an Adblock? As an independent publisher, we rely on ads.',
    }),
    { action: 'remove', reason: 'adblock-modal' },
  );

  assert.deepEqual(
    core.classifyPlacement({
      className: 'modal-backdrop',
      tagName: 'DIV',
    }),
    { action: 'remove', reason: 'adblock-backdrop' },
  );

  assert.deepEqual(
    core.classifyPlacement({
      className: 'custom-modal fade custom-modal',
      id: 'adult_modal',
      tagName: 'DIV',
      text: 'Caution to under-aged viewers. Are you over 18?',
    }),
    { action: 'allow', reason: 'age-gate' },
  );
});

test('classifies dynamic floating ad layers without removing normal floating UI', () => {
  assert.deepEqual(
    core.classifyPlacement({
      height: 280,
      id: 'ukKw943v-exo-video-slider-content',
      position: 'fixed',
      tagName: 'DIV',
      text: '#ukKw943v_video_container position relative exo video slider',
      viewportHeight: 720,
      viewportWidth: 1280,
      width: 360,
      zIndex: 9999,
    }),
    { action: 'remove', reason: 'floating-ad' },
  );

  assert.deepEqual(
    core.classifyPlacement({
      height: 720,
      position: 'absolute',
      tagName: 'DIV',
      viewportHeight: 720,
      viewportWidth: 1280,
      width: 1280,
      zIndex: 1001,
    }),
    { action: 'remove', reason: 'click-shield' },
  );

  assert.deepEqual(
    core.classifyPlacement({
      height: 32,
      href: '#',
      id: 'back_to_top',
      position: 'fixed',
      tagName: 'A',
      text: '↑',
      width: 32,
      zIndex: 9999,
    }),
    { action: 'allow', reason: 'allowed-floating-ui' },
  );

  assert.deepEqual(
    core.classifyPlacement({
      className: 'live-search-result live-pc-result',
      height: 0,
      id: 'search-result',
      position: 'absolute',
      tagName: 'DIV',
      width: 0,
      zIndex: 999,
    }),
    { action: 'allow', reason: 'allowed-floating-ui' },
  );
});

test('removes hidden ExoClick video ad remnants after CSS collapses them', () => {
  assert.deepEqual(
    core.classifyPlacement({
      className: 'exo-video-slider-container-wrapper',
      height: 0,
      id: 'ukKw943v',
      position: 'static',
      tagName: 'DIV',
      text: '#ukKw943v_video_container { position: relative; }',
      width: 1280,
      zIndex: 'auto',
    }),
    { action: 'remove', reason: 'exo-ad' },
  );

  assert.deepEqual(
    core.classifyPlacement({
      id: 'ukKw943v_exo_cta_text_box',
      tagName: 'DIV',
      text: 'View More',
    }),
    { action: 'remove', reason: 'exo-ad' },
  );
});

test('classifies ad scripts and tracking iframes as removable', () => {
  assert.deepEqual(
    core.classifyPlacement({
      src: 'https://a.magsrv.com/ad-provider.js',
      tagName: 'SCRIPT',
    }),
    { action: 'remove', reason: 'blocked-url' },
  );

  assert.deepEqual(
    core.classifyPlacement({
      src: 'https://t.dtscout.com/idg/?su=4C301783223080118EA10EA8A2482BBC',
      tagName: 'IFRAME',
    }),
    { action: 'remove', reason: 'blocked-url' },
  );

  assert.deepEqual(
    core.classifyPlacement({
      tagName: 'SCRIPT',
      text: '(AdProvider = window.AdProvider || []).push({"serve": {}});',
    }),
    { action: 'remove', reason: 'ad-provider-inline' },
  );

  assert.deepEqual(
    core.classifyPlacement({
      src: 'https://manga18fx.com/js/script-v1.js',
      tagName: 'SCRIPT',
    }),
    { action: 'allow', reason: 'allowed' },
  );
});

test('style text hides known Manga18fx ad surfaces early', () => {
  const styleText = core.getStyleText();
  assert.match(styleText, /\.kadx/);
  assert.match(styleText, /\[id\^="bn_"]/);
  assert.match(styleText, /#detect_modal/);
  assert.match(styleText, /exo-video-slider/);
});
