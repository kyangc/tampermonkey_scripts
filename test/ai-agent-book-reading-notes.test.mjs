import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const core = require('../scripts/ai-agent-book-reading-notes.user.js');

function annotation(overrides = {}) {
  return {
    anchor: {
      end: 12,
      exact: 'Agent 架构',
      prefix: '理解 ',
      start: 4,
      suffix: ' 的原则',
    },
    createdAt: '2026-07-25T08:00:00.000Z',
    id: 'annotation-1',
    note: '',
    pageOrder: 1,
    pageTitle: '第1章 Agent基础知识',
    pageUrl: 'https://bojieli.github.io/ai-agent-book/book/chapter1/',
    type: 'highlight',
    updatedAt: '2026-07-25T08:00:00.000Z',
    ...overrides,
  };
}

test('normalizes page URLs by removing query strings and fragments', () => {
  assert.equal(
    core.normalizePageUrl(
      'https://bojieli.github.io/ai-agent-book/book/chapter1/?lang=zh#agent',
    ),
    'https://bojieli.github.io/ai-agent-book/book/chapter1/',
  );
  assert.equal(
    core.normalizePageUrl('/ai-agent-book/book/introduction'),
    'https://bojieli.github.io/ai-agent-book/book/introduction/',
  );
});

test('builds a text quote and position anchor with bounded context', () => {
  const text = '前文：Agent 的设计需要原则。后文继续。';
  const exact = 'Agent 的设计';
  const start = text.indexOf(exact);
  const anchor = core.buildTextAnchor(text, start, start + exact.length, 4);

  assert.deepEqual(anchor, {
    end: start + exact.length,
    exact,
    prefix: '前文：',
    start,
    suffix: '需要原则',
  });
});

test('restores an anchor directly when saved positions still match', () => {
  const text = '把 Agent 的设计从感觉驱动变为原则驱动。';
  const exact = '感觉驱动';
  const start = text.indexOf(exact);
  const anchor = core.buildTextAnchor(text, start, start + exact.length);
  const located = core.locateTextAnchor(text, anchor);

  assert.deepEqual(located, {
    confidence: 1,
    end: start + exact.length,
    start,
    strategy: 'position',
  });
});

test('falls back to quote context after content is inserted before the selection', () => {
  const original = 'Agent 需要上下文、工具和记忆。';
  const exact = '工具';
  const start = original.indexOf(exact);
  const anchor = core.buildTextAnchor(original, start, start + exact.length);
  const changed = `新增导语。${original}`;
  const located = core.locateTextAnchor(changed, anchor);

  assert.equal(located.strategy, 'quote');
  assert.equal(changed.slice(located.start, located.end), exact);
  assert.equal(located.start, changed.indexOf(exact));
});

test('uses prefix and suffix context to disambiguate repeated quotes', () => {
  const original = '第一处 Agent 用于检索；第二处 Agent 用于执行。';
  const secondStart = original.lastIndexOf('Agent');
  const anchor = core.buildTextAnchor(original, secondStart, secondStart + 'Agent'.length, 8);
  const changed = `说明：${original}`;
  const located = core.locateTextAnchor(changed, anchor);

  assert.equal(located.strategy, 'quote');
  assert.equal(located.start, changed.lastIndexOf('Agent'));
});

test('returns null when the selected quote no longer exists', () => {
  const anchor = core.buildTextAnchor('原文包含关键结论。', 4, 8);
  assert.equal(core.locateTextAnchor('正文已经完全重写。', anchor), null);
});

test('creates deterministic brush variations with subtle bounded jitter', () => {
  const first = core.getBrushStrokeVariation('annotation-1', 0);
  const repeated = core.getBrushStrokeVariation('annotation-1', 0);
  const nextLine = core.getBrushStrokeVariation('annotation-1', 1);

  assert.deepEqual(first, repeated);
  assert.notDeepEqual(first, nextLine);
  assert.match(first.clipPath, /^polygon\(/);
  assert.ok(first.heightScale >= 0.58 && first.heightScale <= 0.64);
  assert.ok(first.rotation >= -0.3 && first.rotation <= 0.3);
});

test('creates deterministic hand-drawn underline paths for each line', () => {
  const first = core.getHandUnderlineVariation('annotation-1', 0);
  const repeated = core.getHandUnderlineVariation('annotation-1', 0);
  const nextLine = core.getHandUnderlineVariation('annotation-1', 1);

  assert.deepEqual(first, repeated);
  assert.notDeepEqual(first, nextLine);
  assert.match(first.primaryPath, /^M 1 [\d.]+ C /);
  assert.match(first.ghostPath, /^M 1 [\d.]+ C /);
  assert.ok(first.rotation >= -0.16 && first.rotation <= 0.16);
});

test('merges inline text fragments into one compact rectangle per visual line', () => {
  const lines = core.mergeTextLineRects([
    { left: 120, top: 10, right: 180, bottom: 30 },
    { left: 20, top: 10.4, right: 120, bottom: 30.4 },
    { left: 20, top: 50, right: 190, bottom: 70 },
    { left: 20, top: 90, right: 72, bottom: 110 },
  ]);

  assert.deepEqual(lines, [
    { bottom: 30.4, height: 20.4, left: 20, right: 180, top: 10, width: 160 },
    { bottom: 70, height: 20, left: 20, right: 190, top: 50, width: 170 },
    { bottom: 110, height: 20, left: 20, right: 72, top: 90, width: 52 },
  ]);
});

test('does not merge a tall block box with nearby visual lines', () => {
  const lines = core.mergeTextLineRects([
    { left: 20, top: 10, right: 200, bottom: 30 },
    { left: 20, top: 50, right: 200, bottom: 70 },
    { left: 20, top: 10, right: 200, bottom: 70 },
  ]);

  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((line) => line.height), [20, 60, 20]);
});

