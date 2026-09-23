// SPDX-License-Identifier: AGPL-3.0-or-later
// Bounded, page-local media index. Never retains request headers or full responses.
function createMxgaVideoSource(global, page = global) {
  const instances = createMxgaVideoSource.instances ||= new WeakMap();
  if (instances.has(global)) return instances.get(global);
  const cache = new Map();
  const TTL = 10 * 60 * 1000;
  const MAX_BYTES = 2 * 1024 * 1024;
  const now = () => Date.now();
  function videoUrl(value) {
    try {
      if (typeof value !== 'string' || value.length > 4096) return '';
      const u = new URL(value);
      return u.protocol === 'https:' && u.hostname === 'video.twimg.com' && !u.port
        && !u.username && !u.password && /\.mp4$/.test(u.pathname) ? u.href : '';
    } catch (_) { return ''; }
  }
  function prune() {
    for (const [id, record] of cache) if (now() - record.time >= TTL) cache.delete(id);
    while (cache.size > 100) cache.delete(cache.keys().next().value);
  }
  function ingest(data) {
    const queue = [data];
    const seen = new WeakSet();
    for (let count = 0; queue.length && count < 15000; count++) {
      const node = queue.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      const id = node.rest_id || node.id_str;
      const media = (node.legacy || node).extended_entities?.media;
      if (typeof id === 'string' && /^\d{1,25}$/.test(id) && Array.isArray(media)) {
        const videos = media.slice(0, 4).filter(m => ['video', 'animated_gif'].includes(m?.type));
        const items = videos.map((m, index) => {
          const variants = Array.isArray(m.video_info?.variants) ? m.video_info.variants.slice(0, 32) : [];
          const best = variants.filter(v => v?.content_type === 'video/mp4' && videoUrl(v.url))
            .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))[0];
          return best && { url: videoUrl(best.url), type: 'video', label: `下载视频 ${index + 1}`,
            filename: `x-${id}-${index + 1}.mp4` };
        });
        if (videos.length) {
          cache.delete(id);
          cache.set(id, { time: now(), items: items.every(Boolean) ? items : [], unsupported: items.some(i => !i) });
        }
      }
      // Bounded breadth as well as depth, including malformed page values.
      const values = Object.values(node);
      for (let i = 0; i < values.length && queue.length < 15000; i++) {
        if (values[i] && typeof values[i] === 'object') queue.push(values[i]);
      }
    }
    prune();
  }
  function acceptUrl(value) {
    try {
      const u = new URL(value, page.location?.href);
      return u.origin === page.location?.origin && /^\/i\/api\/graphql\/[^/]+\/(TweetDetail|TweetResultByRestId|TweetResultsByRestIds|HomeTimeline|HomeLatestTimeline|UserTweets|UserTweetsAndReplies|UserMedia|SearchTimeline|Bookmarks|ListLatestTweetsTimeline)$/.test(u.pathname);
    } catch (_) { return false; }
  }
  function ingestText(text) {
    if (typeof text !== 'string' || text.length > MAX_BYTES) return;
    try { ingest(JSON.parse(text)); } catch (_) { /* Observation cannot break X. */ }
  }
  function get(id) {
    prune();
    const record = cache.get(id);
    return record && { ...record, items: record.items.map(item => ({ ...item })) };
  }
  async function resolve(tweetUrl, signal) {
    const id = new URL(tweetUrl).pathname.match(/\/status\/(\d+)\/?$/)?.[1];
    if (!id) throw new Error('无法确认视频所属帖子');
    for (let attempt = 0; attempt < 9; attempt++) {
      if (signal?.aborted) throw new Error('已取消解析');
      const record = get(id);
      if (record?.items.length) return record.items;
      if (record?.unsupported) throw new Error('当前页面的视频没有完整 MP4，暂不支持分片下载');
      if (attempt < 8) await new Promise(resolve => {
        const finish = () => { global.clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
        const timer = global.setTimeout(finish, 250);
        signal?.addEventListener('abort', finish, { once: true });
      });
    }
    throw new Error('尚未获取本帖视频信息，请打开该帖并刷新页面后重试');
  }
  function install() {
    // Functions execute against page-owned APIs, not the userscript sandbox's fetch.
    try {
      const original = page.fetch;
      if (typeof original === 'function') page.fetch = function (...args) {
        const result = Reflect.apply(original, this, args);
        result.then(response => {
          if (!acceptUrl(response.url) || !response.ok || !/application\/json/i.test(response.headers.get('content-type') || '')) return;
          if (Number(response.headers.get('content-length')) > MAX_BYTES) return;
          const copy = response.clone();
          void (async () => {
            const reader = copy.body?.getReader();
            if (!reader) return;
            let size = 0;
            let text = '';
            const decoder = new TextDecoder();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > MAX_BYTES) { void reader.cancel().catch(() => {}); return; }
                text += decoder.decode(value, { stream: true });
              }
              ingestText(text + decoder.decode());
            } finally { reader.releaseLock(); }
          })().catch(() => {});
        }).catch(() => {});
        return result;
      };
    } catch (_) { /* Another script or the manager may disallow wrapping. */ }
    try {
      const proto = page.XMLHttpRequest?.prototype;
      if (!proto) return;
      const original = proto.send;
      proto.send = function (...args) {
        this.addEventListener('load', () => {
          try {
            if (!acceptUrl(this.responseURL) || this.status !== 200
              || !/application\/json/i.test(this.getResponseHeader('content-type') || '')) return;
            if (Number(this.getResponseHeader('content-length')) > MAX_BYTES) return;
            if (this.responseType === 'json') {
              // Bound even pre-parsed JSON before traversing it.
              const text = JSON.stringify(this.response);
              ingestText(text);
            } else if (!this.responseType || this.responseType === 'text') ingestText(this.responseText);
          } catch (_) { /* Original load handlers must still run. */ }
        }, { once: true });
        return Reflect.apply(original, this, args);
      };
    } catch (_) { /* Keep cobalt working if observation is unavailable. */ }
  }
  const api = { ingest, ingestText, get, resolve, videoUrl, acceptUrl };
  instances.set(global, api);
  install();
  return api;
}
if (typeof module !== 'undefined' && module.exports) Object.assign(module.exports, { createMxgaVideoSource });
