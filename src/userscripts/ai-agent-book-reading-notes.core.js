// Pure annotation, anchoring, sync-state, export, and recovery domain module.
// Bundled into the installable userscript by tools/build-userscripts.mjs.

(function aiAgentBookReadingNotes(global) {
  'use strict';

  const CONFIG = Object.freeze({
    anchorVersion: 2,
    autoRelocateConfidence: 0.9,
    bookTitle: 'AI Agents in Depth',
    contextLength: 64,
    maxAnchorHistory: 8,
    maxBackupFileBytes: 50 * 1024 * 1024,
    maxBlockTextLength: 4000,
    maxSelectionLength: 6000,
    portableBackupFormat: 'ai-agent-book-reading-notes',
    portableBackupVersion: 1,
    schemaVersion: 2,
    storageKey: 'ai-agent-book:reading-notes:v1',
    syncStorageKey: 'ai-agent-book:reading-notes-sync:v1',
    uiHostId: 'aab-reading-notes-host',
  });

  const SYNC_CONFIG = Object.freeze({
    apiVersion: 1,
    maxBatchSize: 100,
    maxCiphertextLength: 128 * 1024,
    pairingPollMs: 2200,
    recoveryFormat: 'ai-agent-book-reading-notes-recovery',
    recoveryKdfIterations: 310000,
    recoveryVersion: 1,
    schemaVersion: 2,
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

  function normalizeAnchorText(value) {
    let output = '';
    for (const character of String(value || '')) {
      const normalized = character.normalize('NFKC').toLocaleLowerCase();
      for (const normalizedCharacter of normalized) {
        if (/[\p{White_Space}\p{P}]/u.test(normalizedCharacter)) continue;
        output += normalizedCharacter;
      }
    }
    return output;
  }

  function buildNormalizedTextMap(value) {
    const source = String(value || '');
    const offsets = [];
    const ends = [];
    let text = '';
    let sourceOffset = 0;

    for (const character of source) {
      const normalized = character.normalize('NFKC').toLocaleLowerCase();
      const characterEnd = sourceOffset + character.length;
      for (const normalizedCharacter of normalized) {
        if (/[\p{White_Space}\p{P}]/u.test(normalizedCharacter)) continue;
        text += normalizedCharacter;
        offsets.push(sourceOffset);
        ends.push(characterEnd);
      }
      sourceOffset = characterEnd;
    }

    return { ends, offsets, text };
  }

  function bigramDiceSimilarity(left, right) {
    const first = String(left || '');
    const second = String(right || '');
    if (first === second) return 1;
    if (!first || !second) return 0;
    if (first.length === 1 || second.length === 1) return first === second ? 1 : 0;

    const counts = new Map();
    for (let index = 0; index < first.length - 1; index += 1) {
      const bigram = first.slice(index, index + 2);
      counts.set(bigram, (counts.get(bigram) || 0) + 1);
    }

    let overlap = 0;
    for (let index = 0; index < second.length - 1; index += 1) {
      const bigram = second.slice(index, index + 2);
      const remaining = counts.get(bigram) || 0;
      if (!remaining) continue;
      overlap += 1;
      counts.set(bigram, remaining - 1);
    }

    return (2 * overlap) / (first.length + second.length - 2);
  }

  function headingPathSimilarity(left, right) {
    const first = Array.isArray(left) ? left.map(normalizeAnchorText).filter(Boolean) : [];
    const second = Array.isArray(right) ? right.map(normalizeAnchorText).filter(Boolean) : [];
    if (!first.length || !second.length) return 0;
    const limit = Math.min(first.length, second.length);
    let matches = 0;
    for (let index = 1; index <= limit; index += 1) {
      if (first[first.length - index] !== second[second.length - index]) break;
      matches += 1;
    }
    return matches / Math.max(first.length, second.length);
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

  async function createPairingSafetyNumber(
    pairId,
    publicKeyJwk,
    cryptoObject = global.crypto,
  ) {
    const identity = {
      crv: String(publicKeyJwk?.crv || ''),
      kty: String(publicKeyJwk?.kty || ''),
      x: String(publicKeyJwk?.x || ''),
      y: String(publicKeyJwk?.y || ''),
    };
    if (
      !pairId
      || identity.kty !== 'EC'
      || identity.crv !== 'P-256'
      || !identity.x
      || !identity.y
    ) {
      throw new Error('无法生成设备配对安全码。');
    }
    const input = new TextEncoder().encode(
      `${String(pairId)}|${JSON.stringify(identity)}`,
    );
    const digest = new Uint8Array(
      await cryptoObject.subtle.digest('SHA-256', input),
    );
    const value = [...digest.slice(0, 6)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
    return value.match(/.{4}/g).join('-');
  }

  function normalizePairingSafetyNumber(value) {
    return String(value || '').toUpperCase().replace(/[^A-F0-9]/g, '');
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

  function normalizeBlockedSyncRecord(value) {
    if (!value || typeof value !== 'object') return null;
    const recordId = String(value.recordId || '');
    const projectedCiphertextLength = Number(value.projectedCiphertextLength);
    if (
      !recordId
      || value.code !== 'payload_too_large'
      || !Number.isSafeInteger(projectedCiphertextLength)
      || projectedCiphertextLength <= SYNC_CONFIG.maxCiphertextLength
    ) {
      return null;
    }
    return {
      code: 'payload_too_large',
      projectedCiphertextLength,
      recordId,
      updatedAt: String(value.updatedAt || new Date(0).toISOString()),
    };
  }

  function getAnnotationSyncIssue(annotation) {
    const normalized = normalizeAnnotation(annotation);
    if (!normalized) return null;
    const plaintextLength = new TextEncoder().encode(JSON.stringify(normalized)).length;
    const projectedCiphertextLength = Math.ceil((plaintextLength + 16) * 4 / 3);
    if (projectedCiphertextLength <= SYNC_CONFIG.maxCiphertextLength) return null;
    return {
      code: 'payload_too_large',
      limit: SYNC_CONFIG.maxCiphertextLength,
      projectedCiphertextLength,
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
        safetyNumber: String(source.pairing.safetyNumber || ''),
      }
      : null;
    const blockedByRecord = new Map(
      (Array.isArray(source.blocked) ? source.blocked : [])
        .map(normalizeBlockedSyncRecord)
        .filter(Boolean)
        .map((item) => [item.recordId, item]),
    );
    const pending = [];
    for (const mutation of (Array.isArray(source.pending) ? source.pending : [])) {
      const normalized = normalizePendingMutation(mutation);
      if (!normalized) continue;
      const issue = normalized.deleted ? null : getAnnotationSyncIssue(normalized.snapshot);
      if (!issue) {
        pending.push(normalized);
        blockedByRecord.delete(normalized.recordId);
        continue;
      }
      blockedByRecord.set(normalized.recordId, {
        code: issue.code,
        projectedCiphertextLength: issue.projectedCiphertextLength,
        recordId: normalized.recordId,
        updatedAt: String(
          normalized.snapshot?.updatedAt
          || source.lastSyncAt
          || new Date(0).toISOString(),
        ),
      });
    }

    return {
      blocked: [...blockedByRecord.values()],
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
      pending,
      schemaVersion: SYNC_CONFIG.schemaVersion,
      versions,
    };
  }

  function prepareSyncMutation(current, annotation, options = {}) {
    const sync = normalizeSyncState(current);
    const recordId = String(options.recordId || annotation?.id || '');
    const deleted = Boolean(options.deleted);
    const issue = deleted ? null : getAnnotationSyncIssue(annotation);
    const mutation = issue
      ? null
      : createPendingMutation(sync, annotation, options);

    sync.pending = sync.pending.filter((item) => item.recordId !== recordId);
    sync.blocked = sync.blocked.filter((item) => item.recordId !== recordId);

    if (issue && recordId) {
      sync.blocked.push({
        code: issue.code,
        projectedCiphertextLength: issue.projectedCiphertextLength,
        recordId,
        updatedAt: String(annotation?.updatedAt || new Date().toISOString()),
      });
    } else if (mutation) {
      sync.pending.push(mutation);
    }

    return {
      issue,
      queued: Boolean(mutation),
      sync,
    };
  }

  function classifySyncCompletion(value = {}) {
    const rounds = Math.max(0, Math.trunc(Number(value.rounds) || 0));
    const maxRounds = Math.max(1, Math.trunc(Number(value.maxRounds) || 30));
    const pendingCount = Math.max(0, Math.trunc(Number(value.pendingCount) || 0));
    const shouldContinue = Boolean(value.hasMore || pendingCount);
    return {
      complete: !shouldContinue,
      reachedRoundLimit: shouldContinue && rounds >= maxRounds,
      shouldContinue,
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

  function originalOffsetToNormalizedIndex(map, offset) {
    const target = Math.max(0, Number(offset) || 0);
    let low = 0;
    let high = map.offsets.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (map.offsets[middle] < target) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function mapNormalizedRange(map, start, end) {
    if (
      !map
      || start < 0
      || end <= start
      || start >= map.offsets.length
      || end > map.ends.length
    ) {
      return null;
    }
    return {
      end: map.ends[end - 1],
      start: map.offsets[start],
    };
  }

  function blockScoreForRange(anchor, blocks, start, end) {
    const saved = anchor?.block;
    if (!saved || !Array.isArray(blocks) || !blocks.length) return 0;
    const current = blocks.find((block) => start >= block.start && end <= block.end);
    if (!current) return 0;

    const savedText = normalizeAnchorText(saved.text);
    const currentText = normalizeAnchorText(current.text);
    const textScore = savedText && currentText
      ? bigramDiceSimilarity(savedText, currentText)
      : 0;
    const tagScore = saved.tag && saved.tag === current.tag ? 1 : 0;
    const headingScore = headingPathSimilarity(saved.headingPath, current.headingPath);
    return textScore * 0.68 + headingScore * 0.22 + tagScore * 0.1;
  }

  function findNormalizedQuote(source, anchor, options = {}) {
    const map = buildNormalizedTextMap(source);
    const exact = normalizeAnchorText(anchor?.exact);
    if (!map.text || !exact) return null;

    const prefix = normalizeAnchorText(anchor.prefix);
    const suffix = normalizeAnchorText(anchor.suffix);
    const preferredStart = Number.isFinite(Number(anchor.start))
      ? originalOffsetToNormalizedIndex(map, anchor.start)
      : null;
    const candidates = [];
    let searchFrom = 0;

    while (searchFrom <= map.text.length - exact.length && candidates.length < 500) {
      const index = map.text.indexOf(exact, searchFrom);
      if (index === -1) break;
      const mapped = mapNormalizedRange(map, index, index + exact.length);
      if (!mapped) break;

      const before = map.text.slice(Math.max(0, index - prefix.length), index);
      const after = map.text.slice(index + exact.length, index + exact.length + suffix.length);
      const availableContext = prefix.length + suffix.length;
      const contextScore = commonSuffixLength(before, prefix) + commonPrefixLength(after, suffix);
      const contextRatio = availableContext ? contextScore / availableContext : 0;
      const structuralScore = blockScoreForRange(
        anchor,
        options.blocks,
        mapped.start,
        mapped.end,
      );
      const distance = preferredStart === null ? 0 : Math.abs(index - preferredStart);

      candidates.push({
        ...mapped,
        contextRatio,
        distance,
        rankScore: contextRatio * 0.72 + structuralScore * 0.28,
      });
      searchFrom = index + Math.max(1, exact.length);
    }

    if (!candidates.length) return null;
    candidates.sort((left, right) => (
      right.rankScore - left.rankScore
      || left.distance - right.distance
      || left.start - right.start
    ));

    const best = candidates[0];
    const unique = candidates.length === 1;
    const confidence = unique ? 0.96 : Math.min(0.94, 0.76 + best.rankScore * 0.2);
    return {
      confidence,
      end: best.end,
      needsReview: !unique && best.rankScore < 0.55,
      start: best.start,
      strategy: 'normalized-quote',
    };
  }

  function findFuzzyQuote(source, anchor, options = {}) {
    const map = buildNormalizedTextMap(source);
    const target = normalizeAnchorText(anchor?.exact);
    if (!map.text || target.length < 16 || target.length > 800) return null;

    const maxDelta = clamp(Math.ceil(target.length * 0.1), 2, 14);
    const seedLength = clamp(Math.floor(target.length / 5), 6, 18);
    const seedOffsets = new Set([
      0,
      Math.max(0, Math.floor(target.length * 0.25) - Math.floor(seedLength / 2)),
      Math.max(0, Math.floor(target.length * 0.5) - Math.floor(seedLength / 2)),
      Math.max(0, Math.floor(target.length * 0.75) - Math.floor(seedLength / 2)),
      Math.max(0, target.length - seedLength),
    ]);
    const candidateStarts = new Set();
    const preferredStart = Number.isFinite(Number(anchor.start))
      ? originalOffsetToNormalizedIndex(map, anchor.start)
      : null;
    if (preferredStart !== null) candidateStarts.add(preferredStart);

    for (const seedOffset of seedOffsets) {
      const seed = target.slice(seedOffset, seedOffset + seedLength);
      let from = 0;
      let matches = 0;
      while (seed && matches < 30) {
        const found = map.text.indexOf(seed, from);
        if (found === -1) break;
        candidateStarts.add(Math.max(0, found - seedOffset));
        from = found + Math.max(1, seed.length);
        matches += 1;
      }
    }

    const shifts = [...new Set([
      -maxDelta,
      -Math.floor(maxDelta / 2),
      0,
      Math.floor(maxDelta / 2),
      maxDelta,
    ])];
    const lengths = [...new Set([
      target.length - maxDelta,
      target.length - Math.floor(maxDelta / 2),
      target.length,
      target.length + Math.floor(maxDelta / 2),
      target.length + maxDelta,
    ])].filter((length) => length > 0);
    const prefix = normalizeAnchorText(anchor.prefix);
    const suffix = normalizeAnchorText(anchor.suffix);
    const availableContext = prefix.length + suffix.length;
    const evaluated = new Map();

    for (const estimatedStart of [...candidateStarts].slice(0, 80)) {
      for (const shift of shifts) {
        const start = clamp(estimatedStart + shift, 0, map.text.length);
        for (const length of lengths) {
          const end = Math.min(map.text.length, start + length);
          if (end <= start) continue;
          const candidateText = map.text.slice(start, end);
          const quoteSimilarity = bigramDiceSimilarity(target, candidateText);
          if (quoteSimilarity < 0.72) continue;
          const mapped = mapNormalizedRange(map, start, end);
          if (!mapped) continue;

          const before = map.text.slice(Math.max(0, start - prefix.length), start);
          const after = map.text.slice(end, end + suffix.length);
          const contextScore = commonSuffixLength(before, prefix)
            + commonPrefixLength(after, suffix);
          const contextRatio = availableContext ? contextScore / availableContext : 0;
          const structuralScore = blockScoreForRange(
            anchor,
            options.blocks,
            mapped.start,
            mapped.end,
          );
          const confidence = quoteSimilarity * 0.82
            + contextRatio * 0.12
            + structuralScore * 0.06;
          const key = `${mapped.start}:${mapped.end}`;
          const candidate = {
            ...mapped,
            confidence,
            quoteSimilarity,
          };
          if (!evaluated.has(key) || evaluated.get(key).confidence < confidence) {
            evaluated.set(key, candidate);
          }
        }
      }
    }

    const candidates = [...evaluated.values()]
      .filter((candidate) => candidate.confidence >= 0.78)
      .sort((left, right) => (
        right.confidence - left.confidence
        || Math.abs(left.start - Number(anchor.start || 0))
          - Math.abs(right.start - Number(anchor.start || 0))
      ));
    if (!candidates.length) return null;

    const best = candidates[0];
    const runnerUp = candidates.find((candidate) => (
      Math.abs(candidate.start - best.start) > Math.max(4, target.length * 0.25)
    ));
    const margin = runnerUp ? best.confidence - runnerUp.confidence : 1;
    return {
      confidence: Math.min(0.94, best.confidence),
      end: best.end,
      needsReview: best.confidence < CONFIG.autoRelocateConfidence || margin < 0.04,
      start: best.start,
      strategy: 'fuzzy-quote',
    };
  }

  function locateTextAnchor(text, anchor, options = {}) {
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

    if (!candidates.length) {
      return findNormalizedQuote(source, anchor, options)
        || findFuzzyQuote(source, anchor, options);
    }

    candidates.sort((left, right) => (
      right.contextScore - left.contextScore
      || left.distance - right.distance
      || left.start - right.start
    ));

    const best = candidates[0];
    const runnerUp = candidates[1] || null;
    const availableContext = prefix.length + suffix.length;
    const contextConfidence = availableContext
      ? best.contextScore / availableContext
      : candidates.length === 1 ? 1 : 0.5;
    const contextMargin = runnerUp
      ? best.contextScore - runnerUp.contextScore
      : availableContext;
    const needsReview = candidates.length > 1 && (
      contextConfidence < 0.55
      || contextMargin < Math.max(2, availableContext * 0.08)
    );

    return {
      confidence: Math.max(0.35, Math.min(0.99, contextConfidence)),
      end: best.end,
      needsReview,
      start: best.start,
      strategy: 'quote',
    };
  }

  function normalizeBlockAnchor(value) {
    if (!value || typeof value !== 'object') return null;
    const text = String(value.text || '').slice(0, CONFIG.maxBlockTextLength);
    const tag = String(value.tag || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    const rawStart = Number(value.start);
    const rawEnd = Number(value.end);
    if (!text || !tag || !Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) return null;

    const start = Math.max(0, Math.trunc(rawStart));
    const end = Math.max(start, Math.trunc(rawEnd));
    const selectionStart = clamp(
      Math.trunc(Number(value.selectionStart) || 0),
      0,
      Math.max(0, end - start),
    );
    const selectionEnd = clamp(
      Math.trunc(Number(value.selectionEnd) || selectionStart),
      selectionStart,
      Math.max(selectionStart, end - start),
    );

    return {
      end,
      headingPath: Array.isArray(value.headingPath)
        ? value.headingPath.map((item) => String(item || '').trim()).filter(Boolean).slice(-6)
        : [],
      index: Math.max(0, Math.trunc(Number(value.index) || 0)),
      selectionEnd,
      selectionStart,
      start,
      tag,
      text,
    };
  }

  function normalizeAnchorHistory(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(-CONFIG.maxAnchorHistory).map((item) => {
      const exact = String(item?.exact || '');
      if (!exact) return null;
      const start = Math.max(0, Math.trunc(Number(item.start) || 0));
      const end = Math.max(start + exact.length, Math.trunc(Number(item.end) || 0));
      return {
        changedAt: String(item.changedAt || new Date(0).toISOString()),
        end,
        exact,
        prefix: String(item.prefix || ''),
        reason: ['automatic', 'confirmed', 'manual'].includes(item.reason)
          ? item.reason
          : 'manual',
        start,
        suffix: String(item.suffix || ''),
      };
    }).filter(Boolean);
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

    const block = normalizeBlockAnchor(value.anchor?.block);
    const relocation = value.relocation && typeof value.relocation === 'object'
      ? {
        at: String(value.relocation.at || ''),
        confidence: clamp(Number(value.relocation.confidence) || 0, 0, 1),
        strategy: String(value.relocation.strategy || ''),
      }
      : null;

    return {
      anchor: {
        anchorVersion: Math.max(1, Math.trunc(Number(value.anchor?.anchorVersion) || 1)),
        ...(block ? { block } : {}),
        end,
        exact,
        prefix: String(value.anchor?.prefix || ''),
        start,
        suffix: String(value.anchor?.suffix || ''),
      },
      anchorHistory: normalizeAnchorHistory(value.anchorHistory),
      createdAt: String(value.createdAt || new Date(0).toISOString()),
      id,
      note: String(value.note || '').trim(),
      pageOrder: Number.isFinite(Number(value.pageOrder))
        ? Number(value.pageOrder)
        : 9999,
      pageTitle: String(value.pageTitle || '未命名章节').trim() || '未命名章节',
      pageUrl,
      ...(relocation?.at && relocation.strategy ? { relocation } : {}),
      syncConflict: Boolean(value.syncConflict),
      type,
      updatedAt: String(value.updatedAt || value.createdAt || new Date(0).toISOString()),
    };
  }

  function replaceAnnotationAnchor(annotation, nextAnchor, options = {}) {
    const current = normalizeAnnotation(annotation);
    if (!current || !nextAnchor?.exact) return null;
    const changedAt = String(options.changedAt || new Date().toISOString());
    const changed = (
      current.anchor.exact !== nextAnchor.exact
      || current.anchor.start !== nextAnchor.start
      || current.anchor.end !== nextAnchor.end
    );
    const history = changed
      ? [
        ...current.anchorHistory,
        {
          changedAt,
          end: current.anchor.end,
          exact: current.anchor.exact,
          prefix: current.anchor.prefix,
          reason: options.reason || 'manual',
          start: current.anchor.start,
          suffix: current.anchor.suffix,
        },
      ].slice(-CONFIG.maxAnchorHistory)
      : current.anchorHistory;

    return normalizeAnnotation({
      ...current,
      anchor: nextAnchor,
      anchorHistory: history,
      pageOrder: options.pageOrder ?? current.pageOrder,
      pageTitle: options.pageTitle ?? current.pageTitle,
      pageUrl: options.pageUrl ?? current.pageUrl,
      relocation: {
        at: changedAt,
        confidence: options.confidence ?? 1,
        strategy: options.strategy || options.reason || 'manual',
      },
      updatedAt: changedAt,
    });
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

  function createPortableBackup(annotations, options = {}) {
    const store = normalizeStore({ annotations });
    return `${JSON.stringify({
      exportedAt: String(options.exportedAt || new Date().toISOString()),
      format: CONFIG.portableBackupFormat,
      store,
      version: CONFIG.portableBackupVersion,
    }, null, 2)}\n`;
  }

  function parsePortableBackup(value) {
    let parsed;
    try {
      parsed = typeof value === 'string' ? JSON.parse(value) : value;
    } catch (_error) {
      throw new Error('备份文件不是有效的 JSON。');
    }
    if (
      !parsed
      || parsed.format !== CONFIG.portableBackupFormat
      || parsed.version !== CONFIG.portableBackupVersion
      || !parsed.store
    ) {
      throw new Error('备份文件格式或版本不受支持。');
    }
    return normalizeStore(parsed.store);
  }

  function mergePortableAnnotations(current, imported, options = {}) {
    const currentStore = normalizeStore({ annotations: current });
    const importedStore = normalizeStore({ annotations: imported });
    const byId = new Map(currentStore.annotations.map((item) => [item.id, item]));
    const createId = typeof options.createId === 'function'
      ? options.createId
      : () => `aab-import-${randomBase64Url(18)}`;
    let added = 0;
    let conflicts = 0;
    let skipped = 0;

    for (const annotation of importedStore.annotations) {
      const existing = byId.get(annotation.id);
      if (!existing) {
        byId.set(annotation.id, annotation);
        added += 1;
        continue;
      }
      if (JSON.stringify(existing) === JSON.stringify(annotation)) {
        skipped += 1;
        continue;
      }

      let conflictId = String(createId() || '');
      let attempts = 0;
      while ((!conflictId || byId.has(conflictId)) && attempts < 10) {
        conflictId = String(createId() || '');
        attempts += 1;
      }
      if (!conflictId || byId.has(conflictId)) {
        throw new Error('无法为导入冲突生成新的记录标识。');
      }
      const conflict = normalizeAnnotation({
        ...annotation,
        id: conflictId,
        syncConflict: true,
      });
      byId.set(conflict.id, conflict);
      conflicts += 1;
    }

    return {
      added,
      conflicts,
      skipped,
      store: normalizeStore({ annotations: [...byId.values()] }),
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

        if (annotation.anchorHistory.length) {
          lines.push('**关联前原文**', '');
          for (const item of annotation.anchorHistory.slice().reverse()) {
            lines.push(markdownQuote(item.exact), '');
          }
        }

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
        const history = annotation.anchorHistory.length
          ? `<details class="history">
              <summary>关联前原文（${annotation.anchorHistory.length}）</summary>
              ${annotation.anchorHistory.slice().reverse().map((item) => (
    `<blockquote>${escapeHtml(item.exact)}</blockquote>`
  )).join('')}
            </details>`
          : '';
        return `
          <article class="note-card note-card--${escapeHtml(annotation.type)}">
            <header>
              <span>${index + 1}. ${escapeHtml(ANNOTATION_TYPES[annotation.type])}</span>
              <time>${escapeHtml(formatReadableDate(annotation.createdAt))}</time>
            </header>
            <blockquote>${escapeHtml(annotation.anchor.exact)}</blockquote>
            ${history}
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
    .history {
      margin-top: 14px;
      color: #736b61;
      font-size: 15px;
    }
    .history summary { cursor: pointer; }
    .history blockquote {
      margin-top: 10px;
      border-color: #b7aa99;
    }
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

  async function deriveRecoveryKey(
    passphrase,
    salt,
    iterations,
    usage,
    cryptoObject,
  ) {
    const material = await cryptoObject.subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    return cryptoObject.subtle.deriveKey({
      hash: 'SHA-256',
      iterations,
      name: 'PBKDF2',
      salt,
    }, material, {
      length: 256,
      name: 'AES-GCM',
    }, false, [usage]);
  }

  async function createEncryptedRecoveryKit(
    value,
    passphrase,
    cryptoObject = global.crypto,
  ) {
    const sync = normalizeSyncState(value);
    if (
      !sync.endpoint
      || !sync.libraryId
      || !sync.deviceId
      || !sync.deviceToken
      || !sync.masterKey
    ) {
      throw new Error('当前设备尚未配置完整的同步凭证。');
    }
    if (String(passphrase || '').length < 12) {
      throw new Error('恢复包口令至少需要 12 个字符。');
    }

    const salt = cryptoObject.getRandomValues(new Uint8Array(16));
    const iv = cryptoObject.getRandomValues(new Uint8Array(12));
    const key = await deriveRecoveryKey(
      String(passphrase),
      salt,
      SYNC_CONFIG.recoveryKdfIterations,
      'encrypt',
      cryptoObject,
    );
    const additionalData = new TextEncoder().encode(
      `${SYNC_CONFIG.recoveryFormat}|${SYNC_CONFIG.recoveryVersion}`,
    );
    const plaintext = new TextEncoder().encode(JSON.stringify({
      cursor: sync.cursor,
      deviceId: sync.deviceId,
      deviceName: sync.deviceName,
      deviceToken: sync.deviceToken,
      endpoint: sync.endpoint,
      libraryId: sync.libraryId,
      masterKey: sync.masterKey,
      versions: sync.versions,
    }));
    const ciphertext = await cryptoObject.subtle.encrypt({
      additionalData,
      iv,
      name: 'AES-GCM',
    }, key, plaintext);

    return `${JSON.stringify({
      cipher: {
        ciphertext: bytesToBase64Url(ciphertext),
        iv: bytesToBase64Url(iv),
        name: 'AES-GCM',
      },
      format: SYNC_CONFIG.recoveryFormat,
      kdf: {
        hash: 'SHA-256',
        iterations: SYNC_CONFIG.recoveryKdfIterations,
        name: 'PBKDF2',
        salt: bytesToBase64Url(salt),
      },
      version: SYNC_CONFIG.recoveryVersion,
    }, null, 2)}\n`;
  }

  async function openEncryptedRecoveryKit(
    value,
    passphrase,
    cryptoObject = global.crypto,
  ) {
    let parsed;
    try {
      parsed = typeof value === 'string' ? JSON.parse(value) : value;
    } catch (_error) {
      throw new Error('恢复包不是有效的 JSON。');
    }
    const iterations = Number(parsed?.kdf?.iterations);
    if (
      parsed?.format !== SYNC_CONFIG.recoveryFormat
      || parsed?.version !== SYNC_CONFIG.recoveryVersion
      || parsed?.kdf?.name !== 'PBKDF2'
      || parsed?.kdf?.hash !== 'SHA-256'
      || parsed?.cipher?.name !== 'AES-GCM'
      || !Number.isSafeInteger(iterations)
      || iterations < 100000
      || iterations > 1000000
    ) {
      throw new Error('恢复包格式或加密参数不受支持。');
    }
    if (String(passphrase || '').length < 12) {
      throw new Error('恢复包口令至少需要 12 个字符。');
    }

    try {
      const salt = base64UrlToBytes(parsed.kdf.salt);
      const iv = base64UrlToBytes(parsed.cipher.iv);
      const ciphertext = base64UrlToBytes(parsed.cipher.ciphertext);
      if (salt.length !== 16 || iv.length !== 12 || !ciphertext.length) {
        throw new Error('invalid encrypted payload');
      }
      const key = await deriveRecoveryKey(
        String(passphrase),
        salt,
        iterations,
        'decrypt',
        cryptoObject,
      );
      const additionalData = new TextEncoder().encode(
        `${SYNC_CONFIG.recoveryFormat}|${SYNC_CONFIG.recoveryVersion}`,
      );
      const plaintext = await cryptoObject.subtle.decrypt({
        additionalData,
        iv,
        name: 'AES-GCM',
      }, key, ciphertext);
      const sync = normalizeSyncState(
        JSON.parse(new TextDecoder().decode(plaintext)),
      );
      if (
        !sync.endpoint
        || !sync.libraryId
        || !sync.deviceId
        || !sync.deviceToken
        || !sync.masterKey
      ) {
        throw new Error('incomplete recovery state');
      }
      return sync;
    } catch (_error) {
      throw new Error('恢复包口令错误，或文件已经损坏。');
    }
  }

  const core = Object.freeze({
    ANNOTATION_TYPES,
    CONFIG,
    HIGHLIGHT_NAMES,
    SYNC_CONFIG,
    clamp,
    escapeHtml,
    formatReadableDate,
    normalizePairingSafetyNumber,
    randomBase64Url,
    buildTextAnchor,
    bigramDiceSimilarity,
    calculateCenteredScrollTop,
    classifySyncCompletion,
    compareAnnotations,
    createEncryptedRecoveryKit,
    createPairingSafetyNumber,
    createHtmlExport,
    createMarkdownExport,
    createPortableBackup,
    createPendingMutation,
    base64UrlToBytes,
    bytesToBase64Url,
    findTextOffsetPoint,
    getBrushStrokeVariation,
    getHandUnderlineVariation,
    groupAnnotations,
    locateTextAnchor,
    mergePortableAnnotations,
    mergeTextLineRects,
    normalizeAnchorText,
    normalizeAnnotation,
    normalizeBlockAnchor,
    normalizePageUrl,
    normalizeSyncEndpoint,
    normalizeSyncState,
    normalizeStore,
    openEncryptedRecoveryKit,
    parsePortableBackup,
    prepareSyncMutation,
    replaceAnnotationAnchor,
    sha256Base64Url,
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = core;
  }
  Object.defineProperty(global, '__AAB_READING_NOTES_CORE__', {
    configurable: true,
    value: core,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
