// ==UserScript==
// @name         AI Agent Book Reading Notes
// @namespace    https://github.com/kyangc/tampermonkey_scripts
// @version      0.2.0
// @description  Highlight, annotate, export, and end-to-end encrypt notes across devices.
// @author       kyangc
// @homepageURL  https://github.com/kyangc/tampermonkey_scripts
// @supportURL   https://github.com/kyangc/tampermonkey_scripts/issues
// @updateURL    https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/ai-agent-book-reading-notes.user.js
// @downloadURL  https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/ai-agent-book-reading-notes.user.js
// @match        https://bojieli.github.io/ai-agent-book/book/*
// @run-at       document-idle
// @inject-into  content
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      *
// @noframes
// ==/UserScript==

(function aiAgentBookReadingNotes(global) {
  'use strict';

  const CONFIG = Object.freeze({
    bookTitle: 'AI Agents in Depth',
    contextLength: 64,
    maxSelectionLength: 6000,
    schemaVersion: 1,
    storageKey: 'ai-agent-book:reading-notes:v1',
    syncStorageKey: 'ai-agent-book:reading-notes-sync:v1',
    uiHostId: 'aab-reading-notes-host',
  });

  const SYNC_CONFIG = Object.freeze({
    apiVersion: 1,
    maxBatchSize: 100,
    pairingPollMs: 2200,
    schemaVersion: 1,
  });

  const ANNOTATION_TYPES = Object.freeze({
    highlight: '高亮',
    note: '批注',
    underline: '划线',
  });

  const HIGHLIGHT_NAMES = Object.freeze({
    focus: 'aab-reading-focus',
    highlight: 'aab-reading-highlight',
    note: 'aab-reading-note',
    underline: 'aab-reading-underline',
  });

  const BRUSH_CLIP_PATHS = Object.freeze([
    'polygon(0% 27%, 1% 14%, 5% 18%, 10% 10%, 18% 14%, 27% 8%, 37% 13%, 48% 9%, 60% 14%, 73% 8%, 85% 13%, 95% 9%, 100% 23%, 100% 76%, 97% 88%, 91% 84%, 83% 92%, 72% 86%, 60% 93%, 47% 87%, 35% 94%, 23% 88%, 12% 93%, 4% 86%, 0% 74%)',
    'polygon(0% 21%, 3% 12%, 8% 16%, 15% 8%, 24% 14%, 34% 9%, 45% 15%, 57% 8%, 68% 13%, 79% 9%, 90% 15%, 97% 11%, 100% 28%, 99% 82%, 94% 89%, 86% 85%, 77% 93%, 66% 87%, 54% 94%, 42% 88%, 31% 92%, 20% 86%, 10% 91%, 3% 83%, 0% 70%)',
    'polygon(0% 29%, 2% 17%, 7% 12%, 13% 18%, 21% 9%, 30% 15%, 41% 8%, 52% 14%, 64% 9%, 75% 15%, 87% 8%, 96% 14%, 100% 26%, 100% 73%, 96% 86%, 89% 91%, 80% 85%, 69% 93%, 58% 87%, 46% 94%, 34% 86%, 24% 92%, 14% 87%, 6% 91%, 1% 80%)',
  ]);

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizePageUrl(value, base = 'https://bojieli.github.io/ai-agent-book/book/') {
    try {
      const url = new URL(String(value || ''), base);
      url.hash = '';
      url.search = '';
      const pathname = `${url.pathname.replace(/\/+$/, '')}/`;
      return `${url.origin}${pathname}`;
    } catch (_error) {
      return '';
    }
  }

  function commonPrefixLength(left, right) {
    const limit = Math.min(left.length, right.length);
    let length = 0;
    while (length < limit && left[length] === right[length]) length += 1;
    return length;
  }

  function commonSuffixLength(left, right) {
    const limit = Math.min(left.length, right.length);
    let length = 0;
    while (
      length < limit
      && left[left.length - 1 - length] === right[right.length - 1 - length]
    ) {
      length += 1;
    }
    return length;
  }

  function hashString(value) {
    let hash = 2166136261;
    for (const character of String(value || '')) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function bytesToBase64Url(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  function base64UrlToBytes(value) {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function randomBase64Url(byteLength = 32, cryptoObject = global.crypto) {
    const bytes = new Uint8Array(byteLength);
    cryptoObject.getRandomValues(bytes);
    return bytesToBase64Url(bytes);
  }

  async function sha256Base64Url(value, cryptoObject = global.crypto) {
    const bytes = new TextEncoder().encode(String(value || ''));
    const digest = await cryptoObject.subtle.digest('SHA-256', bytes);
    return bytesToBase64Url(digest);
  }

  function normalizeSyncEndpoint(value) {
    try {
      const url = new URL(String(value || '').trim());
      const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.protocol !== 'https:' && !(isLocal && url.protocol === 'http:')) return '';
      url.hash = '';
      url.search = '';
      return url.href.replace(/\/+$/, '');
    } catch (_error) {
      return '';
    }
  }

  function normalizePendingMutation(value) {
    if (!value || typeof value !== 'object') return null;
    const mutationId = String(value.mutationId || '');
    const recordId = String(value.recordId || '');
    const baseVersion = Number(value.baseVersion);
    const deleted = Boolean(value.deleted);
    const snapshot = deleted ? null : normalizeAnnotation(value.snapshot);
    if (
      !mutationId
      || !recordId
      || !Number.isSafeInteger(baseVersion)
      || baseVersion < 0
      || (!deleted && !snapshot)
    ) {
      return null;
    }
    return {
      baseVersion,
      deleted,
      mutationId,
      recordId,
      snapshot,
    };
  }

  function normalizeSyncState(value) {
    const source = value && typeof value === 'object' ? value : {};
    const versions = {};
    for (const [recordId, version] of Object.entries(source.versions || {})) {
      const number = Number(version);
      if (recordId && Number.isSafeInteger(number) && number >= 0) {
        versions[recordId] = number;
      }
    }

    const pairing = source.pairing && typeof source.pairing === 'object'
      ? {
        code: String(source.pairing.code || ''),
        deviceId: String(source.pairing.deviceId || ''),
        deviceName: String(source.pairing.deviceName || ''),
        deviceToken: String(source.pairing.deviceToken || ''),
        endpoint: normalizeSyncEndpoint(source.pairing.endpoint),
        expiresAt: String(source.pairing.expiresAt || ''),
        pairId: String(source.pairing.pairId || ''),
        pairSecret: String(source.pairing.pairSecret || ''),
        privateKey: source.pairing.privateKey || null,
        role: source.pairing.role === 'inviter' ? 'inviter' : 'joiner',
      }
      : null;

    return {
      cursor: Number.isSafeInteger(Number(source.cursor)) && Number(source.cursor) >= 0
        ? Number(source.cursor)
        : 0,
      deviceId: String(source.deviceId || ''),
      deviceName: String(source.deviceName || ''),
      deviceToken: String(source.deviceToken || ''),
      endpoint: normalizeSyncEndpoint(source.endpoint),
      lastSyncAt: String(source.lastSyncAt || ''),
      libraryId: String(source.libraryId || ''),
      masterKey: String(source.masterKey || ''),
      pairing,
      pending: Array.isArray(source.pending)
        ? source.pending.map(normalizePendingMutation).filter(Boolean)
        : [],
      schemaVersion: SYNC_CONFIG.schemaVersion,
      versions,
    };
  }

  function createPendingMutation(current, annotation, options = {}) {
    const recordId = String(options.recordId || annotation?.id || '');
    if (!recordId) return null;
    const existing = current?.pending?.find((item) => item.recordId === recordId);
    const knownVersion = Number(current?.versions?.[recordId]);
    const baseVersion = existing
      ? existing.baseVersion
      : Number.isSafeInteger(knownVersion) && knownVersion >= 0 ? knownVersion : 0;
    const deleted = Boolean(options.deleted);
    const snapshot = deleted ? null : normalizeAnnotation(annotation);
    if (!deleted && !snapshot) return null;

    return {
      baseVersion,
      deleted,
      mutationId: String(options.mutationId || `mut-${randomBase64Url(18)}`),
      recordId,
      snapshot,
    };
  }

  function getBrushStrokeVariation(annotationId, lineIndex) {
    const seed = hashString(`${annotationId}:${lineIndex}`);
    return {
      clipPath: BRUSH_CLIP_PATHS[seed % BRUSH_CLIP_PATHS.length],
      heightScale: 0.58 + ((seed >>> 8) % 7) / 100,
      leftPad: 1.8 + ((seed >>> 16) % 8) / 10,
      rightPad: 2.6 + ((seed >>> 20) % 10) / 10,
      rotation: (((seed >>> 4) % 13) - 6) / 20,
      verticalOffset: 0.255 + ((seed >>> 12) % 5) / 100,
    };
  }

  function getHandUnderlineVariation(annotationId, lineIndex) {
    const seed = hashString(`underline:${annotationId}:${lineIndex}`);
    const point = (shift, base = 4) => {
      const delta = (((seed >>> shift) % 7) - 3) * 0.18;
      return Math.round((base + delta) * 100) / 100;
    };
    const points = [
      point(0),
      point(3),
      point(6),
      point(9),
      point(12),
      point(15),
      point(18),
    ];
    const ghost = points.map((value, index) => (
      Math.round((value + 1.15 + (index % 2 ? 0.08 : -0.05)) * 100) / 100
    ));

    return {
      ghostPath: `M 1 ${ghost[0]} C 12 ${ghost[1]}, 23 ${ghost[2]}, 35 ${ghost[3]} S 56 ${ghost[4]}, 68 ${ghost[5]} S 88 ${ghost[2]}, 99 ${ghost[6]}`,
      primaryPath: `M 1 ${points[0]} C 12 ${points[1]}, 23 ${points[2]}, 35 ${points[3]} S 56 ${points[4]}, 68 ${points[5]} S 88 ${points[2]}, 99 ${points[6]}`,
      rotation: (((seed >>> 21) % 9) - 4) / 25,
    };
  }

  function mergeTextLineRects(rects) {
    const normalized = Array.from(rects || [])
      .map((rect) => {
        const left = Number(rect.left);
        const top = Number(rect.top);
        const right = Number.isFinite(Number(rect.right))
          ? Number(rect.right)
          : left + Number(rect.width);
        const bottom = Number.isFinite(Number(rect.bottom))
          ? Number(rect.bottom)
          : top + Number(rect.height);

        return {
          bottom,
          height: bottom - top,
          left,
          right,
          top,
          width: right - left,
        };
      })
      .filter((rect) => (
        Object.values(rect).every(Number.isFinite)
        && rect.width > 0.5
        && rect.height > 0.5
      ))
      .sort((left, right) => left.top - right.top || left.left - right.left);

    const lines = [];
    for (const rect of normalized) {
      const center = (rect.top + rect.bottom) / 2;
      const previous = lines.at(-1);
      const tolerance = previous
        ? Math.max(2, Math.min(previous.height, rect.height) * 0.36)
        : 0;

      if (previous && Math.abs(center - previous.center) <= tolerance) {
        previous.left = Math.min(previous.left, rect.left);
        previous.right = Math.max(previous.right, rect.right);
        previous.top = Math.min(previous.top, rect.top);
        previous.bottom = Math.max(previous.bottom, rect.bottom);
        previous.width = previous.right - previous.left;
        previous.height = previous.bottom - previous.top;
        previous.center = (previous.top + previous.bottom) / 2;
        continue;
      }

      lines.push({ ...rect, center });
    }

    return lines.map(({ center: _center, ...rect }) => rect);
  }

  function calculateCenteredScrollTop(rect, scrollY, viewportHeight, topInset = 0) {
    const top = Number(rect?.top);
    const bottom = Number.isFinite(Number(rect?.bottom))
      ? Number(rect.bottom)
      : top + Number(rect?.height);
    const currentScrollY = Number.isFinite(Number(scrollY)) ? Number(scrollY) : 0;
    const height = Math.max(0, Number(viewportHeight) || 0);
    const inset = clamp(Number(topInset) || 0, 0, height);

    if (!Number.isFinite(top) || !Number.isFinite(bottom) || height <= 0) {
      return Math.max(0, currentScrollY);
    }

    const targetCenter = inset + (height - inset) / 2;
    return Math.max(0, currentScrollY + (top + bottom) / 2 - targetCenter);
  }

  function findTextOffsetPoint(nodes, offset, edge) {
    const value = Math.trunc(Number(offset));
    if (!Array.isArray(nodes) || !Number.isFinite(value)) return null;

    if (edge === 'start') {
      return nodes.find((item) => value >= item.start && value < item.end) || null;
    }
    if (edge === 'end') {
      return nodes.find((item) => value > item.start && value <= item.end) || null;
    }
    return null;
  }

  function buildTextAnchor(text, start, end, contextLength = CONFIG.contextLength) {
    const source = String(text || '');
    const safeStart = clamp(Math.trunc(Number(start) || 0), 0, source.length);
    const safeEnd = clamp(Math.trunc(Number(end) || 0), safeStart, source.length);
    if (safeStart === safeEnd) return null;

    return {
      exact: source.slice(safeStart, safeEnd),
      prefix: source.slice(Math.max(0, safeStart - contextLength), safeStart),
      suffix: source.slice(safeEnd, safeEnd + contextLength),
      start: safeStart,
      end: safeEnd,
    };
  }

  function locateTextAnchor(text, anchor) {
    const source = String(text || '');
    const exact = String(anchor?.exact || '');
    if (!source || !exact) return null;

    const preferredStart = Number.isFinite(Number(anchor.start))
      ? clamp(Math.trunc(Number(anchor.start)), 0, source.length)
      : null;
    const preferredEnd = Number.isFinite(Number(anchor.end))
      ? clamp(Math.trunc(Number(anchor.end)), 0, source.length)
      : null;

    if (
      preferredStart !== null
      && preferredEnd !== null
      && preferredEnd >= preferredStart
      && source.slice(preferredStart, preferredEnd) === exact
    ) {
      return {
        confidence: 1,
        end: preferredEnd,
        start: preferredStart,
        strategy: 'position',
      };
    }

    const prefix = String(anchor.prefix || '');
    const suffix = String(anchor.suffix || '');
    const candidates = [];
    let searchFrom = 0;

    while (searchFrom <= source.length - exact.length && candidates.length < 500) {
      const index = source.indexOf(exact, searchFrom);
      if (index === -1) break;

      const before = source.slice(Math.max(0, index - prefix.length), index);
      const after = source.slice(index + exact.length, index + exact.length + suffix.length);
      const prefixScore = commonSuffixLength(before, prefix);
      const suffixScore = commonPrefixLength(after, suffix);
      const distance = preferredStart === null ? 0 : Math.abs(index - preferredStart);
      const contextScore = prefixScore + suffixScore;

      candidates.push({
        contextScore,
        distance,
        end: index + exact.length,
        start: index,
      });
      searchFrom = index + Math.max(1, exact.length);
    }

    if (!candidates.length) return null;

    candidates.sort((left, right) => (
      right.contextScore - left.contextScore
      || left.distance - right.distance
      || left.start - right.start
    ));

    const best = candidates[0];
    const availableContext = prefix.length + suffix.length;
    const contextConfidence = availableContext
      ? best.contextScore / availableContext
      : candidates.length === 1 ? 1 : 0.5;

    return {
      confidence: Math.max(0.35, Math.min(0.99, contextConfidence)),
      end: best.end,
      start: best.start,
      strategy: 'quote',
    };
  }

  function normalizeAnnotation(value) {
    if (!value || typeof value !== 'object') return null;
    const id = String(value.id || '').trim();
    const type = String(value.type || '');
    const pageUrl = normalizePageUrl(value.pageUrl || value.url);
    const exact = String(value.anchor?.exact || '');

    if (!id || !ANNOTATION_TYPES[type] || !pageUrl || !exact) return null;

    const rawStart = Number(value.anchor?.start);
    const rawEnd = Number(value.anchor?.end);
    const start = Number.isFinite(rawStart) ? Math.max(0, Math.trunc(rawStart)) : 0;
    const end = Number.isFinite(rawEnd)
      ? Math.max(start + exact.length, Math.trunc(rawEnd))
      : start + exact.length;

    return {
      anchor: {
        end,
        exact,
        prefix: String(value.anchor?.prefix || ''),
        start,
        suffix: String(value.anchor?.suffix || ''),
      },
      createdAt: String(value.createdAt || new Date(0).toISOString()),
      id,
      note: String(value.note || '').trim(),
      pageOrder: Number.isFinite(Number(value.pageOrder))
        ? Number(value.pageOrder)
        : 9999,
      pageTitle: String(value.pageTitle || '未命名章节').trim() || '未命名章节',
      pageUrl,
      syncConflict: Boolean(value.syncConflict),
      type,
      updatedAt: String(value.updatedAt || value.createdAt || new Date(0).toISOString()),
    };
  }

  function compareAnnotations(left, right) {
    return (
      left.pageOrder - right.pageOrder
      || left.pageTitle.localeCompare(right.pageTitle, 'zh-CN')
      || left.anchor.start - right.anchor.start
      || Date.parse(left.createdAt) - Date.parse(right.createdAt)
    );
  }

  function normalizeStore(value) {
    const annotations = Array.isArray(value)
      ? value
      : Array.isArray(value?.annotations) ? value.annotations : [];

    return {
      annotations: annotations
        .map(normalizeAnnotation)
        .filter(Boolean)
        .sort(compareAnnotations),
      schemaVersion: CONFIG.schemaVersion,
    };
  }

  function groupAnnotations(annotations) {
    const sorted = annotations
      .map(normalizeAnnotation)
      .filter(Boolean)
      .sort(compareAnnotations);
    const groups = [];

    for (const annotation of sorted) {
      let group = groups[groups.length - 1];
      if (!group || group.pageUrl !== annotation.pageUrl) {
        group = {
          annotations: [],
          pageOrder: annotation.pageOrder,
          pageTitle: annotation.pageTitle,
          pageUrl: annotation.pageUrl,
        };
        groups.push(group);
      }
      group.annotations.push(annotation);
    }

    return groups;
  }

  function formatReadableDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat('zh-CN', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function markdownQuote(value) {
    return String(value || '')
      .split(/\r?\n/)
      .map((line) => `> ${line || ' '}`)
      .join('\n');
  }

  function createMarkdownExport(annotations, options = {}) {
    const groups = groupAnnotations(annotations);
    const exportedAt = options.exportedAt || new Date().toISOString();
    const bookTitle = options.bookTitle || CONFIG.bookTitle;
    const lines = [
      `# ${bookTitle} — 读书笔记`,
      '',
      `> 导出时间：${formatReadableDate(exportedAt)}`,
      `> 共 ${groups.reduce((sum, group) => sum + group.annotations.length, 0)} 条记录`,
      '',
    ];

    for (const group of groups) {
      lines.push(`## ${group.pageTitle}`, '', `[打开原文](${group.pageUrl})`, '');

      group.annotations.forEach((annotation, index) => {
        lines.push(`### ${index + 1}. ${ANNOTATION_TYPES[annotation.type]}`, '');
        lines.push(markdownQuote(annotation.anchor.exact), '');

        if (annotation.note) {
          lines.push('**我的观点**', '', annotation.note, '');
        }

        lines.push(
          `_记录时间：${formatReadableDate(annotation.createdAt)}_`,
          '',
          '---',
          '',
        );
      });
    }

    return `${lines.join('\n').trim()}\n`;
  }

  function createHtmlExport(annotations, options = {}) {
    const groups = groupAnnotations(annotations);
    const exportedAt = options.exportedAt || new Date().toISOString();
    const bookTitle = options.bookTitle || CONFIG.bookTitle;
    const count = groups.reduce((sum, group) => sum + group.annotations.length, 0);

    const chapters = groups.map((group) => {
      const cards = group.annotations.map((annotation, index) => {
        const note = annotation.note
          ? `<div class="opinion"><strong>我的观点</strong><p>${escapeHtml(annotation.note)}</p></div>`
          : '';
        return `
          <article class="note-card note-card--${escapeHtml(annotation.type)}">
            <header>
              <span>${index + 1}. ${escapeHtml(ANNOTATION_TYPES[annotation.type])}</span>
              <time>${escapeHtml(formatReadableDate(annotation.createdAt))}</time>
            </header>
            <blockquote>${escapeHtml(annotation.anchor.exact)}</blockquote>
            ${note}
          </article>`;
      }).join('');

      return `
        <section class="chapter">
          <h2>${escapeHtml(group.pageTitle)}</h2>
          <a class="source" href="${escapeHtml(group.pageUrl)}">打开原文</a>
          ${cards}
        </section>`;
    }).join('');

    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(bookTitle)} — 读书笔记</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: #39342e;
      background: #f6f1e7;
      font-family: "Songti SC", "Source Han Serif SC", "Noto Serif SC", serif;
      font-size: 18px;
      line-height: 1.8;
    }
    main { width: min(760px, calc(100% - 32px)); margin: 56px auto 96px; }
    h1, h2, header, .source {
      font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    }
    h1 { margin-bottom: 8px; font-size: clamp(30px, 5vw, 42px); }
    h2 { margin: 64px 0 4px; font-size: 26px; }
    .meta { margin: 0 0 42px; color: #736b61; }
    .source { color: #236c73; font-size: 14px; }
    .note-card {
      margin: 24px 0;
      padding: 20px 22px;
      background: #fbf7ef;
      border: 1px solid #d6ccbd;
      border-radius: 10px;
      break-inside: avoid;
    }
    .note-card header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      color: #736b61;
      font-size: 14px;
    }
    blockquote {
      margin: 18px 0 0;
      padding: 4px 0 4px 16px;
      white-space: pre-wrap;
      border-left: 4px solid #d0a23f;
    }
    .note-card--underline blockquote { border-color: #4f86c6; }
    .note-card--note blockquote { border-color: #8c6bb1; }
    .opinion {
      margin-top: 18px;
      padding: 14px 16px;
      background: #eee7da;
      border-radius: 7px;
    }
    .opinion strong {
      color: #a95f3b;
      font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
      font-size: 14px;
    }
    .opinion p { margin: 6px 0 0; white-space: pre-wrap; }
    @media (prefers-color-scheme: dark) {
      body { color: #d6d2c7; background: #191a17; }
      .meta, .note-card header { color: #aaa498; }
      .source { color: #8fc6c4; }
      .note-card { background: #22231f; border-color: #3b3d37; }
      .opinion { background: #2a2c27; }
      .opinion strong { color: #d08a66; }
    }
    @media print {
      body { color: #222; background: #fff; }
      main { width: 100%; margin: 0; }
      .note-card { background: #fff; }
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(bookTitle)} — 读书笔记</h1>
    <p class="meta">导出于 ${escapeHtml(formatReadableDate(exportedAt))} · 共 ${count} 条记录</p>
    ${chapters || '<p>暂无记录。</p>'}
  </main>
</body>
</html>`;
  }

  const core = Object.freeze({
    buildTextAnchor,
    calculateCenteredScrollTop,
    compareAnnotations,
    createHtmlExport,
    createMarkdownExport,
    createPendingMutation,
    base64UrlToBytes,
    bytesToBase64Url,
    findTextOffsetPoint,
    getBrushStrokeVariation,
    getHandUnderlineVariation,
    groupAnnotations,
    locateTextAnchor,
    mergeTextLineRects,
    normalizeAnnotation,
    normalizePageUrl,
    normalizeSyncEndpoint,
    normalizeSyncState,
    normalizeStore,
    sha256Base64Url,
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = core;
  }

  if (!global?.document) return;

  const state = {
    brushLayer: null,
    brushRefreshTimer: null,
    composer: null,
    filter: 'current',
    highlightsSupported: Boolean(global.CSS?.highlights && global.Highlight),
    observer: null,
    pairingTimer: null,
    pendingSelection: null,
    refreshTimer: null,
    resolved: new Map(),
    root: null,
    rootResizeObserver: null,
    observedRoot: null,
    store: null,
    sync: null,
    syncDevices: [],
    syncError: '',
    syncing: false,
    syncTimer: null,
    ui: null,
  };

  function readRawStore() {
    try {
      if (typeof GM_getValue === 'function') {
        return GM_getValue(CONFIG.storageKey, null);
      }
      const raw = global.localStorage.getItem(CONFIG.storageKey);
      return raw ? JSON.parse(raw) : null;
    } catch (_error) {
      return null;
    }
  }

  function loadStore() {
    return normalizeStore(readRawStore());
  }

  function persistStore() {
    state.store.annotations.sort(compareAnnotations);
    const value = {
      annotations: state.store.annotations,
      schemaVersion: CONFIG.schemaVersion,
    };

    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(CONFIG.storageKey, value);
      } else {
        global.localStorage.setItem(CONFIG.storageKey, JSON.stringify(value));
      }
      return true;
    } catch (_error) {
      showToast('保存失败，请检查 Tampermonkey 存储权限。', 'error');
      return false;
    }
  }

  function readRawSyncState() {
    try {
      if (typeof GM_getValue === 'function') {
        return GM_getValue(CONFIG.syncStorageKey, null);
      }
      const raw = global.localStorage.getItem(CONFIG.syncStorageKey);
      return raw ? JSON.parse(raw) : null;
    } catch (_error) {
      return null;
    }
  }

  function loadSyncState() {
    return normalizeSyncState(readRawSyncState());
  }

  function persistSyncState() {
    const value = normalizeSyncState(state.sync);
    state.sync = value;
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(CONFIG.syncStorageKey, value);
      } else {
        global.localStorage.setItem(CONFIG.syncStorageKey, JSON.stringify(value));
      }
      renderSyncUi();
      return true;
    } catch (_error) {
      showToast('同步设置保存失败。', 'error');
      return false;
    }
  }

  function isSyncConfigured() {
    return Boolean(
      state.sync?.endpoint
      && state.sync?.libraryId
      && state.sync?.deviceId
      && state.sync?.deviceToken
      && state.sync?.masterKey,
    );
  }

  function queueAnnotationMutation(annotation, options = {}) {
    if (!isSyncConfigured()) return;
    const mutation = createPendingMutation(state.sync, annotation, options);
    if (!mutation) return;
    state.sync.pending = state.sync.pending
      .filter((item) => item.recordId !== mutation.recordId);
    state.sync.pending.push(mutation);
    persistSyncState();
    scheduleSync();
  }

  function queueAllLocalAnnotations() {
    if (!isSyncConfigured()) return;
    for (const annotation of state.store.annotations) {
      if (state.sync.versions[annotation.id] !== undefined) continue;
      queueAnnotationMutation(annotation);
    }
  }

  async function importLibraryKey(masterKey) {
    return global.crypto.subtle.importKey(
      'raw',
      base64UrlToBytes(masterKey),
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  function annotationAdditionalData(libraryId, recordId, version) {
    return new TextEncoder().encode(`${libraryId}|${recordId}|${version}`);
  }

  async function encryptAnnotationPayload(annotation, recordId, version) {
    const key = await importLibraryKey(state.sync.masterKey);
    const iv = global.crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(annotation));
    const ciphertext = await global.crypto.subtle.encrypt({
      additionalData: annotationAdditionalData(state.sync.libraryId, recordId, version),
      iv,
      name: 'AES-GCM',
    }, key, plaintext);

    return {
      ciphertext: bytesToBase64Url(ciphertext),
      nonce: bytesToBase64Url(iv),
    };
  }

  async function decryptAnnotationPayload(record) {
    if (!record || record.deleted) return null;
    const key = await importLibraryKey(state.sync.masterKey);
    const plaintext = await global.crypto.subtle.decrypt({
      additionalData: annotationAdditionalData(
        state.sync.libraryId,
        record.recordId,
        record.version,
      ),
      iv: base64UrlToBytes(record.nonce),
      name: 'AES-GCM',
    }, key, base64UrlToBytes(record.ciphertext));
    const value = JSON.parse(new TextDecoder().decode(plaintext));
    return normalizeAnnotation(value);
  }

  async function createPairingKeyPair() {
    const keyPair = await global.crypto.subtle.generateKey({
      name: 'ECDH',
      namedCurve: 'P-256',
    }, true, ['deriveKey']);
    return {
      privateKey: await global.crypto.subtle.exportKey('jwk', keyPair.privateKey),
      publicKey: await global.crypto.subtle.exportKey('jwk', keyPair.publicKey),
    };
  }

  async function encryptLibraryKeyEnvelope(publicKeyJwk, pairId) {
    const recipientKey = await global.crypto.subtle.importKey(
      'jwk',
      publicKeyJwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    const ephemeral = await global.crypto.subtle.generateKey({
      name: 'ECDH',
      namedCurve: 'P-256',
    }, true, ['deriveKey']);
    const wrappingKey = await global.crypto.subtle.deriveKey({
      name: 'ECDH',
      public: recipientKey,
    }, ephemeral.privateKey, {
      length: 256,
      name: 'AES-GCM',
    }, false, ['encrypt']);
    const iv = global.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await global.crypto.subtle.encrypt({
      additionalData: new TextEncoder().encode(pairId),
      iv,
      name: 'AES-GCM',
    }, wrappingKey, base64UrlToBytes(state.sync.masterKey));

    return {
      ciphertext: bytesToBase64Url(ciphertext),
      ephemeralPublicKey: await global.crypto.subtle.exportKey('jwk', ephemeral.publicKey),
      iv: bytesToBase64Url(iv),
    };
  }

  async function decryptLibraryKeyEnvelope(envelope, privateKeyJwk, pairId) {
    const privateKey = await global.crypto.subtle.importKey(
      'jwk',
      privateKeyJwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveKey'],
    );
    const publicKey = await global.crypto.subtle.importKey(
      'jwk',
      envelope.ephemeralPublicKey,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    const wrappingKey = await global.crypto.subtle.deriveKey({
      name: 'ECDH',
      public: publicKey,
    }, privateKey, {
      length: 256,
      name: 'AES-GCM',
    }, false, ['decrypt']);
    const plaintext = await global.crypto.subtle.decrypt({
      additionalData: new TextEncoder().encode(pairId),
      iv: base64UrlToBytes(envelope.iv),
      name: 'AES-GCM',
    }, wrappingKey, base64UrlToBytes(envelope.ciphertext));
    return bytesToBase64Url(plaintext);
  }

  function requestWithUserscript(options) {
    if (typeof GM_xmlhttpRequest !== 'function') {
      return global.fetch(options.url, {
        body: options.data,
        headers: options.headers,
        method: options.method,
      }).then(async (response) => ({
        responseText: await response.text(),
        status: response.status,
      }));
    }

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        anonymous: true,
        data: options.data,
        headers: options.headers,
        method: options.method,
        onabort: () => reject(new Error('请求已取消。')),
        onerror: () => reject(new Error('无法连接同步服务。')),
        onload: resolve,
        ontimeout: () => reject(new Error('连接同步服务超时。')),
        timeout: 15000,
        url: options.url,
      });
    });
  }

  async function syncApi(path, options = {}) {
    const endpoint = normalizeSyncEndpoint(options.endpoint || state.sync.endpoint);
    if (!endpoint) throw new Error('请先填写有效的 HTTPS 同步地址。');
    const headers = { accept: 'application/json' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.bootstrapToken) headers['x-bootstrap-token'] = options.bootstrapToken;
    if (options.pairSecret) headers['x-pair-secret'] = options.pairSecret;
    if (options.auth !== false) {
      headers.authorization = `Bearer ${state.sync.deviceToken}`;
      headers['x-device-id'] = state.sync.deviceId;
      headers['x-library-id'] = state.sync.libraryId;
    }

    const response = await requestWithUserscript({
      data: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers,
      method: options.method || (options.body === undefined ? 'GET' : 'POST'),
      url: `${endpoint}${path}`,
    });

    let payload;
    try {
      payload = response.responseText ? JSON.parse(response.responseText) : {};
    } catch (_error) {
      throw new Error(`同步服务返回了无法解析的响应（HTTP ${response.status}）。`);
    }
    if (response.status < 200 || response.status >= 300) {
      const error = new Error(payload?.error?.message || `同步失败（HTTP ${response.status}）。`);
      error.code = payload?.error?.code || 'sync_error';
      error.status = response.status;
      error.details = payload?.error?.details;
      throw error;
    }
    return payload;
  }

  function installGlobalStyles() {
    const css = `
      #aab-reading-mark-layer {
        position: absolute;
        top: 0;
        left: 0;
        z-index: 2;
        width: 0;
        height: 0;
        overflow: visible;
        pointer-events: none;
      }
      .aab-reading-brush-mark,
      .aab-reading-underline-mark {
        position: absolute;
        display: block;
        pointer-events: none;
        transform-origin: left center;
      }
      .aab-reading-brush-mark {
        overflow: hidden;
        background:
          linear-gradient(
            90deg,
            rgba(244, 204, 72, 0.07) 0%,
            rgba(247, 211, 91, 0.20) 3%,
            rgba(247, 211, 91, 0.19) 91%,
            rgba(244, 204, 72, 0.05) 100%
          ),
          repeating-linear-gradient(
            0deg,
            rgba(255, 225, 116, 0.13) 0 1px,
            rgba(242, 201, 67, 0.045) 1px 3px,
            rgba(255, 222, 105, 0.10) 3px 4px
          );
        border-radius: 2px 1px / 22% 18%;
        filter: blur(0.12px);
        mix-blend-mode: multiply;
      }
      .aab-reading-brush-mark[data-line-position="single"] {
        border-radius: 9% 7% 8% 10% / 31% 24% 34% 29%;
      }
      .aab-reading-brush-mark::after {
        position: absolute;
        content: "";
        inset: 18% 1.5% 14%;
        opacity: 0.38;
        background: repeating-linear-gradient(
          0deg,
          transparent 0 2px,
          rgba(229, 185, 47, 0.11) 2px 3px,
          transparent 3px 5px
        );
      }
      .aab-reading-brush-mark--note {
        background:
          linear-gradient(
            90deg,
            rgba(151, 111, 190, 0.04) 0%,
            rgba(163, 122, 203, 0.13) 4%,
            rgba(163, 122, 203, 0.12) 92%,
            rgba(151, 111, 190, 0.035) 100%
          ),
          repeating-linear-gradient(
            0deg,
            rgba(187, 149, 220, 0.08) 0 1px,
            rgba(137, 91, 176, 0.035) 1px 3px,
            rgba(183, 142, 218, 0.065) 3px 4px
          );
      }
      .aab-reading-brush-mark--note::after {
        background: repeating-linear-gradient(
          0deg,
          transparent 0 2px,
          rgba(126, 78, 166, 0.075) 2px 3px,
          transparent 3px 5px
        );
      }
      .aab-reading-underline-mark {
        overflow: visible;
        color: rgba(53, 116, 190, 0.84);
      }
      .aab-reading-underline-mark--note {
        color: rgba(129, 78, 171, 0.78);
      }
      .aab-reading-underline-mark path {
        fill: none;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        vector-effect: non-scaling-stroke;
      }
      .aab-reading-underline-mark .primary {
        stroke-width: 1.55px;
      }
      .aab-reading-underline-mark .ghost {
        opacity: 0.28;
        stroke-width: 0.72px;
      }
      body[data-md-color-scheme="slate"] .aab-reading-brush-mark {
        background:
          linear-gradient(
            90deg,
            rgba(255, 218, 93, 0.035) 0%,
            rgba(255, 219, 99, 0.13) 4%,
            rgba(255, 219, 99, 0.12) 92%,
            rgba(255, 218, 93, 0.03) 100%
          ),
          repeating-linear-gradient(
            0deg,
            rgba(255, 229, 129, 0.08) 0 1px,
            rgba(255, 207, 58, 0.025) 1px 3px,
            rgba(255, 226, 116, 0.065) 3px 4px
          );
        mix-blend-mode: screen;
      }
      body[data-md-color-scheme="slate"] .aab-reading-brush-mark--note {
        background:
          linear-gradient(
            90deg,
            rgba(202, 161, 236, 0.025) 0%,
            rgba(196, 153, 232, 0.095) 4%,
            rgba(196, 153, 232, 0.085) 92%,
            rgba(202, 161, 236, 0.02) 100%
          ),
          repeating-linear-gradient(
            0deg,
            rgba(210, 177, 238, 0.06) 0 1px,
            rgba(172, 120, 214, 0.022) 1px 3px,
            rgba(206, 169, 237, 0.05) 3px 4px
          );
      }
      body[data-md-color-scheme="slate"] .aab-reading-underline-mark {
        color: rgba(111, 171, 234, 0.82);
      }
      body[data-md-color-scheme="slate"] .aab-reading-underline-mark--note {
        color: rgba(188, 139, 226, 0.76);
      }
      ::highlight(${HIGHLIGHT_NAMES.highlight}) {
        color: inherit;
        background-color: rgba(255, 215, 88, 0.18);
      }
      ::highlight(${HIGHLIGHT_NAMES.underline}) {
        color: inherit;
        text-decoration-line: underline;
        text-decoration-color: rgba(66, 133, 214, 0.98);
        text-decoration-thickness: 2px;
        text-underline-offset: 0.18em;
      }
      ::highlight(${HIGHLIGHT_NAMES.note}) {
        color: inherit;
        background-color: rgba(170, 128, 214, 0.30);
        text-decoration-line: underline;
        text-decoration-color: rgba(133, 89, 176, 0.92);
        text-decoration-thickness: 2px;
        text-underline-offset: 0.18em;
      }
      ::highlight(${HIGHLIGHT_NAMES.focus}) {
        color: inherit;
        background-color: rgba(255, 132, 74, 0.58);
      }
    `;

    if (typeof GM_addStyle === 'function') {
      GM_addStyle(css);
      return;
    }

    const style = document.createElement('style');
    style.dataset.aabReadingNotes = 'highlights';
    style.textContent = css;
    document.head.append(style);
  }

  function getArticleRoot() {
    return document.querySelector('.md-content__inner.md-typeset')
      || document.querySelector('article.md-typeset');
  }

  function getPageTitle() {
    const heading = getArticleRoot()?.querySelector('h1');
    const text = heading?.textContent || document.title || '未命名章节';
    return text.replace(/¶\s*$/, '').trim() || '未命名章节';
  }

  function getPageOrder() {
    const current = normalizePageUrl(global.location.href);
    const seen = new Set();
    let index = 0;

    for (const link of document.querySelectorAll('.md-sidebar--primary a[href]')) {
      const pageUrl = normalizePageUrl(link.href);
      if (!pageUrl.includes('/ai-agent-book/book/') || seen.has(pageUrl)) continue;
      seen.add(pageUrl);
      if (pageUrl === current) return index;
      index += 1;
    }

    return 9999;
  }

  function getPageMeta() {
    return {
      pageOrder: getPageOrder(),
      pageTitle: getPageTitle(),
      pageUrl: normalizePageUrl(global.location.href),
    };
  }

  function buildAnchorFromRange(root, range) {
    if (!root || !range || !root.contains(range.startContainer) || !root.contains(range.endContainer)) {
      return null;
    }

    try {
      const source = root.textContent || '';
      const startProbe = document.createRange();
      startProbe.selectNodeContents(root);
      startProbe.setEnd(range.startContainer, range.startOffset);
      const endProbe = document.createRange();
      endProbe.selectNodeContents(root);
      endProbe.setEnd(range.endContainer, range.endOffset);

      let start = startProbe.toString().length;
      let end = endProbe.toString().length;
      if (end < start) [start, end] = [end, start];

      const raw = source.slice(start, end);
      const leading = raw.match(/^\s*/u)?.[0].length || 0;
      const trailing = raw.match(/\s*$/u)?.[0].length || 0;
      start += leading;
      end -= trailing;

      return buildTextAnchor(source, start, end);
    } catch (_error) {
      return null;
    }
  }

  function createRangeFromOffsets(root, start, end) {
    if (!root || start < 0 || end <= start) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let total = 0;
    let node;

    while ((node = walker.nextNode())) {
      const length = node.nodeValue?.length || 0;
      if (!length) continue;
      nodes.push({ end: total + length, node, start: total });
      total += length;
    }

    if (!nodes.length || end > total) return null;

    const startPoint = findTextOffsetPoint(nodes, start, 'start');
    const endPoint = findTextOffsetPoint(nodes, end, 'end');
    if (!startPoint || !endPoint) return null;

    try {
      const range = document.createRange();
      range.setStart(startPoint.node, start - startPoint.start);
      range.setEnd(endPoint.node, end - endPoint.start);
      return range;
    } catch (_error) {
      return null;
    }
  }

  function ensureMarkLayer() {
    if (state.brushLayer?.isConnected) return state.brushLayer;
    const existing = document.getElementById('aab-reading-mark-layer');
    if (existing) existing.remove();

    const layer = document.createElement('div');
    layer.id = 'aab-reading-mark-layer';
    layer.setAttribute('aria-hidden', 'true');
    document.body.append(layer);
    state.brushLayer = layer;
    return layer;
  }

  function getRangeTextLineRects(range) {
    if (!state.root || !range) return [];
    const walker = document.createTreeWalker(state.root, NodeFilter.SHOW_TEXT);
    const rects = [];
    let node;

    while ((node = walker.nextNode())) {
      try {
        if (!node.nodeValue || !range.intersectsNode(node)) continue;

        const start = node === range.startContainer ? range.startOffset : 0;
        const end = node === range.endContainer ? range.endOffset : node.nodeValue.length;
        if (end <= start) continue;

        const textRange = document.createRange();
        textRange.setStart(node, start);
        textRange.setEnd(node, end);
        rects.push(...textRange.getClientRects());
      } catch (_error) {
        // Skip text nodes that became stale during a live page update.
      }
    }

    return mergeTextLineRects(rects);
  }

  function createBrushMark(annotation, rect, lineIndex, lineCount) {
    const variation = getBrushStrokeVariation(annotation.id, lineIndex);
    const mark = document.createElement('span');
    const isNote = annotation.type === 'note';
    const heightScale = isNote ? variation.heightScale * 0.92 : variation.heightScale;
    const verticalOffset = isNote ? variation.verticalOffset + 0.025 : variation.verticalOffset;
    const linePosition = lineCount === 1
      ? 'single'
      : lineIndex === 0
        ? 'first'
        : lineIndex === lineCount - 1
          ? 'last'
          : 'middle';

    mark.className = `aab-reading-brush-mark${isNote ? ' aab-reading-brush-mark--note' : ''}`;
    mark.dataset.annotationId = annotation.id;
    mark.dataset.linePosition = linePosition;
    mark.style.left = `${global.scrollX + rect.left - variation.leftPad}px`;
    mark.style.top = `${global.scrollY + rect.top + rect.height * verticalOffset}px`;
    mark.style.width = `${rect.width + variation.leftPad + variation.rightPad}px`;
    mark.style.height = `${Math.max(7, rect.height * heightScale)}px`;
    mark.style.clipPath = variation.clipPath;
    mark.style.transform = `rotate(${variation.rotation * (lineCount > 1 ? 0.42 : 1)}deg)`;
    return mark;
  }

  function createUnderlineMark(annotation, rect, lineIndex) {
    const variation = getHandUnderlineVariation(annotation.id, lineIndex);
    const namespace = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(namespace, 'svg');
    const primary = document.createElementNS(namespace, 'path');
    const ghost = document.createElementNS(namespace, 'path');
    const isNote = annotation.type === 'note';

    svg.classList.add('aab-reading-underline-mark');
    if (isNote) svg.classList.add('aab-reading-underline-mark--note');
    svg.dataset.annotationId = annotation.id;
    svg.setAttribute('viewBox', '0 0 100 9');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.left = `${global.scrollX + rect.left - 1}px`;
    svg.style.top = `${global.scrollY + rect.bottom - (isNote ? 4.2 : 3.7)}px`;
    svg.style.width = `${Math.max(6, rect.width + 2)}px`;
    svg.style.height = '9px';
    svg.style.transform = `rotate(${variation.rotation}deg)`;

    ghost.classList.add('ghost');
    ghost.setAttribute('d', variation.ghostPath);
    primary.classList.add('primary');
    primary.setAttribute('d', variation.primaryPath);
    svg.append(ghost, primary);
    return svg;
  }

  function renderHandDrawnMarks() {
    const layer = ensureMarkLayer();
    layer.replaceChildren();
    if (!state.root) return;

    const currentPageUrl = normalizePageUrl(global.location.href);
    const brushFragment = document.createDocumentFragment();
    const lineFragment = document.createDocumentFragment();

    for (const annotation of state.store.annotations) {
      if (annotation.pageUrl !== currentPageUrl) continue;
      const resolved = state.resolved.get(annotation.id);
      if (!resolved) continue;

      const rects = getRangeTextLineRects(resolved.range);

      rects.forEach((rect, lineIndex) => {
        if (annotation.type === 'highlight' || annotation.type === 'note') {
          brushFragment.append(createBrushMark(annotation, rect, lineIndex, rects.length));
        }
        if (annotation.type === 'underline' || annotation.type === 'note') {
          lineFragment.append(createUnderlineMark(annotation, rect, lineIndex));
        }
      });
    }

    layer.append(brushFragment, lineFragment);
  }

  function scheduleHandDrawnMarkRefresh() {
    global.clearTimeout(state.brushRefreshTimer);
    state.brushRefreshTimer = global.setTimeout(renderHandDrawnMarks, 80);
  }

  function observeArticleLayout() {
    if (!global.ResizeObserver || state.observedRoot === state.root) return;
    if (!state.rootResizeObserver) {
      state.rootResizeObserver = new global.ResizeObserver(scheduleHandDrawnMarkRefresh);
    }
    state.rootResizeObserver.disconnect();
    state.observedRoot = state.root;
    if (state.root) state.rootResizeObserver.observe(state.root);
  }

  function clearRegisteredHighlights() {
    if (!state.highlightsSupported) return;
    for (const name of Object.values(HIGHLIGHT_NAMES)) {
      global.CSS.highlights.delete(name);
    }
  }

  function renderHighlights() {
    state.root = getArticleRoot();
    state.resolved.clear();
    clearRegisteredHighlights();
    if (!state.root) return;

    const currentPageUrl = normalizePageUrl(global.location.href);
    const source = state.root.textContent || '';

    for (const annotation of state.store.annotations) {
      if (annotation.pageUrl !== currentPageUrl) continue;
      const match = locateTextAnchor(source, annotation.anchor);
      if (!match) continue;
      const range = createRangeFromOffsets(state.root, match.start, match.end);
      if (!range) continue;

      state.resolved.set(annotation.id, {
        confidence: match.confidence,
        range,
        strategy: match.strategy,
      });
    }

    renderHandDrawnMarks();
    observeArticleLayout();
    renderManager();
    updateLauncherCount();
    schedulePendingScroll();
  }

  function createAnnotationId() {
    if (global.crypto?.randomUUID) return `aab-${global.crypto.randomUUID()}`;
    return `aab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function addAnnotation(type, note = '') {
    const pending = state.pendingSelection;
    if (!pending || !ANNOTATION_TYPES[type]) return;

    const duplicate = state.store.annotations.some((annotation) => (
      annotation.pageUrl === pending.pageUrl
      && annotation.type === type
      && annotation.anchor.start === pending.anchor.start
      && annotation.anchor.end === pending.anchor.end
      && annotation.anchor.exact === pending.anchor.exact
    ));
    if (duplicate) {
      showToast(`这段文字已经${ANNOTATION_TYPES[type]}。`);
      closeComposer();
      hideToolbar();
      return;
    }

    const now = new Date().toISOString();
    const annotation = normalizeAnnotation({
      ...pending,
      createdAt: now,
      id: createAnnotationId(),
      note,
      type,
      updatedAt: now,
    });
    if (!annotation) return;

    state.store.annotations.push(annotation);
    if (!persistStore()) return;
    queueAnnotationMutation(annotation);

    global.getSelection()?.removeAllRanges();
    state.pendingSelection = null;
    hideToolbar();
    closeComposer();
    renderHighlights();
    showToast(`${ANNOTATION_TYPES[type]}已保存到本地。`, 'success');
  }

  function deleteAnnotation(id) {
    const annotation = state.store.annotations.find((item) => item.id === id);
    if (!annotation) return;
    if (!global.confirm(`删除这条${ANNOTATION_TYPES[annotation.type]}记录？`)) return;

    state.store.annotations = state.store.annotations.filter((item) => item.id !== id);
    if (!persistStore()) return;
    queueAnnotationMutation(null, { deleted: true, recordId: id });
    renderHighlights();
    showToast('记录已删除。');
  }

  function updateAnnotationNote(id, note) {
    const annotation = state.store.annotations.find((item) => item.id === id);
    if (!annotation || annotation.type !== 'note') return;

    annotation.note = String(note || '').trim();
    annotation.updatedAt = new Date().toISOString();
    if (!persistStore()) return;
    queueAnnotationMutation(annotation);
    closeComposer();
    renderManager();
    showToast('批注已更新。', 'success');
  }

  function replaceLocalAnnotation(annotation) {
    const index = state.store.annotations.findIndex((item) => item.id === annotation.id);
    if (index === -1) state.store.annotations.push(annotation);
    else state.store.annotations[index] = annotation;
  }

  async function applyRemoteRecord(record) {
    if (!record?.recordId || !Number.isSafeInteger(Number(record.version))) return;
    state.sync.versions[record.recordId] = Number(record.version);
    if (record.deleted) {
      state.store.annotations = state.store.annotations
        .filter((annotation) => annotation.id !== record.recordId);
      return;
    }

    const annotation = await decryptAnnotationPayload(record);
    if (!annotation || annotation.id !== record.recordId) {
      throw new Error('远端笔记记录与加密内容不一致。');
    }
    replaceLocalAnnotation(annotation);
  }

  async function resolveSyncConflict(pending, current) {
    state.sync.pending = state.sync.pending
      .filter((item) => item.mutationId !== pending.mutationId);

    if (!current) {
      const retry = {
        ...pending,
        baseVersion: 0,
        mutationId: `mut-${randomBase64Url(18)}`,
      };
      state.sync.pending.push(retry);
      return;
    }

    await applyRemoteRecord(current);
    if (pending.deleted || !pending.snapshot) return;

    const conflictCopy = normalizeAnnotation({
      ...pending.snapshot,
      id: createAnnotationId(),
      syncConflict: true,
      updatedAt: new Date().toISOString(),
    });
    if (!conflictCopy) return;
    state.store.annotations.push(conflictCopy);
    const conflictMutation = createPendingMutation(state.sync, conflictCopy);
    if (conflictMutation) state.sync.pending.push(conflictMutation);
  }

  async function buildEncryptedMutation(pending) {
    if (pending.deleted) {
      return {
        baseVersion: pending.baseVersion,
        deleted: true,
        mutationId: pending.mutationId,
        recordId: pending.recordId,
      };
    }

    const encrypted = await encryptAnnotationPayload(
      pending.snapshot,
      pending.recordId,
      pending.baseVersion + 1,
    );
    return {
      ...encrypted,
      baseVersion: pending.baseVersion,
      deleted: false,
      mutationId: pending.mutationId,
      recordId: pending.recordId,
    };
  }

  async function processSyncResponse(response) {
    for (const accepted of response.accepted || []) {
      const current = state.sync.pending
        .find((item) => item.recordId === accepted.recordId);
      if (current?.mutationId === accepted.mutationId) {
        state.sync.pending = state.sync.pending
          .filter((item) => item.mutationId !== accepted.mutationId);
      } else if (current) {
        current.baseVersion = Math.max(current.baseVersion, Number(accepted.version) || 0);
      }
      state.sync.versions[accepted.recordId] = Number(accepted.version) || 0;
    }

    for (const conflict of response.conflicts || []) {
      const pending = state.sync.pending
        .find((item) => item.mutationId === conflict.mutationId);
      if (pending) await resolveSyncConflict(pending, conflict.current);
    }

    for (const change of response.changes || []) {
      const pending = state.sync.pending
        .find((item) => item.recordId === change.recordId);
      if (pending && Number(change.version) <= pending.baseVersion) continue;
      if (pending) {
        await resolveSyncConflict(pending, change);
      } else {
        await applyRemoteRecord(change);
      }
    }

    state.sync.cursor = Number(response.cursor) || state.sync.cursor;
    state.sync.lastSyncAt = new Date().toISOString();
  }

  async function syncNow(options = {}) {
    if (!isSyncConfigured() || state.syncing) return false;
    state.syncing = true;
    state.syncError = '';
    renderSyncUi();

    try {
      let rounds = 0;
      let hasMore = true;
      while (hasMore && rounds < 30) {
        rounds += 1;
        const batch = state.sync.pending.slice(0, SYNC_CONFIG.maxBatchSize);
        const mutations = [];
        for (const pending of batch) {
          mutations.push(await buildEncryptedMutation(pending));
        }
        const response = await syncApi('/v1/sync', {
          body: {
            mutations,
            since: state.sync.cursor,
          },
        });
        await processSyncResponse(response);
        hasMore = Boolean(response.hasMore || state.sync.pending.length);

        if (!response.hasMore && !batch.length && !response.changes?.length) break;
      }

      state.store.annotations.sort(compareAnnotations);
      persistStore();
      persistSyncState();
      renderHighlights();
      if (!options.silent) showToast('读书笔记已同步。', 'success');
      return true;
    } catch (error) {
      state.syncError = error.message || '同步失败。';
      renderSyncUi();
      if (!options.silent) showToast(state.syncError, 'error');
      return false;
    } finally {
      state.syncing = false;
      renderSyncUi();
    }
  }

  function scheduleSync(delay = 900) {
    if (!isSyncConfigured()) return;
    global.clearTimeout(state.syncTimer);
    state.syncTimer = global.setTimeout(() => syncNow({ silent: true }), delay);
  }

  function syncFormValues() {
    return {
      deviceName: String(state.ui?.syncDeviceName?.value || '').trim().slice(0, 80),
      endpoint: normalizeSyncEndpoint(state.ui?.syncEndpoint?.value),
    };
  }

  function createDeviceIdentity(deviceName) {
    return {
      deviceId: `dev_${randomBase64Url(18)}`,
      deviceName,
      deviceToken: randomBase64Url(32),
    };
  }

  async function bootstrapSync() {
    const { deviceName, endpoint } = syncFormValues();
    if (!endpoint || !deviceName) {
      showToast('请先填写同步地址和设备名称。', 'error');
      return;
    }
    const bootstrapToken = String(state.ui?.syncSecret?.value || '').trim();
    if (!bootstrapToken) {
      showToast('请在“初始化密钥 / 配对码”中填写 BOOTSTRAP_TOKEN。', 'error');
      state.ui?.syncSecret?.focus();
      return;
    }
    state.ui.syncSecret.value = '';

    const identity = createDeviceIdentity(deviceName);
    const libraryId = `lib_${randomBase64Url(18)}`;
    const masterKey = randomBase64Url(32);

    try {
      await syncApi('/v1/bootstrap', {
        auth: false,
        body: {
          deviceId: identity.deviceId,
          deviceName,
          libraryId,
          tokenHash: await sha256Base64Url(identity.deviceToken),
        },
        bootstrapToken,
        endpoint,
      });
      state.sync = normalizeSyncState({
        ...identity,
        endpoint,
        libraryId,
        masterKey,
      });
      persistSyncState();
      queueAllLocalAnnotations();
      renderSyncUi();
      await syncNow();
      loadSyncDevices();
    } catch (error) {
      showToast(error.message || '初始化同步失败。', 'error');
    }
  }

  async function createPairingInvitation() {
    if (!isSyncConfigured()) {
      showToast('请先在这台设备上初始化或加入笔记库。', 'error');
      return;
    }
    try {
      const response = await syncApi('/v1/pair/invite', { body: {} });
      state.sync.pairing = {
        code: response.code,
        deviceId: '',
        deviceName: '',
        deviceToken: '',
        endpoint: state.sync.endpoint,
        expiresAt: response.expiresAt,
        pairId: response.pairId,
        pairSecret: '',
        privateKey: null,
        role: 'inviter',
      };
      persistSyncState();
      showToast(`配对码：${response.code}`, 'success');
      schedulePairingPoll(500);
    } catch (error) {
      showToast(error.message || '无法创建配对码。', 'error');
    }
  }

  async function joinExistingLibrary() {
    const { deviceName, endpoint } = syncFormValues();
    if (!endpoint || !deviceName) {
      showToast('请先填写同步地址和设备名称。', 'error');
      return;
    }
    const code = String(state.ui?.syncSecret?.value || '')
      .trim()
      .toUpperCase();
    if (!code) {
      showToast('请在“初始化密钥 / 配对码”中填写可信设备显示的配对码。', 'error');
      state.ui?.syncSecret?.focus();
      return;
    }
    state.ui.syncSecret.value = '';

    try {
      const identity = createDeviceIdentity(deviceName);
      const pairSecret = randomBase64Url(32);
      const keyPair = await createPairingKeyPair();
      const response = await syncApi('/v1/pair/claim', {
        auth: false,
        body: {
          code,
          deviceId: identity.deviceId,
          deviceName,
          pairSecretHash: await sha256Base64Url(pairSecret),
          publicKey: keyPair.publicKey,
          tokenHash: await sha256Base64Url(identity.deviceToken),
        },
        endpoint,
      });
      state.sync = normalizeSyncState({
        deviceName,
        endpoint,
        pairing: {
          code,
          ...identity,
          endpoint,
          pairId: response.pairId,
          pairSecret,
          privateKey: keyPair.privateKey,
          role: 'joiner',
        },
      });
      persistSyncState();
      showToast('已提交申请，请在可信设备上确认。', 'success');
      schedulePairingPoll(500);
    } catch (error) {
      showToast(error.message || '加入笔记库失败。', 'error');
    }
  }

  async function pollInviterPairing(pairing) {
    const response = await syncApi(
      `/v1/pair/request?pairId=${encodeURIComponent(pairing.pairId)}`,
    );
    if (response.status === 'invited') return false;
    if (response.status !== 'claimed' || !response.publicKey) return true;

    const approved = global.confirm(
      `允许“${response.deviceName || '新设备'}”加入你的读书笔记吗？`,
    );
    if (!approved) {
      state.sync.pairing = null;
      persistSyncState();
      showToast('已拒绝该设备；如需重试请生成新的配对码。');
      return true;
    }

    const keyEnvelope = await encryptLibraryKeyEnvelope(
      response.publicKey,
      response.pairId,
    );
    await syncApi('/v1/pair/approve', {
      body: {
        keyEnvelope,
        pairId: response.pairId,
      },
    });
    state.sync.pairing = null;
    persistSyncState();
    showToast(`${response.deviceName || '新设备'}已获准加入。`, 'success');
    loadSyncDevices();
    return true;
  }

  async function pollJoiningPairing(pairing) {
    const response = await syncApi(
      `/v1/pair/status?pairId=${encodeURIComponent(pairing.pairId)}`,
      {
        auth: false,
        endpoint: pairing.endpoint,
        pairSecret: pairing.pairSecret,
      },
    );
    if (response.status === 'claimed') return false;
    if (response.status !== 'approved' || !response.keyEnvelope) {
      if (response.status === 'expired') {
        state.sync.pairing = null;
        persistSyncState();
        showToast('配对码已过期，请重新申请。', 'error');
      }
      return true;
    }

    const masterKey = await decryptLibraryKeyEnvelope(
      response.keyEnvelope,
      pairing.privateKey,
      pairing.pairId,
    );
    state.sync = normalizeSyncState({
      cursor: 0,
      deviceId: pairing.deviceId,
      deviceName: pairing.deviceName,
      deviceToken: pairing.deviceToken,
      endpoint: pairing.endpoint,
      libraryId: response.libraryId,
      masterKey,
    });
    persistSyncState();
    queueAllLocalAnnotations();
    showToast('新设备配对成功，正在下载笔记。', 'success');
    await syncNow({ silent: true });
    loadSyncDevices();
    return true;
  }

  async function pollPairing() {
    global.clearTimeout(state.pairingTimer);
    const pairing = state.sync?.pairing;
    if (!pairing?.pairId) return;
    const expiresAt = Date.parse(pairing.expiresAt);
    if (
      Number.isFinite(expiresAt)
      && expiresAt <= Date.now()
      && pairing.role === 'inviter'
    ) {
      state.sync.pairing = null;
      persistSyncState();
      showToast('配对码已过期，请重新生成。', 'error');
      return;
    }
    try {
      const finished = pairing.role === 'inviter'
        ? await pollInviterPairing(pairing)
        : await pollJoiningPairing(pairing);
      state.syncError = '';
      renderSyncUi();
      if (!finished) schedulePairingPoll();
    } catch (error) {
      state.syncError = error.message || '检查配对状态失败。';
      renderSyncUi();
      schedulePairingPoll(5000);
    }
  }

  function schedulePairingPoll(delay = SYNC_CONFIG.pairingPollMs) {
    global.clearTimeout(state.pairingTimer);
    if (!state.sync?.pairing) return;
    state.pairingTimer = global.setTimeout(pollPairing, delay);
  }

  async function loadSyncDevices() {
    if (!isSyncConfigured()) return;
    try {
      const response = await syncApi('/v1/devices');
      state.syncDevices = response.devices || [];
      renderSyncUi();
    } catch (error) {
      state.syncError = error.message || '无法读取设备列表。';
      renderSyncUi();
    }
  }

  async function revokeSyncDevice(deviceId) {
    const device = state.syncDevices.find((item) => item.deviceId === deviceId);
    if (!device || device.current || device.revokedAt) return;
    if (!global.confirm(`撤销“${device.deviceName}”的同步权限？`)) return;
    try {
      await syncApi('/v1/devices/revoke', { body: { deviceId } });
      showToast('设备权限已撤销。', 'success');
      await loadSyncDevices();
    } catch (error) {
      showToast(error.message || '撤销设备失败。', 'error');
    }
  }

  function disconnectSyncDevice() {
    if (!global.confirm('断开本机同步？本地笔记不会删除，但需要重新配对才能继续同步。')) return;
    global.clearTimeout(state.syncTimer);
    global.clearTimeout(state.pairingTimer);
    state.sync = normalizeSyncState({});
    state.syncDevices = [];
    state.syncError = '';
    persistSyncState();
    renderSyncUi();
  }

  function syncUiTheme() {
    if (!state.ui) return;
    const isDark = document.body?.dataset.mdColorScheme === 'slate';
    state.ui.host.dataset.theme = isDark ? 'dark' : 'light';
  }

  function mountUi() {
    const existing = document.getElementById(CONFIG.uiHostId);
    if (existing) existing.remove();

    const host = document.createElement('div');
    host.id = CONFIG.uiHostId;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          --accent: #9b5b3d;
          --accent-soft: #f3e4d9;
          --backdrop: rgba(30, 24, 20, 0.24);
          --border: #ddd4c8;
          --danger: #b33a3a;
          --muted: #716a62;
          --panel: #fffdf8;
          --panel-2: #f5f0e8;
          --shadow: 0 18px 48px rgba(49, 39, 31, 0.22);
          --text: #312d29;
          color: var(--text);
          font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
          font-size: 14px;
          line-height: 1.5;
        }
        :host([data-theme="dark"]) {
          --accent: #df9873;
          --accent-soft: #3e2f28;
          --backdrop: rgba(0, 0, 0, 0.42);
          --border: #45443f;
          --danger: #ef8484;
          --muted: #aaa59b;
          --panel: #22231f;
          --panel-2: #2b2c27;
          --shadow: 0 18px 48px rgba(0, 0, 0, 0.42);
          --text: #ebe6db;
        }
        *, *::before, *::after { box-sizing: border-box; }
        button, input, textarea { font: inherit; }
        button { color: inherit; }
        [hidden] { display: none !important; }
        #toolbar {
          position: fixed;
          z-index: 2147483646;
          display: flex;
          gap: 4px;
          padding: 5px;
          background: var(--panel);
          border: 1px solid var(--border);
          border-radius: 10px;
          box-shadow: var(--shadow);
          transform: translateX(-50%);
        }
        #toolbar button {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          min-height: 32px;
          padding: 5px 9px;
          background: transparent;
          border: 0;
          border-radius: 7px;
          cursor: pointer;
          white-space: nowrap;
        }
        #toolbar button:hover { background: var(--panel-2); }
        .swatch {
          width: 12px;
          height: 12px;
          border-radius: 3px;
        }
        .swatch--highlight { background: rgba(255, 210, 74, 0.82); }
        .swatch--underline {
          height: 10px;
          border-bottom: 2px solid #4285d6;
          border-radius: 0;
        }
        .swatch--note {
          background: rgba(170, 128, 214, 0.54);
          border-bottom: 2px solid #8559b0;
        }
        #launcher {
          position: fixed;
          right: 22px;
          bottom: 22px;
          z-index: 2147483644;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          height: 42px;
          padding: 0 15px;
          color: #fff;
          background: #8d573d;
          border: 0;
          border-radius: 999px;
          box-shadow: 0 8px 24px rgba(65, 43, 31, 0.28);
          cursor: pointer;
          font-weight: 650;
        }
        :host([data-theme="dark"]) #launcher { color: #1d1815; background: #df9873; }
        #count {
          min-width: 20px;
          padding: 1px 6px;
          color: #fff;
          background: rgba(255, 255, 255, 0.20);
          border-radius: 999px;
          font-size: 12px;
          text-align: center;
        }
        :host([data-theme="dark"]) #count {
          color: #1d1815;
          background: rgba(20, 14, 10, 0.14);
        }
        #backdrop {
          position: fixed;
          inset: 0;
          z-index: 2147483644;
          background: var(--backdrop);
          backdrop-filter: blur(2px);
        }
        #drawer {
          position: fixed;
          top: 0;
          right: 0;
          bottom: 0;
          z-index: 2147483645;
          display: flex;
          flex-direction: column;
          width: min(420px, 94vw);
          color: var(--text);
          background: var(--panel);
          border-left: 1px solid var(--border);
          box-shadow: var(--shadow);
          transform: translateX(102%);
          transition: transform 180ms ease;
        }
        #drawer.open { transform: translateX(0); }
        .drawer-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
          padding: 20px 20px 14px;
          border-bottom: 1px solid var(--border);
        }
        .drawer-header h2 { margin: 0; font-size: 19px; }
        .drawer-header p { margin: 3px 0 0; color: var(--muted); font-size: 12px; }
        .icon-button {
          display: grid;
          place-items: center;
          width: 34px;
          height: 34px;
          padding: 0;
          background: transparent;
          border: 0;
          border-radius: 8px;
          cursor: pointer;
          font-size: 22px;
        }
        .icon-button:hover { background: var(--panel-2); }
        .filters {
          display: flex;
          gap: 6px;
          padding: 12px 20px;
          border-bottom: 1px solid var(--border);
        }
        .filters button {
          padding: 6px 12px;
          color: var(--muted);
          background: transparent;
          border: 1px solid transparent;
          border-radius: 999px;
          cursor: pointer;
        }
        .filters button.active {
          color: var(--accent);
          background: var(--accent-soft);
          border-color: color-mix(in srgb, var(--accent) 24%, transparent);
          font-weight: 650;
        }
        .sync-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          min-height: 38px;
          padding: 7px 20px;
          color: var(--muted);
          border-bottom: 1px solid var(--border);
          font-size: 12px;
        }
        .sync-bar button {
          padding: 3px 8px;
          color: var(--accent);
          background: transparent;
          border: 0;
          border-radius: 6px;
          cursor: pointer;
        }
        #sync-panel {
          max-height: min(410px, 54vh);
          overflow: auto;
          padding: 14px 20px 16px;
          background: var(--panel-2);
          border-bottom: 1px solid var(--border);
        }
        #sync-panel label {
          display: grid;
          gap: 4px;
          margin-bottom: 10px;
          color: var(--muted);
          font-size: 12px;
        }
        #sync-panel input {
          width: 100%;
          min-height: 34px;
          padding: 6px 8px;
          color: var(--text);
          background: var(--panel);
          border: 1px solid var(--border);
          border-radius: 7px;
          outline: none;
        }
        #sync-panel input:focus { border-color: var(--accent); }
        .sync-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 7px;
          margin-top: 12px;
        }
        .sync-actions button,
        .device-row button {
          min-height: 32px;
          padding: 5px 9px;
          color: var(--text);
          background: var(--panel);
          border: 1px solid var(--border);
          border-radius: 7px;
          cursor: pointer;
        }
        .sync-actions button:hover,
        .device-row button:hover { border-color: var(--accent); }
        .pairing-card {
          margin-top: 12px;
          padding: 10px;
          background: var(--panel);
          border: 1px dashed var(--accent);
          border-radius: 8px;
        }
        .pairing-code {
          display: block;
          margin: 4px 0;
          color: var(--accent);
          font-size: 20px;
          font-weight: 750;
          letter-spacing: 0.12em;
          user-select: all;
        }
        .pairing-card p,
        .sync-help { margin: 4px 0; color: var(--muted); font-size: 12px; }
        #device-list { margin-top: 12px; }
        .device-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          align-items: center;
          gap: 8px;
          padding: 8px 0;
          border-top: 1px solid var(--border);
        }
        .device-row strong,
        .device-row small { display: block; }
        .device-row small { color: var(--muted); }
        .device-row button { min-height: 28px; color: var(--danger); font-size: 12px; }
        #list {
          flex: 1 1 auto;
          min-height: 0;
          overflow: auto;
          padding: 14px 16px 28px;
        }
        .empty {
          margin: 34px 8px;
          color: var(--muted);
          text-align: center;
        }
        .annotation {
          margin: 0 0 12px;
          padding: 14px;
          background: var(--panel-2);
          border: 1px solid var(--border);
          border-left: 4px solid #d2a63f;
          border-radius: 9px;
        }
        .annotation[data-type="underline"] { border-left-color: #4f86c6; }
        .annotation[data-type="note"] { border-left-color: #8c6bb1; }
        .annotation-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin-bottom: 8px;
          color: var(--muted);
          font-size: 12px;
        }
        .annotation-title {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .annotation-quote {
          margin: 0;
          color: var(--text);
          display: -webkit-box;
          overflow: hidden;
          -webkit-box-orient: vertical;
          -webkit-line-clamp: 4;
          white-space: pre-wrap;
          cursor: pointer;
          font-family: "Songti SC", "Source Han Serif SC", serif;
          font-size: 15px;
          line-height: 1.65;
        }
        .annotation-note {
          margin: 10px 0 0;
          padding: 9px 10px;
          color: var(--text);
          background: var(--panel);
          border-radius: 6px;
          white-space: pre-wrap;
        }
        .annotation-status {
          margin-top: 8px;
          color: var(--danger);
          font-size: 12px;
        }
        .annotation-actions {
          display: flex;
          justify-content: flex-end;
          gap: 4px;
          margin-top: 10px;
        }
        .annotation-actions button {
          padding: 4px 8px;
          color: var(--muted);
          background: transparent;
          border: 0;
          border-radius: 6px;
          cursor: pointer;
          font-size: 12px;
        }
        .annotation-actions button:hover { color: var(--text); background: var(--panel); }
        .annotation-actions .danger:hover { color: var(--danger); }
        .drawer-footer {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 8px;
          padding: 14px 16px 18px;
          background: var(--panel);
          border-top: 1px solid var(--border);
        }
        .drawer-footer button,
        .modal-actions button {
          min-height: 38px;
          padding: 7px 12px;
          background: var(--panel-2);
          border: 1px solid var(--border);
          border-radius: 8px;
          cursor: pointer;
        }
        .drawer-footer button:hover { border-color: var(--accent); }
        #modal-layer {
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          display: grid;
          place-items: center;
          padding: 16px;
          background: var(--backdrop);
          backdrop-filter: blur(3px);
        }
        #modal {
          width: min(520px, 96vw);
          padding: 20px;
          color: var(--text);
          background: var(--panel);
          border: 1px solid var(--border);
          border-radius: 12px;
          box-shadow: var(--shadow);
        }
        #modal h3 { margin: 0 0 10px; font-size: 18px; }
        #modal-quote {
          max-height: 130px;
          overflow: auto;
          margin: 0 0 14px;
          padding: 10px 12px;
          color: var(--muted);
          background: var(--panel-2);
          border-left: 3px solid #8c6bb1;
          border-radius: 6px;
          white-space: pre-wrap;
          font-family: "Songti SC", "Source Han Serif SC", serif;
        }
        #note-input {
          display: block;
          width: 100%;
          min-height: 140px;
          resize: vertical;
          padding: 11px 12px;
          color: var(--text);
          background: var(--panel);
          border: 1px solid var(--border);
          border-radius: 8px;
          outline: none;
        }
        #note-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
        .modal-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          margin-top: 14px;
        }
        .modal-actions .primary {
          color: #fff;
          background: #8d573d;
          border-color: #8d573d;
          font-weight: 650;
        }
        :host([data-theme="dark"]) .modal-actions .primary {
          color: #1d1815;
          background: #df9873;
          border-color: #df9873;
        }
        #toast {
          position: fixed;
          left: 50%;
          bottom: 26px;
          z-index: 2147483647;
          max-width: min(420px, calc(100vw - 32px));
          padding: 10px 14px;
          color: var(--text);
          background: var(--panel);
          border: 1px solid var(--border);
          border-radius: 9px;
          box-shadow: var(--shadow);
          opacity: 0;
          pointer-events: none;
          transform: translate(-50%, 10px);
          transition: opacity 140ms ease, transform 140ms ease;
        }
        #toast.show { opacity: 1; transform: translate(-50%, 0); }
        #toast[data-kind="error"] { color: var(--danger); }
        #toast[data-kind="success"] { color: var(--accent); }
        @media (max-width: 600px) {
          #launcher { right: 14px; bottom: 14px; }
          #toolbar { max-width: calc(100vw - 16px); }
          #toolbar button { padding: 5px 7px; }
          .drawer-header { padding-top: 16px; }
        }
        @media (prefers-reduced-motion: reduce) {
          #drawer, #toast { transition: none; }
        }
      </style>
      <div id="toolbar" role="toolbar" aria-label="选中文本操作" hidden>
        <button type="button" data-action="add-highlight">
          <span class="swatch swatch--highlight"></span>高亮
        </button>
        <button type="button" data-action="add-underline">
          <span class="swatch swatch--underline"></span>划线
        </button>
        <button type="button" data-action="add-note">
          <span class="swatch swatch--note"></span>写批注
        </button>
      </div>
      <button id="launcher" type="button" aria-label="打开读书笔记">
        读书笔记 <span id="count">0</span>
      </button>
      <div id="backdrop" data-action="close-drawer" hidden></div>
      <aside id="drawer" aria-hidden="true">
        <header class="drawer-header">
          <div>
            <h2>读书笔记</h2>
            <p id="summary">本页 0 条 · 全书 0 条</p>
          </div>
          <button class="icon-button" type="button" data-action="close-drawer" aria-label="关闭">×</button>
        </header>
        <nav class="filters" aria-label="笔记范围">
          <button type="button" data-filter="current" class="active">本页</button>
          <button type="button" data-filter="all">全书</button>
        </nav>
        <div class="sync-bar">
          <span id="sync-status">仅保存在本机</span>
          <button type="button" data-action="sync-now">立即同步</button>
        </div>
        <section id="sync-panel" hidden>
          <label>
            同步服务地址
            <input id="sync-endpoint" type="url" inputmode="url"
              placeholder="https://reading-notes-sync.example.workers.dev">
          </label>
          <label>
            本机名称
            <input id="sync-device-name" maxlength="80" placeholder="例如：家里的 MacBook">
          </label>
          <label>
            初始化密钥 / 配对码
            <input id="sync-secret" type="password" autocomplete="off"
              placeholder="只在本次操作中使用，不会保存">
          </label>
          <p class="sync-help">笔记正文会先在本机使用 AES-GCM 加密，再发送到 Cloudflare。</p>
          <div class="sync-actions">
            <button type="button" data-action="sync-bootstrap">初始化笔记库</button>
            <button type="button" data-action="sync-invite">生成新设备配对码</button>
            <button type="button" data-action="sync-join">加入已有笔记库</button>
            <button type="button" data-action="sync-refresh-devices">刷新设备</button>
            <button type="button" data-action="sync-disconnect">断开本机</button>
          </div>
          <div id="pairing-info"></div>
          <div id="device-list"></div>
        </section>
        <div id="list"></div>
        <footer class="drawer-footer">
          <button type="button" data-action="export-markdown">导出 Markdown</button>
          <button type="button" data-action="export-html">导出网页</button>
          <button type="button" data-action="toggle-sync-panel">同步设置</button>
        </footer>
      </aside>
      <div id="modal-layer" hidden>
        <form id="modal">
          <h3 id="modal-title">写批注</h3>
          <p id="modal-quote"></p>
          <textarea id="note-input" placeholder="写下你的观点、疑问或联想……" required></textarea>
          <div class="modal-actions">
            <button type="button" data-action="close-composer">取消</button>
            <button class="primary" type="submit">保存批注</button>
          </div>
        </form>
      </div>
      <div id="toast" role="status" aria-live="polite"></div>
    `;
    document.documentElement.append(host);

    state.ui = {
      backdrop: shadow.getElementById('backdrop'),
      count: shadow.getElementById('count'),
      drawer: shadow.getElementById('drawer'),
      host,
      list: shadow.getElementById('list'),
      modalLayer: shadow.getElementById('modal-layer'),
      modalQuote: shadow.getElementById('modal-quote'),
      modalTitle: shadow.getElementById('modal-title'),
      noteInput: shadow.getElementById('note-input'),
      shadow,
      summary: shadow.getElementById('summary'),
      syncDeviceName: shadow.getElementById('sync-device-name'),
      syncEndpoint: shadow.getElementById('sync-endpoint'),
      syncPanel: shadow.getElementById('sync-panel'),
      syncSecret: shadow.getElementById('sync-secret'),
      syncStatus: shadow.getElementById('sync-status'),
      pairingInfo: shadow.getElementById('pairing-info'),
      deviceList: shadow.getElementById('device-list'),
      toast: shadow.getElementById('toast'),
      toolbar: shadow.getElementById('toolbar'),
    };

    state.ui.toolbar.addEventListener('pointerdown', (event) => event.preventDefault());
    shadow.addEventListener('click', handleUiClick);
    shadow.getElementById('modal').addEventListener('submit', handleComposerSubmit);
    syncUiTheme();
    renderManager();
    updateLauncherCount();
  }

  function showToast(message, kind = 'info') {
    if (!state.ui) return;
    const toast = state.ui.toast;
    toast.textContent = String(message || '');
    toast.dataset.kind = kind;
    toast.classList.add('show');
    global.clearTimeout(showToast.timer);
    showToast.timer = global.setTimeout(() => toast.classList.remove('show'), 2400);
  }

  function currentPageAnnotations() {
    const pageUrl = normalizePageUrl(global.location.href);
    return state.store.annotations.filter((annotation) => annotation.pageUrl === pageUrl);
  }

  function updateLauncherCount() {
    if (!state.ui) return;
    state.ui.count.textContent = String(state.store.annotations.length);
    state.ui.summary.textContent = `本页 ${currentPageAnnotations().length} 条 · 全书 ${state.store.annotations.length} 条`;
  }

  function renderSyncUi() {
    if (!state.ui?.syncStatus) return;
    const configured = isSyncConfigured();
    const pendingCount = state.sync?.pending?.length || 0;
    let status = '仅保存在本机';
    if (state.syncing) status = '正在同步…';
    else if (state.syncError) status = `同步异常：${state.syncError}`;
    else if (state.sync?.pairing?.role === 'joiner') status = '等待可信设备批准';
    else if (state.sync?.pairing?.role === 'inviter') status = '等待新设备认领';
    else if (configured && pendingCount) status = `待同步 ${pendingCount} 条`;
    else if (configured && state.sync.lastSyncAt) {
      status = `已同步 · ${formatReadableDate(state.sync.lastSyncAt)}`;
    } else if (configured) status = '同步已启用';
    state.ui.syncStatus.textContent = status;
    state.ui.syncStatus.title = state.syncError || status;

    if (state.ui.shadow.activeElement !== state.ui.syncEndpoint) {
      state.ui.syncEndpoint.value = state.sync.endpoint
        || state.sync.pairing?.endpoint
        || state.ui.syncEndpoint.value;
    }
    if (state.ui.shadow.activeElement !== state.ui.syncDeviceName) {
      state.ui.syncDeviceName.value = state.sync.deviceName
        || state.sync.pairing?.deviceName
        || state.ui.syncDeviceName.value
        || `${navigator.platform || '浏览器'}设备`;
    }

    for (const action of ['sync-invite', 'sync-refresh-devices', 'sync-disconnect']) {
      const button = state.ui.shadow.querySelector(`[data-action="${action}"]`);
      if (button) button.hidden = !configured;
    }
    for (const action of ['sync-bootstrap', 'sync-join']) {
      const button = state.ui.shadow.querySelector(`[data-action="${action}"]`);
      if (button) button.hidden = configured;
    }

    const pairing = state.sync?.pairing;
    if (!pairing) {
      state.ui.pairingInfo.innerHTML = '';
    } else if (pairing.role === 'inviter') {
      state.ui.pairingInfo.innerHTML = `
        <div class="pairing-card">
          <p>请在新设备的同步设置中输入：</p>
          <strong class="pairing-code">${escapeHtml(pairing.code)}</strong>
          <p>有效期至 ${escapeHtml(formatReadableDate(pairing.expiresAt))}，本页会自动等待认领。</p>
        </div>`;
    } else {
      state.ui.pairingInfo.innerHTML = `
        <div class="pairing-card">
          <p>已认领配对码 <strong>${escapeHtml(pairing.code)}</strong></p>
          <p>请回到可信设备确认“${escapeHtml(pairing.deviceName)}”。</p>
        </div>`;
    }

    state.ui.deviceList.innerHTML = state.syncDevices.length
      ? state.syncDevices.map((device) => {
        const stateText = device.revokedAt
          ? `已撤销 · ${formatReadableDate(device.revokedAt)}`
          : device.current ? '当前设备' : `最近同步 ${formatReadableDate(device.lastSeenAt)}`;
        const action = !device.current && !device.revokedAt
          ? `<button type="button" data-action="sync-revoke-device" data-id="${escapeHtml(device.deviceId)}">撤销</button>`
          : '';
        return `
          <div class="device-row">
            <div>
              <strong>${escapeHtml(device.deviceName)}</strong>
              <small>${escapeHtml(stateText)}</small>
            </div>
            ${action}
          </div>`;
      }).join('')
      : '';
  }

  function renderManager() {
    if (!state.ui) return;
    syncUiTheme();
    updateLauncherCount();
    renderSyncUi();

    for (const button of state.ui.shadow.querySelectorAll('[data-filter]')) {
      button.classList.toggle('active', button.dataset.filter === state.filter);
    }

    const annotations = state.filter === 'all'
      ? [...state.store.annotations].sort(compareAnnotations)
      : currentPageAnnotations().sort(compareAnnotations);

    if (!annotations.length) {
      state.ui.list.innerHTML = `
        <p class="empty">${state.filter === 'all'
    ? '还没有读书笔记。选中正文即可开始。'
    : '本页还没有记录。选中一段正文试试。'}</p>`;
      return;
    }

    const currentPageUrl = normalizePageUrl(global.location.href);
    state.ui.list.innerHTML = annotations.map((annotation) => {
      const isCurrentPage = annotation.pageUrl === currentPageUrl;
      const isResolved = !isCurrentPage || state.resolved.has(annotation.id);
      const note = annotation.note
        ? `<p class="annotation-note">${escapeHtml(annotation.note)}</p>`
        : '';
      const conflict = annotation.syncConflict
        ? '<p class="annotation-status">这是一份并发修改产生的冲突副本，请确认后保留或删除。</p>'
        : '';
      const edit = annotation.type === 'note'
        ? `<button type="button" data-action="edit-note" data-id="${escapeHtml(annotation.id)}">编辑</button>`
        : '';

      return `
        <article class="annotation" data-type="${escapeHtml(annotation.type)}">
          <header class="annotation-head">
            <span>${escapeHtml(ANNOTATION_TYPES[annotation.type])}</span>
            <span class="annotation-title" title="${escapeHtml(annotation.pageTitle)}">${escapeHtml(annotation.pageTitle)}</span>
          </header>
          <p class="annotation-quote" data-action="goto-annotation" data-id="${escapeHtml(annotation.id)}">${escapeHtml(annotation.anchor.exact)}</p>
          ${note}
          ${conflict}
          ${isResolved ? '' : '<p class="annotation-status">原文已变化，暂时无法定位；导出不受影响。</p>'}
          <div class="annotation-actions">
            ${edit}
            <button class="danger" type="button" data-action="delete-annotation" data-id="${escapeHtml(annotation.id)}">删除</button>
          </div>
        </article>`;
    }).join('');
  }

  function showToolbar(rect) {
    if (!state.ui || !rect) return;
    const toolbar = state.ui.toolbar;
    toolbar.hidden = false;
    const desiredLeft = clamp(rect.left + rect.width / 2, 92, global.innerWidth - 92);
    let desiredTop = rect.top - 46;
    if (desiredTop < 8) desiredTop = rect.bottom + 8;
    toolbar.style.left = `${desiredLeft}px`;
    toolbar.style.top = `${clamp(desiredTop, 8, global.innerHeight - 52)}px`;
  }

  function hideToolbar() {
    if (state.ui) state.ui.toolbar.hidden = true;
  }

  function captureSelection() {
    const selection = global.getSelection();
    const root = getArticleRoot();
    if (!selection || selection.isCollapsed || !selection.rangeCount || !root) {
      hideToolbar();
      return;
    }

    const range = selection.getRangeAt(0);
    const anchor = buildAnchorFromRange(root, range);
    if (!anchor?.exact) {
      hideToolbar();
      return;
    }
    if (anchor.exact.length > CONFIG.maxSelectionLength) {
      hideToolbar();
      showToast(`一次最多选择 ${CONFIG.maxSelectionLength} 个字符。`, 'error');
      return;
    }

    state.pendingSelection = {
      anchor,
      ...getPageMeta(),
    };
    showToolbar(range.getBoundingClientRect());
  }

  function openDrawer(filter = state.filter) {
    state.filter = filter;
    renderManager();
    state.ui.backdrop.hidden = false;
    state.ui.drawer.classList.add('open');
    state.ui.drawer.setAttribute('aria-hidden', 'false');
  }

  function closeDrawer() {
    if (!state.ui) return;
    state.ui.backdrop.hidden = true;
    state.ui.drawer.classList.remove('open');
    state.ui.drawer.setAttribute('aria-hidden', 'true');
  }

  function openComposerForSelection() {
    if (!state.pendingSelection) return;
    state.composer = {
      mode: 'create',
      quote: state.pendingSelection.anchor.exact,
    };
    state.ui.modalTitle.textContent = '写批注';
    state.ui.modalQuote.textContent = state.composer.quote;
    state.ui.noteInput.value = '';
    state.ui.modalLayer.hidden = false;
    global.setTimeout(() => state.ui.noteInput.focus(), 0);
  }

  function openComposerForEdit(id) {
    const annotation = state.store.annotations.find((item) => item.id === id);
    if (!annotation || annotation.type !== 'note') return;
    state.composer = { id, mode: 'edit', quote: annotation.anchor.exact };
    state.ui.modalTitle.textContent = '编辑批注';
    state.ui.modalQuote.textContent = annotation.anchor.exact;
    state.ui.noteInput.value = annotation.note;
    state.ui.modalLayer.hidden = false;
    global.setTimeout(() => {
      state.ui.noteInput.focus();
      state.ui.noteInput.setSelectionRange(
        state.ui.noteInput.value.length,
        state.ui.noteInput.value.length,
      );
    }, 0);
  }

  function closeComposer() {
    if (!state.ui) return;
    state.composer = null;
    state.ui.modalLayer.hidden = true;
    state.ui.noteInput.value = '';
  }

  function handleComposerSubmit(event) {
    event.preventDefault();
    const note = state.ui.noteInput.value.trim();
    if (!note) {
      showToast('请先写下观点。', 'error');
      state.ui.noteInput.focus();
      return;
    }

    if (state.composer?.mode === 'create') {
      addAnnotation('note', note);
    } else if (state.composer?.mode === 'edit') {
      updateAnnotationNote(state.composer.id, note);
    }
  }

  function handleUiClick(event) {
    const target = event.target.closest?.('[data-action], [data-filter], #launcher');
    if (!target) return;

    if (target.id === 'launcher') {
      openDrawer('current');
      return;
    }
    if (target.dataset.filter) {
      state.filter = target.dataset.filter;
      renderManager();
      return;
    }

    const action = target.dataset.action;
    const id = target.dataset.id;
    if (action === 'add-highlight') addAnnotation('highlight');
    if (action === 'add-underline') addAnnotation('underline');
    if (action === 'add-note') openComposerForSelection();
    if (action === 'close-drawer') closeDrawer();
    if (action === 'close-composer') closeComposer();
    if (action === 'delete-annotation') deleteAnnotation(id);
    if (action === 'edit-note') openComposerForEdit(id);
    if (action === 'goto-annotation') goToAnnotation(id);
    if (action === 'export-markdown') exportNotes('markdown');
    if (action === 'export-html') exportNotes('html');
    if (action === 'toggle-sync-panel') {
      state.ui.syncPanel.hidden = !state.ui.syncPanel.hidden;
      renderSyncUi();
      if (!state.ui.syncPanel.hidden && isSyncConfigured()) loadSyncDevices();
    }
    if (action === 'sync-now') {
      if (isSyncConfigured()) syncNow();
      else {
        state.ui.syncPanel.hidden = false;
        renderSyncUi();
        showToast('请先初始化或加入一个同步笔记库。');
      }
    }
    if (action === 'sync-bootstrap') bootstrapSync();
    if (action === 'sync-invite') createPairingInvitation();
    if (action === 'sync-join') joinExistingLibrary();
    if (action === 'sync-refresh-devices') loadSyncDevices();
    if (action === 'sync-disconnect') disconnectSyncDevice();
    if (action === 'sync-revoke-device') revokeSyncDevice(id);
  }

  function flashRange(range) {
    if (!state.highlightsSupported || !range) return;
    global.CSS.highlights.set(HIGHLIGHT_NAMES.focus, new global.Highlight(range));
    global.setTimeout(() => global.CSS.highlights.delete(HIGHLIGHT_NAMES.focus), 1500);
  }

  function getViewportTopInset() {
    const header = document.querySelector('.md-header');
    if (!header) return 0;
    const position = global.getComputedStyle(header).position;
    if (position !== 'fixed' && position !== 'sticky') return 0;
    const rect = header.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top > 1) return 0;
    return clamp(rect.bottom, 0, global.innerHeight * 0.35);
  }

  function scrollRangeIntoView(range) {
    const rects = getRangeTextLineRects(range);
    if (!rects.length) return false;

    const top = Math.min(...rects.map((rect) => rect.top));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    const targetTop = calculateCenteredScrollTop(
      { bottom, top },
      global.scrollY,
      global.innerHeight,
      getViewportTopInset(),
    );

    global.scrollTo({ behavior: 'smooth', top: targetTop });
    return true;
  }

  function goToAnnotation(id) {
    const annotation = state.store.annotations.find((item) => item.id === id);
    if (!annotation) return;
    const currentPageUrl = normalizePageUrl(global.location.href);

    if (annotation.pageUrl !== currentPageUrl) {
      global.sessionStorage.setItem('aab-reading-notes:pending-scroll', id);
      global.location.href = annotation.pageUrl;
      return;
    }

    const resolved = state.resolved.get(id);
    if (!resolved) {
      showToast('这条记录暂时无法在当前原文中定位。', 'error');
      return;
    }

    closeDrawer();
    if (!scrollRangeIntoView(resolved.range)) {
      const element = resolved.range.startContainer.parentElement;
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    flashRange(resolved.range);
  }

  function schedulePendingScroll() {
    const id = global.sessionStorage.getItem('aab-reading-notes:pending-scroll');
    if (!id || !state.resolved.has(id)) return;
    global.sessionStorage.removeItem('aab-reading-notes:pending-scroll');
    global.setTimeout(() => goToAnnotation(id), 180);
  }

  function downloadText(filename, content, mimeType) {
    const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.append(link);
    link.click();
    link.remove();
    global.setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function exportNotes(format) {
    if (!state.store.annotations.length) {
      showToast('还没有可以导出的记录。');
      return;
    }

    const date = new Date().toISOString().slice(0, 10);
    if (format === 'html') {
      downloadText(
        `ai-agent-book-notes-${date}.html`,
        createHtmlExport(state.store.annotations),
        'text/html',
      );
      showToast('网页笔记已导出。', 'success');
      return;
    }

    downloadText(
      `ai-agent-book-notes-${date}.md`,
      createMarkdownExport(state.store.annotations),
      'text/markdown',
    );
    showToast('Markdown 笔记已导出。', 'success');
  }

  function scheduleRefresh() {
    global.clearTimeout(state.refreshTimer);
    state.refreshTimer = global.setTimeout(() => {
      syncUiTheme();
      if (getArticleRoot() !== state.root) {
        renderHighlights();
      } else {
        scheduleHandDrawnMarkRefresh();
      }
    }, 120);
  }

  function installListeners() {
    document.addEventListener('mouseup', (event) => {
      if (event.composedPath().includes(state.ui.host)) return;
      global.setTimeout(captureSelection, 0);
    });
    document.addEventListener('keyup', (event) => {
      if (event.key === 'Escape') {
        hideToolbar();
        closeComposer();
        closeDrawer();
        return;
      }
      if (event.shiftKey || event.key.startsWith('Arrow')) {
        global.setTimeout(captureSelection, 0);
      }
    });
    document.addEventListener('pointerdown', (event) => {
      if (!event.composedPath().includes(state.ui.host)) hideToolbar();
    }, true);
    global.addEventListener('scroll', hideToolbar, true);
    global.addEventListener('resize', () => {
      hideToolbar();
      scheduleHandDrawnMarkRefresh();
    });
    global.addEventListener('popstate', scheduleRefresh);
    global.addEventListener('pageshow', scheduleRefresh);
    global.addEventListener('online', () => scheduleSync(250));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') scheduleSync(350);
    });

    state.observer = new MutationObserver((mutations) => {
      const pageChanged = mutations.some((mutation) => (
        Array.from(mutation.addedNodes).some((node) => (
          node.nodeType === Node.ELEMENT_NODE
          && (node.matches?.('.md-content, .md-content__inner')
            || node.querySelector?.('.md-content, .md-content__inner'))
        ))
      ));
      const themeChanged = mutations.some((mutation) => (
        mutation.type === 'attributes'
        && mutation.target === document.body
        && mutation.attributeName === 'data-md-color-scheme'
      ));
      if (pageChanged || themeChanged) scheduleRefresh();
    });
    state.observer.observe(document.documentElement, {
      attributeFilter: ['data-md-color-scheme'],
      attributes: true,
      childList: true,
      subtree: true,
    });

    if (typeof GM_addValueChangeListener === 'function') {
      GM_addValueChangeListener(CONFIG.storageKey, (_name, _oldValue, newValue, remote) => {
        if (!remote) return;
        state.store = normalizeStore(newValue);
        renderHighlights();
      });
      GM_addValueChangeListener(CONFIG.syncStorageKey, (_name, _oldValue, newValue, remote) => {
        if (!remote) return;
        state.sync = normalizeSyncState(newValue);
        renderSyncUi();
        scheduleSync(300);
      });
    }
  }

  function installMenuCommands() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    GM_registerMenuCommand('打开读书笔记', () => openDrawer('all'));
    GM_registerMenuCommand('导出 Markdown 笔记', () => exportNotes('markdown'));
    GM_registerMenuCommand('导出 HTML 笔记', () => exportNotes('html'));
    GM_registerMenuCommand('立即同步读书笔记', () => syncNow());
  }

  function init() {
    state.store = loadStore();
    state.sync = loadSyncState();
    installGlobalStyles();
    mountUi();
    installListeners();
    installMenuCommands();
    renderHighlights();
    if (state.sync.pairing) schedulePairingPoll(500);
    if (isSyncConfigured()) scheduleSync(700);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
