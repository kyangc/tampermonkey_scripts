const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function createFakeElement(tagName = "div") {
  const children = [];
  const classNames = new Set();
  const listeners = new Map();
  const attributes = new Map();
  let className = "";
  let innerHTML = "";

  function syncClassName() {
    className = Array.from(classNames).join(" ");
  }

  function setDataAttribute(name, value) {
    if (!name.startsWith("data-")) return;
    const key = name
      .slice(5)
      .replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    element.dataset[key] = String(value);
  }

  const element = {
    tagName: tagName.toUpperCase(),
    style: {},
    dataset: {},
    textContent: "",
    innerText: "",
    children,
    classList: {
      add(...tokens) {
        for (const token of tokens) classNames.add(String(token));
        syncClassName();
      },
      remove(...tokens) {
        for (const token of tokens) classNames.delete(String(token));
        syncClassName();
      },
      contains(token) {
        return classNames.has(String(token)) || className.split(/\s+/).includes(String(token));
      },
    },
    appendChild(child) {
      children.push(child);
      child.parentNode = this;
      return child;
    },
    append(...nodes) {
      for (const node of nodes) {
        children.push(node);
        if (node && (typeof node === "object" || typeof node === "function")) {
          node.parentNode = this;
        }
      }
    },
    prepend(child) {
      children.unshift(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      const index = children.indexOf(child);
      if (index >= 0) children.splice(index, 1);
      return child;
    },
    remove() {},
    setAttribute(name, value) {
      const stringValue = String(value);
      attributes.set(name, stringValue);
      if (name === "id") this.id = stringValue;
      else if (name === "class") this.className = stringValue;
      else if (name === "disabled") this.disabled = true;
      else if (name === "checked") this.checked = true;
      else this[name] = stringValue;
      setDataAttribute(name, stringValue);
    },
    getAttribute(name) {
      if (attributes.has(name)) return attributes.get(name);
      if (name === "class") return className || null;
      if (name === "disabled") return this.disabled ? "disabled" : null;
      if (name === "checked") return this.checked ? "checked" : null;
      return this[name] || null;
    },
    removeAttribute(name) {
      attributes.delete(name);
      if (name === "disabled") this.disabled = false;
      else if (name === "checked") this.checked = false;
      else delete this[name];
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    async dispatchEvent(event = {}) {
      const eventObject = {
        ...event,
        type: event.type || "",
        target: event.target || this,
        currentTarget: this,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {},
      };
      for (const listener of listeners.get(eventObject.type) || []) {
        await listener.call(this, eventObject);
      }
      return !eventObject.defaultPrevented;
    },
    click() {
      return this.dispatchEvent({ type: "click" });
    },
    matches(selector) {
      return selectorMatches(this, selector);
    },
    querySelector(selector) {
      return findFirst(this, selector);
    },
    querySelectorAll(selector) {
      return findAll(this, selector);
    },
    closest(selector) {
      let current = this;
      while (current) {
        if (current.matches?.(selector)) return current;
        current = current.parentNode;
      }
      return null;
    },
    getBoundingClientRect() {
      return { width: 20, height: 20, left: 0, top: 0 };
    },
  };

  Object.defineProperty(element, "className", {
    get() {
      return className;
    },
    set(value) {
      className = String(value || "");
      classNames.clear();
      for (const token of className.split(/\s+/).filter(Boolean)) classNames.add(token);
      if (className) attributes.set("class", className);
      else attributes.delete("class");
    },
  });

  Object.defineProperty(element, "innerHTML", {
    get() {
      return innerHTML;
    },
    set(value) {
      innerHTML = String(value || "");
      children.length = 0;
      const tagPattern = /<([a-z][\w-]*)([^>]*)>([^<]*)/gi;
      let match;
      while ((match = tagPattern.exec(innerHTML))) {
        const child = createFakeElement(match[1]);
        applyFakeAttributes(child, match[2]);
        const text = match[3].trim();
        if (text) child.textContent = text;
        element.appendChild(child);
      }
    },
  });

  return element;
}

function applyFakeAttributes(element, source) {
  const attrPattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match;
  while ((match = attrPattern.exec(source))) {
    const name = match[1];
    const value = match[2] ?? match[3] ?? match[4] ?? name;
    element.setAttribute(name, value);
  }
}

function selectorMatches(element, selector) {
  return String(selector)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => selectorPartMatches(element, part));
}

function selectorPartMatches(element, selector) {
  if (selector.startsWith("#")) return element.id === selector.slice(1);
  if (selector.startsWith(".")) return element.classList.contains(selector.slice(1));
  if (selector.startsWith("[") && selector.endsWith("]")) {
    const [name, rawValue] = selector.slice(1, -1).split("=");
    if (!rawValue) return element.getAttribute(name) !== null;
    return element.getAttribute(name) === rawValue.replace(/^["']|["']$/g, "");
  }
  if (selector.includes(".")) {
    const [tag, selectorClassName] = selector.split(".");
    return element.tagName.toLowerCase() === tag.toLowerCase() && element.classList.contains(selectorClassName);
  }
  return element.tagName.toLowerCase() === selector.toLowerCase();
}

function findAll(root, selector) {
  const matches = [];
  for (const child of root.children || []) {
    if (!child || typeof child !== "object") continue;
    if (child.matches?.(selector)) matches.push(child);
    matches.push(...findAll(child, selector));
  }
  return matches;
}

function findFirst(root, selector) {
  return findAll(root, selector)[0] || null;
}

function normalizeVmValue(value) {
  if (!value || typeof value !== "object") return value;
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object Date]") {
    return new Date(value.getTime());
  }
  if (Array.isArray(value) || tag === "[object Array]") {
    return Array.from(value, (item) => normalizeVmValue(item));
  }
  if (tag === "[object Object]") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeVmValue(item)]));
  }
  return value;
}

function loadTestApi({ testMode = true, pageTestMode = testMode } = {}) {
  const scriptPath = path.join(__dirname, "..", "scripts", "telegram-webk-media-downloader.user.js");
  const code = fs.readFileSync(scriptPath, "utf8");
  const FileCtor =
    typeof File === "undefined"
      ? class File extends Blob {
          constructor(parts, name, options = {}) {
            super(parts, options);
            this.name = String(name);
            this.lastModified = options.lastModified || Date.now();
          }
        }
      : File;
  const body = createFakeElement("body");
  const document = {
    body,
    documentElement: createFakeElement("html"),
    createElement: createFakeElement,
    querySelector(selector) {
      return body.querySelector(selector) || this.documentElement.querySelector(selector);
    },
    querySelectorAll(selector) {
      return [...body.querySelectorAll(selector), ...this.documentElement.querySelectorAll(selector)];
    },
    addEventListener() {},
  };
  const unsafeWindow = {
    __TG_WEBK_MEDIA_DOWNLOADER_TEST_MODE__: pageTestMode,
    location: { href: "https://web.telegram.org/k/", pathname: "/k/" },
    document,
    console,
    setTimeout() {
      return 1;
    },
    clearTimeout() {},
    setInterval() {
      return 1;
    },
    clearInterval() {},
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    Blob,
    URL: {
      createObjectURL() {
        return "blob:test";
      },
      revokeObjectURL() {},
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      blob: async () => new Blob(["fetch"], { type: "application/octet-stream" }),
    }),
    getComputedStyle() {
      return { position: "static" };
    },
  };
  unsafeWindow.window = unsafeWindow;
  const sandbox = {
    window: unsafeWindow,
    unsafeWindow,
    document,
    console,
    GM_addStyle() {},
    getComputedStyle: unsafeWindow.getComputedStyle,
    setTimeout: unsafeWindow.setTimeout,
    clearTimeout: unsafeWindow.clearTimeout,
    setInterval: unsafeWindow.setInterval,
    clearInterval: unsafeWindow.clearInterval,
    MutationObserver: unsafeWindow.MutationObserver,
    Blob,
    File: FileCtor,
    DOMException,
    Date,
    Object,
    URL: unsafeWindow.URL,
    fetch: unsafeWindow.fetch,
    __TG_WEBK_MEDIA_DOWNLOADER_TEST_MODE__: testMode,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: scriptPath });
  if (!testMode) return { __unsafeWindow: unsafeWindow };
  const api = unsafeWindow.__TG_WEBK_MEDIA_DOWNLOADER_TESTS__;
  const proxiedApi = Object.fromEntries(
    Object.entries(api).map(([name, value]) => [
      name,
      typeof value === "function"
        ? new Proxy(value, {
            apply(target, thisArg, args) {
              const result = Reflect.apply(target, thisArg, args);
              return normalizeVmValue(result);
            },
            construct(target, args) {
              return Reflect.construct(target, args);
            },
          })
        : value,
    ]),
  );
  proxiedApi.__unsafeWindow = unsafeWindow;
  return proxiedApi;
}

test("production runtime exposes diagnostics without exposing test controls", () => {
  const { __unsafeWindow } = loadTestApi({ testMode: false, pageTestMode: true });
  const debugApi = __unsafeWindow.__TG_WEBK_MEDIA_DOWNLOADER_DEBUG__;

  assert.equal(__unsafeWindow.__TG_WEBK_MEDIA_DOWNLOADER_TESTS__, undefined);
  assert.deepEqual(
    Object.keys(debugApi).sort(),
    ["createDebugReport", "debugApiVersion"].sort(),
  );
});

