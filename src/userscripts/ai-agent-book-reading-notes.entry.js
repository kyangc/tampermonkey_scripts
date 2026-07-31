// Browser runtime and UI adapter for the AI Agent Book reading-notes core.
// Bundled into the installable userscript by tools/build-userscripts.mjs.

(function aiAgentBookReadingNotesRuntime(global) {
  'use strict';

  const core = global.__AAB_READING_NOTES_CORE__;
  if (!core) throw new Error('AI Agent Book reading-notes core is missing.');
  const {
    ANNOTATION_TYPES,
    CONFIG,
    HIGHLIGHT_NAMES,
    SYNC_CONFIG,
    base64UrlToBytes,
    buildTextAnchor,
    bytesToBase64Url,
    calculateCenteredScrollTop,
    clamp,
    classifySyncCompletion,
    compareAnnotations,
    createEncryptedRecoveryKit,
    createHtmlExport,
    createMarkdownExport,
    createPairingSafetyNumber,
    createPendingMutation,
    createPortableBackup,
    escapeHtml,
    findTextOffsetPoint,
    formatReadableDate,
    getBrushStrokeVariation,
    getHandUnderlineVariation,
    groupAnnotations,
    locateTextAnchor,
    mergePortableAnnotations,
    mergeTextLineRects,
    normalizeAnnotation,
    normalizeBlockAnchor,
    normalizePageUrl,
    normalizePairingSafetyNumber,
    normalizeStore,
    normalizeSyncEndpoint,
    normalizeSyncState,
    openEncryptedRecoveryKit,
    parsePortableBackup,
    prepareSyncMutation,
    randomBase64Url,
    replaceAnnotationAnchor,
    sha256Base64Url,
  } = core;

  if (!global?.document) return;
  const state = {
    bootstrapAttempts: 0,
    bootstrapTimer: null,
    brushLayer: null,
    brushRefreshTimer: null,
    candidates: new Map(),
    composer: null,
    filter: 'current',
    focusReturn: {
      composer: null,
      drawer: null,
      recovery: null,
    },
    highlightsSupported: Boolean(global.CSS?.highlights && global.Highlight),
    initialized: false,
    observer: null,
    pairingTimer: null,
    pendingSelection: null,
    rebindingAnnotationId: null,
    refreshTimer: null,
    recoveryAction: null,
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
    if (!isSyncConfigured()) return null;
    const outcome = prepareSyncMutation(state.sync, annotation, options);
    state.sync = outcome.sync;
    persistSyncState();
    if (outcome.queued) scheduleSync();
    return outcome;
  }

  function queueAllLocalAnnotations(options = {}) {
    if (!isSyncConfigured()) return;
    const selectedIds = options.recordIds instanceof Set ? options.recordIds : null;
    let changed = false;
    let queued = false;
    for (const annotation of state.store.annotations) {
      if (selectedIds && !selectedIds.has(annotation.id)) continue;
      if (!options.force && state.sync.versions[annotation.id] !== undefined) continue;
      const outcome = prepareSyncMutation(state.sync, annotation);
      state.sync = outcome.sync;
      changed = true;
      queued = queued || outcome.queued;
    }
    if (changed) persistSyncState();
    if (queued) scheduleSync();
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
    (document.head || document.documentElement).append(style);
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
    if (current === 'https://bojieli.github.io/ai-agent-book/') return -1;

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

  const STRUCTURAL_BLOCK_SELECTOR = [
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'p',
    'li',
    'blockquote',
    'pre',
    'figcaption',
    'td',
    'th',
  ].join(',');

  function getTextOffsetBeforeElement(root, element) {
    if (!root || !element || !root.contains(element)) return null;
    try {
      const probe = document.createRange();
      probe.selectNodeContents(root);
      probe.setEnd(element, 0);
      return probe.toString().length;
    } catch (_error) {
      return null;
    }
  }

  function getHeadingPath(root, element) {
    if (!root || !element) return [];
    const path = [];
    for (const heading of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      if (heading === element || !(heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)) {
        continue;
      }
      const level = Number(heading.tagName.slice(1));
      path.length = Math.min(path.length, Math.max(0, level - 1));
      path[level - 1] = (heading.textContent || '').replace(/¶\s*$/u, '').trim();
    }
    return path.filter(Boolean);
  }

  function semanticBlocks(root) {
    if (!root) return [];
    return [...root.querySelectorAll(STRUCTURAL_BLOCK_SELECTOR)].filter((element) => (
      !element.querySelector(STRUCTURAL_BLOCK_SELECTOR)
      && Boolean((element.textContent || '').trim())
    ));
  }

  function createStructuralBlockAnchor(root, range, selectionStart, selectionEnd) {
    const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer
      : range.startContainer.parentElement;
    const endElement = range.endContainer.nodeType === Node.ELEMENT_NODE
      ? range.endContainer
      : range.endContainer.parentElement;
    const startBlock = startElement?.closest?.(STRUCTURAL_BLOCK_SELECTOR);
    const endBlock = endElement?.closest?.(STRUCTURAL_BLOCK_SELECTOR);
    if (!startBlock || startBlock !== endBlock || !root.contains(startBlock)) return null;

    const start = getTextOffsetBeforeElement(root, startBlock);
    const text = startBlock.textContent || '';
    if (start === null || !text.trim()) return null;
    const blocks = semanticBlocks(root);
    return normalizeBlockAnchor({
      end: start + text.length,
      headingPath: getHeadingPath(root, startBlock),
      index: Math.max(0, blocks.indexOf(startBlock)),
      selectionEnd: selectionEnd - start,
      selectionStart: selectionStart - start,
      start,
      tag: startBlock.tagName.toLowerCase(),
      text,
    });
  }

  function collectStructuralBlocks(root) {
    return semanticBlocks(root).map((element, index) => {
      const start = getTextOffsetBeforeElement(root, element);
      const text = element.textContent || '';
      if (start === null || !text.trim()) return null;
      return {
        end: start + text.length,
        headingPath: getHeadingPath(root, element),
        index,
        start,
        tag: element.tagName.toLowerCase(),
        text,
      };
    }).filter(Boolean);
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

      const anchor = buildTextAnchor(source, start, end);
      if (!anchor) return null;
      const block = createStructuralBlockAnchor(root, range, start, end);
      return {
        ...anchor,
        anchorVersion: CONFIG.anchorVersion,
        ...(block ? { block } : {}),
      };
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
    state.candidates.clear();
    clearRegisteredHighlights();
    if (!state.root) return;

    const currentPageUrl = normalizePageUrl(global.location.href);
    const source = state.root.textContent || '';
    const blocks = collectStructuralBlocks(state.root);
    const automaticallyRelocated = [];

    for (const annotation of state.store.annotations) {
      if (annotation.pageUrl !== currentPageUrl) continue;
      const match = locateTextAnchor(source, annotation.anchor, { blocks });
      if (!match) continue;
      const range = createRangeFromOffsets(state.root, match.start, match.end);
      if (!range) continue;

      if (match.needsReview) {
        state.candidates.set(annotation.id, {
          confidence: match.confidence,
          range,
          strategy: match.strategy,
        });
        continue;
      }

      if (
        ['normalized-quote', 'fuzzy-quote'].includes(match.strategy)
        && match.confidence >= CONFIG.autoRelocateConfidence
      ) {
        const nextAnchor = buildAnchorFromRange(state.root, range);
        const replacement = replaceAnnotationAnchor(annotation, nextAnchor, {
          confidence: match.confidence,
          reason: 'automatic',
          strategy: match.strategy,
        });
        if (replacement) {
          replaceLocalAnnotation(replacement);
          automaticallyRelocated.push(replacement);
        }
      }

      state.resolved.set(annotation.id, {
        confidence: match.confidence,
        range,
        strategy: match.strategy,
      });
    }

    if (automaticallyRelocated.length && persistStore()) {
      for (const annotation of automaticallyRelocated) queueAnnotationMutation(annotation);
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
    const syncOutcome = queueAnnotationMutation(annotation);

    global.getSelection()?.removeAllRanges();
    state.pendingSelection = null;
    hideToolbar();
    closeComposer();
    renderHighlights();
    showToast(
      syncOutcome?.issue
        ? `${ANNOTATION_TYPES[type]}已保存到本地，但记录过大，未加入同步队列。`
        : `${ANNOTATION_TYPES[type]}已保存到本地。`,
      syncOutcome?.issue ? 'error' : 'success',
    );
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
    const syncOutcome = queueAnnotationMutation(annotation);
    closeComposer();
    renderManager();
    showToast(
      syncOutcome?.issue
        ? '批注已更新到本地，但记录过大，未加入同步队列。'
        : '批注已更新。',
      syncOutcome?.issue ? 'error' : 'success',
    );
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
      const completion = classifySyncCompletion({
        hasMore,
        maxRounds: 30,
        pendingCount: state.sync.pending.length,
        rounds,
      });
      if (completion.shouldContinue) {
        scheduleSync(250);
        if (!options.silent) {
          showToast('已同步一批，剩余内容会继续处理。');
        }
      } else if (!options.silent) {
        showToast('读书笔记已同步。', 'success');
      }
      return completion.complete;
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
        safetyNumber: '',
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
      const safetyNumber = await createPairingSafetyNumber(
        response.pairId,
        keyPair.publicKey,
      );
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
          safetyNumber,
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

    const safetyNumber = await createPairingSafetyNumber(
      response.pairId,
      response.publicKey,
    );
    const suppliedSafetyNumber = global.prompt(
      `“${response.deviceName || '新设备'}”请求加入。\n\n`
      + '请在新设备上查看配对安全码，并在这里输入。'
      + '\n只有两台设备的安全码完全一致才会放行；输入即表示批准。',
      '',
    );
    if (
      normalizePairingSafetyNumber(suppliedSafetyNumber)
      !== normalizePairingSafetyNumber(safetyNumber)
    ) {
      state.sync.pairing = null;
      persistSyncState();
      showToast('安全码未确认或不一致，已拒绝该设备。', 'error');
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
    if (!pairing.safetyNumber && pairing.privateKey) {
      pairing.safetyNumber = await createPairingSafetyNumber(
        pairing.pairId,
        pairing.privateKey,
      );
      persistSyncState();
    }
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
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: auto;
          overscroll-behavior: contain;
          padding: 18px 20px 28px;
          background: var(--panel-2);
          border-bottom: 0;
        }
        #drawer.sync-open .filters,
        #drawer.sync-open #list {
          display: none;
        }
        #drawer.sync-open .sync-bar {
          flex: 0 0 auto;
        }
        #drawer.sync-open .drawer-footer {
          grid-template-columns: 1fr;
        }
        #drawer.sync-open .drawer-footer [data-action="export-markdown"],
        #drawer.sync-open .drawer-footer [data-action="export-html"] {
          display: none;
        }
        #drawer.sync-open [data-action="toggle-sync-panel"] {
          color: var(--accent);
          border-color: color-mix(in srgb, var(--accent) 42%, var(--border));
          background: color-mix(in srgb, var(--accent) 9%, var(--panel));
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
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 7px;
          margin-top: 12px;
        }
        .sync-actions button { width: 100%; }
        .backup-section {
          margin-top: 18px;
          padding-top: 14px;
          border-top: 1px solid var(--border);
        }
        .backup-section h3 { margin: 0 0 4px; font-size: 14px; }
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
        .annotation-status--info { color: var(--accent); }
        .anchor-history {
          margin-top: 8px;
          color: var(--muted);
          font-size: 12px;
        }
        .anchor-history summary { cursor: pointer; }
        .anchor-history blockquote {
          max-height: 90px;
          overflow: auto;
          margin: 6px 0 0;
          padding: 7px 9px;
          background: var(--panel);
          border-left: 2px solid var(--border);
          white-space: pre-wrap;
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
        #modal-layer,
        #recovery-modal-layer {
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          display: grid;
          place-items: center;
          padding: 16px;
          background: var(--backdrop);
          backdrop-filter: blur(3px);
        }
        #modal,
        #recovery-modal {
          width: min(520px, 96vw);
          padding: 20px;
          color: var(--text);
          background: var(--panel);
          border: 1px solid var(--border);
          border-radius: 12px;
          box-shadow: var(--shadow);
        }
        #modal h3,
        #recovery-modal h3 { margin: 0 0 10px; font-size: 18px; }
        #recovery-modal label {
          display: grid;
          gap: 5px;
          margin-top: 12px;
          color: var(--muted);
          font-size: 12px;
        }
        #recovery-modal input {
          width: 100%;
          min-height: 38px;
          padding: 7px 10px;
          color: var(--text);
          background: var(--panel);
          border: 1px solid var(--border);
          border-radius: 8px;
          outline: none;
        }
        #recovery-modal input:focus {
          border-color: var(--accent);
          box-shadow: 0 0 0 3px var(--accent-soft);
        }
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
          .sync-actions { grid-template-columns: 1fr; }
        }
        @media (prefers-reduced-motion: reduce) {
          #drawer, #toast { transition: none; }
        }
      </style>
      <div id="toolbar" role="toolbar" aria-label="选中文本操作" hidden>
        <button type="button" data-action="add-highlight" data-toolbar-mode="create">
          <span class="swatch swatch--highlight"></span>高亮
        </button>
        <button type="button" data-action="add-underline" data-toolbar-mode="create">
          <span class="swatch swatch--underline"></span>划线
        </button>
        <button type="button" data-action="add-note" data-toolbar-mode="create">
          <span class="swatch swatch--note"></span>写批注
        </button>
        <button type="button" data-action="apply-rebind" data-toolbar-mode="rebind" hidden>
          关联到这段文字
        </button>
        <button type="button" data-action="cancel-rebind" data-toolbar-mode="rebind" hidden>
          取消
        </button>
      </div>
      <button id="launcher" type="button" aria-label="打开读书笔记">
        读书笔记 <span id="count">0</span>
      </button>
      <div id="backdrop" data-action="close-drawer" hidden></div>
      <aside id="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title"
        aria-hidden="true">
        <header class="drawer-header">
          <div>
            <h2 id="drawer-title" tabindex="-1">读书笔记</h2>
            <p id="summary">本页 0 条 · 全书 0 条</p>
          </div>
          <button class="icon-button" type="button" data-action="close-drawer" aria-label="关闭">×</button>
        </header>
        <nav class="filters" aria-label="笔记范围">
          <button type="button" data-filter="current" class="active">本页</button>
          <button type="button" data-filter="all">全书</button>
        </nav>
        <div class="sync-bar">
          <span id="sync-status" role="status" aria-live="polite">仅保存在本机</span>
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
          <section class="backup-section" aria-labelledby="backup-title">
            <h3 id="backup-title">备份与恢复</h3>
            <p class="sync-help">便携备份只含笔记；加密恢复包含同步凭据，必须使用至少 12 位的独立口令保护。</p>
            <div class="sync-actions">
              <button type="button" data-action="export-portable-backup">导出便携备份</button>
              <button type="button" data-action="import-portable-backup">导入便携备份</button>
              <button type="button" data-action="export-recovery-kit">导出加密恢复包</button>
              <button type="button" data-action="import-recovery-kit">导入加密恢复包</button>
            </div>
          </section>
        </section>
        <div id="list"></div>
        <footer class="drawer-footer">
          <button type="button" data-action="export-markdown">导出 Markdown</button>
          <button type="button" data-action="export-html">导出网页</button>
          <button id="sync-view-toggle" type="button" data-action="toggle-sync-panel"
            aria-expanded="false">同步设置</button>
        </footer>
      </aside>
      <div id="modal-layer" hidden>
        <form id="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"
          aria-describedby="modal-quote">
          <h3 id="modal-title">写批注</h3>
          <p id="modal-quote"></p>
          <textarea id="note-input" aria-label="批注内容"
            placeholder="写下你的观点、疑问或联想……" required></textarea>
          <div class="modal-actions">
            <button type="button" data-action="close-composer">取消</button>
            <button class="primary" type="submit">保存批注</button>
          </div>
        </form>
      </div>
      <div id="recovery-modal-layer" hidden>
        <form id="recovery-modal" role="dialog" aria-modal="true"
          aria-labelledby="recovery-modal-title" aria-describedby="recovery-modal-help">
          <h3 id="recovery-modal-title">导出加密恢复包</h3>
          <p id="recovery-modal-help" class="sync-help"></p>
          <label>
            恢复包口令
            <input id="recovery-passphrase" type="password" minlength="12"
              autocomplete="new-password" required>
          </label>
          <label id="recovery-confirm-label">
            再次输入口令
            <input id="recovery-passphrase-confirm" type="password" minlength="12"
              autocomplete="new-password">
          </label>
          <div class="modal-actions">
            <button type="button" data-action="close-recovery-modal">取消</button>
            <button class="primary" type="submit">继续</button>
          </div>
        </form>
      </div>
      <input id="backup-file-input" type="file" accept=".json,application/json" hidden>
      <div id="toast" role="status" aria-live="polite"></div>
    `;
    document.documentElement.append(host);

    state.ui = {
      backdrop: shadow.getElementById('backdrop'),
      backupFileInput: shadow.getElementById('backup-file-input'),
      count: shadow.getElementById('count'),
      drawer: shadow.getElementById('drawer'),
      drawerTitle: shadow.getElementById('drawer-title'),
      host,
      list: shadow.getElementById('list'),
      modalLayer: shadow.getElementById('modal-layer'),
      modalQuote: shadow.getElementById('modal-quote'),
      modalTitle: shadow.getElementById('modal-title'),
      noteInput: shadow.getElementById('note-input'),
      recoveryConfirmLabel: shadow.getElementById('recovery-confirm-label'),
      recoveryModalHelp: shadow.getElementById('recovery-modal-help'),
      recoveryModalLayer: shadow.getElementById('recovery-modal-layer'),
      recoveryModalTitle: shadow.getElementById('recovery-modal-title'),
      recoveryPassphrase: shadow.getElementById('recovery-passphrase'),
      recoveryPassphraseConfirm: shadow.getElementById('recovery-passphrase-confirm'),
      shadow,
      summary: shadow.getElementById('summary'),
      syncDeviceName: shadow.getElementById('sync-device-name'),
      syncEndpoint: shadow.getElementById('sync-endpoint'),
      syncPanel: shadow.getElementById('sync-panel'),
      syncSecret: shadow.getElementById('sync-secret'),
      syncStatus: shadow.getElementById('sync-status'),
      syncToggle: shadow.getElementById('sync-view-toggle'),
      pairingInfo: shadow.getElementById('pairing-info'),
      deviceList: shadow.getElementById('device-list'),
      toast: shadow.getElementById('toast'),
      toolbar: shadow.getElementById('toolbar'),
    };

    state.ui.toolbar.addEventListener('pointerdown', (event) => event.preventDefault());
    shadow.addEventListener('click', handleUiClick);
    shadow.addEventListener('keydown', handleShadowKeydown);
    shadow.getElementById('modal').addEventListener('submit', handleComposerSubmit);
    shadow.getElementById('recovery-modal').addEventListener(
      'submit',
      handleRecoveryModalSubmit,
    );
    state.ui.backupFileInput.addEventListener('change', handleBackupFileSelection);
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
    const blockedCount = state.sync?.blocked?.length || 0;
    let status = '仅保存在本机';
    if (state.syncing) status = '正在同步…';
    else if (state.syncError) status = `同步异常：${state.syncError}`;
    else if (state.sync?.pairing?.role === 'joiner') status = '等待可信设备批准';
    else if (state.sync?.pairing?.role === 'inviter') status = '等待新设备认领';
    else if (configured && blockedCount) {
      status = `${blockedCount} 条记录过大，仅保存在本机`;
    }
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
    const recoveryExport = state.ui.shadow.querySelector(
      '[data-action="export-recovery-kit"]',
    );
    if (recoveryExport) recoveryExport.hidden = !configured;

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
          <p>请在可信设备输入新设备显示的安全码：</p>
          <strong class="pairing-code">${escapeHtml(pairing.safetyNumber || '正在生成…')}</strong>
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
      const candidate = isCurrentPage ? state.candidates.get(annotation.id) : null;
      const note = annotation.note
        ? `<p class="annotation-note">${escapeHtml(annotation.note)}</p>`
        : '';
      const conflict = annotation.syncConflict
        ? '<p class="annotation-status">这是一份并发修改产生的冲突副本，请确认后保留或删除。</p>'
        : '';
      const edit = annotation.type === 'note'
        ? `<button type="button" data-action="edit-note" data-id="${escapeHtml(annotation.id)}">编辑</button>`
        : '';
      const relocation = isResolved && annotation.relocation?.at
        ? `<p class="annotation-status annotation-status--info">已根据新版原文重新关联 · ${escapeHtml(formatReadableDate(annotation.relocation.at))}</p>`
        : '';
      const candidateStatus = candidate
        ? `<p class="annotation-status annotation-status--info">找到疑似位置（置信度 ${Math.round(candidate.confidence * 100)}%），请确认后再显示。</p>`
        : '';
      const unresolvedStatus = !isResolved && !candidate
        ? '<p class="annotation-status">原文已变化，暂时无法定位；笔记和导出不受影响。</p>'
        : '';
      const history = annotation.anchorHistory.length
        ? `<details class="anchor-history">
            <summary>查看关联历史（${annotation.anchorHistory.length}）</summary>
            ${annotation.anchorHistory.slice().reverse().map((item) => (
    `<blockquote>${escapeHtml(item.exact)}</blockquote>`
  )).join('')}
          </details>`
        : '';
      const rebind = isCurrentPage
        ? `<button type="button" data-action="rebind-annotation" data-id="${escapeHtml(annotation.id)}">重新关联</button>`
        : '';
      const confirmCandidate = candidate
        ? `<button type="button" data-action="confirm-candidate" data-id="${escapeHtml(annotation.id)}">确认疑似位置</button>`
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
          ${relocation}
          ${candidateStatus}
          ${unresolvedStatus}
          ${history}
          <div class="annotation-actions">
            ${confirmCandidate}
            ${rebind}
            ${edit}
            <button class="danger" type="button" data-action="delete-annotation" data-id="${escapeHtml(annotation.id)}">删除</button>
          </div>
        </article>`;
    }).join('');
  }

  function showToolbar(rect) {
    if (!state.ui || !rect) return;
    const toolbar = state.ui.toolbar;
    const rebinding = Boolean(state.rebindingAnnotationId);
    for (const button of toolbar.querySelectorAll('[data-toolbar-mode]')) {
      button.hidden = button.dataset.toolbarMode === 'rebind' ? !rebinding : rebinding;
    }
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

  function startRebindingAnnotation(id) {
    const annotation = state.store.annotations.find((item) => item.id === id);
    if (!annotation) return;
    if (annotation.pageUrl !== normalizePageUrl(global.location.href)) {
      showToast('请先打开这条笔记所属的章节。', 'error');
      return;
    }

    state.rebindingAnnotationId = id;
    state.pendingSelection = null;
    global.getSelection()?.removeAllRanges();
    closeDrawer();
    hideToolbar();
    showToast('请在正文中选择新的对应文字，再点击“关联到这段文字”。');
  }

  function cancelRebinding() {
    state.rebindingAnnotationId = null;
    state.pendingSelection = null;
    global.getSelection()?.removeAllRanges();
    hideToolbar();
    showToast('已取消重新关联。');
  }

  function persistReanchoredAnnotation(annotation, nextAnchor, options) {
    const replacement = replaceAnnotationAnchor(annotation, nextAnchor, options);
    if (!replacement) return false;
    replaceLocalAnnotation(replacement);
    if (!persistStore()) return false;
    queueAnnotationMutation(replacement);
    return true;
  }

  function applyRebindSelection() {
    const annotation = state.store.annotations.find(
      (item) => item.id === state.rebindingAnnotationId,
    );
    const pending = state.pendingSelection;
    if (!annotation || !pending?.anchor) {
      showToast('请先在正文中选择新的对应文字。', 'error');
      return;
    }

    const success = persistReanchoredAnnotation(annotation, pending.anchor, {
      ...getPageMeta(),
      confidence: 1,
      reason: 'manual',
      strategy: 'manual',
    });
    if (!success) return;

    state.rebindingAnnotationId = null;
    state.pendingSelection = null;
    global.getSelection()?.removeAllRanges();
    hideToolbar();
    renderHighlights();
    showToast('已重新关联，并保留旧原文记录。', 'success');
  }

  function confirmCandidate(id) {
    const annotation = state.store.annotations.find((item) => item.id === id);
    const candidate = state.candidates.get(id);
    if (!annotation || !candidate?.range) return;
    const nextAnchor = buildAnchorFromRange(state.root, candidate.range);
    if (!nextAnchor) {
      showToast('疑似位置已经变化，请重新选择文字。', 'error');
      return;
    }

    const success = persistReanchoredAnnotation(annotation, nextAnchor, {
      confidence: candidate.confidence,
      reason: 'confirmed',
      strategy: candidate.strategy,
    });
    if (!success) return;
    renderHighlights();
    showToast('疑似位置已确认，旧原文已保留。', 'success');
  }

  function activeUiElement() {
    return state.ui?.shadow?.activeElement || document.activeElement;
  }

  function restoreFocus(element, fallback = state.ui?.shadow?.getElementById('launcher')) {
    global.setTimeout(() => {
      const target = (
        element?.isConnected
        && !element.closest?.('[hidden]')
        && !element.closest?.('[aria-hidden="true"]')
      ) ? element : fallback;
      target?.focus?.();
    }, 0);
  }

  function focusableElements(container) {
    if (!container) return [];
    return Array.from(container.querySelectorAll([
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(','))).filter((element) => (
      !element.hidden
      && !element.closest('[hidden]')
      && element.getAttribute('aria-hidden') !== 'true'
    ));
  }

  function trapDialogFocus(event, container) {
    if (event.key !== 'Tab') return;
    const focusable = focusableElements(container);
    if (!focusable.length) {
      event.preventDefault();
      container.focus?.();
      return;
    }
    const current = state.ui.shadow.activeElement;
    const first = focusable[0];
    const last = focusable.at(-1);
    const currentIndex = focusable.indexOf(current);
    if (event.shiftKey && currentIndex <= 0) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (currentIndex === -1 || current === last)) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleShadowKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!state.ui.recoveryModalLayer.hidden) closeRecoveryModal();
      else if (!state.ui.modalLayer.hidden) closeComposer();
      else if (state.ui.drawer.classList.contains('open')) closeDrawer();
      else if (state.rebindingAnnotationId) cancelRebinding();
      else hideToolbar();
      return;
    }
    if (!state.ui.recoveryModalLayer.hidden) {
      trapDialogFocus(event, state.ui.recoveryModalLayer.firstElementChild);
    } else if (!state.ui.modalLayer.hidden) {
      trapDialogFocus(event, state.ui.modalLayer.firstElementChild);
    } else if (state.ui.drawer.classList.contains('open')) {
      trapDialogFocus(event, state.ui.drawer);
    }
  }

  function openDrawer(filter = state.filter) {
    if (!state.ui.drawer.classList.contains('open')) {
      state.focusReturn.drawer = activeUiElement();
    }
    state.filter = filter;
    renderManager();
    state.ui.backdrop.hidden = false;
    state.ui.drawer.classList.add('open');
    state.ui.drawer.setAttribute('aria-hidden', 'false');
    global.setTimeout(() => state.ui.drawerTitle.focus(), 0);
  }

  function closeDrawer() {
    if (!state.ui) return;
    const wasOpen = state.ui.drawer.classList.contains('open');
    setSyncPanelOpen(false);
    state.ui.backdrop.hidden = true;
    state.ui.drawer.classList.remove('open');
    state.ui.drawer.setAttribute('aria-hidden', 'true');
    if (wasOpen) {
      restoreFocus(state.focusReturn.drawer);
      state.focusReturn.drawer = null;
    }
  }

  function setSyncPanelOpen(open) {
    const shouldOpen = Boolean(open);
    state.ui.syncPanel.hidden = !shouldOpen;
    state.ui.drawer.classList.toggle('sync-open', shouldOpen);
    state.ui.syncToggle.textContent = shouldOpen ? '返回笔记' : '同步设置';
    state.ui.syncToggle.setAttribute('aria-expanded', String(shouldOpen));
    if (shouldOpen) state.ui.syncPanel.scrollTop = 0;
  }

  function openComposerForSelection() {
    if (!state.pendingSelection) return;
    state.focusReturn.composer = activeUiElement();
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
    state.focusReturn.composer = activeUiElement();
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
    const wasOpen = !state.ui.modalLayer.hidden;
    state.composer = null;
    state.ui.modalLayer.hidden = true;
    state.ui.noteInput.value = '';
    if (wasOpen) {
      restoreFocus(state.focusReturn.composer);
      state.focusReturn.composer = null;
    }
  }

  function openRecoveryModal(mode, contents = '') {
    if (!state.ui) return;
    state.focusReturn.recovery = activeUiElement();
    const importing = mode === 'import';
    state.recoveryAction = { contents: String(contents || ''), mode };
    state.ui.recoveryModalTitle.textContent = importing
      ? '导入加密恢复包'
      : '导出加密恢复包';
    state.ui.recoveryModalHelp.textContent = importing
      ? '输入创建恢复包时使用的口令。恢复会替换本机当前的同步身份，但不会删除本地笔记。'
      : '恢复包包含同步密钥和设备凭据。请使用与账号无关的独立口令，并把文件保存在可信位置。';
    state.ui.recoveryConfirmLabel.hidden = importing;
    state.ui.recoveryPassphrase.autocomplete = importing
      ? 'current-password'
      : 'new-password';
    state.ui.recoveryPassphrase.value = '';
    state.ui.recoveryPassphraseConfirm.value = '';
    state.ui.recoveryModalLayer.hidden = false;
    global.setTimeout(() => state.ui.recoveryPassphrase.focus(), 0);
  }

  function closeRecoveryModal() {
    if (!state.ui) return;
    const wasOpen = !state.ui.recoveryModalLayer.hidden;
    state.recoveryAction = null;
    state.ui.recoveryModalLayer.hidden = true;
    state.ui.recoveryPassphrase.value = '';
    state.ui.recoveryPassphraseConfirm.value = '';
    if (wasOpen) {
      restoreFocus(state.focusReturn.recovery);
      state.focusReturn.recovery = null;
    }
  }

  async function handleRecoveryModalSubmit(event) {
    event.preventDefault();
    const action = state.recoveryAction;
    const passphrase = state.ui.recoveryPassphrase.value;
    if (!action) return;
    if (passphrase.length < 12) {
      showToast('恢复包口令至少需要 12 个字符。', 'error');
      state.ui.recoveryPassphrase.focus();
      return;
    }
    if (
      action.mode === 'export'
      && passphrase !== state.ui.recoveryPassphraseConfirm.value
    ) {
      showToast('两次输入的口令不一致。', 'error');
      state.ui.recoveryPassphraseConfirm.focus();
      return;
    }

    const submit = event.submitter || event.currentTarget.querySelector('[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      if (action.mode === 'export') {
        const recoveryKit = await createEncryptedRecoveryKit(state.sync, passphrase);
        const date = new Date().toISOString().slice(0, 10);
        downloadText(
          `ai-agent-book-recovery-${date}.json`,
          recoveryKit,
          'application/json',
        );
        closeRecoveryModal();
        showToast('加密恢复包已导出。', 'success');
        return;
      }

      const recovered = await openEncryptedRecoveryKit(action.contents, passphrase);
      if (
        isSyncConfigured()
        && !global.confirm('导入会替换本机当前的同步身份。确认继续？')
      ) {
        return;
      }
      const previousSync = state.sync;
      state.sync = recovered;
      state.syncDevices = [];
      state.syncError = '';
      if (!persistSyncState()) {
        state.sync = previousSync;
        renderSyncUi();
        return;
      }
      queueAllLocalAnnotations({ force: true });
      closeRecoveryModal();
      showToast('同步身份已恢复，正在核对远端笔记。', 'success');
      syncNow({ silent: true });
    } catch (error) {
      showToast(error.message || '恢复包处理失败。', 'error');
    } finally {
      if (submit) submit.disabled = false;
    }
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

  function openBackupFilePicker(kind) {
    state.ui.backupFileInput.value = '';
    state.ui.backupFileInput.dataset.kind = kind;
    state.ui.backupFileInput.click();
  }

  async function handleBackupFileSelection() {
    const input = state.ui.backupFileInput;
    const file = input.files?.[0];
    const kind = input.dataset.kind;
    input.value = '';
    if (!file) return;
    if (file.size > CONFIG.maxBackupFileBytes) {
      showToast(
        `备份文件超过 ${CONFIG.maxBackupFileBytes / 1024 / 1024} MiB，已拒绝读取。`,
        'error',
      );
      return;
    }

    try {
      const contents = await file.text();
      if (kind === 'recovery') {
        openRecoveryModal('import', contents);
        return;
      }

      const imported = parsePortableBackup(contents);
      const previousStore = state.store;
      const previousIds = new Set(previousStore.annotations.map((item) => item.id));
      const result = mergePortableAnnotations(
        previousStore.annotations,
        imported.annotations,
        { createId: createAnnotationId },
      );
      if (!result.added && !result.conflicts) {
        showToast(`没有新记录，已跳过 ${result.skipped} 条相同笔记。`);
        return;
      }
      const summary = [
        `新增 ${result.added} 条`,
        `冲突副本 ${result.conflicts} 条`,
        `跳过相同记录 ${result.skipped} 条`,
      ].join('，');
      if (!global.confirm(`即将合并便携备份：${summary}。确认继续？`)) return;

      state.store = result.store;
      if (!persistStore()) {
        state.store = previousStore;
        renderManager();
        return;
      }
      const importedIds = new Set(
        state.store.annotations
          .filter((item) => !previousIds.has(item.id))
          .map((item) => item.id),
      );
      queueAllLocalAnnotations({ force: true, recordIds: importedIds });
      renderHighlights();
      renderManager();
      showToast(`备份已合并：${summary}。`, 'success');
    } catch (error) {
      showToast(error.message || '无法读取备份文件。', 'error');
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
    if (action === 'apply-rebind') applyRebindSelection();
    if (action === 'cancel-rebind') cancelRebinding();
    if (action === 'close-drawer') closeDrawer();
    if (action === 'close-composer') closeComposer();
    if (action === 'delete-annotation') deleteAnnotation(id);
    if (action === 'edit-note') openComposerForEdit(id);
    if (action === 'rebind-annotation') startRebindingAnnotation(id);
    if (action === 'confirm-candidate') confirmCandidate(id);
    if (action === 'goto-annotation') goToAnnotation(id);
    if (action === 'export-markdown') exportNotes('markdown');
    if (action === 'export-html') exportNotes('html');
    if (action === 'toggle-sync-panel') {
      const shouldOpen = state.ui.syncPanel.hidden;
      setSyncPanelOpen(shouldOpen);
      renderSyncUi();
      if (shouldOpen && isSyncConfigured()) loadSyncDevices();
    }
    if (action === 'sync-now') {
      if (isSyncConfigured()) syncNow();
      else {
        setSyncPanelOpen(true);
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
    if (action === 'export-portable-backup') {
      const date = new Date().toISOString().slice(0, 10);
      downloadText(
        `ai-agent-book-backup-${date}.json`,
        createPortableBackup(state.store.annotations),
        'application/json',
      );
      showToast('便携备份已导出。', 'success');
    }
    if (action === 'import-portable-backup') openBackupFilePicker('portable');
    if (action === 'export-recovery-kit') openRecoveryModal('export');
    if (action === 'import-recovery-kit') openBackupFilePicker('recovery');
    if (action === 'close-recovery-modal') closeRecoveryModal();
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
      renderHighlights();
    }, 120);
  }

  function installListeners() {
    document.addEventListener('mouseup', (event) => {
      if (event.composedPath().includes(state.ui.host)) return;
      global.setTimeout(captureSelection, 0);
    });
    document.addEventListener('keyup', (event) => {
      if (event.key === 'Escape') {
        if (event.composedPath().includes(state.ui.host)) return;
        if (state.rebindingAnnotationId) cancelRebinding();
        else if (state.ui.drawer.classList.contains('open')) closeDrawer();
        else hideToolbar();
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
    global.addEventListener('load', scheduleRefresh);
    global.addEventListener('popstate', scheduleRefresh);
    global.addEventListener('pageshow', scheduleRefresh);
    global.addEventListener('online', () => scheduleSync(250));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      scheduleRefresh();
      scheduleSync(350);
    });

    state.observer = new MutationObserver((mutations) => {
      const articleRoot = getArticleRoot();
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
      const articleChanged = Boolean(articleRoot) && mutations.some((mutation) => (
        mutation.target === articleRoot || articleRoot.contains(mutation.target)
      ));
      if (pageChanged || articleChanged || themeChanged) scheduleRefresh();
    });
    state.observer.observe(document.documentElement, {
      attributeFilter: ['data-md-color-scheme'],
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });

    if (document.fonts?.ready) {
      document.fonts.ready.then(() => {
        if (state.initialized) scheduleHandDrawnMarkRefresh();
      }).catch(() => {});
    }

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
    if (state.initialized) {
      scheduleRefresh();
      return;
    }
    state.initialized = true;
    global.clearTimeout(state.bootstrapTimer);
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

  function bootstrap() {
    if (state.initialized) {
      scheduleRefresh();
      return;
    }

    if (!document.documentElement) {
      state.bootstrapAttempts += 1;
      if (state.bootstrapAttempts <= 8) {
        const delay = Math.min(1200, 25 * (2 ** (state.bootstrapAttempts - 1)));
        global.clearTimeout(state.bootstrapTimer);
        state.bootstrapTimer = global.setTimeout(bootstrap, delay);
      }
      return;
    }

    init();
  }

  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  global.addEventListener('load', bootstrap, { once: true });
  global.addEventListener('pageshow', bootstrap);
  bootstrap();
})(typeof window !== 'undefined' ? window : globalThis);
