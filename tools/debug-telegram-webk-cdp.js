#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_PORT = 9222;
const REQUIRED_DEBUG_API_VERSION = 11;
const USER_SCRIPT = path.resolve(__dirname, "..", "scripts", "telegram-webk-media-downloader.user.js");

function isTelegramWebKUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:") return false;
    if (url.hostname === "webk.telegram.org") return true;
    return url.hostname === "web.telegram.org" && (url.pathname === "/k" || url.pathname.startsWith("/k/"));
  } catch (_error) {
    return false;
  }
}

function pickTelegramPageTarget(targets) {
  return (targets || []).find(
    (target) =>
      target.type === "page" &&
      isTelegramWebKUrl(target.url) &&
      target.webSocketDebuggerUrl
  );
}

function redactDebugPath(filePath) {
  return String(filePath || "")
    .replace(/^[^/]+__peer-[^/]+/, "<chat-dir>")
    .replace(/^(<chat-dir>\/(?:images|videos|documents)\/)[^/]+(\.[a-z0-9]+)$/i, "$1<file>$2");
}

function redactDebugUrl(url) {
  return String(url || "").replace(/#.*$/, "");
}

function isSensitiveDebugKey(key) {
  const lowerKey = String(key || "").toLowerCase();
  return (
    ["title", "text", "message", "caption", "name", "filename", "handlename", "chatid", "peerid", "error"].includes(lowerKey) ||
    lowerKey.endsWith("title") ||
    lowerKey.endsWith("name")
  );
}

function redactDebugResult(value) {
  if (Array.isArray(value)) return value.map(redactDebugResult);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key === "path") return [key, redactDebugPath(item)];
      if (key.toLowerCase() === "url") return [key, redactDebugUrl(item)];
      if (isSensitiveDebugKey(key)) return [key, item ? "[redacted]" : item];
      return [key, redactDebugResult(item)];
    })
  );
}

function parseArgs(argv) {
  const args = { mode: "diagnose", port: Number(process.env.CDP_PORT || DEFAULT_PORT) };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--port=")) args.port = Number(arg.slice("--port=".length));
    else if (!arg.startsWith("--")) args.mode = arg;
  }
  return args;
}

class CDP {
  constructor(webSocketDebuggerUrl) {
    this.webSocketDebuggerUrl = webSocketDebuggerUrl;
    this.nextId = 1;
    this.pending = new Map();
  }

  async open() {
    this.ws = new WebSocket(this.webSocketDebuggerUrl);
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.message}: ${message.error.data || ""}`));
      else pending.resolve(message.result || {});
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}, timeoutMs = 120000) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      timeout.unref?.();
      this.pending.set(id, {
        resolve(value) {
          clearTimeout(timeout);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  async evaluate(expression, options = {}) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: options.awaitPromise !== false,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(detail || "Runtime evaluation failed");
    }
    return result.result?.value;
  }

  close() {
    this.ws?.close();
  }
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`Could not read CDP targets: HTTP ${response.status}`);
  return response.json();
}

async function connectToTelegram(port) {
  const target = pickTelegramPageTarget(await listTargets(port));
  if (!target) {
    throw new Error(
      `Telegram WebK page not found on CDP port ${port}. Open https://web.telegram.org/k/ or https://webk.telegram.org/ first.`
    );
  }
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Runtime.enable");
  return { cdp, target };
}

