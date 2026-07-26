// ==UserScript==
// @name         Telegram WebK Media Downloader
// @namespace    https://github.com/kyangc/tampermonkey_scripts
// @version      0.2.0
// @description  Download Telegram WebK media into a user-selected local directory.
// @author       kyangc
// @license      MIT
// @homepageURL  https://github.com/kyangc/tampermonkey_scripts
// @supportURL   https://github.com/kyangc/tampermonkey_scripts/issues
// @updateURL    https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/telegram-webk-media-downloader.user.js
// @downloadURL  https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/telegram-webk-media-downloader.user.js
// @match        https://web.telegram.org/k/*
// @match        https://webk.telegram.org/*
// @grant        unsafeWindow
// @grant        GM_addStyle
// ==/UserScript==

(function () {
  "use strict";

  const APP = {
    id: "tg-webk-media-downloader",
    testApiKey: "__TG_WEBK_MEDIA_DOWNLOADER_TESTS__",
    debugApiKey: "__TG_WEBK_MEDIA_DOWNLOADER_DEBUG__",
    debugApiVersion: 10,
    panelPositionKey: "tg-webk-media-downloader:panel-position",
    directoryDbName: "tg-webk-media-downloader",
    directoryStoreName: "handles",
    directoryHandleKey: "last-directory",
    directoryPickerId: "tg-webk-media-downloader",
  };
  const IS_TEST_MODE =
    unsafeWindow === window && Boolean(globalThis.__TG_WEBK_MEDIA_DOWNLOADER_TEST_MODE__);

  const SELECTORS = {
    columnCenter: "#column-center",
    bubble: ".bubble",
    peerTitle: ".chat-info .peer-title, .top-header .peer-title, .chat-title, .person .peer-title",
  };

  const state = {
    running: false,
    stopped: false,
    scan: {
      active: false,
      stopped: false,
      chatSnapshot: null,
      counters: { scanned: 0, discovered: 0 },
      status: "Idle",
    },
    downloadQueue: {
      activeJob: null,
      pendingJobs: [],
      completedJobs: [],
      workerRunning: false,
      workerPromise: null,
      restartAfterCurrentWorker: false,
      stopAfterCurrentItem: false,
    },
    legacyTaskToken: null,
    rootHandle: null,
    storage: null,
    currentChat: { chatTitle: "telegram_chat", chatId: "unknown" },
    chatRevision: 0,
    filters: { image: true, video: true, document: true },
    dateCutoff: "",
    dateCutoffReached: false,
    counters: { scanned: 0, discovered: 0, downloaded: 0, skipped: 0, failed: 0, unsupported: 0 },
    debugEvents: [],
  };
  let runDownloadJobForTest = null;
  let scanCurrentChatMessagesForTest = null;

  function isWebK() {
    return window.location.href.includes("webk.telegram.org") || window.location.pathname.includes("/k/");
  }

  function log(message, data) {
    if (data === undefined) console.log(`[TG WebK Media] ${message}`);
    else console.log(`[TG WebK Media] ${message}`, data);
  }

  function sanitizeDebugValue(key, value) {
    const lowerKey = String(key || "").toLowerCase();
    if (
      ["title", "text", "message", "caption", "name", "filename", "handlename", "chatid", "peerid"].includes(lowerKey) ||
      lowerKey.endsWith("title") ||
      lowerKey.endsWith("name")
    ) {
      return value ? "[redacted]" : value;
    }
    if (value === null || value === undefined) return value;
    if (["string", "number", "boolean"].includes(typeof value)) return value;
    if (value && typeof value.getTime === "function") return new Date(value.getTime()).toISOString();
    if (Array.isArray(value)) return `[array:${value.length}]`;
    return "[object]";
  }

  function sanitizeDebugDetail(detail = {}) {
    const clean = {};
    for (const [key, value] of Object.entries(detail || {})) {
      clean[key] = sanitizeDebugValue(key, value);
    }
    return clean;
  }

  function recordDebugEvent(event, detail = {}) {
    state.debugEvents.push({
      at: new Date().toISOString(),
      event: String(event || "event"),
      detail: sanitizeDebugDetail(detail),
    });
    if (state.debugEvents.length > 120) {
      state.debugEvents.splice(0, state.debugEvents.length - 120);
    }
  }

  function getRuntimeDebugCounts() {
    const root = document.querySelector(SELECTORS.columnCenter) || document;
    const bubbles = Array.from(root.querySelectorAll(SELECTORS.bubble));
    return {
      visibleBubbles: bubbles.length,
      downloadableBubbles: bubbles.filter((bubble) =>
        bubble.querySelector(".media-container, .document, video, img.thumbnail, .photo, .document-name, .file-name")
      ).length,
      hoverButtons: root.querySelectorAll(".tg-wmk-hover-download").length,
    };
  }

  function createDebugReport(extraRuntime = {}) {
    const status = document.querySelector("#tg-wmk-status")?.textContent || "";
    const headerStatus = document.querySelector("#tg-wmk-header-status")?.textContent || "";
    const safeUrl = (() => {
      const href = String(window.location.href || "");
      const match = href.match(/^(https?:\/\/[^/#?]+)([^#?]*)/);
      if (match) return `${match[1]}${match[2] || "/"}`;
      return window.location.pathname || "";
    })();
    return {
      appId: APP.id,
      debugApiVersion: APP.debugApiVersion,
      generatedAt: new Date().toISOString(),
      url: safeUrl,
      isWebK: isWebK(),
      currentChat: {
        chatTitle: state.currentChat.chatTitle ? "[redacted]" : "",
        chatTitleLength: String(state.currentChat.chatTitle || "").length,
        chatId: state.currentChat.chatId ? "[redacted]" : "",
        chatIdLength: String(state.currentChat.chatId || "").length,
        chatRevision: state.chatRevision,
      },
      state: {
        running: Boolean(state.scan.active || state.downloadQueue.activeJob || state.downloadQueue.workerRunning),
        stopped: Boolean(state.scan.stopped || state.downloadQueue.stopAfterCurrentItem),
        hasStorage: Boolean(state.storage),
        filters: { ...state.filters },
        dateCutoff: state.dateCutoff,
        dateCutoffReached: state.dateCutoffReached,
        counters: { ...state.counters },
        status: status || headerStatus,
        scan: {
          active: state.scan.active,
          stopped: state.scan.stopped,
          counters: { ...state.scan.counters },
          status: state.scan.status,
        },
        downloadQueue: {
          activeJob: state.downloadQueue.activeJob
            ? {
                jobId: state.downloadQueue.activeJob.jobId,
                chatTitle: "[redacted]",
                itemCount: state.downloadQueue.activeJob.items.length,
                status: state.downloadQueue.activeJob.status,
              }
            : null,
          pendingJobCount: state.downloadQueue.pendingJobs.length,
          completedJobCount: state.downloadQueue.completedJobs.length,
          workerRunning: state.downloadQueue.workerRunning,
        },
      },
      webk: {
        appDownloadManager: Boolean(unsafeWindow.appDownloadManager),
        downloadMedia: typeof unsafeWindow.appDownloadManager?.downloadMedia,
        downloadToDisc: typeof unsafeWindow.appDownloadManager?.downloadToDisc,
        downloadMediaURL: typeof unsafeWindow.appDownloadManager?.downloadMediaURL,
        appImManager: Boolean(unsafeWindow.appImManager),
        currentChat: Boolean(unsafeWindow.appImManager?.chat),
      },
      runtime: {
        ...getRuntimeDebugCounts(),
        ...extraRuntime,
      },
      events: state.debugEvents.slice(-120),
    };
  }

  function installStyles() {
    GM_addStyle(`
      #tg-wmk-panel {
        position: fixed;
        right: 18px;
        bottom: 72px;
        z-index: 99999;
        width: 320px;
        max-width: calc(100vw - 36px);
        color: #fff;
        background: rgba(32, 38, 46, 0.96);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 10px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.35);
        font: 12px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        overflow: hidden;
      }
      #tg-wmk-panel.tg-wmk-dragging {
        user-select: none;
        opacity: 0.94;
      }
      #tg-wmk-panel.tg-wmk-collapsed {
        width: auto;
      }
      #tg-wmk-panel button {
        border: 0;
        border-radius: 7px;
        padding: 7px 9px;
        color: #fff;
        background: #3390ec;
        cursor: pointer;
        font-weight: 650;
      }
      #tg-wmk-panel button:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }
      .tg-wmk-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px;
        background: rgba(255,255,255,0.06);
        cursor: move;
        user-select: none;
        touch-action: none;
      }
      .tg-wmk-header button {
        cursor: pointer;
      }
      .tg-wmk-body {
        display: grid;
        gap: 8px;
        padding: 8px;
      }
      .tg-wmk-row {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .tg-wmk-muted {
        color: rgba(255,255,255,0.68);
      }
      .tg-wmk-stat {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 4px;
      }
      .tg-wmk-stat span {
        padding: 5px;
        border-radius: 6px;
        background: rgba(255,255,255,0.07);
      }
      .tg-wmk-date-input {
        color-scheme: dark;
        max-width: 140px;
      }
      .tg-wmk-hover-anchor {
        overflow: visible !important;
      }
      .tg-wmk-hover-download {
        position: absolute;
        left: calc(100% + 4px);
        right: auto;
        top: 6px;
        width: 28px;
        height: 28px;
        border: 0;
        border-radius: 50%;
        color: white;
        background: rgba(51,144,236,0.92);
        cursor: pointer;
        display: none;
        align-items: center;
        justify-content: center;
        z-index: 5;
        box-shadow: 0 2px 10px rgba(0,0,0,0.26);
      }
      .tg-wmk-hover-download.tg-wmk-hover-download-inside {
        box-shadow: 0 2px 10px rgba(0,0,0,0.36);
      }
      .bubble:hover > .tg-wmk-hover-download,
      .tg-wmk-hover-download:focus {
        display: flex;
      }
    `);
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function sanitizePathSegment(value, fallback = "untitled") {
    const raw = String(value || "").trim();
    const cleaned = raw
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/[\u0000-\u001f]+/g, "")
      .replace(/\s+/g, " ")
      .replace(/^_+|_+$/g, "")
      .replace(/[. ]+$/g, "")
      .trim();
    const reservedName = cleaned.split(".")[0].toLowerCase();
    const isWindowsReservedName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(reservedName);
    if (isWindowsReservedName) return fallback;
    if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
    return cleaned.slice(0, 160);
  }

  function stripExtension(fileName) {
    const clean = sanitizePathSegment(fileName, "");
    const dotIndex = clean.lastIndexOf(".");
    if (dotIndex <= 0) return clean;
    return clean.slice(0, dotIndex);
  }

  function coerceDate(value) {
    if (value && typeof value.getTime === "function") {
      const time = value.getTime();
      if (Number.isFinite(time)) return new Date(time);
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date;
  }

  function formatFileTimestamp(value) {
    const date = coerceDate(value);
    if (!date) {
      return "unknown-time";
    }
    const year = date.getFullYear();
    const month = pad2(date.getMonth() + 1);
    const day = pad2(date.getDate());
    const hour = pad2(date.getHours());
    const minute = pad2(date.getMinutes());
    const second = pad2(date.getSeconds());
    return `${year}${month}${day}_${hour}${minute}${second}`;
  }

  function dateInputToCutoffDate(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return date;
  }

  function messageIsBeforeDateCutoff(message, cutoffDate) {
    if (!cutoffDate) return false;
    const messageDate = messageDateToDate(message?.date);
    return Boolean(messageDate && messageDate.getTime() < cutoffDate.getTime());
  }

  function splitMessagesByDateCutoff(messages, cutoffDate) {
    if (!cutoffDate) return { messages: Array.from(messages || []), reachedCutoff: false };
    const kept = [];
    let reachedCutoff = false;
    for (const message of messages || []) {
      if (messageIsBeforeDateCutoff(message, cutoffDate)) {
        reachedCutoff = true;
      } else {
        kept.push(message);
      }
    }
    return { messages: kept, reachedCutoff };
  }

  function clampNumber(value, min, max) {
    const safeMax = Math.max(min, max);
    return Math.min(Math.max(value, min), safeMax);
  }

  function clampPanelPosition(position, panelSize, viewportSize, margin = 8) {
    const width = Math.max(1, Number(panelSize?.width) || 1);
    const height = Math.max(1, Number(panelSize?.height) || 1);
    const viewportWidth = Math.max(width + margin * 2, Number(viewportSize?.width) || window.innerWidth || width);
    const viewportHeight = Math.max(height + margin * 2, Number(viewportSize?.height) || window.innerHeight || height);
    return {
      left: Math.round(clampNumber(Number(position?.left) || 0, margin, viewportWidth - width - margin)),
      top: Math.round(clampNumber(Number(position?.top) || 0, margin, viewportHeight - height - margin)),
    };
  }

  function positionExpandedPanelNearAnchor(anchorRect, panelSize, viewportSize, margin = 8) {
    const viewportWidth = Math.max(1, Number(viewportSize?.width) || window.innerWidth || 1);
    const viewportHeight = Math.max(1, Number(viewportSize?.height) || window.innerHeight || 1);
    const width = Math.max(1, Number(panelSize?.width) || 1);
    const height = Math.max(1, Number(panelSize?.height) || 1);
    const anchorLeft = Number(anchorRect?.left) || margin;
    const anchorTop = Number(anchorRect?.top) || margin;
    const anchorRight = Number(anchorRect?.right) || anchorLeft;
    const anchorBottom = Number(anchorRect?.bottom) || anchorTop;
    const anchorCenterX = (anchorLeft + anchorRight) / 2;
    const anchorCenterY = (anchorTop + anchorBottom) / 2;
    const left = anchorCenterX > viewportWidth / 2 ? anchorRight - width : anchorLeft;
    const top = anchorCenterY > viewportHeight / 2 ? anchorBottom - height : anchorTop;
    return clampPanelPosition({ left, top }, { width, height }, { width: viewportWidth, height: viewportHeight }, margin);
  }

  function normalizeExtension(extension) {
    const clean = String(extension || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (clean === "jpeg") return "jpg";
    if (clean === "quicktime") return "mov";
    if (clean) return clean;
    return "bin";
  }

  function extensionFromName(fileName) {
    const clean = String(fileName || "");
    const dotIndex = clean.lastIndexOf(".");
    if (dotIndex < 0 || dotIndex === clean.length - 1) return "";
    return normalizeExtension(clean.slice(dotIndex + 1));
  }

  function inferMediaKind({ mimeType = "", originalName = "" } = {}) {
    const mime = String(mimeType || "").toLowerCase();
    const ext = extensionFromName(originalName);
    if (mime.startsWith("image/") || ["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) return "image";
    if (mime.startsWith("video/") || ["mp4", "mov", "m4v", "webm", "mkv", "avi"].includes(ext)) return "video";
    return "document";
  }

  function typeDirName(type) {
    if (type === "image") return "images";
    if (type === "video") return "videos";
    return "documents";
  }

  function chatDirName(chatTitle, chatId) {
    const maxLength = 240;
    const chatName = sanitizePathSegment(chatTitle, "telegram_chat");
    const peerId = sanitizePathSegment(chatId || "unknown", "unknown");
    const suffix = `__peer-${peerId}`;
    const availableNameLength = Math.max(1, maxLength - suffix.length);
    return `${chatName.slice(0, availableNameLength)}${suffix}`.slice(0, maxLength);
  }

  function planMediaPath(item) {
    const dirChatName = chatDirName(item.chatTitle, item.chatId);
    const dirName = typeDirName(item.type);
    const timestamp = formatFileTimestamp(item.sentAt);
    const mid = sanitizePathSegment(item.mid || "unknown", "unknown");
    const type = sanitizePathSegment(item.type || "document", "document");
    const ext = normalizeExtension(item.extension || extensionFromName(item.originalName));
    const baseName = stripExtension(item.originalName) || sanitizePathSegment(item.mediaId || "media", "media");
    const parts = [`${timestamp}_mid-${mid}`];
    if (item.groupedId) parts.push(`gid-${sanitizePathSegment(item.groupedId, "group")}`);
    if (item.groupedId && item.groupIndex !== undefined && item.groupIndex !== null) parts.push(`idx-${pad2(item.groupIndex)}`);
    parts.push(type, baseName);
    const fileName = `${parts.join("_")}.${ext}`;
    return {
      chatDirName: dirChatName,
      typeDirName: dirName,
      fileName,
      relativePath: `${dirName}/${fileName}`,
    };
  }

  function reportChatDirNameForRun(items, fallbackChat) {
    const firstItem = (items || []).find(Boolean);
    const chatInfo = firstItem || fallbackChat || {};
    return chatDirName(chatInfo.chatTitle, chatInfo.chatId);
  }

  function shouldSkipExistingFile(existingFile, expectedSize) {
    if (!existingFile) return { skip: false, reason: "missing" };
    if (typeof expectedSize !== "number" || expectedSize <= 0) {
      return { skip: true, reason: "exists-size-unknown" };
    }
    if (existingFile.size === expectedSize) return { skip: true, reason: "size-match" };
    return { skip: false, reason: "size-mismatch" };
  }

  function messageDateToDate(value) {
    if (value && typeof value.getTime === "function") {
      const time = value.getTime();
      if (Number.isFinite(time)) return new Date(time);
    }
    if (typeof value === "number") {
      const millis = value > 100000000000 ? value : value * 1000;
      return new Date(millis);
    }
    return null;
  }

  function extractMediaFromMessage(message) {
    if (!message || !message.media) return [];
    const media = message.media;
    const result = [];
    if (media.photo) {
      result.push({
        media: media.photo,
        source: "photo",
        originalName: "",
        mimeType: media.photo.mime_type || media.photo.mimeType || "image/jpeg",
        extension: "jpg",
      });
    }
    if (media.document) {
      const documentMedia = media.document;
      const originalName = documentMedia.file_name || documentMedia.fileName || "";
      const mimeType = documentMedia.mime_type || documentMedia.mimeType || "";
      result.push({
        media: documentMedia,
        source: "document",
        originalName,
        mimeType,
        extension: extensionFromName(originalName) || normalizeExtension(mimeType.split("/")[1] || ""),
      });
    }
    return result;
  }

  function extractMediaItems(messages, chatInfo) {
    const groupCounters = new Map();
    const items = [];
    for (const message of messages || []) {
      const mid = String(message.mid || message.id || "");
      const groupedId = message.grouped_id ? String(message.grouped_id) : "";
      let groupIndex = 0;
      if (groupedId) {
        groupIndex = (groupCounters.get(groupedId) || 0) + 1;
        groupCounters.set(groupedId, groupIndex);
      }
      for (const entry of extractMediaFromMessage(message)) {
        const dcId = entry.media.dc_id || entry.media.dcId || "";
        const fallbackMediaId = dcId ? `${mid}-${entry.source}-${dcId}` : `${mid}-${entry.source}`;
        const mediaId = String(entry.media.id || fallbackMediaId);
        const type = inferMediaKind({ mimeType: entry.mimeType, originalName: entry.originalName });
        const downloadContext = captureDownloadContext();
        items.push({
          chatId: String(chatInfo.chatId || "unknown"),
          chatTitle: chatInfo.chatTitle || "telegram_chat",
          mid,
          groupedId,
          groupIndex,
          mediaId,
          type,
          originalName: entry.originalName,
          extension: entry.extension,
          mimeType: entry.mimeType,
          size: entry.media.size,
          sentAt: messageDateToDate(message.date),
          media: entry.media,
          source: entry.source,
          downloadContext,
        });
      }
    }
    return items;
  }

  class FakeFileHandle {
    constructor(name, blob = new Blob([])) {
      this.kind = "file";
      this.name = name;
      this.blob = blob;
    }

    async getFile() {
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
      return new FileCtor([this.blob], this.name, { type: this.blob.type || "application/octet-stream" });
    }

    async createWritable() {
      const handle = this;
      const chunks = [];
      return {
        async write(value) {
          chunks.push(value instanceof Blob ? value : new Blob([value]));
        },
        async close() {
          handle.blob = new Blob(chunks);
        },
      };
    }
  }

  class FakeDirectoryHandle {
    constructor(name) {
      this.kind = "directory";
      this.name = name;
      this.entries = new Map();
      this.children = this.entries;
    }

    async getDirectoryHandle(name, options = {}) {
      if (this.entries.has(name)) {
        const existing = this.entries.get(name);
        if (existing.kind !== "directory") throw new Error(`${name} is not a directory`);
        return existing;
      }
      if (!options.create) throw new DOMException("Directory not found", "NotFoundError");
      const dir = new FakeDirectoryHandle(name);
      this.entries.set(name, dir);
      return dir;
    }

    async getFileHandle(name, options = {}) {
      if (this.entries.has(name)) {
        const existing = this.entries.get(name);
        if (existing.kind !== "file") throw new Error(`${name} is not a file`);
        return existing;
      }
      if (!options.create) throw new DOMException("File not found", "NotFoundError");
      const file = new FakeFileHandle(name);
      this.entries.set(name, file);
      return file;
    }
  }

  class StorageManager {
    constructor(rootHandle) {
      this.rootHandle = rootHandle;
    }

    async getChatDirectory(chatDirName, create = true) {
      return this.rootHandle.getDirectoryHandle(chatDirName, { create });
    }

    async getTypeDirectory(planned, create = true) {
      const chatDir = await this.getChatDirectory(planned.chatDirName, create);
      return chatDir.getDirectoryHandle(planned.typeDirName, { create });
    }

    async getExistingFile(planned) {
      try {
        const typeDir = await this.getTypeDirectory(planned, false);
        const fileHandle = await typeDir.getFileHandle(planned.fileName, { create: false });
        return fileHandle.getFile();
      } catch (error) {
        if (error && error.name === "NotFoundError") return null;
        throw error;
      }
    }

    async writePlannedFile(planned, blob) {
      const typeDir = await this.getTypeDirectory(planned, true);
      const fileHandle = await typeDir.getFileHandle(planned.fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      return fileHandle.getFile();
    }

    async readJson(chatDirName, fileName, fallback) {
      try {
        const chatDir = await this.getChatDirectory(chatDirName, false);
        const fileHandle = await chatDir.getFileHandle(fileName, { create: false });
        const file = await fileHandle.getFile();
        return JSON.parse(await file.text());
      } catch (error) {
        if (error && error.name === "NotFoundError") return fallback;
        throw error;
      }
    }

    async writeJson(chatDirName, fileName, value) {
      const chatDir = await this.getChatDirectory(chatDirName, true);
      const fileHandle = await chatDir.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
      await writable.close();
    }

    async upsertManifest(chatDirName, items) {
      const manifest = await this.readJson(chatDirName, "_manifest.json", { items: [] });
      const byPath = new Map(manifest.items.map((item) => [item.relativePath, item]));
      for (const item of items) byPath.set(item.relativePath, { ...byPath.get(item.relativePath), ...item });
      manifest.items = Array.from(byPath.values());
      await this.writeJson(chatDirName, "_manifest.json", manifest);
      return manifest;
    }
  }

  function resetCounters() {
    state.counters = { scanned: 0, discovered: 0, downloaded: 0, skipped: 0, failed: 0, unsupported: 0 };
  }

  function mirrorDownloadJobCounters(job) {
    state.counters = {
      ...state.counters,
      discovered: job.counters.discovered,
      downloaded: job.counters.downloaded,
      skipped: job.counters.skipped,
      failed: job.counters.failed,
      unsupported: job.counters.unsupported,
    };
  }

  function hasEnabledMediaFilter(filters = state.filters) {
    return ["image", "video", "document"].some((type) => Boolean(filters?.[type]));
  }

  function getStartSettingsBlocker({ hasStorage = Boolean(state.storage), filters = state.filters } = {}) {
    if (!hasStorage) return "Choose a download directory first.";
    if (!hasEnabledMediaFilter(filters)) return "Enable at least one media type.";
    return "";
  }

  function getScanStartBlocker({
    scanActive = state.scan.active,
    hasStorage = Boolean(state.storage),
    filters = state.filters,
  } = {}) {
    if (scanActive) return "A scan is already running.";
    return getStartSettingsBlocker({ hasStorage, filters });
  }

  function getActionAvailability({
    hasStorage = Boolean(state.storage),
    filters = state.filters,
    scanActive = state.scan.active,
    activeDownload = Boolean(state.downloadQueue.activeJob),
  } = {}) {
    void activeDownload;
    const settingsBlocker = getStartSettingsBlocker({ hasStorage, filters });
    const scanBlocker = settingsBlocker || getScanStartBlocker({ scanActive, hasStorage, filters });
    const hoverBlocker = settingsBlocker || (scanActive ? "A scan is already running." : "");
    return {
      batchDisabled: Boolean(scanBlocker),
      batchTitle: scanBlocker || "Batch Download Current Chat",
      hoverDisabled: Boolean(hoverBlocker),
      hoverTitle: hoverBlocker || "Download media from this message",
    };
  }

  function beginScanTask({
    chatSnapshot = captureChatSnapshot(),
    hasStorage = Boolean(state.storage),
    filters = state.filters,
  } = {}) {
    const blocker = getScanStartBlocker({ scanActive: state.scan.active, hasStorage, filters });
    if (blocker) {
      updatePanelStatus(blocker);
      return { ok: false, message: blocker };
    }
    state.scan.active = true;
    state.scan.stopped = false;
    state.scan.chatSnapshot = chatSnapshot;
    state.scan.counters = { scanned: 0, discovered: 0 };
    state.scan.status = "Scanning current chat.";
    syncLegacyStopButton();
    return { ok: true, chatSnapshot };
  }

  function stopCurrentScanTask() {
    if (!state.scan.active) {
      updatePanelStatus("No active scan.");
      return;
    }
    state.scan.stopped = true;
    recordDebugEvent("scan-stop-requested");
    updatePanelStatus("Stopping scan.");
  }

  function finishScanTask(items, { autoStart = true, source = "batch" } = {}) {
    const scanSnapshot = state.scan.chatSnapshot;
    const queueItems = Array.isArray(items) ? items : [];
    state.scan.counters.discovered = queueItems.length;
    state.scan.active = false;
    state.scan.stopped = false;
    state.scan.status = "Idle";
    state.scan.chatSnapshot = null;
    syncLegacyStopButton();
    if (!queueItems.length) {
      updatePanelStatus("No supported media found.");
      return false;
    }
    const job = createDownloadJob({ source, chatInfo: scanSnapshot || state.currentChat, items: queueItems });
    return enqueueDownloadJob(job, { autoStart });
  }

  function nextJobId() {
    state.nextJobId = (state.nextJobId || 0) + 1;
    return `job-${Date.now()}-${state.nextJobId}`;
  }

  function cloneJobItems(items) {
    return (items || []).map((item) => ({
      ...item,
      downloadContext: item.downloadContext ? { ...item.downloadContext } : undefined,
    }));
  }

  function createJobCompletion() {
    let resolveCompletion = () => {};
    let rejectCompletion = () => {};
    const completionPromise = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    return { completionPromise, resolveCompletion, rejectCompletion, completionSettled: false };
  }

  function createDownloadJob({ source = "batch", chatInfo = state.currentChat, items = [] } = {}) {
    const normalizedItems = cloneJobItems(items);
    return {
      jobId: nextJobId(),
      source,
      chatInfo: {
        chatTitle: chatInfo.chatTitle || "telegram_chat",
        chatId: String(chatInfo.chatId || "unknown"),
        chatRevisionAtScanStart: chatInfo.chatRevision ?? state.chatRevision,
      },
      createdAt: new Date().toISOString(),
      status: "pending",
      counters: {
        total: normalizedItems.length,
        discovered: normalizedItems.length,
        downloaded: 0,
        skipped: 0,
        failed: 0,
        unsupported: 0,
      },
      items: normalizedItems,
      currentItem: null,
      errors: [],
      stopRequested: false,
      ...createJobCompletion(),
    };
  }

  function errorMessageFrom(reason, fallback = "Unexpected download worker error.") {
    if (reason && typeof reason === "object" && reason.message) return String(reason.message);
    if (reason === undefined || reason === null || reason === "") return fallback;
    return String(reason);
  }

  function errorFromReason(reason, fallback = "Unexpected download worker error.") {
    if (reason instanceof Error) return reason;
    const error = new Error(errorMessageFrom(reason, fallback));
    error.cause = reason;
    return error;
  }

  function settleDownloadJob(job, error = null) {
    if (!job || job.completionSettled) return;
    const hasError = arguments.length >= 2;
    job.completionSettled = true;
    const resolveCompletion = job.resolveCompletion;
    const rejectCompletion = job.rejectCompletion;
    job.resolveCompletion = null;
    job.rejectCompletion = null;
    if (hasError && typeof rejectCompletion === "function") rejectCompletion(error);
    else if (typeof resolveCompletion === "function") resolveCompletion(job);
  }

  function observeDownloadJobCompletion(job) {
    if (!job || !job.completionPromise || job.completionObserved) return;
    job.completionObserved = true;
    job.completionPromise.catch((error) => {
      recordDebugEvent("queue-job-completion-rejected", {
        jobId: job.jobId,
        error: errorMessageFrom(error),
      });
    });
  }

  function startDownloadWorker({ restartIfStopping = false } = {}) {
    if (state.downloadQueue.workerPromise) {
      if (restartIfStopping && state.downloadQueue.stopAfterCurrentItem) {
        state.downloadQueue.restartAfterCurrentWorker = true;
      }
      return state.downloadQueue.workerPromise;
    }
    if (!state.storage) {
      updatePanelStatus("Choose a download directory first.");
      return Promise.resolve();
    }
    state.downloadQueue.workerPromise = (async () => {
      state.downloadQueue.workerRunning = true;
      state.downloadQueue.stopAfterCurrentItem = false;
      state.downloadQueue.restartAfterCurrentWorker = false;
      syncLegacyStopButton();
      try {
        while (!state.downloadQueue.stopAfterCurrentItem) {
          const job = dequeueNextDownloadJob();
          if (!job) break;
          state.downloadQueue.activeJob = job;
          updateDownloadActionAvailability();
          let stopWorker = false;
          try {
            const runJob = IS_TEST_MODE && runDownloadJobForTest ? runDownloadJobForTest : runDownloadJob;
            await runJob(job);
          } catch (reason) {
            const error = errorFromReason(reason);
            const message = error.message;
            job.status = "failed";
            job.counters.failed += 1;
            mirrorDownloadJobCounters(job);
            job.errors.push(message);
            settleDownloadJob(job, error);
            recordDebugEvent("queue-job-worker-error", { jobId: job.jobId, error: message });
            log("Download worker job failed unexpectedly.", { error: message });
            stopWorker = true;
          } finally {
            state.downloadQueue.completedJobs.push(job);
            state.downloadQueue.activeJob = null;
            updateDownloadActionAvailability();
          }
          if (stopWorker || job.status === "stopped") break;
        }
      } finally {
        const shouldRestart = Boolean(
          state.downloadQueue.restartAfterCurrentWorker &&
          state.downloadQueue.pendingJobs.length &&
          state.storage
        );
        state.downloadQueue.activeJob = null;
        state.downloadQueue.workerRunning = false;
        state.downloadQueue.workerPromise = null;
        state.downloadQueue.restartAfterCurrentWorker = false;
        syncLegacyStopButton();
        if (state.downloadQueue.activeJob || state.downloadQueue.pendingJobs.length) {
          updatePanelStatus(renderQueueStatus());
        }
        if (shouldRestart) startDownloadWorker();
      }
    })();
    return state.downloadQueue.workerPromise;
  }

  function enqueueDownloadJob(job, { autoStart = true } = {}) {
    observeDownloadJobCompletion(job);
    if (!job || !Array.isArray(job.items) || !job.items.length) {
      const message = "No supported media found.";
      if (job) {
        job.status = "failed";
        if (Array.isArray(job.errors)) job.errors.push(message);
        settleDownloadJob(job, new Error(message));
      }
      updatePanelStatus(message);
      return false;
    }
    state.downloadQueue.pendingJobs.push(job);
    updatePanelStatus(`Queued ${job.items.length} media from ${job.chatInfo.chatTitle}.`);
    updateDownloadActionAvailability();
    if (autoStart) startDownloadWorker({ restartIfStopping: true });
    return true;
  }

  function dequeueNextDownloadJob() {
    const job = state.downloadQueue.pendingJobs.shift() || null;
    updateDownloadActionAvailability();
    return job;
  }

  function getDownloadQueueSnapshot() {
    return {
      activeJob: state.downloadQueue.activeJob,
      pendingJobs: [...state.downloadQueue.pendingJobs],
      completedJobs: [...state.downloadQueue.completedJobs],
      workerRunning: state.downloadQueue.workerRunning,
    };
  }

  function setDownloadQueueForTest(nextQueue = {}) {
    state.downloadQueue = {
      ...state.downloadQueue,
      ...nextQueue,
      completedJobs: nextQueue.completedJobs || state.downloadQueue.completedJobs || [],
      stopAfterCurrentItem: nextQueue.stopAfterCurrentItem || false,
    };
    updateDownloadActionAvailability();
  }

  function getStateForTest() {
    return {
      running: state.running,
      stopped: state.stopped,
      legacyTaskToken: state.legacyTaskToken,
      scan: { ...state.scan },
      counters: { ...state.counters },
    };
  }

  function setStateForTest(nextState = {}) {
    if (Object.prototype.hasOwnProperty.call(nextState, "running")) state.running = Boolean(nextState.running);
    if (Object.prototype.hasOwnProperty.call(nextState, "stopped")) state.stopped = Boolean(nextState.stopped);
    if (Object.prototype.hasOwnProperty.call(nextState, "legacyTaskToken")) {
      state.legacyTaskToken = nextState.legacyTaskToken;
    }
    if (nextState.scan) state.scan = { ...state.scan, ...nextState.scan };
    if (nextState.counters) state.counters = { ...state.counters, ...nextState.counters };
  }

  function setRunDownloadJobForTest(runJob) {
    if (!IS_TEST_MODE) return;
    runDownloadJobForTest = typeof runJob === "function" ? runJob : null;
  }

  function setScanCurrentChatMessagesForTest(scanMessages) {
    if (!IS_TEST_MODE) return;
    scanCurrentChatMessagesForTest = typeof scanMessages === "function" ? scanMessages : null;
  }

  function setStorageForTest(storage) {
    state.storage = storage || null;
    state.rootHandle = storage?.rootHandle || null;
  }

  function stopCurrentDownloadJob() {
    const job = state.downloadQueue.activeJob;
    if (!job) {
      updatePanelStatus("No active download.");
      return;
    }
    job.stopRequested = true;
    state.downloadQueue.stopAfterCurrentItem = true;
    recordDebugEvent("download-stop-requested", { jobId: job.jobId });
    updatePanelStatus("Stopping download after current item.");
  }

  function nextLegacyTaskToken() {
    state.nextLegacyTaskToken = (state.nextLegacyTaskToken || 0) + 1;
    return `legacy-${Date.now()}-${state.nextLegacyTaskToken}`;
  }

  function beginLegacyScanTask() {
    const token = nextLegacyTaskToken();
    state.legacyTaskToken = token;
    state.running = true;
    state.stopped = false;
    syncLegacyStopButton();
    return token;
  }

  function clearLegacyScanTask(token) {
    if (state.legacyTaskToken !== token) return false;
    state.running = false;
    state.legacyTaskToken = null;
    syncLegacyStopButton();
    return true;
  }

  function hasActiveScanTask() {
    return Boolean(state.scan.active);
  }

  function hasActiveDownloadTask() {
    return Boolean(state.downloadQueue.activeJob || state.downloadQueue.workerRunning);
  }

  function setLegacyStopButtonEnabled(enabled) {
    const legacyStop = document.querySelector("#tg-wmk-stop");
    if (legacyStop) {
      if (enabled) legacyStop.removeAttribute("disabled");
      else legacyStop.setAttribute("disabled", "disabled");
    }
    updateDownloadActionAvailability();
  }

  function syncLegacyStopButton() {
    setLegacyStopButtonEnabled(hasActiveScanTask() || hasActiveDownloadTask());
  }

  function updatePanelStatus(message) {
    const status = document.querySelector("#tg-wmk-status");
    if (status) status.textContent = message;
    const headerStatus = document.querySelector("#tg-wmk-header-status");
    if (headerStatus) headerStatus.textContent = message;
    recordDebugEvent("status", { message });
    const stats = document.querySelector("#tg-wmk-stats");
    if (stats) {
      stats.innerHTML = `
        <span>Scan ${state.counters.scanned}</span>
        <span>Found ${state.counters.discovered}</span>
        <span>Done ${state.counters.downloaded}</span>
        <span>Skip ${state.counters.skipped}</span>
        <span>Fail ${state.counters.failed}</span>
        <span>Unsup ${state.counters.unsupported}</span>
      `;
    }
    updatePanelDetails();
  }

  function renderPendingQueueSummary() {
    const jobs = state.downloadQueue.pendingJobs;
    if (!jobs.length) return "Queue: empty";
    const summary = jobs
      .slice(0, 3)
      .map((job) => `${job.chatInfo.chatTitle} ${job.items.length} items`)
      .join("; ");
    return `Queue: ${summary}${jobs.length > 3 ? `; +${jobs.length - 3} more` : ""}`;
  }

  function applyHoverButtonAvailability(button, availability = getActionAvailability()) {
    if (!button) return;
    button.disabled = availability.hoverDisabled;
    button.title = availability.hoverTitle;
  }

  function updatePanelControls() {
    const availability = getActionAvailability();
    const batchButton = document.querySelector("#tg-wmk-batch");
    if (batchButton) {
      batchButton.disabled = availability.batchDisabled;
      batchButton.title = availability.batchTitle;
    }
    document.querySelectorAll(".tg-wmk-hover-download").forEach((button) => {
      applyHoverButtonAvailability(button, availability);
    });
    const stopScan = document.querySelector("#tg-wmk-stop-scan");
    if (stopScan) {
      stopScan.disabled = !state.scan.active;
      stopScan.title = state.scan.active ? "Stop Scan" : "No active scan.";
    }
    const stopDownload = document.querySelector("#tg-wmk-stop-download");
    if (stopDownload) {
      stopDownload.disabled = !state.downloadQueue.activeJob;
      stopDownload.title = state.downloadQueue.activeJob ? "Stop Download" : "No active download.";
    }
  }

  function activeDownloadFileName(job) {
    if (!job?.currentItem) return "";
    try {
      return planMediaPath(job.currentItem).fileName;
    } catch (error) {
      return job.currentItem.originalName || job.currentItem.mediaId || job.currentItem.mid || "current item";
    }
  }

  function updatePanelDetails() {
    const scan = document.querySelector("#tg-wmk-scan-status");
    if (scan) {
      scan.textContent = state.scan.active
        ? `Scanning: ${state.scan.chatSnapshot?.chatTitle || "current chat"}, ${state.scan.counters.scanned} messages, ${state.scan.counters.discovered} media`
        : "Scan: idle";
    }
    const download = document.querySelector("#tg-wmk-download-status");
    if (download) {
      const job = state.downloadQueue.activeJob;
      const processed = job
        ? job.counters.downloaded + job.counters.skipped + job.counters.failed + job.counters.unsupported
        : 0;
      const fileName = activeDownloadFileName(job);
      download.textContent = job
        ? `Downloading: ${job.chatInfo.chatTitle}, ${processed}/${job.counters.total}${fileName ? `, ${fileName}` : ""}`
        : "Download: idle";
    }
    const queue = document.querySelector("#tg-wmk-queue-status");
    if (queue) queue.textContent = renderPendingQueueSummary();
  }

  function updateDownloadActionAvailability() {
    updatePanelControls();
    updatePanelDetails();
  }

  function renderQueueStatus() {
    const active = state.downloadQueue.activeJob;
    if (active) {
      return `Downloading: ${active.chatInfo.chatTitle} ${active.counters.downloaded + active.counters.skipped + active.counters.failed + active.counters.unsupported}/${active.counters.total}`;
    }
    const pending = state.downloadQueue.pendingJobs.length;
    if (pending) return `Queued ${pending} job${pending === 1 ? "" : "s"}.`;
    return "Ready";
  }

  function getViewportSize() {
    return {
      width: window.innerWidth || document.documentElement?.clientWidth || 1024,
      height: window.innerHeight || document.documentElement?.clientHeight || 768,
    };
  }

  function getPanelSize(panel) {
    const rect = panel.getBoundingClientRect();
    return {
      width: rect.width || panel.offsetWidth || 320,
      height: rect.height || panel.offsetHeight || 80,
    };
  }

  function loadPanelPosition() {
    try {
      const value = window.localStorage?.getItem(APP.panelPositionKey);
      if (!value) return null;
      const parsed = JSON.parse(value);
      if (!Number.isFinite(parsed?.left) || !Number.isFinite(parsed?.top)) return null;
      return { left: parsed.left, top: parsed.top };
    } catch (error) {
      recordDebugEvent("panel-position-load-failed", { error: error.message || String(error) });
      return null;
    }
  }

  function savePanelPosition(position) {
    try {
      window.localStorage?.setItem(APP.panelPositionKey, JSON.stringify(position));
    } catch (error) {
      recordDebugEvent("panel-position-save-failed", { error: error.message || String(error) });
    }
  }

  function applyPanelPosition(panel, position) {
    const clamped = clampPanelPosition(position, getPanelSize(panel), getViewportSize());
    panel.style.left = `${clamped.left}px`;
    panel.style.top = `${clamped.top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    return clamped;
  }

  function getPanelRectPosition(panel) {
    const rect = panel.getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  }

  function saveCurrentPanelPosition(panel, position) {
    const clamped = applyPanelPosition(panel, position);
    panel.__tgWmkCollapsedPosition = clamped;
    savePanelPosition(clamped);
    return clamped;
  }

  function restorePanelPosition(panel) {
    const position = loadPanelPosition();
    if (position) panel.__tgWmkCollapsedPosition = applyPanelPosition(panel, position);
  }

  function setPanelExpanded(panel, expanded) {
    const body = panel.querySelector(".tg-wmk-body");
    const toggle = panel.querySelector("#tg-wmk-toggle");
    if (!body || !toggle) return;
    if (expanded) {
      const anchorRect = panel.getBoundingClientRect();
      panel.__tgWmkCollapsedPosition = { left: anchorRect.left, top: anchorRect.top };
      panel.classList.remove("tg-wmk-collapsed");
      body.style.display = "grid";
      toggle.textContent = "−";
      applyPanelPosition(panel, positionExpandedPanelNearAnchor(anchorRect, getPanelSize(panel), getViewportSize()));
    } else {
      body.style.display = "none";
      panel.classList.add("tg-wmk-collapsed");
      toggle.textContent = "+";
      saveCurrentPanelPosition(panel, panel.__tgWmkCollapsedPosition || getPanelRectPosition(panel));
    }
  }

  function makePanelDraggable(panel) {
    const header = panel.querySelector(".tg-wmk-header");
    if (!header) return;
    let drag = null;

    header.addEventListener("pointerdown", (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      if (event.target?.closest?.("button, input, label, a")) return;
      const rect = panel.getBoundingClientRect();
      drag = {
        startX: event.clientX,
        startY: event.clientY,
        left: rect.left,
        top: rect.top,
        moved: false,
      };
      panel.classList.add("tg-wmk-dragging");
      event.preventDefault();
    });

    document.addEventListener("pointermove", (event) => {
      if (!drag) return;
      const next = applyPanelPosition(panel, {
        left: drag.left + event.clientX - drag.startX,
        top: drag.top + event.clientY - drag.startY,
      });
      drag.moved = drag.moved || Math.abs(event.clientX - drag.startX) > 2 || Math.abs(event.clientY - drag.startY) > 2;
      if (drag.moved) {
        panel.__tgWmkCollapsedPosition = next;
        savePanelPosition(next);
      }
      event.preventDefault();
    });

    document.addEventListener("pointerup", () => {
      if (!drag) return;
      panel.classList.remove("tg-wmk-dragging");
      const rect = panel.getBoundingClientRect();
      saveCurrentPanelPosition(panel, { left: rect.left, top: rect.top });
      drag = null;
    });

    window.addEventListener?.("resize", () => {
      saveCurrentPanelPosition(panel, getPanelRectPosition(panel));
    });
  }

  function createPanel() {
    if (document.querySelector("#tg-wmk-panel")) return;
    const panel = document.createElement("div");
    panel.id = "tg-wmk-panel";
    panel.className = "tg-wmk-collapsed";
    panel.innerHTML = `
      <div class="tg-wmk-header">
        <strong>WebK Media</strong>
        <span class="tg-wmk-muted" id="tg-wmk-header-status">Ready</span>
        <button id="tg-wmk-toggle" title="Collapse or expand">+</button>
      </div>
      <div class="tg-wmk-body" style="display: none;">
        <div class="tg-wmk-muted" id="tg-wmk-chat">Chat: unknown</div>
        <div class="tg-wmk-row">
          <button id="tg-wmk-choose-dir">Choose Directory</button>
          <span class="tg-wmk-muted" id="tg-wmk-dir">No directory</span>
        </div>
        <div class="tg-wmk-row">
          <label><input type="checkbox" data-tg-wmk-filter="image" checked> Images</label>
          <label><input type="checkbox" data-tg-wmk-filter="video" checked> Videos</label>
          <label><input type="checkbox" data-tg-wmk-filter="document" checked> Documents</label>
        </div>
        <div class="tg-wmk-row">
          <label>Stop before <input class="tg-wmk-date-input" id="tg-wmk-before-date" type="date"></label>
          <button id="tg-wmk-clear-date" title="Clear date limit">Clear</button>
        </div>
        <div class="tg-wmk-row">
          <button id="tg-wmk-batch">Batch Download Current Chat</button>
          <button id="tg-wmk-stop-scan" disabled>Stop Scan</button>
          <button id="tg-wmk-stop-download" disabled>Stop Download</button>
        </div>
        <div class="tg-wmk-row">
          <button id="tg-wmk-copy-debug">Copy Debug Report</button>
        </div>
        <div id="tg-wmk-stats" class="tg-wmk-stat"></div>
        <div class="tg-wmk-muted" id="tg-wmk-status">Ready</div>
        <div class="tg-wmk-muted" id="tg-wmk-scan-status">Scan: idle</div>
        <div class="tg-wmk-muted" id="tg-wmk-download-status">Download: idle</div>
        <div class="tg-wmk-muted" id="tg-wmk-queue-status">Queue: empty</div>
      </div>
    `;
    document.body.appendChild(panel);
    panel.querySelector("#tg-wmk-toggle").addEventListener("click", () => {
      const body = panel.querySelector(".tg-wmk-body");
      const hidden = body.style.display === "none";
      setPanelExpanded(panel, hidden);
    });
    panel.querySelector("#tg-wmk-choose-dir").addEventListener("click", chooseDirectory);
    panel.querySelector("#tg-wmk-stop-scan").addEventListener("click", stopCurrentScanTask);
    panel.querySelector("#tg-wmk-stop-download").addEventListener("click", stopCurrentDownloadJob);
    panel.querySelector("#tg-wmk-batch").addEventListener("click", () => startBatchDownload());
    panel.querySelector("#tg-wmk-copy-debug").addEventListener("click", copyDebugReport);
    panel.querySelectorAll("[data-tg-wmk-filter]").forEach((input) => {
      input.addEventListener("change", () => {
        const filter = input.getAttribute("data-tg-wmk-filter");
        state.filters[filter] = input.checked;
        updateDownloadActionAvailability();
      });
    });
    panel.querySelector("#tg-wmk-before-date").addEventListener("change", (event) => {
      state.dateCutoff = event.target.value || "";
      state.dateCutoffReached = false;
      recordDebugEvent("date-cutoff-changed", { value: state.dateCutoff });
      updatePanelStatus(state.dateCutoff ? `Date limit: ${state.dateCutoff}` : "Date limit cleared.");
    });
    panel.querySelector("#tg-wmk-clear-date").addEventListener("click", () => {
      state.dateCutoff = "";
      state.dateCutoffReached = false;
      panel.querySelector("#tg-wmk-before-date").value = "";
      recordDebugEvent("date-cutoff-cleared");
      updatePanelStatus("Date limit cleared.");
    });
    restorePanelPosition(panel);
    makePanelDraggable(panel);
    updatePanelStatus("Ready");
    updateDownloadActionAvailability();
  }

  async function copyDebugReport() {
    const reportText = JSON.stringify(createDebugReport(), null, 2);
    try {
      await navigator.clipboard.writeText(reportText);
      recordDebugEvent("debug-report-copied");
      updatePanelStatus("Debug report copied.");
    } catch (error) {
      recordDebugEvent("debug-report-copy-failed", { error: error.message || String(error) });
      log("Debug report copy failed.", createDebugReport());
      updatePanelStatus("Debug report copy failed; see console.");
    }
  }

  function clearSelectedDirectory() {
    state.rootHandle = null;
    state.storage = null;
    const dirLabel = document.querySelector("#tg-wmk-dir");
    if (dirLabel) dirLabel.textContent = "No directory";
    updateDownloadActionAvailability();
  }

  function idbRequestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
    });
  }

  function idbTransactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed."));
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted."));
    });
  }

  async function openDirectoryHandleDb() {
    const indexedDB = unsafeWindow.indexedDB || window.indexedDB;
    if (!indexedDB) return null;
    const request = indexedDB.open(APP.directoryDbName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(APP.directoryStoreName)) {
        db.createObjectStore(APP.directoryStoreName);
      }
    };
    return idbRequestToPromise(request);
  }

  function canRememberDirectoryHandle(handle) {
    return Boolean(
      handle &&
        handle.kind === "directory" &&
        (typeof handle.queryPermission === "function" || typeof handle.requestPermission === "function")
    );
  }

  async function forgetRememberedDirectoryHandle() {
    try {
      const db = await openDirectoryHandleDb();
      if (!db) return false;
      const transaction = db.transaction(APP.directoryStoreName, "readwrite");
      transaction.objectStore(APP.directoryStoreName).delete(APP.directoryHandleKey);
      await idbTransactionDone(transaction);
      db.close?.();
      recordDebugEvent("directory-memory-cleared");
      return true;
    } catch (error) {
      recordDebugEvent("directory-memory-clear-failed", { error: error.message || String(error) });
      return false;
    }
  }

  async function saveRememberedDirectoryHandle(handle) {
    if (!canRememberDirectoryHandle(handle)) return false;
    try {
      const db = await openDirectoryHandleDb();
      if (!db) return false;
      const transaction = db.transaction(APP.directoryStoreName, "readwrite");
      transaction.objectStore(APP.directoryStoreName).put(handle, APP.directoryHandleKey);
      await idbTransactionDone(transaction);
      db.close?.();
      recordDebugEvent("directory-remembered", { handleName: handle.name || "" });
      return true;
    } catch (error) {
      recordDebugEvent("directory-remember-failed", { error: error.message || String(error) });
      return false;
    }
  }

  async function loadRememberedDirectoryHandle() {
    try {
      const db = await openDirectoryHandleDb();
      if (!db) return null;
      const transaction = db.transaction(APP.directoryStoreName, "readonly");
      const handle = await idbRequestToPromise(transaction.objectStore(APP.directoryStoreName).get(APP.directoryHandleKey));
      db.close?.();
      return handle || null;
    } catch (error) {
      recordDebugEvent("directory-restore-load-failed", { error: error.message || String(error) });
      return null;
    }
  }

  async function hasGrantedDirectoryPermission(handle) {
    if (!handle) return false;
    const options = { mode: "readwrite" };
    if (!handle.queryPermission) return true;
    return (await handle.queryPermission(options)) === "granted";
  }

  async function ensureDirectoryPermission(handle) {
    if (!handle) return false;
    const options = { mode: "readwrite" };
    if ((await handle.queryPermission?.(options)) === "granted") return true;
    if ((await handle.requestPermission?.(options)) === "granted") return true;
    return !handle.queryPermission && !handle.requestPermission;
  }

  async function activateDirectoryHandle(handle, { requestPermission = false, remember = false, status = "Directory ready." } = {}) {
    const allowed = requestPermission ? await ensureDirectoryPermission(handle) : await hasGrantedDirectoryPermission(handle);
    if (!allowed) return false;
    state.rootHandle = handle;
    state.storage = new StorageManager(handle);
    const dirLabel = document.querySelector("#tg-wmk-dir");
    if (dirLabel) dirLabel.textContent = handle.name || "Selected";
    if (remember) await saveRememberedDirectoryHandle(handle);
    recordDebugEvent("directory-ready", { handleName: handle.name || "Selected" });
    updatePanelStatus(status);
    updateDownloadActionAvailability();
    return true;
  }

  async function restoreRememberedDirectory() {
    const handle = await loadRememberedDirectoryHandle();
    if (!handle) return false;
    if (!canRememberDirectoryHandle(handle)) {
      await forgetRememberedDirectoryHandle();
      return false;
    }
    state.rootHandle = handle;
    if (await activateDirectoryHandle(handle, { status: "Directory restored." })) return true;
    const dirLabel = document.querySelector("#tg-wmk-dir");
    if (dirLabel) dirLabel.textContent = `Saved: ${handle.name || "directory"}`;
    recordDebugEvent("directory-restore-needs-permission", { handleName: handle.name || "" });
    updatePanelStatus("Saved directory needs permission.");
    return false;
  }

  async function pickDirectoryHandle() {
    const options = { mode: "readwrite", id: APP.directoryPickerId, startIn: "downloads" };
    try {
      return await unsafeWindow.showDirectoryPicker(options);
    } catch (error) {
      if (error && error.name === "TypeError") {
        return unsafeWindow.showDirectoryPicker({ mode: "readwrite" });
      }
      throw error;
    }
  }

  async function chooseDirectory() {
    if (!unsafeWindow.showDirectoryPicker) {
      recordDebugEvent("directory-unavailable");
      updatePanelStatus("Your browser does not expose showDirectoryPicker on this page.");
      return;
    }
    try {
      if (state.rootHandle && !state.storage) {
        const restored = await activateDirectoryHandle(state.rootHandle, {
          requestPermission: true,
          remember: true,
          status: "Directory restored.",
        });
        if (restored) return;
        state.rootHandle = null;
      }
      const handle = await pickDirectoryHandle();
      const activated = await activateDirectoryHandle(handle, {
        requestPermission: true,
        remember: true,
        status: "Directory ready.",
      });
      if (!activated) {
        clearSelectedDirectory();
        recordDebugEvent("directory-denied", { handleName: handle?.name || "" });
        updatePanelStatus("Directory permission denied.");
      }
    } catch (error) {
      if (error && error.name === "AbortError") {
        recordDebugEvent("directory-canceled");
        updatePanelStatus("Directory selection canceled.");
      }
      else {
        clearSelectedDirectory();
        recordDebugEvent("directory-error", { error: error.message || String(error) });
        updatePanelStatus(`Directory error: ${error.message || error}`);
      }
    }
  }

  function stopCurrentTask() {
    if (state.scan.active) {
      stopCurrentScanTask();
      return;
    }
    if (state.downloadQueue.activeJob) {
      stopCurrentDownloadJob();
      return;
    }
    updatePanelStatus("No active task.");
  }

  function getCurrentChatTitle() {
    const colCenter = document.querySelector(SELECTORS.columnCenter);
    const titleEl = colCenter?.querySelector(SELECTORS.peerTitle) || document.querySelector(SELECTORS.peerTitle);
    return sanitizePathSegment(titleEl ? titleEl.textContent : "telegram_chat", "telegram_chat");
  }

  function normalizePeerIdValue(value) {
    if (value === undefined || value === null) return "";
    if (["string", "number", "bigint"].includes(typeof value)) return String(value);
    if (typeof value.toString === "function" && value.toString !== Object.prototype.toString) return value.toString();
    return "";
  }

  function getCurrentChatId() {
    const chat = unsafeWindow.appImManager?.chat;
    const peerId = [
      chat?.peerId,
      chat?.peerIdString,
      chat?.peer?.id,
      chat?.peer?.toPeerId?.(),
      chat?.peerId?.toString?.(),
    ]
      .map(normalizePeerIdValue)
      .find(Boolean);
    return sanitizePathSegment(peerId || "unknown", "unknown");
  }

  function sameChatInfo(left, right) {
    return Boolean(left && right && left.chatId === right.chatId && left.chatTitle === right.chatTitle);
  }

  function updateCurrentChat() {
    const nextChat = {
      chatTitle: getCurrentChatTitle(),
      chatId: getCurrentChatId(),
    };
    if (!sameChatInfo(state.currentChat, nextChat)) {
      state.chatRevision += 1;
    }
    state.currentChat = nextChat;
    const chat = document.querySelector("#tg-wmk-chat");
    if (chat) chat.textContent = `Chat: ${state.currentChat.chatTitle}`;
  }

  function captureChatSnapshot() {
    updateCurrentChat();
    return { ...state.currentChat, chatRevision: state.chatRevision };
  }

  function assertChatSnapshot(snapshot) {
    updateCurrentChat();
    if (state.chatRevision !== snapshot.chatRevision || !sameChatInfo(snapshot, state.currentChat)) {
      const error = new Error("Chat changed during scan. Stopped.");
      error.code = "chat-changed";
      throw error;
    }
  }

  function findScrollableElement() {
    const colCenter = document.querySelector(SELECTORS.columnCenter);
    if (!colCenter) return null;
    const direct = colCenter.querySelector(".bubbles-container") || colCenter.querySelector(".scrollable-y");
    if (direct) return direct;
    const bubble = colCenter.querySelector(SELECTORS.bubble);
    let parent = bubble ? bubble.parentElement : null;
    while (parent && parent !== colCenter) {
      if (parent.scrollHeight > parent.clientHeight) return parent;
      parent = parent.parentElement;
    }
    return null;
  }

  function getScrollMetrics(container) {
    return {
      scrollTop: Math.round(Number(container?.scrollTop) || 0),
      scrollHeight: Math.round(Number(container?.scrollHeight) || 0),
      clientHeight: Math.round(Number(container?.clientHeight) || 0),
    };
  }

  function scanMadeProgress(before, after, sawNewMessages) {
    return Boolean(
      sawNewMessages ||
        Math.abs((after?.scrollTop || 0) - (before?.scrollTop || 0)) > 2 ||
        Math.abs((after?.scrollHeight || 0) - (before?.scrollHeight || 0)) > 2
    );
  }

  function scrollTowardOlderMessages(container) {
    const step = Math.max(420, Math.floor((container?.clientHeight || window.innerHeight || 600) * 0.85));
    if (typeof container.scrollBy === "function") {
      container.scrollBy({ top: -step, behavior: "auto" });
    } else {
      container.scrollTop = Math.max(0, (Number(container.scrollTop) || 0) - step);
    }
    return step;
  }

  async function readSelectedMessages() {
    return unsafeWindow.appImManager?.chat?.selection?.getSelectedMessages?.() || [];
  }

  function getMessageMid(message) {
    const mid = message?.mid ?? message?.id;
    return mid === undefined || mid === null ? "" : String(mid);
  }

  function messageMatchesMid(message, mid) {
    return getMessageMid(message) === String(mid);
  }

  function collectMessageIdsFromBubble(bubble) {
    const mids = [];
    const addMid = (mid) => {
      const value = mid === undefined || mid === null ? "" : String(mid);
      if (value && !mids.includes(value)) mids.push(value);
    };
    addMid(bubble?.dataset?.mid);
    bubble?.querySelectorAll?.("[data-mid]")?.forEach((element) => addMid(element.dataset?.mid));
    return mids;
  }

  function filterMessagesByMids(messages, mids) {
    const byMid = new Map();
    for (const message of messages || []) {
      const mid = getMessageMid(message);
      if (mid && !byMid.has(mid)) byMid.set(mid, message);
    }
    return (mids || []).map((mid) => byMid.get(String(mid))).filter(Boolean);
  }

  function simulateClick(element) {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const options = {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      buttons: 1,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    };
    const PointerCtor = typeof PointerEvent === "undefined" ? MouseEvent : PointerEvent;
    element.dispatchEvent(new PointerCtor("pointerdown", options));
    element.dispatchEvent(new MouseEvent("mousedown", options));
    element.dispatchEvent(new PointerCtor("pointerup", options));
    element.dispatchEvent(new MouseEvent("mouseup", options));
    element.dispatchEvent(new MouseEvent("click", options));
  }

  function getBubbleSelectionTarget(bubble) {
    return (
      bubble.querySelector(".time") ||
      bubble.querySelector(".message-time") ||
      bubble.querySelector(".bubble-time") ||
      bubble.querySelector(".select-checkbox")
    );
  }

  async function resolveMessagesFromBubble(bubble, mids = collectMessageIdsFromBubble(bubble)) {
    const expectedMids = [];
    for (const mid of mids || []) {
      const value = String(mid || "");
      if (value && !expectedMids.includes(value)) expectedMids.push(value);
    }
    if (!expectedMids.length) return [];
    const selected = await readSelectedMessages();
    const alreadySelected = filterMessagesByMids(selected, expectedMids);
    if (alreadySelected.length === expectedMids.length) return alreadySelected;
    const target = getBubbleSelectionTarget(bubble);
    if (!target) return alreadySelected;
    let temporarySelected = false;
    try {
      simulateClick(target);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const messages = await readSelectedMessages();
      const resolved = filterMessagesByMids(messages, expectedMids);
      temporarySelected = resolved.length > alreadySelected.length || (resolved.length > 0 && alreadySelected.length === 0);
      return resolved.length ? resolved : alreadySelected;
    } finally {
      let shouldDeselect = temporarySelected;
      if (!shouldDeselect) {
        try {
          const messages = await readSelectedMessages();
          shouldDeselect = messages.some((message) => expectedMids.includes(getMessageMid(message)));
        } catch (error) {
          shouldDeselect = true;
        }
      }
      if (shouldDeselect) simulateClick(target);
    }
  }

  async function resolveMessageFromBubble(bubble, mid = bubble?.dataset?.mid) {
    return (await resolveMessagesFromBubble(bubble, [mid]))[0] || null;
  }

  function bubbleLooksDownloadable(bubble) {
    return Boolean(
      bubble.querySelector(".media-container, .document, video, img.thumbnail, .photo, .document-name, .file-name")
    );
  }

  const HOVER_BUTTON_ANCHOR_SELECTOR = ".media-container, .document, video, .photo, img.thumbnail, .document-name, .file-name";

  function findHoverButtonAnchor(bubble) {
    return bubble.querySelector(HOVER_BUTTON_ANCHOR_SELECTOR) || bubble;
  }

  function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function getHoverButtonAnchorRect(bubble) {
    const rects = Array.from(bubble?.querySelectorAll?.(HOVER_BUTTON_ANCHOR_SELECTOR) || [])
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect && rect.width > 0 && rect.height > 0);
    if (!rects.length) return findHoverButtonAnchor(bubble).getBoundingClientRect();
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function computeHoverButtonPosition(bubbleRect, itemRect, viewportSize, buttonWidth = 28, gap = 4, margin = 8) {
    const viewportWidth = numberOr(viewportSize?.width, window.innerWidth || document.documentElement?.clientWidth || 1024);
    const itemRight = numberOr(itemRect?.right, numberOr(bubbleRect?.right, 0));
    const itemLeft = numberOr(itemRect?.left, itemRight);
    const itemTop = numberOr(itemRect?.top, numberOr(bubbleRect?.top, 0));
    const bubbleLeft = numberOr(bubbleRect?.left, 0);
    const bubbleTop = numberOr(bubbleRect?.top, 0);
    const fitsOutsideRight = itemRight + gap + buttonWidth <= viewportWidth - margin;
    const fitsOutsideLeft = itemLeft - gap - buttonWidth >= margin;
    let left;
    let inside = false;
    if (fitsOutsideRight) {
      left = itemRight + gap;
    } else if (fitsOutsideLeft) {
      left = itemLeft - gap - buttonWidth;
    } else {
      left = clampNumber(itemRight - buttonWidth - gap, margin, viewportWidth - margin - buttonWidth);
      inside = true;
    }
    return {
      left: Math.round(left - bubbleLeft),
      top: Math.max(0, Math.round(itemTop - bubbleTop + 6)),
      inside,
    };
  }

  function updateHoverButtonPlacement(bubble, button) {
    const position = computeHoverButtonPosition(bubble.getBoundingClientRect(), getHoverButtonAnchorRect(bubble), getViewportSize());
    button.style.left = `${position.left}px`;
    button.style.top = `${position.top}px`;
    button.style.right = "auto";
    if (position.inside) button.classList.add("tg-wmk-hover-download-inside");
    else button.classList.remove("tg-wmk-hover-download-inside");
    applyHoverButtonAvailability(button);
  }

  async function prepareItem(item, storage = state.storage) {
    if (!storage) throw new Error("Choose a download directory first.");
    const planned = planMediaPath(item);
    const existing = await storage.getExistingFile(planned);
    const skipDecision = shouldSkipExistingFile(existing, item.size);
    recordDebugEvent("prepare-item", {
      mid: item.mid,
      type: item.type,
      size: item.size || 0,
      fileName: planned.fileName,
      skip: skipDecision.skip,
      reason: skipDecision.reason,
    });
    return { item, planned, existing, skipDecision };
  }

  function itemToManifestRecord(item, planned, status, errorMessage = "") {
    const sentAt = coerceDate(item.sentAt);
    return {
      mid: item.mid,
      groupedId: item.groupedId,
      mediaId: item.mediaId,
      type: item.type,
      sentAt: sentAt ? sentAt.toISOString() : "",
      relativePath: planned.relativePath,
      size: item.size || 0,
      status,
      error: errorMessage,
    };
  }

  function resolveDownloadUrl(item) {
    const media = item.media || {};
    const candidates = [
      media.url,
      media.src,
      media.download_url,
      media.downloadUrl,
      media.blobUrl,
      media.location && media.location.url,
    ].filter(Boolean);
    return candidates[0] || "";
  }

  function isBlobLike(value) {
    return Boolean(
      value &&
        typeof value === "object" &&
        typeof value.arrayBuffer === "function" &&
        typeof value.size === "number"
    );
  }

  function getCurrentQueueId() {
    return unsafeWindow.appImManager?.chat?.bubbles?.lazyLoadQueue?.queueId;
  }

  function captureDownloadContext() {
    const queueId = getCurrentQueueId();
    return queueId === undefined || queueId === null ? {} : { queueId };
  }

  function getLargestPhotoThumb(media) {
    const sizes = Array.isArray(media?.sizes) ? media.sizes.slice() : [];
    const candidates = sizes.filter((size) => size && size._ !== "photoStrippedSize");
    if (!candidates.length) return null;
    return candidates[candidates.length - 1];
  }

  function buildWebKDownloadOptions(item) {
    const options = { media: item.media };
    const queueId =
      item.downloadContext?.queueId !== undefined && item.downloadContext?.queueId !== null
        ? item.downloadContext.queueId
        : getCurrentQueueId();
    if (queueId !== undefined && queueId !== null) options.queueId = queueId;
    if (item.media?._ === "photo") {
      const thumb = item.thumb || getLargestPhotoThumb(item.media);
      if (thumb) options.thumb = thumb;
    }
    return options;
  }

  function normalizeDownloadError(error, fallbackMessage) {
    if (error instanceof Error) return error;
    return new Error(error ? String(error) : fallbackMessage);
  }

  async function fetchDownloadUrl(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Download failed with HTTP ${response.status}`);
    }
    return response.blob();
  }

  async function unwrapDownloadBlob(result) {
    const value = await result;
    if (isBlobLike(value)) return value;
    if (typeof value === "string" && value) return fetchDownloadUrl(value);
    if (value?.blob && isBlobLike(value.blob)) return value.blob;
    if (typeof value?.blob === "function") {
      const blob = await value.blob();
      if (isBlobLike(blob)) return blob;
    }
    return null;
  }

  async function downloadViaWebKManager(item) {
    const manager = unsafeWindow.appDownloadManager;
    if (!manager || !item.media || !item.media._) return { attempted: false, blob: null, error: null };

    recordDebugEvent("webk-download-start", { mid: item.mid, type: item.type, source: item.source });
    const attempts = [
      {
        name: "downloadMedia",
        available: typeof manager.downloadMedia === "function",
        run: () => manager.downloadMedia(buildWebKDownloadOptions(item)),
      },
      {
        name: "downloadToDiscAttach",
        available: typeof manager.downloadToDisc === "function",
        run: () => manager.downloadToDisc(buildWebKDownloadOptions(item), true),
      },
      {
        name: "downloadMediaURL",
        available: typeof manager.downloadMediaURL === "function",
        run: () => manager.downloadMediaURL(buildWebKDownloadOptions(item)),
      },
    ];

    let attempted = false;
    let lastError = null;
    for (const attempt of attempts) {
      if (!attempt.available) continue;
      attempted = true;
      try {
        const blob = await unwrapDownloadBlob(attempt.run());
        if (blob) {
          recordDebugEvent("webk-download-ok", {
            mid: item.mid,
            method: attempt.name,
            size: blob.size,
            type: blob.type || item.type,
          });
          return { attempted, blob, error: null };
        }
      } catch (error) {
        lastError = normalizeDownloadError(error, `${attempt.name} failed.`);
        recordDebugEvent("webk-download-failed", { mid: item.mid, method: attempt.name, error: lastError.message });
        log(`${attempt.name} failed.`, error);
      }
    }
    return { attempted, blob: null, error: lastError };
  }

  async function downloadItemBlob(item) {
    const webKResult = await downloadViaWebKManager(item);
    if (webKResult.blob) return webKResult.blob;

    const url = resolveDownloadUrl(item);
    if (url) return fetchDownloadUrl(url);

    if (webKResult.error) {
      throw webKResult.error;
    }

    const error = new Error("No controlled download source available.");
    error.code = "unsupported-media";
    throw error;
  }

  async function runDownloadQueue(items, label = "Download") {
    const blocker = getStartSettingsBlocker();
    if (blocker) {
      updatePanelStatus(blocker);
      return;
    }
    const queueItems = Array.isArray(items) ? items : [];
    if (!queueItems.length) {
      updatePanelStatus(label === "Message" ? "No supported media in this message." : "No supported media found.");
      return;
    }
    const job = createDownloadJob({
      source: label === "Message" ? "hover" : "batch",
      chatInfo: state.currentChat,
      items: queueItems,
    });
    if (!enqueueDownloadJob(job)) return;
    startDownloadWorker();
    return job.completionPromise;
  }

  async function runDownloadJob(job, storage = state.storage) {
    if (!storage) {
      job.status = "failed";
      job.errors.push("Choose a download directory first.");
      updatePanelStatus("Choose a download directory first.");
      settleDownloadJob(job);
      return job;
    }
    job.status = "downloading";
    mirrorDownloadJobCounters(job);
    const reportChatDirName = reportChatDirNameForRun(job.items, job.chatInfo);
    const manifestRecords = [];
    let persistenceFailed = false;
    recordDebugEvent("queue-job-start", {
      jobId: job.jobId,
      source: job.source,
      itemCount: job.items.length,
      chatTitle: job.chatInfo.chatTitle,
      chatId: job.chatInfo.chatId,
    });
    let completionError = null;
    try {
      for (const item of job.items) {
        if (job.stopRequested) break;
        if (!state.filters[item.type]) continue;
        job.currentItem = item;
        let itemStatus = `Downloading: ${job.chatInfo.chatTitle}`;
        try {
          const prepared = await prepareItem(item, storage);
          if (prepared.skipDecision.skip) {
            job.counters.skipped += 1;
            mirrorDownloadJobCounters(job);
            manifestRecords.push(itemToManifestRecord(item, prepared.planned, "skipped"));
            itemStatus = `Skipped ${prepared.planned.fileName}`;
            continue;
          }
          updatePanelStatus(`Downloading ${prepared.planned.fileName}`);
          const blob = await downloadItemBlob(item);
          await storage.writePlannedFile(prepared.planned, blob);
          job.counters.downloaded += 1;
          mirrorDownloadJobCounters(job);
          manifestRecords.push(itemToManifestRecord(item, prepared.planned, "downloaded"));
          itemStatus = `Downloaded ${prepared.planned.fileName}`;
        } catch (error) {
          if (error.code === "unsupported-media") job.counters.unsupported += 1;
          else job.counters.failed += 1;
          mirrorDownloadJobCounters(job);
          const planned = planMediaPath(item);
          const message = error.message || String(error);
          job.errors.push(message);
          manifestRecords.push(
            itemToManifestRecord(item, planned, error.code || "failed", message)
          );
          itemStatus = message;
        } finally {
          updatePanelStatus(itemStatus);
        }
      }
      try {
        if (manifestRecords.length) {
          await storage.upsertManifest(reportChatDirName, manifestRecords);
        }
        await storage.writeJson(reportChatDirName, "_download-report.json", {
          createdAt: new Date().toISOString(),
          jobId: job.jobId,
          source: job.source,
          counters: job.counters,
          items: manifestRecords,
        });
      } catch (error) {
        persistenceFailed = true;
        job.counters.failed += 1;
        mirrorDownloadJobCounters(job);
        job.errors.push(`Report write failed: ${error.message || error}`);
        log("Report write failed.", error);
      }
      if (persistenceFailed) job.status = "failed";
      else if (job.stopRequested) job.status = "stopped";
      else job.status = "completed";
      return job;
    } catch (reason) {
      const error = errorFromReason(reason);
      completionError = error;
      job.status = "failed";
      throw error;
    } finally {
      job.currentItem = null;
      recordDebugEvent("queue-job-finish", { jobId: job.jobId, status: job.status });
      updatePanelStatus(job.status === "completed" ? "Done." : job.status === "stopped" ? "Stopped." : "Download failed.");
      if (completionError) settleDownloadJob(job, completionError);
      else settleDownloadJob(job);
    }
  }

  function createHoverDownloadJob(messages, chatInfo = state.currentChat) {
    const items = extractMediaItems(messages, chatInfo);
    if (!items.length) return null;
    return createDownloadJob({ source: "hover", chatInfo, items });
  }

  async function downloadBubbleMedia(bubble) {
    const availability = getActionAvailability();
    if (availability.hoverDisabled) {
      updatePanelStatus(availability.hoverTitle);
      return;
    }
    try {
      updateCurrentChat();
      const chatInfo = { ...state.currentChat };
      const messages = await resolveMessagesFromBubble(bubble);
      if (!messages.length) {
        updatePanelStatus("Could not resolve message.");
        return;
      }
      const job = createHoverDownloadJob(messages, chatInfo);
      if (!job) {
        updatePanelStatus("No supported media in this message.");
        return;
      }
      enqueueDownloadJob(job);
    } catch (error) {
      updatePanelStatus(`Download error: ${error.message || error}`);
      log("Download error.", error);
    }
  }

  function attachHoverButton(bubble) {
    if (!bubble || bubble.dataset.tgWmkHoverAttached === "1") return;
    if (!bubbleLooksDownloadable(bubble)) return;
    if (getComputedStyle(bubble).position === "static") bubble.style.position = "relative";
    bubble.classList.add("tg-wmk-hover-anchor");
    const button = document.createElement("button");
    button.className = "tg-wmk-hover-download";
    button.type = "button";
    button.title = "Download media from this message";
    button.textContent = "↓";
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await downloadBubbleMedia(bubble);
    });
    bubble.addEventListener("mouseenter", () => updateHoverButtonPlacement(bubble, button));
    updateHoverButtonPlacement(bubble, button);
    bubble.appendChild(button);
    bubble.dataset.tgWmkHoverAttached = "1";
    updateDownloadActionAvailability();
  }

  function scanVisibleBubblesForHoverButtons() {
    document.querySelectorAll(SELECTORS.bubble).forEach(attachHoverButton);
  }

  function scanNodeForHoverButtons(node) {
    if (!(node instanceof Element)) return;
    if (node.matches(SELECTORS.bubble)) attachHoverButton(node);
    else {
      const parentBubble = node.closest?.(SELECTORS.bubble);
      if (parentBubble) attachHoverButton(parentBubble);
    }
    node.querySelectorAll(SELECTORS.bubble).forEach(attachHoverButton);
  }

  function startHoverObserver() {
    scanVisibleBubblesForHoverButtons();
    const observer = new MutationObserver((mutations) => {
      updateCurrentChat();
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach(scanNodeForHoverButtons);
      });
    });
    const root = document.querySelector(SELECTORS.columnCenter) || document.body;
    observer.observe(root, { childList: true, subtree: true });
  }

  async function collectVisibleMessages(seen, chatSnapshot) {
    if (chatSnapshot) assertChatSnapshot(chatSnapshot);
    const cutoffDate = dateInputToCutoffDate(state.dateCutoff);
    const messages = [];
    let reachedCutoff = false;
    const root = document.querySelector(SELECTORS.columnCenter) || document;
    const bubbles = Array.from(root.querySelectorAll(SELECTORS.bubble));
    for (const bubble of bubbles) {
      if (state.scan.stopped) break;
      if (chatSnapshot) assertChatSnapshot(chatSnapshot);
      const mids = collectMessageIdsFromBubble(bubble);
      const unseenMids = mids.filter((mid) => !seen.has(mid));
      if (!unseenMids.length) {
        attachHoverButton(bubble);
        continue;
      }
      unseenMids.forEach((mid) => seen.add(mid));
      state.counters.scanned += unseenMids.length;
      state.scan.counters.scanned = state.counters.scanned;
      const resolvedMessages = await resolveMessagesFromBubble(bubble, unseenMids);
      if (chatSnapshot) assertChatSnapshot(chatSnapshot);
      if (state.scan.stopped) break;
      if (resolvedMessages.length) {
        const split = splitMessagesByDateCutoff(resolvedMessages, cutoffDate);
        messages.push(...split.messages);
        reachedCutoff = reachedCutoff || split.reachedCutoff;
      }
      attachHoverButton(bubble);
      updatePanelStatus(`Scanning: ${state.counters.scanned}`);
    }
    return { messages, reachedCutoff };
  }

  async function scanCurrentChatMessages(chatSnapshot) {
    if (chatSnapshot) assertChatSnapshot(chatSnapshot);
    const container = findScrollableElement();
    if (!container) throw new Error("Chat scroll container not found.");
    const seen = new Set();
    const collected = [];
    let stuckCycles = 0;
    while (!state.scan.stopped && stuckCycles < 6) {
      if (chatSnapshot) assertChatSnapshot(chatSnapshot);
      const seenBefore = seen.size;
      const visible = await collectVisibleMessages(seen, chatSnapshot);
      collected.push(...visible.messages);
      if (state.scan.stopped) break;
      if (visible.reachedCutoff) {
        state.dateCutoffReached = true;
        recordDebugEvent("date-cutoff-reached", { value: state.dateCutoff });
        break;
      }
      const beforeScroll = getScrollMetrics(container);
      scrollTowardOlderMessages(container);
      await new Promise((resolve) => setTimeout(resolve, 650));
      if (chatSnapshot) assertChatSnapshot(chatSnapshot);
      const afterScroll = getScrollMetrics(container);
      if (scanMadeProgress(beforeScroll, afterScroll, seen.size > seenBefore)) {
        stuckCycles = 0;
      } else {
        stuckCycles += 1;
        recordDebugEvent("scan-no-progress", {
          seen: seen.size,
          stuckCycles,
          scrollTop: afterScroll.scrollTop,
          scrollHeight: afterScroll.scrollHeight,
        });
      }
    }
    return collected;
  }

  async function startBatchDownload() {
    const batchChat = captureChatSnapshot();
    const scanStart = beginScanTask({ chatSnapshot: batchChat });
    if (!scanStart.ok) return;
    resetCounters();
    state.dateCutoffReached = false;
    recordDebugEvent("batch-scan-start", { chatTitle: batchChat.chatTitle, chatId: batchChat.chatId });
    try {
      updatePanelStatus("Scanning current chat.");
      const scanMessages = IS_TEST_MODE && scanCurrentChatMessagesForTest ? scanCurrentChatMessagesForTest : scanCurrentChatMessages;
      const messages = await scanMessages(batchChat);
      if (state.scan.stopped) {
        updatePanelStatus("Stopped.");
        return;
      }
      const items = extractMediaItems(messages, batchChat);
      state.scan.counters.discovered = items.length;
      recordDebugEvent("batch-scan-finish", { messageCount: messages.length, itemCount: items.length });
      finishScanTask(items);
    } catch (error) {
      if (error.code === "chat-changed") state.scan.stopped = true;
      else state.counters.failed += 1;
      state.scan.active = false;
      state.scan.chatSnapshot = null;
      state.scan.status = "Idle";
      recordDebugEvent("batch-scan-error", { error: error.message || String(error), code: error.code || "" });
      updatePanelStatus(error.message || String(error));
    } finally {
      state.scan.active = false;
      state.scan.chatSnapshot = null;
      state.scan.status = "Idle";
      syncLegacyStopButton();
    }
  }

  function start() {
    if (!isWebK()) {
      log("Not Telegram WebK. Script is idle.");
      return;
    }
    installStyles();
    createPanel();
    updateCurrentChat();
    restoreRememberedDirectory();
    startHoverObserver();
  }

  const testApi = {
    debugApiVersion: APP.debugApiVersion,
    recordDebugEvent,
    sanitizeDebugDetail,
    createDebugReport,
    sanitizePathSegment,
    formatFileTimestamp,
    dateInputToCutoffDate,
    messageIsBeforeDateCutoff,
    splitMessagesByDateCutoff,
    clampPanelPosition,
    positionExpandedPanelNearAnchor,
    inferMediaKind,
    planMediaPath,
    reportChatDirNameForRun,
    sameChatInfo,
    captureChatSnapshot,
    assertChatSnapshot,
    shouldSkipExistingFile,
    prepareItem,
    itemToManifestRecord,
    resolveDownloadUrl,
    isBlobLike,
    captureDownloadContext,
    buildWebKDownloadOptions,
    fetchDownloadUrl,
    unwrapDownloadBlob,
    downloadViaWebKManager,
    downloadItemBlob,
    runDownloadQueue,
    runDownloadJob,
    startDownloadWorker,
    stopCurrentDownloadJob,
    beginScanTask,
    finishScanTask,
    stopCurrentScanTask,
    startBatchDownload,
    stopCurrentTask,
    messageDateToDate,
    extractMediaFromMessage,
    extractMediaItems,
    collectVisibleMessages,
    collectMessageIdsFromBubble,
    resolveMessagesFromBubble,
    scanMadeProgress,
    hasEnabledMediaFilter,
    getStartSettingsBlocker,
    getScanStartBlocker,
    getActionAvailability,
    renderPendingQueueSummary,
    updateDownloadActionAvailability,
    createPanel,
    createDownloadJob,
    createHoverDownloadJob,
    enqueueDownloadJob,
    dequeueNextDownloadJob,
    __getDownloadQueueForTest: getDownloadQueueSnapshot,
    __setDownloadQueueForTest: setDownloadQueueForTest,
    __getStateForTest: getStateForTest,
    __setStateForTest: setStateForTest,
    __beginLegacyScanTaskForTest: beginLegacyScanTask,
    __clearLegacyScanTaskForTest: clearLegacyScanTask,
    __setStorageForTest: setStorageForTest,
    attachHoverButton,
    computeHoverButtonPosition,
    findHoverButtonAnchor,
    updateHoverButtonPlacement,
    normalizeExtension,
    extensionFromName,
    stripExtension,
    FakeFileHandle,
    FakeDirectoryHandle,
    StorageManager,
    clearSelectedDirectory,
    canRememberDirectoryHandle,
  };
  if (IS_TEST_MODE) {
    testApi.__setRunDownloadJobForTest = setRunDownloadJobForTest;
    testApi.__setScanCurrentChatMessagesForTest = setScanCurrentChatMessagesForTest;
    testApi.startForDebug = start;
  }

  unsafeWindow[APP.debugApiKey] = {
    debugApiVersion: APP.debugApiVersion,
    createDebugReport,
  };
  if (IS_TEST_MODE) {
    unsafeWindow[APP.testApiKey] = testApi;
  }
  if (!IS_TEST_MODE) {
    start();
  }
})();