test("userscript exposes test helpers", () => {
  const api = loadTestApi();
  assert.equal(typeof api.sanitizePathSegment, "function");
  assert.equal(typeof api.formatFileTimestamp, "function");
  assert.equal(typeof api.inferMediaKind, "function");
  assert.equal(typeof api.planMediaPath, "function");
  assert.equal(typeof api.shouldSkipExistingFile, "function");
  assert.equal(typeof api.clearSelectedDirectory, "function");
  assert.equal(typeof api.dateInputToCutoffDate, "function");
  assert.equal(typeof api.splitMessagesByDateCutoff, "function");
  assert.equal(typeof api.clampPanelPosition, "function");
  assert.equal(typeof api.positionExpandedPanelNearAnchor, "function");
  assert.equal(typeof api.computeHoverButtonPosition, "function");
  assert.equal(typeof api.canRememberDirectoryHandle, "function");
  assert.equal(typeof api.attachHoverButton, "function");
  assert.equal(typeof api.collectMessageIdsFromBubble, "function");
  assert.equal(typeof api.resolveMessagesFromBubble, "function");
  assert.equal(typeof api.scanMadeProgress, "function");
  assert.equal(typeof api.hasEnabledMediaFilter, "function");
  assert.equal(typeof api.snapshotMediaFilters, "function");
  assert.equal(typeof api.filterMediaItems, "function");
  assert.equal(typeof api.getStartSettingsBlocker, "function");
  assert.equal(typeof api.getScanStartBlocker, "function");
  assert.equal(typeof api.getActionAvailability, "function");
  assert.equal(typeof api.renderPendingQueueSummary, "function");
  assert.equal(typeof api.updateDownloadActionAvailability, "function");
  assert.equal(typeof api.createPanel, "function");
  assert.equal(typeof api.createDownloadJob, "function");
  assert.equal(typeof api.createHoverDownloadJob, "function");
  assert.equal(typeof api.enqueueDownloadJob, "function");
  assert.equal(typeof api.dequeueNextDownloadJob, "function");
  assert.equal(typeof api.runDownloadJob, "function");
  assert.equal(typeof api.finalDownloadJobStatus, "function");
  assert.equal(typeof api.downloadJobStatusMessage, "function");
  assert.equal(typeof api.startDownloadWorker, "function");
  assert.equal(typeof api.stopCurrentDownloadJob, "function");
  assert.equal(typeof api.beginScanTask, "function");
  assert.equal(typeof api.finishScanTask, "function");
  assert.equal(typeof api.stopCurrentScanTask, "function");
  assert.equal(typeof api.startBatchDownload, "function");
  assert.equal(typeof api.stopCurrentTask, "function");
  assert.equal(typeof api.collectVisibleMessages, "function");
  assert.equal(typeof api.__getStateForTest, "function");
  assert.equal(typeof api.__setStateForTest, "function");
  assert.equal(typeof api.__setStorageForTest, "function");
  assert.equal(typeof api.__beginLegacyScanTaskForTest, "function");
  assert.equal(typeof api.__clearLegacyScanTaskForTest, "function");
  assert.equal(typeof api.__setRunDownloadJobForTest, "function");
  assert.equal(typeof api.__setScanCurrentChatMessagesForTest, "function");
});

test("sanitizePathSegment removes illegal filesystem characters and trims whitespace", () => {
  const api = loadTestApi();
  assert.equal(api.sanitizePathSegment('  A/B:*?"<>|  '), "A_B");
  assert.equal(api.sanitizePathSegment(""), "untitled");
  assert.equal(api.sanitizePathSegment(".."), "untitled");
});

test("sanitizePathSegment avoids trailing dots and Windows reserved names", () => {
  const api = loadTestApi();
  assert.equal(api.sanitizePathSegment("report..."), "report");
  assert.equal(api.sanitizePathSegment("CON"), "untitled");
  assert.equal(api.sanitizePathSegment("lpt1.txt"), "untitled");
});

test("formatFileTimestamp creates sortable local timestamps", () => {
  const api = loadTestApi();
  const date = new Date(2026, 3, 30, 23, 15, 22);
  assert.equal(api.formatFileTimestamp(date), "20260430_231522");
});

test("formatFileTimestamp accepts date-like objects from other realms", () => {
  const api = loadTestApi();
  const dateLike = {
    getTime() {
      return new Date(2026, 3, 30, 23, 15, 22).getTime();
    },
  };
  assert.equal(api.formatFileTimestamp(dateLike), "20260430_231522");
});

test("messageDateToDate keeps dates date-like through the VM wrapper", () => {
  const api = loadTestApi();
  const epochSeconds = Math.floor(new Date(2026, 3, 30, 10, 0, 0).getTime() / 1000);
  const date = api.messageDateToDate(epochSeconds);
  assert.ok(date instanceof Date);
  assert.equal(date.getTime(), epochSeconds * 1000);
});

test("date cutoff keeps messages on or after the selected local day", () => {
  const api = loadTestApi();
  const cutoff = api.dateInputToCutoffDate("2026-04-20");
  const result = api.splitMessagesByDateCutoff(
    [
      { mid: "old", date: Math.floor(new Date(2026, 3, 19, 23, 59, 59).getTime() / 1000) },
      { mid: "same-day", date: Math.floor(new Date(2026, 3, 20, 0, 0, 0).getTime() / 1000) },
      { mid: "later", date: Math.floor(new Date(2026, 3, 21, 12, 0, 0).getTime() / 1000) },
    ],
    cutoff,
  );

  assert.deepEqual(result.messages.map((message) => message.mid), ["same-day", "later"]);
  assert.equal(result.reachedCutoff, true);
});

test("date cutoff ignores invalid or empty date input", () => {
  const api = loadTestApi();
  assert.equal(api.dateInputToCutoffDate(""), null);
  assert.equal(api.dateInputToCutoffDate("not-a-date"), null);
  assert.deepEqual(api.splitMessagesByDateCutoff([{ mid: "1", date: 1 }], null), {
    messages: [{ mid: "1", date: 1 }],
    reachedCutoff: false,
  });
});

test("start settings require a directory and at least one enabled media type", () => {
  const api = loadTestApi();

  assert.equal(api.hasEnabledMediaFilter({ image: false, video: false, document: false }), false);
  assert.equal(api.hasEnabledMediaFilter({ image: false, video: true, document: false }), true);
  assert.equal(
    api.getStartSettingsBlocker({ hasStorage: false, filters: { image: true, video: false, document: false } }),
    "Choose a download directory first.",
  );
  assert.equal(
    api.getStartSettingsBlocker({ hasStorage: true, filters: { image: false, video: false, document: false } }),
    "Enable at least one media type.",
  );
  assert.equal(
    api.getStartSettingsBlocker({ hasStorage: true, filters: { image: true, video: false, document: false } }),
    "",
  );
});

test("scan start blocker ignores active downloads but blocks active scans", () => {
  const api = loadTestApi();

  assert.equal(
    api.getScanStartBlocker({
      scanActive: false,
      activeDownload: true,
      hasStorage: true,
      filters: { image: true, video: false, document: false },
    }),
    "",
  );
  assert.equal(
    api.getScanStartBlocker({
      scanActive: true,
      activeDownload: true,
      hasStorage: true,
      filters: { image: true, video: false, document: false },
    }),
    "A scan is already running.",
  );
});

test("action availability allows scan and hover while download is active", () => {
  const api = loadTestApi();

  assert.deepEqual(
    api.getActionAvailability({
      hasStorage: true,
      filters: { image: true, video: false, document: false },
      scanActive: false,
      activeDownload: true,
    }),
    {
      batchDisabled: false,
      batchTitle: "Batch Download Current Chat",
      hoverDisabled: false,
      hoverTitle: "Download media from this message",
    },
  );

  assert.deepEqual(
    api.getActionAvailability({
      hasStorage: false,
      filters: { image: true, video: false, document: false },
      scanActive: false,
      activeDownload: true,
    }),
    {
      batchDisabled: true,
      batchTitle: "Choose a download directory first.",
      hoverDisabled: true,
      hoverTitle: "Choose a download directory first.",
    },
  );

  assert.deepEqual(
    api.getActionAvailability({
      hasStorage: true,
      filters: { image: false, video: false, document: false },
      scanActive: false,
      activeDownload: false,
    }),
    {
      batchDisabled: true,
      batchTitle: "Enable at least one media type.",
      hoverDisabled: true,
      hoverTitle: "Enable at least one media type.",
    },
  );

  assert.deepEqual(
    api.getActionAvailability({
      hasStorage: true,
      filters: { image: true, video: false, document: false },
      scanActive: true,
      activeDownload: false,
    }),
    {
      batchDisabled: true,
      batchTitle: "A scan is already running.",
      hoverDisabled: true,
      hoverTitle: "A scan is already running.",
    },
  );
});

test("createPanel disables batch until a directory is selected", () => {
  const api = loadTestApi();

  api.createPanel();

  const batch = api.__unsafeWindow.document.querySelector("#tg-wmk-batch");
  assert.equal(batch.disabled, true);
  assert.equal(batch.title, "Choose a download directory first.");
  assert.equal(api.__unsafeWindow.document.querySelector("#tg-wmk-stop"), null);
  assert.ok(api.__unsafeWindow.document.querySelector("#tg-wmk-stop-scan"));
  assert.ok(api.__unsafeWindow.document.querySelector("#tg-wmk-stop-download"));
});

test("filter changes disable batch and hover actions when all media types are off", async () => {
  const api = loadTestApi();
  const root = new api.FakeDirectoryHandle("root");
  api.__setStorageForTest(new api.StorageManager(root));
  api.createPanel();

  const media = createFakeElement("div");
  const bubble = createFakeElement("div");
  bubble.querySelector = (selector) => (String(selector).includes(".media-container") ? media : null);
  api.__unsafeWindow.document.body.appendChild(bubble);
  api.attachHoverButton(bubble);

  const batch = api.__unsafeWindow.document.querySelector("#tg-wmk-batch");
  const button = bubble.children.find((child) => child.className === "tg-wmk-hover-download");
  assert.equal(batch.disabled, false);
  assert.equal(button.disabled, false);

  for (const input of api.__unsafeWindow.document.querySelectorAll("[data-tg-wmk-filter]")) {
    input.checked = false;
    await input.dispatchEvent({ type: "change" });
  }

  assert.equal(batch.disabled, true);
  assert.equal(batch.title, "Enable at least one media type.");
  assert.equal(button.disabled, true);
  assert.equal(button.title, "Enable at least one media type.");
});

test("active downloads do not disable batch or hover actions", () => {
  const api = loadTestApi();
  const root = new api.FakeDirectoryHandle("root");
  api.__setStorageForTest(new api.StorageManager(root));
  const active = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Downloading", chatId: "downloading", chatRevision: 1 },
    items: [{ mid: "1", type: "image", chatTitle: "Downloading", chatId: "downloading" }],
  });
  api.__setDownloadQueueForTest({ activeJob: active, workerRunning: true });
  api.createPanel();

  const media = createFakeElement("div");
  const bubble = createFakeElement("div");
  bubble.querySelector = (selector) => (String(selector).includes(".media-container") ? media : null);
  api.__unsafeWindow.document.body.appendChild(bubble);
  api.attachHoverButton(bubble);

  const batch = api.__unsafeWindow.document.querySelector("#tg-wmk-batch");
  const button = bubble.children.find((child) => child.className === "tg-wmk-hover-download");
  assert.equal(batch.disabled, false);
  assert.equal(batch.title, "Batch Download Current Chat");
  assert.equal(button.disabled, false);
  assert.equal(button.title, "Download media from this message");
});

