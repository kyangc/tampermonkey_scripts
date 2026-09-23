import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const sources = Object.fromEntries(['manga18fx', 'simpcity'].map((site) => [
  site, readFileSync(new URL(`../src/userscripts/website-cleanup.${site}.module.js`, import.meta.url), 'utf8'),
]));

// The first document read checks availability; the second starts the runtime.
// Stop there so routing can be verified without mocking either site's DOM.
function startsRuntime(source, href) {
  let reads = 0;
  const started = new Error('runtime started');
  const page = {
    location: new URL(href),
    get document() {
      if (++reads > 1) throw started;
      return {};
    },
  };
  const sandboxWindow = new Proxy({}, {
    get() { throw new Error('must use the page window when unsafeWindow is available'); },
  });
  try {
    vm.runInNewContext(source, { unsafeWindow: page, window: sandboxWindow, URL });
    return false;
  } catch (error) {
    if (error === started) return true;
    throw error;
  }
}

for (const [href, expected] of [
  ['https://manga18fx.com/', 'manga18fx'],
  ['https://www.manga18fx.com/chapter/1', 'manga18fx'],
  ['https://simpcity.cr/threads/example/', 'simpcity'],
  ['https://www.simpcity.cr/', 'simpcity'],
  ['https://turbo.cr/embed/example', 'simpcity'],
  ['https://www.turbo.cr/embed/example', 'simpcity'],
  ['https://turbo.cr/videos/example', null],
  ['https://turbo.cr/embedder/example', null],
  ['https://simpcity.cr.example.com/', null],
  ['https://other.manga18fx.com/', null],
  ['http://manga18fx.com/', null],
  ['https://example.com/', null],
]) {
  test(`cleanup runtime routing: ${href}`, () => {
    for (const [site, source] of Object.entries(sources)) {
      assert.equal(startsRuntime(source, href), site === expected, site);
    }
  });
}

test('installable bundle exposes both rule sets and ignores unrelated sites', () => {
  const source = readFileSync(new URL('../scripts/website-cleanup.user.js', import.meta.url), 'utf8');
  const context = { module: { exports: {} }, URL };
  vm.runInNewContext(source, context);
  assert.deepEqual(Object.keys(context.module.exports).sort(), ['manga18fx', 'simpcity']);
  const untouched = new Proxy({}, { get() { throw new Error('unexpected DOM access'); } });
  vm.runInNewContext(source, {
    URL, unsafeWindow: { location: new URL('https://example.com/'), document: untouched },
  });
});
