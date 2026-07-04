import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const core = require('../scripts/m-team-torrent-enhancer.user.js');

const NOW = Date.parse('2026-07-04T12:00:00+08:00');

test('extracts torrent items from the M-Team search API response', () => {
  const response = {
    code: '0',
    data: {
      pageNumber: 1,
      data: [
        { id: '1001', name: 'first' },
        { id: '1002', name: 'second' },
      ],
    },
  };

  assert.deepEqual(core.extractSearchItems(response).map((item) => item.id), ['1001', '1002']);
});

test('computes a stronger hotness score only when a torrent is both new and active', () => {
  const freshActive = {
    createdDate: '2026-07-04T08:00:00+08:00',
    status: {
      seeders: '160',
      leechers: '34',
      timesCompleted: '320',
      comments: '8',
    },
  };
  const oldActive = {
    ...freshActive,
    createdDate: '2026-05-01T08:00:00+08:00',
  };
  const freshQuiet = {
    createdDate: '2026-07-04T08:00:00+08:00',
    status: {
      seeders: '2',
      leechers: '0',
      timesCompleted: '1',
      comments: '0',
    },
  };

  const activeScore = core.computeHotnessScore(freshActive, NOW);
  const oldScore = core.computeHotnessScore(oldActive, NOW);
  const quietScore = core.computeHotnessScore(freshQuiet, NOW);

  assert.ok(activeScore.score > 0.55, `expected fresh active score to be high, got ${activeScore.score}`);
  assert.ok(activeScore.alpha > oldScore.alpha, 'fresh active torrents should be visibly hotter than old active torrents');
  assert.ok(activeScore.alpha > quietScore.alpha, 'fresh active torrents should be visibly hotter than fresh quiet torrents');
  assert.equal(oldScore.alpha, 0, 'old active torrents should not be highlighted');
  assert.equal(quietScore.alpha, 0, 'fresh quiet torrents should not be highlighted');
});

test('marks older but heavily seeded active torrents as hot', () => {
  const heavilySeeded = {
    createdDate: '2026-06-09T12:00:00+08:00',
    status: {
      seeders: '1556',
      leechers: '20',
      comments: '7',
    },
  };

  const score = core.computeHotnessScore(heavilySeeded, NOW);

  assert.ok(score.score >= 0.5, `expected 25-day heavily seeded torrent to pass hot threshold, got ${score.score}`);
  assert.ok(score.alpha > 0, 'expected visible hot color');
});

test('does not mark torrents older than the new-hot window even when very active', () => {
  const oldButActive = {
    createdDate: '2026-06-03T12:00:00+08:00',
    status: {
      seeders: '3000',
      leechers: '500',
      comments: '80',
    },
  };

  const score = core.computeHotnessScore(oldButActive, NOW);

  assert.equal(score.scores.recency, 0);
  assert.equal(score.alpha, 0);
});

test('marks mid-window torrents with very high seeders as hot even with low leechers', () => {
  const highSeederLowLeecher = {
    createdDate: '2026-06-18T12:00:00+08:00',
    status: {
      seeders: '1427',
      leechers: '1',
      comments: '0',
    },
  };

  const score = core.computeHotnessScore(highSeederLowLeecher, NOW);

  assert.ok(score.score >= 0.45, `expected 16-day high-seeder torrent to pass hot threshold, got ${score.score}`);
  assert.ok(score.alpha > 0, 'expected visible hot color');
});

test('hotness weights time above seeders and leechers, with comments lower', () => {
  const score = core.computeHotnessScore({
    createdDate: '2026-07-04T08:00:00+08:00',
    status: {
      seeders: '160',
      leechers: '34',
      comments: '8',
    },
  }, NOW);

  assert.ok(score.weights.recency > score.weights.seeders);
  assert.equal(score.weights.seeders, score.weights.leechers);
  assert.ok(score.weights.leechers > score.weights.comments);
});

test('extracts torrent ids from detail URLs', () => {
  assert.equal(core.getTorrentIdFromUrl('/detail/123456'), '123456');
  assert.equal(core.getTorrentIdFromUrl('https://kp.m-team.cc/detail/123456?foo=bar'), '123456');
  assert.equal(core.getTorrentIdFromUrl('/browse/adult'), null);
});

test('marks viewed torrents and prunes the oldest entries', () => {
  let store = {};

  store = core.markViewedInStore(store, '1001', NOW - 3000, { maxEntries: 2 });
  store = core.markViewedInStore(store, '1002', NOW - 2000, { maxEntries: 2 });
  store = core.markViewedInStore(store, '1003', NOW - 1000, { maxEntries: 2 });

  assert.equal(core.isViewedInStore(store, '1001'), false);
  assert.equal(core.isViewedInStore(store, '1002'), true);
  assert.equal(core.isViewedInStore(store, '1003'), true);
});

test('uses row-level hot styling without an inline badge that consumes title width', () => {
  const hotTorrent = {
    createdDate: '2026-07-04T08:00:00+08:00',
    status: {
      seeders: '160',
      leechers: '34',
      timesCompleted: '320',
      comments: '8',
    },
  };

  const visualState = core.computeRowVisualState(hotTorrent, false, NOW);

  assert.equal(visualState.hot, true);
  assert.equal(visualState.renderInlineBadge, false);
  assert.ok(Number(visualState.cssVars['--mte-hot-alpha']) > 0.38);
  assert.equal(Object.hasOwn(visualState.cssVars, '--mte-hot-alpha-mid'), false);
  assert.equal(Object.hasOwn(visualState.cssVars, '--mte-hot-alpha-end'), false);
});

test('treats moderately recent active torrents as hot', () => {
  const moderatelyRecentActive = {
    createdDate: '2026-06-25T12:00:00+08:00',
    status: {
      seeders: '120',
      leechers: '12',
      timesCompleted: '180',
      comments: '3',
    },
  };

  const score = core.computeHotnessScore(moderatelyRecentActive, NOW);

  assert.ok(score.score > 0.16, `expected moderately recent active torrent to pass hot threshold, got ${score.score}`);
  assert.ok(score.alpha > 0, 'expected visible hot color');
});

test('route changes always request a row refresh, including returning from detail to browse', () => {
  assert.deepEqual(core.getRouteUpdate('https://kp.m-team.cc/detail/123456'), {
    shouldRefreshRows: true,
    viewedId: '123456',
  });
  assert.deepEqual(core.getRouteUpdate('https://kp.m-team.cc/browse/adult'), {
    shouldRefreshRows: true,
    viewedId: null,
  });
});

test('style sheet does not reset row-level CSS variables on cells', () => {
  const styleText = core.getStyleText();

  assert.match(styleText, /tr\.mte-row \{/);
  assert.doesNotMatch(styleText, /90deg/);
  assert.doesNotMatch(styleText, /--mte-hot-alpha-mid/);
  assert.doesNotMatch(styleText, /--mte-hot-alpha-end/);
  assert.doesNotMatch(styleText, /tr\.mte-row > td \{[^}]*--mte-hot-alpha:\s*0;/s);
  assert.doesNotMatch(styleText, /tr\.mte-row > td \{[^}]*--mte-viewed-alpha:\s*0;/s);
});