test("panel stop buttons follow scan and download activity independently", () => {
  const scanApi = loadTestApi();
  scanApi.__setStorageForTest(new scanApi.StorageManager(new scanApi.FakeDirectoryHandle("root")));
  scanApi.__setStateForTest({
    scan: {
      active: true,
      chatSnapshot: { chatTitle: "Scan Chat", chatId: "scan", chatRevision: 1 },
      counters: { scanned: 3, discovered: 2 },
    },
  });
  scanApi.createPanel();
  assert.equal(scanApi.__unsafeWindow.document.querySelector("#tg-wmk-stop-scan").disabled, false);
  assert.equal(scanApi.__unsafeWindow.document.querySelector("#tg-wmk-stop-download").disabled, true);

  const downloadApi = loadTestApi();
  downloadApi.__setStorageForTest(new downloadApi.StorageManager(new downloadApi.FakeDirectoryHandle("root")));
  const active = downloadApi.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Download Chat", chatId: "download", chatRevision: 1 },
    items: [{ mid: "1", type: "image", chatTitle: "Download Chat", chatId: "download" }],
  });
  downloadApi.__setDownloadQueueForTest({ activeJob: active, workerRunning: true });
  downloadApi.createPanel();
  assert.equal(downloadApi.__unsafeWindow.document.querySelector("#tg-wmk-stop-scan").disabled, true);
  assert.equal(downloadApi.__unsafeWindow.document.querySelector("#tg-wmk-stop-download").disabled, false);
});

test("legacy stop button compatibility still follows active tasks", () => {
  const api = loadTestApi();
  const legacyStop = createFakeElement("button");
  legacyStop.setAttribute("id", "tg-wmk-stop");
  legacyStop.setAttribute("disabled", "disabled");
  api.__unsafeWindow.document.body.appendChild(legacyStop);

  api.beginScanTask({
    chatSnapshot: { chatTitle: "Legacy Scan", chatId: "legacy-scan", chatRevision: 1 },
    hasStorage: true,
    filters: { image: true, video: false, document: false },
  });
  assert.equal(legacyStop.disabled, false);

  api.finishScanTask([], { autoStart: false });
  assert.equal(legacyStop.disabled, true);
});

test("pending queue summary lists queued jobs", () => {
  const api = loadTestApi();
  const jobs = [
    ["First", "1", 1],
    ["Second", "2", 2],
    ["Third", "3", 1],
    ["Fourth", "4", 1],
  ].map(([chatTitle, chatId, count]) =>
    api.createDownloadJob({
      source: "batch",
      chatInfo: { chatTitle, chatId, chatRevision: 1 },
      items: Array.from({ length: count }, (_, index) => ({
        mid: `${chatId}-${index}`,
        type: "image",
        chatTitle,
        chatId,
      })),
    })
  );

  for (const job of jobs) api.enqueueDownloadJob(job, { autoStart: false });

  assert.equal(api.renderPendingQueueSummary(), "Queue: First 1 items; Second 2 items; Third 1 items; +1 more");
  api.createPanel();
  assert.equal(
    api.__unsafeWindow.document.querySelector("#tg-wmk-queue-status").textContent,
    "Queue: First 1 items; Second 2 items; Third 1 items; +1 more",
  );
});

test("beginScanTask blocks only another active scan and ignores active downloads", () => {
  const api = loadTestApi();
  const active = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Downloading", chatId: "downloading", chatRevision: 1 },
    items: [{ mid: "1", type: "image", chatTitle: "Downloading", chatId: "downloading" }],
  });
  api.__setStateForTest({ running: true, stopped: false });
  api.__setDownloadQueueForTest({ activeJob: active, workerRunning: true });

  const first = api.beginScanTask({
    chatSnapshot: { chatTitle: "A", chatId: "a", chatRevision: 1 },
    hasStorage: true,
    filters: { image: true, video: false, document: false },
  });
  const second = api.beginScanTask({
    chatSnapshot: { chatTitle: "B", chatId: "b", chatRevision: 2 },
    hasStorage: true,
    filters: { image: true, video: false, document: false },
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.message, "A scan is already running.");
});

test("finishScanTask enqueues completed scan items with the scan chat snapshot", () => {
  const api = loadTestApi();
  api.beginScanTask({
    chatSnapshot: { chatTitle: "Scan Chat", chatId: "scan-peer", chatRevision: 1 },
    hasStorage: true,
    filters: { image: true, video: false, document: false },
  });
  api.__unsafeWindow.appImManager = { chat: { peerIdString: "current-peer" } };
  api.__unsafeWindow.document.querySelector = (selector) =>
    String(selector).includes("peer-title") ? { textContent: "Current Chat" } : null;
  api.captureChatSnapshot();

  const queued = api.finishScanTask(
    [{ mid: "1", type: "image", chatTitle: "Scan Chat", chatId: "scan-peer", media: { _: "photo" } }],
    { autoStart: false },
  );

  const snapshot = api.__getDownloadQueueForTest();
  assert.equal(queued, true);
  assert.equal(snapshot.pendingJobs.length, 1);
  assert.equal(snapshot.pendingJobs[0].chatInfo.chatTitle, "Scan Chat");
  assert.equal(snapshot.pendingJobs[0].chatInfo.chatId, "scan-peer");
  assert.equal(api.__getStateForTest().scan.counters.discovered, 1);
});

test("finishScanTask ignores empty scans without leaving an active scan", () => {
  const api = loadTestApi();
  api.beginScanTask({
    chatSnapshot: { chatTitle: "Empty", chatId: "empty-peer", chatRevision: 1 },
    hasStorage: true,
    filters: { image: true, video: false, document: false },
  });

  const queued = api.finishScanTask([], { autoStart: false });

  const state = api.__getStateForTest();
  assert.equal(queued, false);
  assert.equal(state.scan.active, false);
  assert.equal(state.scan.stopped, false);
  assert.equal(api.__getDownloadQueueForTest().pendingJobs.length, 0);
});

test("finishScanTask observes auto-started job failures", async () => {
  const api = loadTestApi();
  api.__setStorageForTest(new api.StorageManager(new api.FakeDirectoryHandle("root")));
  api.beginScanTask({
    chatSnapshot: { chatTitle: "Auto Fail", chatId: "auto-fail", chatRevision: 1 },
    hasStorage: true,
    filters: { image: true, video: false, document: false },
  });
  api.__setRunDownloadJobForTest(async () => {
    throw new Error("auto worker boom");
  });

  assert.equal(api.finishScanTask([
    { mid: "1", type: "image", chatTitle: "Auto Fail", chatId: "auto-fail", media: { _: "photo" } },
  ]), true);
  await api.startDownloadWorker();

  const snapshot = api.__getDownloadQueueForTest();
  assert.equal(snapshot.completedJobs.length, 1);
  assert.equal(snapshot.completedJobs[0].status, "failed");
  assert.equal(snapshot.completedJobs[0].errors.includes("auto worker boom"), true);
});

test("startBatchDownload does not enqueue no-media or stopped scans", async () => {
  const noMediaApi = loadTestApi();
  noMediaApi.__setStorageForTest(new noMediaApi.StorageManager(new noMediaApi.FakeDirectoryHandle("root")));
  noMediaApi.__setScanCurrentChatMessagesForTest(async () => [{ mid: "1", date: 1777676400 }]);

  await noMediaApi.startBatchDownload();

  assert.equal(noMediaApi.__getDownloadQueueForTest().pendingJobs.length, 0);
  assert.equal(noMediaApi.__getStateForTest().scan.active, false);

  const stoppedApi = loadTestApi();
  stoppedApi.__setStorageForTest(new stoppedApi.StorageManager(new stoppedApi.FakeDirectoryHandle("root")));
  stoppedApi.__setScanCurrentChatMessagesForTest(async () => {
    stoppedApi.stopCurrentScanTask();
    return [{
      mid: "2",
      date: 1777676400,
      media: { photo: { _: "photo", id: "photo-2", size: 10, sizes: [] } },
    }];
  });

  await stoppedApi.startBatchDownload();

  const stoppedState = stoppedApi.__getStateForTest();
  assert.equal(stoppedApi.__getDownloadQueueForTest().pendingJobs.length, 0);
  assert.equal(stoppedState.scan.active, false);
  assert.equal(stoppedState.scan.chatSnapshot, null);
});

test("createDownloadJob freezes chat info and initializes counters", () => {
  const api = loadTestApi();
  const job = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Chat A", chatId: "peer-a", chatRevision: 7 },
    items: [
      { mid: "1", type: "image", chatTitle: "Chat A", chatId: "peer-a" },
      { mid: "2", type: "video", chatTitle: "Chat A", chatId: "peer-a" },
    ],
  });

  assert.equal(job.source, "batch");
  assert.equal(job.chatInfo.chatTitle, "Chat A");
  assert.equal(job.chatInfo.chatId, "peer-a");
  assert.equal(job.chatInfo.chatRevisionAtScanStart, 7);
  assert.equal(job.status, "pending");
  assert.equal(job.counters.total, 2);
  assert.equal(job.counters.discovered, 2);
  assert.equal(job.counters.downloaded, 0);
  assert.equal(job.items[0].chatTitle, "Chat A");
  assert.match(job.jobId, /^job-/);
  assert.equal(typeof job.completionPromise?.then, "function");
  assert.equal(typeof job.resolveCompletion, "function");
  assert.equal(typeof job.rejectCompletion, "function");
});

test("createDownloadJob freezes filters and excludes disabled media from counters", () => {
  const api = loadTestApi();
  const filters = { image: true, video: false, document: false };
  const job = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Filtered", chatId: "filtered-peer", chatRevision: 1 },
    filters,
    items: [
      { mid: "1", type: "image", chatTitle: "Filtered", chatId: "filtered-peer" },
      { mid: "2", type: "video", chatTitle: "Filtered", chatId: "filtered-peer" },
    ],
  });

  filters.image = false;
  filters.video = true;

  assert.deepEqual(job.filters, { image: true, video: false, document: false });
  assert.deepEqual(job.items.map((item) => item.type), ["image"]);
  assert.equal(job.counters.total, 1);
  assert.equal(job.counters.discovered, 1);
});

