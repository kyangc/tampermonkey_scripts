import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const core = require('../scripts/make-x-great-again.user.js');
const endpoint = 'https://cobalt.example.com/';
const tweet = 'https://x.com/example/status/123';

test('cobalt settings accept HTTPS endpoints but never URL credentials or query secrets', () => {
  assert.equal(core.normalizeCobaltUrl(' https://cobalt.example.com:9037/ '), 'https://cobalt.example.com:9037/');
  for (const url of ['http://example.com', 'javascript:alert(1)', 'https://key@example.com', 'https://example.com/?key=secret', 'https://example.com/#secret', '']) {
    assert.equal(core.normalizeCobaltUrl(url), '');
  }
});

test('cobalt requests normalize a tweet URL and keep processing on the server', () => {
  assert.deepEqual(core.cobaltRequestBody('https://twitter.com/example/status/123?s=20'), {
    url: tweet, downloadMode: 'auto', videoQuality: 'max', localProcessing: 'disabled', convertGif: false, alwaysProxy: true,
  });
  for (const url of ['https://evil.example/example/status/123', 'https://x.com/home', 'https://x.com/example/status/123/video/1', 'blob:https://x.com/123']) {
    assert.throws(() => core.cobaltRequestBody(url));
  }
});

test('cobalt parses single downloads and filters mixed-media picker results', () => {
  for (const status of ['tunnel', 'redirect']) {
    assert.equal(core.parseCobaltResponse({ status, url: endpoint + 'file', filename: 'clip.mp4' })[0].filename, 'clip.mp4');
  }
  const result = core.parseCobaltResponse({ status: 'picker', picker: [
    { type: 'photo', url: 'https://images.example/a.jpg' },
    { type: 'video', url: endpoint + 'one' }, { type: 'gif', url: endpoint + 'two' },
  ] });
  assert.deepEqual(result.map((item) => item.label), ['下载视频 1', '下载视频 2']);
  assert.throws(() => core.parseCobaltResponse({ status: 'picker', picker: [{ type: 'photo' }] }), /没有返回/);
});

test('cobalt rejects unsupported, malformed and unsafe download responses', () => {
  assert.throws(() => core.parseCobaltResponse({ status: 'local-processing' }), /转码/);
  assert.throws(() => core.parseCobaltResponse({ status: 'error', error: { code: 'error.api.auth.key.missing' } }), /API Key/);
  assert.throws(() => core.parseCobaltResponse({}, 429), /频繁/);
  for (const url of ['javascript:alert(1)', 'http://cobalt.example/file', 'https://secret@cobalt.example/file', '/file']) {
    assert.throws(() => core.parseCobaltResponse({ status: 'tunnel', url }), /地址/);
  }
  assert.throws(() => core.parseCobaltResponse(null), /没有返回/);
});

test('GM request sends only the configured API credential, handles JSON and omits browser cookies', async () => {
  let options;
  const pending = core.requestCobalt({ xmlHttpRequest(o) { options = o; return {}; } }, endpoint, 'local-key', tweet);
  assert.equal(options.anonymous, true);
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.Authorization, 'Api-Key local-key');
  assert.equal(JSON.parse(options.data).url, tweet);
  assert.equal(options.timeout, 45000);
  options.onload({ status: 200, finalUrl: endpoint, responseText: JSON.stringify({ status: 'tunnel', url: endpoint + 'file' }) });
  assert.equal((await pending).length, 1);
});

test('closing aborts the request and late responses cannot replace its result', async () => {
  let options, aborted = false;
  const controller = new AbortController();
  const pending = core.requestCobalt({ xmlHttpRequest(o) { options = o; return { abort() { aborted = true; } }; } }, endpoint, '', tweet, controller.signal);
  controller.abort();
  await assert.rejects(pending, /取消/);
  assert.equal(aborted, true);
  options.onload({ status: 200, responseText: '{"status":"tunnel","url":"https://cobalt.example.com/file"}' });
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(core.requestCobalt({ xmlHttpRequest() { assert.fail('must not start'); } }, endpoint, '', tweet, stopped.signal), /取消/);
});

test('request errors cover timeouts, network failure, bad JSON, authentication and cross-origin redirects', async () => {
  for (const [trigger, pattern] of [
    [o => o.ontimeout(), /超时/], [o => o.onerror(), /无法连接/],
    [o => o.onload({ status: 502, responseText: '<html>bad gateway</html>' }), /502/],
    [o => o.onload({ status: 401, responseText: '{}' }), /API Key/],
    [o => o.onload({ status: 200, finalUrl: 'https://other.example/', responseText: '{}' }), /重定向/],
  ]) {
    await assert.rejects(core.requestCobalt({ xmlHttpRequest(o) { queueMicrotask(() => trigger(o)); } }, endpoint, '', tweet), pattern);
  }
});

function articleFixture({ video = true, href = '/example/status/123', quoteVideo = false } = {}) {
  const player = {};
  const anchor = { getAttribute: () => href };
  const time = { closest: () => anchor };
  const quote = { contains: node => node === player };
  const name = { closest: () => quote };
  const nodes = selector => {
    if (selector === '[data-testid="User-Name"], [data-testid="UserName"]') return quoteVideo ? [{}, name] : [];
    if (selector === '[data-testid="videoPlayer"], video') return video ? [player] : [];
    if (selector === 'time[datetime]') return [time];
    return [];
  };
  return { querySelector: selector => nodes(selector)[0] || null, querySelectorAll: nodes };
}

test('video menu requires the owning tweet video and timestamp permalink, not its poster or quoted content', () => {
  assert.equal(core.extractVideoTweetUrl(articleFixture()), tweet);
  assert.equal(core.extractVideoTweetUrl(articleFixture({ video: false })), '');
  assert.equal(core.extractVideoTweetUrl(articleFixture({ quoteVideo: true })), '');
  assert.equal(core.extractVideoTweetUrl(articleFixture({ href: '' })), '');
  assert.equal(core.extractVideoTweetUrl(articleFixture({ href: 'https://evil.example/example/status/123' })), '');
  assert.equal(core.extractVideoTweetUrl(articleFixture({ href: '/example/status/123?s=20' })), tweet);
});
