// ==UserScript==
// @name         AI Agent Book Reading Notes
// @namespace    https://github.com/kyangc/tampermonkey_scripts
// @version      0.1.0
// @description  Highlight, underline, annotate, persist, and export notes from AI Agents in Depth.
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
    uiHostId: 'aab-reading-notes-host',
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
    compareAnnotations,
    createHtmlExport,
    createMarkdownExport,
    groupAnnotations,
    locateTextAnchor,
    normalizeAnnotation,
    normalizePageUrl,
    normalizeStore,
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = core;
  }

  if (!global?.document) return;

  const state = {
    composer: null,
    filter: 'current',
    highlightsSupported: Boolean(global.CSS?.highlights && global.Highlight),
    observer: null,
    pendingSelection: null,
    refreshTimer: null,
    resolved: new Map(),
    root: null,
    store: null,
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

  function installGlobalStyles() {
    const css = `
      ::highlight(${HIGHLIGHT_NAMES.highlight}) {
        color: inherit;
        background-color: rgba(255, 210, 74, 0.48);
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
      nodes.push({ end: total + length, node, start: total });
      total += length;
    }

    if (!nodes.length || end > total) return null;

    const startPoint = nodes.find((item) => start >= item.start && start <= item.end);
    const endPoint = nodes.find((item) => end >= item.start && end <= item.end);
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
    const rangesByType = {
      highlight: [],
      note: [],
      underline: [],
    };

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
      rangesByType[annotation.type].push(range);
    }

    if (state.highlightsSupported) {
      for (const type of Object.keys(rangesByType)) {
        global.CSS.highlights.set(
          HIGHLIGHT_NAMES[type],
          new global.Highlight(...rangesByType[type]),
        );
      }
    }

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
    renderHighlights();
    showToast('记录已删除。');
  }

  function updateAnnotationNote(id, note) {
    const annotation = state.store.annotations.find((item) => item.id === id);
    if (!annotation || annotation.type !== 'note') return;

    annotation.note = String(note || '').trim();
    annotation.updatedAt = new Date().toISOString();
    if (!persistStore()) return;
    closeComposer();
    renderManager();
    showToast('批注已更新。', 'success');
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
        button, textarea { font: inherit; }
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
          display: grid;
          grid-template-rows: auto auto minmax(0, 1fr) auto;
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
        #list {
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
          grid-template-columns: 1fr 1fr;
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
        <div id="list"></div>
        <footer class="drawer-footer">
          <button type="button" data-action="export-markdown">导出 Markdown</button>
          <button type="button" data-action="export-html">导出网页</button>
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

  function renderManager() {
    if (!state.ui) return;
    syncUiTheme();
    updateLauncherCount();

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
  }

  function flashRange(range) {
    if (!state.highlightsSupported || !range) return;
    global.CSS.highlights.set(HIGHLIGHT_NAMES.focus, new global.Highlight(range));
    global.setTimeout(() => global.CSS.highlights.delete(HIGHLIGHT_NAMES.focus), 1500);
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
    const element = resolved.range.startContainer.parentElement;
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
      if (getArticleRoot() !== state.root) renderHighlights();
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
    global.addEventListener('resize', hideToolbar);
    global.addEventListener('popstate', scheduleRefresh);
    global.addEventListener('pageshow', scheduleRefresh);

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
    }
  }

  function installMenuCommands() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    GM_registerMenuCommand('打开读书笔记', () => openDrawer('all'));
    GM_registerMenuCommand('导出 Markdown 笔记', () => exportNotes('markdown'));
    GM_registerMenuCommand('导出 HTML 笔记', () => exportNotes('html'));
  }

  function init() {
    state.store = loadStore();
    installGlobalStyles();
    mountUi();
    installListeners();
    installMenuCommands();
    renderHighlights();

    if (!state.highlightsSupported) {
      showToast('当前浏览器不支持 CSS Highlights，请使用新版 Chrome、Edge 或 Firefox。', 'error');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