test("download queue preserves FIFO order", () => {
  const api = loadTestApi();
  const first = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "First", chatId: "1", chatRevision: 1 },
    items: [{ mid: "1", type: "image", chatTitle: "First", chatId: "1" }],
  });
  const second = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Second", chatId: "2", chatRevision: 2 },
    items: [{ mid: "2", type: "image", chatTitle: "Second", chatId: "2" }],
  });

  api.enqueueDownloadJob(first, { autoStart: false });
  api.enqueueDownloadJob(second, { autoStart: false });

  assert.equal(api.dequeueNextDownloadJob().jobId, first.jobId);
  assert.equal(api.dequeueNextDownloadJob().jobId, second.jobId);
  assert.equal(api.dequeueNextDownloadJob(), null);
});

test("enqueueDownloadJob rejects invalid jobs with a settled completion promise", async () => {
  const api = loadTestApi();
  const job = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Empty", chatId: "empty", chatRevision: 1 },
    items: [],
  });
  const completion = job.completionPromise.then(
    () => "resolved",
    (error) => error.message,
  );

  assert.equal(api.enqueueDownloadJob(job, { autoStart: false }), false);

  assert.equal(await completion, "No supported media found.");
  assert.equal(job.status, "failed");
  assert.equal(job.errors.includes("No supported media found."), true);
  assert.equal(api.__getDownloadQueueForTest().pendingJobs.length, 0);
});

test("clampPanelPosition keeps draggable panel inside the viewport", () => {
  const api = loadTestApi();
  assert.deepEqual(
    api.clampPanelPosition(
      { left: -20, top: 900 },
      { width: 320, height: 200 },
      { width: 1000, height: 700 },
    ),
    { left: 8, top: 492 },
  );
  assert.deepEqual(
    api.clampPanelPosition(
      { left: 900, top: -10 },
      { width: 320, height: 200 },
      { width: 1000, height: 700 },
    ),
    { left: 672, top: 8 },
  );
});

test("positionExpandedPanelNearAnchor expands toward available viewport space", () => {
  const api = loadTestApi();

  assert.deepEqual(
    api.positionExpandedPanelNearAnchor(
      { left: 760, top: 540, right: 880, bottom: 582 },
      { width: 320, height: 280 },
      { width: 900, height: 620 },
    ),
    { left: 560, top: 302 },
  );

  assert.deepEqual(
    api.positionExpandedPanelNearAnchor(
      { left: 18, top: 20, right: 138, bottom: 62 },
      { width: 320, height: 280 },
      { width: 900, height: 620 },
    ),
    { left: 18, top: 20 },
  );
});

test("attachHoverButton anchors the download button to downloadable bubbles", () => {
  const api = loadTestApi();
  const media = createFakeElement("div");
  const bubble = createFakeElement("div");
  bubble.querySelector = (selector) => (selector.includes(".media-container") ? media : null);

  api.attachHoverButton(bubble);

  const button = bubble.children.find((child) => child.className === "tg-wmk-hover-download");
  assert.ok(button);
  assert.equal(button.disabled, true);
  assert.equal(button.title, "Choose a download directory first.");
  assert.equal(button.textContent, "↓");
  assert.equal(bubble.dataset.tgWmkHoverAttached, "1");
  assert.equal(bubble.style.position, "relative");
  assert.equal(bubble.classList.contains("tg-wmk-hover-anchor"), true);
});

test("collectMessageIdsFromBubble includes nested album item mids once", () => {
  const api = loadTestApi();
  const bubble = createFakeElement("div");
  bubble.dataset.mid = "10";
  const firstAlbumItem = createFakeElement("div");
  firstAlbumItem.dataset.mid = "10";
  const secondAlbumItem = createFakeElement("div");
  secondAlbumItem.dataset.mid = "11";
  const duplicateSecondAlbumItem = createFakeElement("div");
  duplicateSecondAlbumItem.dataset.mid = "11";
  bubble.querySelectorAll = (selector) =>
    selector === "[data-mid]" ? [firstAlbumItem, secondAlbumItem, duplicateSecondAlbumItem] : [];

  assert.deepEqual(api.collectMessageIdsFromBubble(bubble), ["10", "11"]);
});

test("resolveMessagesFromBubble returns every selected album message in DOM order", async () => {
  const api = loadTestApi();
  const bubble = createFakeElement("div");
  bubble.dataset.mid = "10";
  const firstAlbumItem = createFakeElement("div");
  firstAlbumItem.dataset.mid = "10";
  const secondAlbumItem = createFakeElement("div");
  secondAlbumItem.dataset.mid = "11";
  bubble.querySelectorAll = (selector) => (selector === "[data-mid]" ? [firstAlbumItem, secondAlbumItem] : []);
  api.__unsafeWindow.appImManager = {
    chat: {
      selection: {
        async getSelectedMessages() {
          return [{ mid: "11" }, { mid: "other" }, { mid: "10" }];
        },
      },
    },
  };

  const messages = await api.resolveMessagesFromBubble(bubble);

  assert.deepEqual(Array.from(messages, (message) => message.mid), ["10", "11"]);
});

test("collectVisibleMessages reads scan stopped state instead of legacy stopped state", async () => {
  const api = loadTestApi();
  const root = createFakeElement("div");
  root.setAttribute("id", "column-center");
  const bubble = createDownloadableBubble("21");
  root.appendChild(bubble);
  api.__unsafeWindow.document.body.appendChild(root);
  api.__unsafeWindow.appImManager = {
    chat: {
      selection: {
        getSelectedMessages: () => [
          { mid: "21", media: { photo: { _: "photo", id: "photo-21", size: 10, sizes: [] } } },
        ],
      },
    },
  };

  api.__setStateForTest({ stopped: true, scan: { stopped: false } });
  const visible = await api.collectVisibleMessages(new Set());
  assert.deepEqual(Array.from(visible.messages, (message) => message.mid), ["21"]);

  api.__setStateForTest({ stopped: false, scan: { stopped: true } });
  const stopped = await api.collectVisibleMessages(new Set());
  assert.deepEqual(Array.from(stopped.messages), []);
});

function createDownloadableBubble(mid) {
  const media = createFakeElement("div");
  media.getBoundingClientRect = () => ({ left: 120, top: 70, right: 300, bottom: 250, width: 180, height: 180 });
  const bubble = createFakeElement("div");
  bubble.setAttribute("class", "bubble");
  bubble.dataset.mid = mid;
  bubble.getBoundingClientRect = () => ({ left: 100, top: 50, right: 320, bottom: 270, width: 220, height: 220 });
  bubble.querySelector = (selector) => (String(selector).includes(".media-container") ? media : null);
  bubble.querySelectorAll = (selector) => {
    if (selector === "[data-mid]") return [];
    return String(selector).includes(".media-container") ? [media] : [];
  };
  return bubble;
}

test("createHoverDownloadJob creates a queued hover job from resolved messages", () => {
  const api = loadTestApi();
  const job = api.createHoverDownloadJob(
    [
      {
        mid: "30",
        date: 1714518000,
        media: { photo: { _: "photo", id: "photo-30", sizes: [], mime_type: "image/jpeg" } },
      },
    ],
    { chatTitle: "Hover Chat", chatId: "hover-peer" },
  );

  assert.equal(job.source, "hover");
  assert.equal(job.chatInfo.chatTitle, "Hover Chat");
  assert.equal(job.items.length, 1);
  assert.equal(job.items[0].chatId, "hover-peer");
});

test("createHoverDownloadJob ignores empty or unsupported messages", () => {
  const api = loadTestApi();

  assert.equal(api.createHoverDownloadJob([], { chatTitle: "Hover Chat", chatId: "hover-peer" }), null);
  assert.equal(
    api.createHoverDownloadJob([{ mid: "31", date: 1714518000 }], {
      chatTitle: "Hover Chat",
      chatId: "hover-peer",
    }),
    null,
  );
});

test("createHoverDownloadJob ignores media disabled by the current filter snapshot", () => {
  const api = loadTestApi();
  api.createPanel();
  const videoFilter = api.__unsafeWindow.document.querySelector('[data-tg-wmk-filter="video"]');
  videoFilter.checked = false;
  videoFilter.dispatchEvent({ type: "change", target: videoFilter });

  const job = api.createHoverDownloadJob(
    [{
      mid: "32",
      date: 1714518000,
      media: {
        document: {
          _: "document",
          id: "video-32",
          file_name: "clip.mp4",
          mime_type: "video/mp4",
        },
      },
    }],
    { chatTitle: "Hover Chat", chatId: "hover-peer" },
  );

  assert.equal(job, null);
});

test("hover click enqueues a frozen chat job without waiting for active downloads", async () => {
  const api = loadTestApi();
  api.__setStorageForTest(new api.StorageManager(new api.FakeDirectoryHandle("root")));
  const active = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Active Download", chatId: "active-peer", chatRevision: 1 },
    items: [{ mid: "1", type: "image", chatTitle: "Active Download", chatId: "active-peer" }],
  });
  api.__setDownloadQueueForTest({
    activeJob: active,
    workerRunning: true,
    workerPromise: new Promise(() => {}),
  });

  let chatTitle = "Clicked Chat";
  const chat = {
    peerIdString: "clicked-peer",
    selection: {
      async getSelectedMessages() {
        chatTitle = "Later Chat";
        chat.peerIdString = "later-peer";
        api.captureChatSnapshot();
        return [
          {
            mid: "42",
            date: 1714518000,
            media: { photo: { _: "photo", id: "photo-42", sizes: [], mime_type: "image/jpeg", size: 4 } },
          },
        ];
      },
    },
  };
  api.__unsafeWindow.appImManager = { chat };
  api.__unsafeWindow.document.querySelector = (selector) =>
    String(selector).includes("peer-title") || String(selector).includes("chat-title")
      ? { textContent: chatTitle }
      : null;
  const bubble = createDownloadableBubble("42");
  api.attachHoverButton(bubble);
  const button = bubble.children.find((child) => child.className === "tg-wmk-hover-download");

  const clickFinished = button.dispatchEvent({ type: "click" }).then(() => true);
  const finishedQuickly = await Promise.race([
    clickFinished,
    new Promise((resolve) => setTimeout(() => resolve(false), 25)),
  ]);

  assert.equal(finishedQuickly, true);
  const snapshot = api.__getDownloadQueueForTest();
  assert.equal(snapshot.pendingJobs.length, 1);
  assert.equal(snapshot.pendingJobs[0].source, "hover");
  assert.equal(snapshot.pendingJobs[0].chatInfo.chatTitle, "Clicked Chat");
  assert.equal(snapshot.pendingJobs[0].chatInfo.chatId, "clicked-peer");
  assert.equal(snapshot.pendingJobs[0].items[0].chatTitle, "Clicked Chat");
  assert.equal(snapshot.pendingJobs[0].items[0].chatId, "clicked-peer");
});

