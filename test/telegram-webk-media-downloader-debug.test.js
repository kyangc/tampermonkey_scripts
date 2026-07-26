const assert = require("node:assert/strict");
const test = require("node:test");

const {
  pickTelegramPageTarget,
  redactDebugPath,
  redactDebugUrl,
} = require("../tools/debug-telegram-webk-cdp");

test("pickTelegramPageTarget selects the WebK page target and ignores workers", () => {
  const targets = [
    { type: "shared_worker", url: "https://web.telegram.org/k/index.worker.js" },
    { type: "page", url: "https://example.com/" },
    { type: "page", url: "https://web.telegram.org/k/#-123", title: "Telegram Web", webSocketDebuggerUrl: "ws://page" },
  ];

  assert.deepEqual(pickTelegramPageTarget(targets), targets[2]);
});

test("pickTelegramPageTarget supports the webk.telegram.org alias", () => {
  const target = {
    type: "page",
    url: "https://webk.telegram.org/#-123",
    title: "Telegram Web",
    webSocketDebuggerUrl: "ws://page",
  };

  assert.deepEqual(pickTelegramPageTarget([target]), target);
});

test("redactDebugPath hides chat directory names while keeping useful file layout", () => {
  const path = "Private Group__peer-123/images/20260409_202854_mid-1_image_photo.jpg";

  assert.equal(redactDebugPath(path), "<chat-dir>/images/<file>.jpg");
  assert.equal(redactDebugPath("Private Group__peer-123/_manifest.json"), "<chat-dir>/_manifest.json");
});

test("redactDebugUrl removes Telegram chat hash from reports", () => {
  assert.equal(redactDebugUrl("https://web.telegram.org/k/#-123"), "https://web.telegram.org/k/");
});