test('centers an annotation range in the usable viewport', () => {
  const target = core.calculateCenteredScrollTop(
    { bottom: 940, top: 900 },
    200,
    700,
    60,
  );

  assert.equal(target, 740);
});

test('keeps centered scrolling correct when page coordinates are zoomed', () => {
  const normal = core.calculateCenteredScrollTop(
    { bottom: 940, top: 900 },
    200,
    700,
    60,
  );
  const zoomed = core.calculateCenteredScrollTop(
    { bottom: 752, top: 720 },
    160,
    560,
    48,
  );

  assert.equal(zoomed * 1.25, normal);
});

test('assigns a shared text boundary to the following node for range starts', () => {
  const newline = { end: 8, node: 'article-newline', start: 7 };
  const paragraph = { end: 24, node: 'paragraph-text', start: 8 };
  const nodes = [newline, paragraph];

  assert.equal(core.findTextOffsetPoint(nodes, 8, 'start'), paragraph);
  assert.equal(core.findTextOffsetPoint(nodes, 8, 'end'), newline);
});

test('normalizes, filters, and sorts stored annotations', () => {
  const later = annotation({
    anchor: {
      end: 20,
      exact: '后面的记录',
      prefix: '',
      start: 15,
      suffix: '',
    },
    id: 'later',
  });
  const earlierPage = annotation({
    id: 'earlier-page',
    pageOrder: 0,
    pageTitle: '引言',
    pageUrl: 'https://bojieli.github.io/ai-agent-book/book/introduction/',
  });
  const store = core.normalizeStore({
    annotations: [later, { invalid: true }, earlierPage],
    schemaVersion: 1,
  });

  assert.deepEqual(store.annotations.map((item) => item.id), ['earlier-page', 'later']);
  assert.equal(store.schemaVersion, 1);
});

test('groups annotations by chapter in book order', () => {
  const groups = core.groupAnnotations([
    annotation({
      id: 'chapter-2',
      pageOrder: 2,
      pageTitle: '第二章',
      pageUrl: 'https://bojieli.github.io/ai-agent-book/book/chapter2/',
    }),
    annotation({
      id: 'intro',
      pageOrder: 0,
      pageTitle: '引言',
      pageUrl: 'https://bojieli.github.io/ai-agent-book/book/introduction/',
    }),
    annotation({ id: 'chapter-1', pageOrder: 1 }),
  ]);

  assert.deepEqual(groups.map((group) => group.pageTitle), ['引言', '第1章 Agent基础知识', '第二章']);
});

test('exports readable Markdown with quotes, notes, and source links', () => {
  const output = core.createMarkdownExport([
    annotation({
      note: '这里强调的是原则，而不是堆叠工具。',
      type: 'note',
    }),
  ], {
    exportedAt: '2026-07-25T09:30:00.000Z',
  });

  assert.match(output, /^# AI Agents in Depth — 读书笔记/m);
  assert.match(output, /## 第1章 Agent基础知识/);
  assert.match(output, /> Agent 架构/);
  assert.match(output, /\*\*我的观点\*\*/);
  assert.match(output, /这里强调的是原则/);
  assert.match(output, /\[打开原文\]\(https:\/\/bojieli\.github\.io/);
});

test('escapes user text in HTML exports while keeping notes readable', () => {
  const output = core.createHtmlExport([
    annotation({
      anchor: {
        end: 10,
        exact: '<script>alert(1)</script>',
        prefix: '',
        start: 0,
        suffix: '',
      },
      note: '<b>我的观点</b>',
      type: 'note',
    }),
  ], {
    exportedAt: '2026-07-25T09:30:00.000Z',
  });

  assert.match(output, /<!doctype html>/i);
  assert.doesNotMatch(output, /<script>alert/);
  assert.match(output, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(output, /&lt;b&gt;我的观点&lt;\/b&gt;/);
});