test("hover click does not enqueue when directory settings are missing", async () => {
  const api = loadTestApi();
  api.__unsafeWindow.appImManager = {
    chat: {
      peerIdString: "hover-peer",
      selection: {
        async getSelectedMessages() {
          return [
            {
              mid: "43",
              date: 1714518000,
              media: { photo: { _: "photo", id: "photo-43", sizes: [], mime_type: "image/jpeg" } },
            },
          ];
        },
      },
    },
  };
  api.__unsafeWindow.document.querySelector = (selector) =>
    String(selector).includes("peer-title") || String(selector).includes("chat-title")
      ? { textContent: "Hover Chat" }
      : null;
  const bubble = createDownloadableBubble("43");
  api.attachHoverButton(bubble);
  const button = bubble.children.find((child) => child.className === "tg-wmk-hover-download");

  await button.dispatchEvent({ type: "click" });

  assert.equal(api.__getDownloadQueueForTest().pendingJobs.length, 0);
});

test("computeHoverButtonPosition keeps the download button outside the media item", () => {
  const api = loadTestApi();
  assert.deepEqual(
    api.computeHoverButtonPosition(
      { left: 400, top: 100 },
      { left: 420, right: 700, top: 120 },
      { width: 900 },
    ),
    { left: 304, top: 26, inside: false },
  );
  assert.deepEqual(
    api.computeHoverButtonPosition(
      { left: 400, top: 100 },
      { left: 420, right: 880, top: 120 },
      { width: 900 },
    ),
    { left: -12, top: 26, inside: false },
  );
});

test("updateHoverButtonPlacement positions albums against the whole media group", () => {
  const api = loadTestApi();
  const firstImage = createFakeElement("div");
  firstImage.getBoundingClientRect = () => ({ left: 120, top: 70, right: 300, bottom: 250, width: 180, height: 180 });
  const secondImage = createFakeElement("div");
  secondImage.getBoundingClientRect = () => ({ left: 304, top: 70, right: 480, bottom: 250, width: 176, height: 180 });
  const bubble = createFakeElement("div");
  bubble.getBoundingClientRect = () => ({ left: 100, top: 50, right: 500, bottom: 270, width: 400, height: 220 });
  bubble.querySelector = (selector) => (selector.includes(".media-container") ? firstImage : null);
  bubble.querySelectorAll = (selector) => (selector.includes(".media-container") ? [firstImage, secondImage] : []);
  const button = createFakeElement("button");

  api.updateHoverButtonPlacement(bubble, button);

  assert.equal(button.style.left, "384px");
  assert.equal(button.style.top, "26px");
  assert.equal(button.classList.contains("tg-wmk-hover-download-inside"), false);
});

test("canRememberDirectoryHandle accepts real permission-bearing directory handles only", () => {
  const api = loadTestApi();
  assert.equal(api.canRememberDirectoryHandle(new api.FakeDirectoryHandle("debug-root")), false);
  assert.equal(
    api.canRememberDirectoryHandle({
      kind: "directory",
      name: "Downloads",
      queryPermission() {},
      requestPermission() {},
    }),
    true,
  );
});

test("inferMediaKind maps mime and names to storage folders", () => {
  const api = loadTestApi();
  assert.equal(api.inferMediaKind({ mimeType: "image/jpeg", originalName: "" }), "image");
  assert.equal(api.inferMediaKind({ mimeType: "video/mp4", originalName: "" }), "video");
  assert.equal(api.inferMediaKind({ mimeType: "application/pdf", originalName: "x.pdf" }), "document");
  assert.equal(api.inferMediaKind({ mimeType: "", originalName: "clip.mov" }), "video");
  assert.equal(api.inferMediaKind({ mimeType: "", originalName: "photo.webp" }), "image");
});

test("planMediaPath creates chat/type directories and sortable filenames", () => {
  const api = loadTestApi();
  const item = {
    chatTitle: "A/B Group",
    chatId: "12345",
    mid: "88421",
    groupedId: "719332",
    groupIndex: 1,
    type: "video",
    originalName: "Trip: Day 1.MP4",
    extension: "mp4",
    mediaId: "video-1",
    sentAt: new Date(2026, 3, 30, 23, 15, 22),
  };
  assert.deepEqual(api.planMediaPath(item), {
    chatDirName: "A_B Group__peer-12345",
    typeDirName: "videos",
    fileName: "20260430_231522_mid-88421_gid-719332_idx-01_video_Trip_ Day 1.mp4",
    relativePath: "videos/20260430_231522_mid-88421_gid-719332_idx-01_video_Trip_ Day 1.mp4",
  });
});

test("planMediaPath caps chat directory names", () => {
  const api = loadTestApi();
  const item = {
    chatTitle: "A".repeat(300),
    chatId: "9".repeat(300),
    mid: "1",
    type: "document",
    originalName: "file.pdf",
    extension: "pdf",
    sentAt: new Date(2026, 3, 30, 23, 15, 22),
  };
  assert.ok(api.planMediaPath(item).chatDirName.length <= 240);
});

test("reportChatDirNameForRun prefers item chat over mutable current chat fallback", () => {
  const api = loadTestApi();
  const items = [{ chatTitle: "Original/Chat", chatId: "100" }];
  assert.equal(api.reportChatDirNameForRun(items, { chatTitle: "Other Chat", chatId: "200" }), "Original_Chat__peer-100");
  assert.equal(api.reportChatDirNameForRun([], { chatTitle: "Fallback", chatId: "300" }), "Fallback__peer-300");
});

test("sameChatInfo detects navigation between batch scan start and finish", () => {
  const api = loadTestApi();
  assert.equal(api.sameChatInfo({ chatTitle: "Room", chatId: "1" }, { chatTitle: "Room", chatId: "1" }), true);
  assert.equal(api.sameChatInfo({ chatTitle: "Room", chatId: "1" }, { chatTitle: "Other", chatId: "2" }), false);
});

test("chat snapshots reject transient navigation even after returning to the original chat", () => {
  const api = loadTestApi();
  api.__unsafeWindow.appImManager = { chat: { peerId: "1" } };
  const snapshot = api.captureChatSnapshot();

  api.__unsafeWindow.appImManager.chat.peerId = "2";
  assert.throws(() => api.assertChatSnapshot(snapshot), /Chat changed during scan/);

  api.__unsafeWindow.appImManager.chat.peerId = "1";
  assert.throws(() => api.assertChatSnapshot(snapshot), /Chat changed during scan/);
});

test("debug report summarizes safe runtime diagnostics", () => {
  const api = loadTestApi();
  api.createPanel();
  api.__unsafeWindow.document.querySelector("#tg-wmk-status").textContent =
    "Downloading 20260726_120000_mid-1_document_private-file.pdf";
  api.recordDebugEvent("download-start", { mid: "123", chatTitle: "private title", nested: { ignored: true } });
  const report = api.createDebugReport({ visibleBubbles: 4, downloadableBubbles: 2 });

  assert.equal(report.appId, "tg-webk-media-downloader");
  assert.equal(report.currentChat.chatTitle, "[redacted]");
  assert.equal(report.currentChat.chatTitleLength, "telegram_chat".length);
  assert.equal(report.currentChat.chatId, "[redacted]");
  assert.equal(report.currentChat.chatIdLength, "unknown".length);
  assert.equal(report.url, "https://web.telegram.org/k/");
  assert.equal(report.runtime.visibleBubbles, 4);
  assert.equal(report.runtime.downloadableBubbles, 2);
  assert.equal(report.webk.appDownloadManager, false);
  assert.equal(report.state.status, "downloading");
  assert.equal(JSON.stringify(report).includes("private-file.pdf"), false);
  assert.equal(report.events.length >= 1, true);
  assert.deepEqual(report.events.at(-1).detail, { mid: "123", chatTitle: "[redacted]", nested: "[object]" });
});

test("debug report legacy task fields are derived from scan and download queue state", () => {
  const api = loadTestApi();
  const active = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Private Chat", chatId: "private-peer", chatRevision: 1 },
    items: [
      { mid: "1", type: "image", chatTitle: "Private Chat", chatId: "private-peer" },
      { mid: "2", type: "video", chatTitle: "Private Chat", chatId: "private-peer" },
    ],
  });
  const pending = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Pending Chat", chatId: "pending-peer", chatRevision: 2 },
    items: [{ mid: "3", type: "image", chatTitle: "Pending Chat", chatId: "pending-peer" }],
  });
  const completed = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Done Chat", chatId: "done-peer", chatRevision: 3 },
    items: [{ mid: "4", type: "document", chatTitle: "Done Chat", chatId: "done-peer" }],
  });

  api.__setStateForTest({
    running: false,
    stopped: false,
    scan: {
      active: true,
      stopped: true,
      counters: { scanned: 7, discovered: 2 },
      status: "Stopping scan.",
    },
  });
  api.__setDownloadQueueForTest({
    activeJob: active,
    pendingJobs: [pending],
    completedJobs: [completed],
    workerRunning: true,
    stopAfterCurrentItem: true,
  });

  const report = api.createDebugReport();

  assert.equal(report.state.running, true);
  assert.equal(report.state.stopped, true);
  assert.deepEqual(report.state.scan, {
    active: true,
    stopped: true,
    counters: { scanned: 7, discovered: 2 },
    status: "Stopping scan.",
  });
  assert.deepEqual(report.state.downloadQueue, {
    activeJob: {
      jobId: active.jobId,
      chatTitle: "[redacted]",
      itemCount: 2,
      status: "pending",
    },
    pendingJobCount: 1,
    completedJobCount: 1,
    workerRunning: true,
  });

  const idleApi = loadTestApi();
  idleApi.__setStateForTest({ running: true, stopped: true, scan: { active: false, stopped: false } });
  const idleReport = idleApi.createDebugReport();
  assert.equal(idleReport.state.running, false);
  assert.equal(idleReport.state.stopped, false);
});