async function ensureUserscript(cdp, { requireTestApi = false } = {}) {
  const action = await cdp.evaluate(`(() => {
    window.unsafeWindow = window;
    window.GM_addStyle = function(css) {
      const style = document.createElement("style");
      style.setAttribute("data-tg-wmk-cdp-style", "1");
      style.textContent = css;
      document.head.appendChild(style);
    };
    const debugApi = window.__TG_WEBK_MEDIA_DOWNLOADER_DEBUG__;
    const testApi = window.__TG_WEBK_MEDIA_DOWNLOADER_TESTS__;
    const hasFreshDebugApi = Boolean(
      debugApi &&
      debugApi.createDebugReport &&
      debugApi.debugApiVersion === ${REQUIRED_DEBUG_API_VERSION}
    );
    const hasFreshTestApi = Boolean(
      testApi &&
      testApi.FakeDirectoryHandle &&
      testApi.clearSelectedDirectory &&
      testApi.debugApiVersion === ${REQUIRED_DEBUG_API_VERSION}
    );
    const hasFreshPanel = Boolean(document.querySelector("#tg-wmk-copy-debug"));
    if (
      hasFreshDebugApi &&
      hasFreshPanel &&
      (!${JSON.stringify(requireTestApi)} || hasFreshTestApi)
    ) return "present";
    document.querySelector("#tg-wmk-panel")?.remove();
    document.querySelectorAll(".tg-wmk-hover-download").forEach((button) => button.remove());
    document.querySelectorAll(".bubble[data-tg-wmk-hover-attached]").forEach((bubble) => {
      delete bubble.dataset.tgWmkHoverAttached;
    });
    delete window.__TG_WEBK_MEDIA_DOWNLOADER_DEBUG__;
    delete window.__TG_WEBK_MEDIA_DOWNLOADER_TESTS__;
    if (${JSON.stringify(requireTestApi)}) {
      window.__TG_WEBK_MEDIA_DOWNLOADER_TEST_MODE__ = true;
    } else {
      delete window.__TG_WEBK_MEDIA_DOWNLOADER_TEST_MODE__;
    }
    return "inject";
  })()`);

  if (action === "inject") {
    await cdp.evaluate(fs.readFileSync(USER_SCRIPT, "utf8"), { awaitPromise: false });
    if (requireTestApi) {
      await cdp.evaluate("window.__TG_WEBK_MEDIA_DOWNLOADER_TESTS__?.startForDebug?.()");
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return action;
}

async function collectReport(cdp, extraRuntime = {}) {
  return cdp.evaluate(`(() => {
    const api = window.__TG_WEBK_MEDIA_DOWNLOADER_DEBUG__;
    if (!api?.createDebugReport) return { error: "debug report API missing" };
    return api.createDebugReport(${JSON.stringify(extraRuntime)});
  })()`);
}

async function runDiagnose(cdp, target) {
  const before = await cdp.evaluate(`(() => {
    const root = document.querySelector("#column-center") || document;
    const bubbles = Array.from(root.querySelectorAll(".bubble"));
    return {
      url: location.origin + location.pathname,
      title: document.title,
      readyState: document.readyState,
      hasAppDownloadManager: Boolean(window.appDownloadManager),
      downloadManagerMethods: {
        downloadMedia: typeof window.appDownloadManager?.downloadMedia,
        downloadToDisc: typeof window.appDownloadManager?.downloadToDisc,
        downloadMediaURL: typeof window.appDownloadManager?.downloadMediaURL,
      },
      hasAppImManager: Boolean(window.appImManager),
      hasCurrentChat: Boolean(window.appImManager?.chat),
      bubbleCount: bubbles.length,
      downloadableLookingBubbleCount: bubbles.filter((bubble) =>
        bubble.querySelector(".media-container, .document, video, img.thumbnail, .photo, .document-name, .file-name")
      ).length,
      existingPanel: Boolean(document.querySelector("#tg-wmk-panel")),
    };
  })()`);
  const injectAction = await ensureUserscript(cdp);
  const report = await collectReport(cdp);
  return { mode: "diagnose", target: { title: target.title, url: redactDebugUrl(target.url) }, injectAction, before, report };
}

async function installFakeDirectory(cdp) {
  await cdp.evaluate(`(() => {
    const api = window.__TG_WEBK_MEDIA_DOWNLOADER_TESTS__;
    const root = new api.FakeDirectoryHandle("debug-root");
    window.__tgWmkDebugRoot = root;
    window.__tgWmkOriginalShowDirectoryPicker = window.showDirectoryPicker;
    window.showDirectoryPicker = async () => root;
    document.querySelector("#tg-wmk-choose-dir")?.click();
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 500));
}

function collectFilesExpression() {
  return `function collectFiles(dir, prefix = "") {
    const files = [];
    for (const [name, handle] of dir.entries) {
      const next = prefix ? prefix + "/" + name : name;
      if (handle.kind === "directory") files.push(...collectFiles(handle, next));
      else files.push({ path: next, size: handle.blob?.size || 0, type: handle.blob?.type || "" });
    }
    return files;
  }`;
}

function restoreFakeDirectoryExpression() {
  return `if (Object.prototype.hasOwnProperty.call(window, "__tgWmkOriginalShowDirectoryPicker")) {
    if (window.__tgWmkOriginalShowDirectoryPicker === undefined) delete window.showDirectoryPicker;
    else window.showDirectoryPicker = window.__tgWmkOriginalShowDirectoryPicker;
    delete window.__tgWmkOriginalShowDirectoryPicker;
  }
  window.__TG_WEBK_MEDIA_DOWNLOADER_TESTS__?.clearSelectedDirectory?.();`;
}

async function runSmokeSingle(cdp) {
  await ensureUserscript(cdp, { requireTestApi: true });
  await installFakeDirectory(cdp);
  return cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    ${collectFilesExpression()}
    try {
      const beforeFiles = collectFiles(window.__tgWmkDebugRoot);
      const column = document.querySelector("#column-center") || document;
      const bubble = Array.from(column.querySelectorAll(".bubble")).find((candidate) =>
        candidate.querySelector(".tg-wmk-hover-download") &&
        candidate.querySelector(".media-container, img.thumbnail, .photo, .document, video")
      );
      if (!bubble) return { mode: "smoke-single", ok: false, error: "No visible media bubble with hover button." };
      bubble.querySelector(".tg-wmk-hover-download").click();
      let status = "";
      for (let i = 0; i < 120; i += 1) {
        await sleep(500);
        status = document.querySelector("#tg-wmk-status")?.textContent || "";
        if (/Done\\.|Stopped\\.|No supported media found|failed|unsupported|Choose a directory|error/i.test(status)) break;
      }
      const files = collectFiles(window.__tgWmkDebugRoot).sort((a, b) => a.path.localeCompare(b.path));
      const selected = await window.appImManager?.chat?.selection?.getSelectedMessages?.() || [];
      const beforePaths = new Set(beforeFiles.map((file) => file.path));
      const newFiles = files.filter((file) => !beforePaths.has(file.path));
      return {
        mode: "smoke-single",
        ok: newFiles.some((file) => /\\/(images|videos|documents)\\//.test(file.path)),
        status,
        selectedAfter: selected.length,
        files: newFiles.map((file) => ({ ...file, path: file.path.replace(/^[^/]+__peer-[^/]+/, "<chat-dir>") })),
        report: window.__TG_WEBK_MEDIA_DOWNLOADER_DEBUG__.createDebugReport(),
      };
    } finally {
      ${restoreFakeDirectoryExpression()}
    }
  })()`);
}

async function runSmokeVisibleBatch(cdp) {
  await ensureUserscript(cdp, { requireTestApi: true });
  await installFakeDirectory(cdp);
  return cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    ${collectFilesExpression()}
    const colCenter = document.querySelector("#column-center");
    const container = colCenter?.querySelector(".bubbles-container") || colCenter?.querySelector(".scrollable-y");
    if (container && !container.__tgWmkOriginalScrollBy) {
      container.__tgWmkOriginalScrollBy = container.scrollBy.bind(container);
      container.scrollBy = () => {};
    }
    try {
      for (const type of ["video", "document"]) {
        const input = document.querySelector('[data-tg-wmk-filter="' + type + '"]');
        if (input && input.checked) {
          input.checked = false;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      const image = document.querySelector('[data-tg-wmk-filter="image"]');
      if (image && !image.checked) {
        image.checked = true;
        image.dispatchEvent(new Event("change", { bubbles: true }));
      }
      document.querySelector("#tg-wmk-batch")?.click();
      let status = "";
      for (let i = 0; i < 120; i += 1) {
        await sleep(500);
        status = document.querySelector("#tg-wmk-status")?.textContent || "";
        if (/Done\\.|Stopped\\.|No supported media found|Chat changed|failed|error/i.test(status)) break;
      }
      const files = collectFiles(window.__tgWmkDebugRoot).sort((a, b) => a.path.localeCompare(b.path));
      const selected = await window.appImManager?.chat?.selection?.getSelectedMessages?.() || [];
      return {
        mode: "smoke-visible-batch",
        ok: /Done\\.|No supported media found/i.test(status),
        status,
        selectedAfter: selected.length,
        mediaFiles: files
          .filter((file) => /\\/(images|videos|documents)\\//.test(file.path))
          .map((file) => ({ ...file, path: file.path.replace(/^[^/]+__peer-[^/]+/, "<chat-dir>") })),
        report: window.__TG_WEBK_MEDIA_DOWNLOADER_DEBUG__.createDebugReport(),
      };
    } finally {
      if (container?.__tgWmkOriginalScrollBy) {
        container.scrollBy = container.__tgWmkOriginalScrollBy;
        delete container.__tgWmkOriginalScrollBy;
      }
      for (const type of ["image", "video", "document"]) {
        const input = document.querySelector('[data-tg-wmk-filter="' + type + '"]');
        if (input && !input.checked) {
          input.checked = true;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      ${restoreFakeDirectoryExpression()}
    }
  })()`);
}

async function main() {
  const args = parseArgs(process.argv);
  const { cdp, target } = await connectToTelegram(args.port);
  try {
    let result;
    if (args.mode === "diagnose") result = await runDiagnose(cdp, target);
    else if (args.mode === "smoke-single") result = await runSmokeSingle(cdp);
    else if (args.mode === "smoke-visible-batch") result = await runSmokeVisibleBatch(cdp);
    else throw new Error(`Unknown mode "${args.mode}". Use diagnose, smoke-single, or smoke-visible-batch.`);
    console.log(JSON.stringify(redactDebugResult(result), null, 2));
  } finally {
    cdp.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
  });
}

module.exports = {
  CDP,
  pickTelegramPageTarget,
  redactDebugPath,
  redactDebugUrl,
  redactDebugResult,
  parseArgs,
};