test("debug event log is capped to recent entries", () => {
  const api = loadTestApi();
  for (let index = 0; index < 140; index += 1) {
    api.recordDebugEvent("status", { index });
  }
  const report = api.createDebugReport();

  assert.equal(report.events.length, 120);
  assert.equal(report.events[0].detail.index, 20);
  assert.equal(report.events[119].detail.index, 139);
});

test("planMediaPath preserves zero-based grouped indices", () => {
  const api = loadTestApi();
  const item = {
    chatTitle: "Group",
    chatId: "123",
    mid: "2",
    groupedId: "777",
    groupIndex: 0,
    type: "image",
    originalName: "photo.jpg",
    extension: "jpg",
    sentAt: new Date(2026, 3, 30, 23, 15, 22),
  };
  assert.match(api.planMediaPath(item).fileName, /_gid-777_idx-00_image_/);
});

test("shouldSkipExistingFile follows filename and size rules", () => {
  const api = loadTestApi();
  assert.deepEqual(api.shouldSkipExistingFile(null, 123), { skip: false, reason: "missing" });
  assert.deepEqual(api.shouldSkipExistingFile({ size: 123 }, 123), { skip: true, reason: "size-match" });
  assert.deepEqual(api.shouldSkipExistingFile({ size: 123 }, undefined), { skip: true, reason: "exists-size-unknown" });
  assert.deepEqual(api.shouldSkipExistingFile({ size: 100 }, 123), { skip: false, reason: "size-mismatch" });
});

test("extractMediaItems normalizes photos, videos, and documents", () => {
  const api = loadTestApi();
  const chat = { chatTitle: "Media Room", chatId: "777" };
  const messages = [
    {
      mid: 10,
      date: Math.floor(new Date(2026, 3, 30, 10, 0, 0).getTime() / 1000),
      grouped_id: "album-1",
      media: { photo: { id: "photo-10", size: 1000, mime_type: "image/jpeg" } },
    },
    {
      mid: 11,
      date: Math.floor(new Date(2026, 3, 30, 10, 0, 1).getTime() / 1000),
      media: { document: { id: "doc-11", file_name: "clip.mp4", size: 2000, mime_type: "video/mp4" } },
    },
    {
      mid: 12,
      date: Math.floor(new Date(2026, 3, 30, 10, 0, 2).getTime() / 1000),
      media: { document: { id: "doc-12", file_name: "paper.pdf", size: 3000, mime_type: "application/pdf" } },
    },
  ];
  const items = api.extractMediaItems(messages, chat);
  assert.equal(items.length, 3);
  assert.ok(items[0].sentAt instanceof Date);
  assert.equal(items[0].sentAt.getTime(), messages[0].date * 1000);
  assert.deepEqual(items.map((item) => item.type), ["image", "video", "document"]);
  assert.deepEqual(items.map((item) => item.mid), ["10", "11", "12"]);
  assert.equal(items[0].groupedId, "album-1");
  assert.equal(items[0].groupIndex, 1);
  assert.equal(items[1].originalName, "clip.mp4");
  assert.equal(items[2].extension, "pdf");
});

test("extractMediaItems includes message and source in dc_id mediaId fallbacks", () => {
  const api = loadTestApi();
  const items = api.extractMediaItems(
    [
      {
        mid: 20,
        media: { document: { dc_id: "4", file_name: "asset.bin", size: 50 } },
      },
    ],
    { chatTitle: "Media Room", chatId: "777" },
  );
  assert.equal(items[0].mediaId, "20-document-4");
});

test("scan progress continues while scrolling even before new DOM messages appear", () => {
  const api = loadTestApi();

  assert.equal(
    api.scanMadeProgress(
      { scrollTop: 3852, scrollHeight: 4654, clientHeight: 802 },
      { scrollTop: 3171, scrollHeight: 4654, clientHeight: 802 },
      false,
    ),
    true,
  );
  assert.equal(
    api.scanMadeProgress(
      { scrollTop: 0, scrollHeight: 4654, clientHeight: 802 },
      { scrollTop: 0, scrollHeight: 4654, clientHeight: 802 },
      false,
    ),
    false,
  );
  assert.equal(
    api.scanMadeProgress(
      { scrollTop: 0, scrollHeight: 4654, clientHeight: 802 },
      { scrollTop: 0, scrollHeight: 4654, clientHeight: 802 },
      true,
    ),
    true,
  );
});

test("buildWebKDownloadOptions includes queue id and largest photo thumb", () => {
  const api = loadTestApi();
  api.__unsafeWindow.appImManager = { chat: { bubbles: { lazyLoadQueue: { queueId: 42 } } } };
  const media = {
    _: "photo",
    sizes: [
      { _: "photoStrippedSize", type: "i", size: 1 },
      { _: "photoSize", type: "m", size: 100 },
      { _: "photoSize", type: "x", size: 200 },
    ],
  };
  const options = api.buildWebKDownloadOptions({ media });
  assert.deepEqual(options.media, media);
  assert.equal(options.queueId, 42);
  assert.equal(options.thumb.type, "x");
});

test("extractMediaItems freezes current WebK queue id for later downloads", () => {
  const api = loadTestApi();
  assert.equal(typeof api.captureDownloadContext, "function");
  api.__unsafeWindow.appImManager = { chat: { bubbles: { lazyLoadQueue: { queueId: 99 } } } };

  const items = api.extractMediaItems(
    [
      {
        mid: "10",
        date: 1714518000,
        media: { photo: { _: "photo", id: "photo-10", sizes: [], mime_type: "image/jpeg" } },
      },
    ],
    { chatTitle: "Frozen", chatId: "peer-frozen" },
  );

  assert.equal(items[0].downloadContext.queueId, 99);
});

test("buildWebKDownloadOptions prefers frozen queue id over current chat queue id", () => {
  const api = loadTestApi();
  api.__unsafeWindow.appImManager = { chat: { bubbles: { lazyLoadQueue: { queueId: 12 } } } };

  const options = api.buildWebKDownloadOptions({
    media: { _: "document", id: "doc-1" },
    downloadContext: { queueId: 77 },
  });

  assert.equal(options.queueId, 77);
});

test("downloadItemBlob uses WebK appDownloadManager before URL fallback", async () => {
  const api = loadTestApi();
  let calledWith;
  api.__unsafeWindow.appDownloadManager = {
    downloadMedia(options) {
      calledWith = options;
      return Promise.resolve(new Blob(["webk"], { type: "video/mp4" }));
    },
  };
  const blob = await api.downloadItemBlob({ media: { _: "document", id: "doc-1" } });
  assert.equal(await blob.text(), "webk");
  assert.equal(calledWith.media.id, "doc-1");
});

test("downloadItemBlob falls back to attached downloadToDisc for photos needing a thumb", async () => {
  const api = loadTestApi();
  let attached = false;
  api.__unsafeWindow.appDownloadManager = {
    downloadMedia() {
      return Promise.reject("preloadPhoto photoEmpty!");
    },
    downloadToDisc(options, justAttach) {
      attached = justAttach;
      assert.equal(options.thumb.type, "x");
      return Promise.resolve(new Blob(["photo"], { type: "image/jpeg" }));
    },
  };
  const blob = await api.downloadItemBlob({
    media: {
      _: "photo",
      id: "photo-1",
      sizes: [
        { _: "photoSize", type: "m", size: 100 },
        { _: "photoSize", type: "x", size: 200 },
      ],
    },
  });
  assert.equal(attached, true);
  assert.equal(await blob.text(), "photo");
});

test("StorageManager writes files, creates directories, and merges manifest items", async () => {
  const api = loadTestApi();
  const root = new api.FakeDirectoryHandle("root");
  const storage = new api.StorageManager(root);
  const item = {
    chatTitle: "A/B Group",
    chatId: "12345",
    mid: "88421",
    groupedId: "",
    groupIndex: 0,
    type: "image",
    originalName: "",
    extension: "jpg",
    mediaId: "photo-1",
    sentAt: new Date(2026, 3, 30, 23, 15, 22),
    size: 5,
  };
  const planned = api.planMediaPath(item);
  const file = await storage.writePlannedFile(planned, new Blob(["hello"]));
  assert.equal(file.size, 5);
  const existing = await storage.getExistingFile(planned);
  assert.equal(existing.size, 5);
  await storage.upsertManifest(planned.chatDirName, [{ mid: "88421", relativePath: planned.relativePath, status: "downloaded" }]);
  await storage.upsertManifest(planned.chatDirName, [{ mid: "88421", relativePath: planned.relativePath, status: "skipped" }]);
  const manifest = await storage.readJson(planned.chatDirName, "_manifest.json", { items: [] });
  assert.equal(manifest.items.length, 1);
  assert.equal(manifest.items[0].status, "skipped");
});

test("runDownloadJob writes files using the queued item chat info", async () => {
  const api = loadTestApi();
  const root = new api.FakeDirectoryHandle("root");
  api.__unsafeWindow.appDownloadManager = {
    async downloadMedia() {
      return new Blob(["queued"], { type: "image/jpeg" });
    },
  };
  api.__unsafeWindow.appImManager = { chat: { bubbles: { lazyLoadQueue: { queueId: 5 } } } };

  const storage = new api.StorageManager(root);
  const job = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Old Chat", chatId: "old-peer", chatRevision: 1 },
    items: [
      {
        chatTitle: "Old Chat",
        chatId: "old-peer",
        mid: "20",
        mediaId: "photo-20",
        type: "image",
        originalName: "",
        extension: "jpg",
        mimeType: "image/jpeg",
        size: 6,
        sentAt: new Date(2026, 4, 1, 10, 0, 0),
        media: { _: "photo", id: "photo-20", sizes: [] },
        source: "photo",
        downloadContext: { queueId: 44 },
      },
    ],
  });

  await api.runDownloadJob(job, storage);

  assert.equal(job.status, "completed");
  assert.equal(job.counters.downloaded, 1);
  assert.equal(job.resolveCompletion, null);
  assert.equal(job.rejectCompletion, null);
  const chatDir = await root.getDirectoryHandle("Old Chat__peer-old-peer", { create: false });
  const imagesDir = await chatDir.getDirectoryHandle("images", { create: false });
  assert.equal(imagesDir.children.size, 1);
});

test("runDownloadJob reports handled media failures instead of showing a clean completion", async () => {
  const api = loadTestApi();
  const root = new api.FakeDirectoryHandle("root");
  api.createPanel();
  api.__unsafeWindow.appDownloadManager = {
    async downloadMedia() {
      throw new Error("private-file.pdf failed");
    },
  };
  const storage = new api.StorageManager(root);
  const job = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Failure Chat", chatId: "failure-peer", chatRevision: 1 },
    items: [{
      chatTitle: "Failure Chat",
      chatId: "failure-peer",
      mid: "22",
      mediaId: "document-22",
      type: "document",
      originalName: "private-file.pdf",
      extension: "pdf",
      mimeType: "application/pdf",
      size: 12,
      sentAt: new Date(2026, 4, 1, 10, 10, 0),
      media: { _: "document", id: "document-22" },
      source: "document",
    }],
  });

  await api.runDownloadJob(job, storage);

  assert.equal(job.status, "completed-with-errors");
  assert.equal(job.counters.failed, 1);
  assert.equal(
    api.__unsafeWindow.document.querySelector("#tg-wmk-status").textContent,
    "Done with warnings: 1 item not downloaded.",
  );
  const report = api.createDebugReport();
  assert.equal(report.state.status, "done-with-warnings");
  assert.equal(JSON.stringify(report).includes("private-file.pdf"), false);
});

test("runDownloadJob mirrors job counters into existing state counters", async () => {
  const api = loadTestApi();
  const root = new api.FakeDirectoryHandle("root");
  api.__unsafeWindow.appDownloadManager = {
    async downloadMedia() {
      return new Blob(["counter"], { type: "image/jpeg" });
    },
  };

  const storage = new api.StorageManager(root);
  const job = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Counter Chat", chatId: "counter-peer", chatRevision: 1 },
    items: [
      {
        chatTitle: "Counter Chat",
        chatId: "counter-peer",
        mid: "21",
        mediaId: "photo-21",
        type: "image",
        originalName: "",
        extension: "jpg",
        mimeType: "image/jpeg",
        size: 7,
        sentAt: new Date(2026, 4, 1, 10, 5, 0),
        media: { _: "photo", id: "photo-21", sizes: [] },
        source: "photo",
      },
    ],
  });

  await api.runDownloadJob(job, storage);

  const counters = api.createDebugReport().state.counters;
  assert.equal(counters.discovered, 1);
  assert.equal(counters.downloaded, 1);
  assert.equal(counters.skipped, 0);
  assert.equal(counters.failed, 0);
  assert.equal(counters.unsupported, 0);
});

test("runDownloadQueue waits for the queued worker to finish", async () => {
  const api = loadTestApi();
  const root = new api.FakeDirectoryHandle("root");
  const storage = new api.StorageManager(root);
  api.__setStorageForTest(storage);
  api.__unsafeWindow.appDownloadManager = {
    async downloadMedia() {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Blob(["awaited"], { type: "image/jpeg" });
    },
  };
  const item = {
    chatTitle: "Await Chat",
    chatId: "await-peer",
    mid: "22",
    mediaId: "photo-22",
    type: "image",
    originalName: "",
    extension: "jpg",
    mimeType: "image/jpeg",
    size: 7,
    sentAt: new Date(2026, 4, 1, 10, 10, 0),
    media: { _: "photo", id: "photo-22", sizes: [] },
    source: "photo",
  };

  await api.runDownloadQueue([item], "Batch");

  const snapshot = api.__getDownloadQueueForTest();
  assert.equal(snapshot.workerRunning, false);
  assert.equal(snapshot.completedJobs.length, 1);
  assert.equal(snapshot.completedJobs[0].status, "completed");
  const chatDir = await root.getDirectoryHandle("Await Chat__peer-await-peer", { create: false });
  const imagesDir = await chatDir.getDirectoryHandle("images", { create: false });
  assert.equal(imagesDir.children.size, 1);
});

test("runDownloadQueue ignores empty item lists before creating a job", async () => {
  const api = loadTestApi();
  const root = new api.FakeDirectoryHandle("root");
  api.__setStorageForTest(new api.StorageManager(root));

  assert.equal(await api.runDownloadQueue([], "Batch"), undefined);

  const snapshot = api.__getDownloadQueueForTest();
  assert.equal(snapshot.pendingJobs.length, 0);
  assert.equal(snapshot.completedJobs.length, 0);
  assert.equal(snapshot.workerRunning, false);
});

test("runDownloadQueue resolves after its own queued job finishes", async () => {
  const api = loadTestApi();
  const root = new api.FakeDirectoryHandle("root");
  api.__setStorageForTest(new api.StorageManager(root));

  let releaseFirst;
  let releaseSecond;
  let resolveFirstStarted;
  let resolveSecondStarted;
  const firstStarted = new Promise((resolve) => {
    resolveFirstStarted = resolve;
  });
  const secondStarted = new Promise((resolve) => {
    resolveSecondStarted = resolve;
  });
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const secondGate = new Promise((resolve) => {
    releaseSecond = resolve;
  });

  api.__unsafeWindow.appDownloadManager = {
    async downloadMedia(options) {
      if (options.media.id === "photo-first") {
        resolveFirstStarted();
        await firstGate;
        return new Blob(["first"], { type: "image/jpeg" });
      }
      resolveSecondStarted();
      await secondGate;
      return new Blob(["second"], { type: "image/jpeg" });
    },
  };
  const firstItem = {
    chatTitle: "First Queue Chat",
    chatId: "first-queue",
    mid: "23",
    mediaId: "photo-first",
    type: "image",
    originalName: "",
    extension: "jpg",
    mimeType: "image/jpeg",
    size: 5,
    sentAt: new Date(2026, 4, 1, 10, 15, 0),
    media: { _: "photo", id: "photo-first", sizes: [] },
    source: "photo",
  };
  const secondItem = {
    chatTitle: "Second Queue Chat",
    chatId: "second-queue",
    mid: "24",
    mediaId: "photo-second",
    type: "image",
    originalName: "",
    extension: "jpg",
    mimeType: "image/jpeg",
    size: 6,
    sentAt: new Date(2026, 4, 1, 10, 16, 0),
    media: { _: "photo", id: "photo-second", sizes: [] },
    source: "photo",
  };

  const firstPromise = api.runDownloadQueue([firstItem], "Batch");
  await firstStarted;
  const secondPromise = api.runDownloadQueue([secondItem], "Batch");
  let firstResolved = false;
  let secondResolved = false;
  firstPromise.then(() => {
    firstResolved = true;
  });
  secondPromise.then(() => {
    secondResolved = true;
  });

  releaseFirst();
  await secondStarted;
  await Promise.resolve();

  assert.equal(firstResolved, true);
  assert.equal(secondResolved, false);

  releaseSecond();
  await secondPromise;
});

test("runDownloadQueue enables and later disables the download stop button", async () => {
  const api = loadTestApi();
  const root = new api.FakeDirectoryHandle("root");
  api.__setStorageForTest(new api.StorageManager(root));
  const stopButton = {
    disabled: true,
  };
  api.__unsafeWindow.document.querySelector = (selector) =>
    selector === "#tg-wmk-stop-download" ? stopButton : null;

  let releaseDownload;
  let resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  const downloadGate = new Promise((resolve) => {
    releaseDownload = resolve;
  });
  api.__unsafeWindow.appDownloadManager = {
    async downloadMedia() {
      resolveStarted();
      await downloadGate;
      return new Blob(["button"], { type: "image/jpeg" });
    },
  };
  const item = {
    chatTitle: "Button Chat",
    chatId: "button-peer",
    mid: "25",
    mediaId: "photo-25",
    type: "image",
    originalName: "",
    extension: "jpg",
    mimeType: "image/jpeg",
    size: 6,
    sentAt: new Date(2026, 4, 1, 10, 20, 0),
    media: { _: "photo", id: "photo-25", sizes: [] },
    source: "photo",
  };

  const downloadPromise = api.runDownloadQueue([item], "Batch");
  await started;
  assert.equal(stopButton.disabled, false);

  releaseDownload();
  await downloadPromise;
  assert.equal(stopButton.disabled, true);
});

test("legacy scan cleanup only clears the current owner token", () => {
  const api = loadTestApi();

  const firstToken = api.__beginLegacyScanTaskForTest();
  const secondToken = api.__beginLegacyScanTaskForTest();
  assert.notEqual(firstToken, secondToken);

  assert.equal(api.__clearLegacyScanTaskForTest(firstToken), false);
  let state = api.__getStateForTest();
  assert.equal(state.running, true);
  assert.equal(state.legacyTaskToken, secondToken);

  assert.equal(api.__clearLegacyScanTaskForTest(secondToken), true);
  state = api.__getStateForTest();
  assert.equal(state.running, false);
  assert.equal(state.legacyTaskToken, null);
});

test("startDownloadWorker fails only active job on unexpected rejection", async () => {
  const api = loadTestApi();
  const root = new api.FakeDirectoryHandle("root");
  api.__setStorageForTest(new api.StorageManager(root));
  const failing = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Failing", chatId: "failing", chatRevision: 1 },
    items: [{ mid: "1", type: "image", chatTitle: "Failing", chatId: "failing" }],
  });
  const pending = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Pending", chatId: "pending", chatRevision: 2 },
    items: [{ mid: "2", type: "image", chatTitle: "Pending", chatId: "pending" }],
  });
  api.enqueueDownloadJob(failing, { autoStart: false });
  api.enqueueDownloadJob(pending, { autoStart: false });
  api.__setRunDownloadJobForTest(async () => {
    throw new Error("worker boom");
  });

  const failedCompletion = failing.completionPromise.catch((error) => error.message);
  await api.startDownloadWorker();

  assert.equal(await failedCompletion, "worker boom");
  assert.equal(failing.status, "failed");
  assert.equal(failing.errors.includes("worker boom"), true);
  const snapshot = api.__getDownloadQueueForTest();
  assert.equal(snapshot.activeJob, null);
  assert.equal(snapshot.workerRunning, false);
  assert.equal(snapshot.completedJobs[0].jobId, failing.jobId);
  assert.equal(snapshot.pendingJobs[0].jobId, pending.jobId);
});

test("startDownloadWorker settles active job when runner rejects undefined", async () => {
  const api = loadTestApi();
  const root = new api.FakeDirectoryHandle("root");
  api.__setStorageForTest(new api.StorageManager(root));
  const failing = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Failing", chatId: "failing", chatRevision: 1 },
    items: [{ mid: "1", type: "image", chatTitle: "Failing", chatId: "failing" }],
  });
  const pending = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Pending", chatId: "pending", chatRevision: 2 },
    items: [{ mid: "2", type: "image", chatTitle: "Pending", chatId: "pending" }],
  });
  api.enqueueDownloadJob(failing, { autoStart: false });
  api.enqueueDownloadJob(pending, { autoStart: false });
  api.__setRunDownloadJobForTest(() => Promise.reject(undefined));

  const failedCompletion = failing.completionPromise.then(
    () => "resolved",
    (error) => error.message,
  );
  await api.startDownloadWorker();

  assert.equal(await failedCompletion, "Unexpected download worker error.");
  assert.equal(failing.status, "failed");
  assert.equal(failing.errors.includes("Unexpected download worker error."), true);
  const snapshot = api.__getDownloadQueueForTest();
  assert.equal(snapshot.workerRunning, false);
  assert.equal(snapshot.pendingJobs[0].jobId, pending.jobId);
});

test("startDownloadWorker treats zero rejection reason as failure", async () => {
  const api = loadTestApi();
  const root = new api.FakeDirectoryHandle("root");
  api.__setStorageForTest(new api.StorageManager(root));
  const failing = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Failing", chatId: "failing", chatRevision: 1 },
    items: [{ mid: "1", type: "image", chatTitle: "Failing", chatId: "failing" }],
  });
  const pending = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Pending", chatId: "pending", chatRevision: 2 },
    items: [{ mid: "2", type: "image", chatTitle: "Pending", chatId: "pending" }],
  });
  api.enqueueDownloadJob(failing, { autoStart: false });
  api.enqueueDownloadJob(pending, { autoStart: false });
  api.__setRunDownloadJobForTest(() => Promise.reject(0));

  let settledAs = "";
  const failedCompletion = failing.completionPromise.then(
    () => {
      settledAs = "resolved";
      return "";
    },
    (error) => {
      settledAs = "rejected";
      return error.message;
    },
  );
  await api.startDownloadWorker();

  assert.equal(await failedCompletion, "0");
  assert.equal(settledAs, "rejected");
  assert.equal(failing.status, "failed");
  assert.equal(failing.errors.includes("0"), true);
  const snapshot = api.__getDownloadQueueForTest();
  assert.equal(snapshot.workerRunning, false);
  assert.equal(snapshot.pendingJobs[0].jobId, pending.jobId);
});

test("startDownloadWorker ignores runner overrides stored in queue state", async () => {
  const api = loadTestApi();
  const root = new api.FakeDirectoryHandle("root");
  api.__setStorageForTest(new api.StorageManager(root));
  api.__setDownloadQueueForTest({
    runDownloadJobOverride: async () => {
      throw new Error("state override leaked");
    },
  });
  api.__unsafeWindow.appDownloadManager = {
    async downloadMedia() {
      return new Blob(["safe"], { type: "image/jpeg" });
    },
  };
  const job = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Safe Runner", chatId: "safe-runner", chatRevision: 1 },
    items: [{
      chatTitle: "Safe Runner",
      chatId: "safe-runner",
      mid: "1",
      mediaId: "photo-safe",
      type: "image",
      originalName: "",
      extension: "jpg",
      mimeType: "image/jpeg",
      size: 4,
      sentAt: new Date(2026, 4, 1, 11, 0, 0),
      media: { _: "photo", id: "photo-safe", sizes: [] },
      source: "photo",
    }],
  });
  api.enqueueDownloadJob(job, { autoStart: false });

  await api.startDownloadWorker();

  assert.equal(job.status, "completed");
  assert.equal(job.errors.includes("state override leaked"), false);
});

test("auto-started jobs restart after a stopping worker exits", async () => {
  const api = loadTestApi();
  const root = new api.FakeDirectoryHandle("root");
  api.__setStorageForTest(new api.StorageManager(root));
  let releaseActiveDownload;
  let resolveActiveStarted;
  let resolveNextStarted;
  const activeStarted = new Promise((resolve) => {
    resolveActiveStarted = resolve;
  });
  const nextStarted = new Promise((resolve) => {
    resolveNextStarted = resolve;
  });
  const activeGate = new Promise((resolve) => {
    releaseActiveDownload = resolve;
  });
  api.__unsafeWindow.appDownloadManager = {
    async downloadMedia(options) {
      if (options.media.id === "photo-active") {
        resolveActiveStarted();
        await activeGate;
        return new Blob(["active"], { type: "image/jpeg" });
      }
      resolveNextStarted();
      return new Blob(["next"], { type: "image/jpeg" });
    },
  };
  const activeJob = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Active", chatId: "active", chatRevision: 1 },
    items: [{
      chatTitle: "Active",
      chatId: "active",
      mid: "1",
      mediaId: "photo-active",
      type: "image",
      originalName: "",
      extension: "jpg",
      mimeType: "image/jpeg",
      size: 4,
      sentAt: new Date(2026, 4, 1, 11, 5, 0),
      media: { _: "photo", id: "photo-active", sizes: [] },
      source: "photo",
    }],
  });
  const nextJob = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Next", chatId: "next", chatRevision: 2 },
    items: [{
      chatTitle: "Next",
      chatId: "next",
      mid: "2",
      mediaId: "photo-next",
      type: "image",
      originalName: "",
      extension: "jpg",
      mimeType: "image/jpeg",
      size: 5,
      sentAt: new Date(2026, 4, 1, 11, 6, 0),
      media: { _: "photo", id: "photo-next", sizes: [] },
      source: "photo",
    }],
  });

  api.enqueueDownloadJob(activeJob, { autoStart: false });
  const stoppingWorker = api.startDownloadWorker();
  await activeStarted;
  api.stopCurrentDownloadJob();
  api.enqueueDownloadJob(nextJob, { autoStart: true });
  releaseActiveDownload();
  await stoppingWorker;
  const restarted = await Promise.race([
    nextStarted.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 25)),
  ]);

  assert.equal(restarted, true);
  assert.equal((await nextJob.completionPromise).status, "completed");
});

test("stopping an active download job preserves pending jobs", () => {
  const api = loadTestApi();
  const active = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Active", chatId: "active", chatRevision: 1 },
    items: [{ mid: "1", type: "image", chatTitle: "Active", chatId: "active" }],
  });
  const pending = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Pending", chatId: "pending", chatRevision: 2 },
    items: [{ mid: "2", type: "image", chatTitle: "Pending", chatId: "pending" }],
  });

  api.__setDownloadQueueForTest({ activeJob: active, pendingJobs: [pending], workerRunning: true });
  api.stopCurrentDownloadJob();

  assert.equal(active.stopRequested, true);
  assert.equal(api.__getDownloadQueueForTest().pendingJobs[0].jobId, pending.jobId);
});

test("stopCurrentTask stops active queued download jobs", () => {
  const api = loadTestApi();
  const active = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Active", chatId: "active", chatRevision: 1 },
    items: [{ mid: "1", type: "image", chatTitle: "Active", chatId: "active" }],
  });
  const pending = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Pending", chatId: "pending", chatRevision: 2 },
    items: [{ mid: "2", type: "image", chatTitle: "Pending", chatId: "pending" }],
  });

  api.__setDownloadQueueForTest({ activeJob: active, pendingJobs: [pending], workerRunning: true });
  api.stopCurrentTask();

  assert.equal(active.stopRequested, true);
  assert.equal(api.__getDownloadQueueForTest().pendingJobs[0].jobId, pending.jobId);
});

test("stopCurrentTask routes to active scan before active download when both overlap", () => {
  const api = loadTestApi();
  const active = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Active", chatId: "active", chatRevision: 1 },
    items: [{ mid: "1", type: "image", chatTitle: "Active", chatId: "active" }],
  });
  const pending = api.createDownloadJob({
    source: "batch",
    chatInfo: { chatTitle: "Pending", chatId: "pending", chatRevision: 2 },
    items: [{ mid: "2", type: "image", chatTitle: "Pending", chatId: "pending" }],
  });

  api.__setStateForTest({ running: true, stopped: false, scan: { active: true, stopped: false } });
  api.__setDownloadQueueForTest({ activeJob: active, pendingJobs: [pending], workerRunning: true });
  api.stopCurrentTask();

  const state = api.__getStateForTest();
  assert.equal(active.stopRequested, false);
  assert.equal(api.__getDownloadQueueForTest().pendingJobs[0].jobId, pending.jobId);
  assert.equal(state.stopped, false);
  assert.equal(state.scan.stopped, true);
});

test("stopCurrentTask reports no active task without changing legacy stopped state", () => {
  const api = loadTestApi();
  api.createPanel();
  api.__setStateForTest({ stopped: false, scan: { active: false, stopped: false } });

  api.stopCurrentTask();

  assert.equal(api.__unsafeWindow.document.querySelector("#tg-wmk-status").textContent, "No active task.");
  assert.equal(api.__getStateForTest().stopped, false);
  assert.equal(api.__getStateForTest().scan.stopped, false);
});

test("StorageManager getExistingFile rethrows non-missing storage errors", async () => {
  const api = loadTestApi();
  const root = new api.FakeDirectoryHandle("root");
  const storage = new api.StorageManager(root);
  const planned = {
    chatDirName: "Chat__peer-1",
    typeDirName: "images",
    fileName: "photo.jpg",
    relativePath: "images/photo.jpg",
  };
  const chatDir = await root.getDirectoryHandle(planned.chatDirName, { create: true });
  await chatDir.getFileHandle(planned.typeDirName, { create: true });

  await assert.rejects(
    () => storage.getExistingFile(planned),
    /images is not a directory/,
  );
});

test("StorageManager readJson falls back only for missing files and rethrows malformed JSON", async () => {
  const api = loadTestApi();
  const root = new api.FakeDirectoryHandle("root");
  const storage = new api.StorageManager(root);
  const fallback = { items: [] };

  assert.deepEqual(await storage.readJson("Chat__peer-1", "_manifest.json", fallback), fallback);

  const chatDir = await root.getDirectoryHandle("Chat__peer-1", { create: true });
  const fileHandle = await chatDir.getFileHandle("_manifest.json", { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(new Blob(["{not json"], { type: "application/json" }));
  await writable.close();

  await assert.rejects(
    () => storage.readJson("Chat__peer-1", "_manifest.json", fallback),
    { name: "SyntaxError" },
  );
});
