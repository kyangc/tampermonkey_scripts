// SPDX-License-Identifier: AGPL-3.0-or-later
// Bundled helper; encrypted configuration sync is managed by the MXGA entry.
function createMxgaCobalt(global) {
  'use strict';
  const STORAGE_KEY = 'mxga:cobalt:v1';

  function normalizeCobaltUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return '';
      return url.href;
    } catch (_) { return ''; }
  }

  function cobaltRequestBody(url) {
    const parsed = new URL(url);
    if (!['x.com', 'twitter.com'].includes(parsed.hostname) || parsed.protocol !== 'https:'
      || parsed.username || parsed.password || !/^\/[A-Za-z0-9_]{1,15}\/status\/\d+\/?$/.test(parsed.pathname)) {
      throw new Error('无法确认视频所属帖子');
    }
    return { url: `https://x.com${parsed.pathname.replace(/\/$/, '')}`, downloadMode: 'auto',
      videoQuality: 'max', localProcessing: 'disabled', convertGif: false, alwaysProxy: true };
  }

  function cobaltError(status, code) {
    if (status === 429) return '请求过于频繁，请稍后重试';
    if (status === 401 || status === 403 || /auth|turnstile/.test(code || '')) return '服务拒绝访问，请检查 API Key 或服务端验证设置';
    if (/private|age|unavailable|empty/.test(code || '')) return '服务无法获取该帖子的视频，内容可能受限或已不可用';
    return `视频解析失败${code && /^[a-zA-Z0-9._-]{1,100}$/.test(code) ? `（${code}）` : status ? `（HTTP ${status}）` : ''}`;
  }

  function parseCobaltResponse(data, status = 200) {
    if (status < 200 || status >= 300 || data?.status === 'error') throw new Error(cobaltError(status, data?.error?.code));
    if (data?.status === 'local-processing') throw new Error('该视频需要本地转码，当前下载器暂不支持');
    const rows = ['tunnel', 'redirect'].includes(data?.status)
      ? [{ url: data.url, filename: data.filename }]
      : data?.status === 'picker' && Array.isArray(data.picker)
        ? data.picker.filter((item) => ['video', 'gif'].includes(item?.type)) : [];
    if (!rows.length) throw new Error('服务没有返回可下载的视频');
    return rows.map((item, index) => {
      let url;
      try { url = new URL(item.url); } catch (_) { throw new Error('服务返回了无效下载地址'); }
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('服务返回了不安全的下载地址');
      return { url: url.href, label: `下载视频${rows.length > 1 ? ` ${index + 1}` : ''}`,
        filename: typeof item.filename === 'string' ? item.filename.slice(0, 240) : '' };
    });
  }

  function requestCobalt(gm, endpoint, apiKey, tweetUrl, signal) {
    const target = normalizeCobaltUrl(endpoint);
    if (!target) return Promise.reject(new Error('请输入有效的 HTTPS API 地址，不含查询参数或密钥'));
    const body = cobaltRequestBody(tweetUrl);
    if (!gm?.xmlHttpRequest) return Promise.reject(new Error('当前脚本管理器不支持跨域请求'));
    return new Promise((resolve, reject) => {
      let request;
      let done = false;
      const finish = (error, value) => {
        if (done) return;
        done = true;
        signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(value);
      };
      const abort = () => {
        finish(new Error('已取消解析'));
        request?.abort?.();
      };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      try {
        request = gm.xmlHttpRequest({
          method: 'POST', url: target, anonymous: true, redirect: 'error', timeout: 45000,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Api-Key ${apiKey}` } : {}) },
          data: JSON.stringify(body),
          onload: (response) => {
            try {
              if (response.finalUrl && new URL(response.finalUrl).origin !== new URL(target).origin) {
                throw new Error('API 地址发生跨站重定向，请检查配置');
              }
              let data;
              try { data = JSON.parse(response.responseText); }
              catch (_) { throw new Error(cobaltError(response.status)); }
              finish(null, parseCobaltResponse(data, response.status));
            } catch (error) { finish(error); }
          },
          onerror: () => finish(new Error('无法连接 cobalt，请检查地址、网络及脚本管理器的域名访问权限')),
          ontimeout: () => finish(new Error('解析超时，请稍后重试')),
          onabort: () => finish(new Error('已取消解析')),
        });
        // Some managers return a promise in addition to invoking callbacks.
        request?.catch?.(() => finish(new Error('cobalt 请求失败，请检查域名访问权限')));
      } catch (_) { finish(new Error('无法发起 cobalt 请求，请检查脚本管理器权限')); }
    });
  }

  function cobaltDownloadRoute(config, tweetUrl) {
    const source = cobaltRequestBody(tweetUrl).url;
    const rawEndpoint = typeof config?.endpoint === 'string' ? config.endpoint.trim() : '';
    if (!rawEndpoint) return { mode: 'web', url: `https://cobalt.tools/#${encodeURIComponent(source)}` };
    const endpoint = normalizeCobaltUrl(rawEndpoint);
    return endpoint ? { mode: 'api', url: endpoint } : { mode: 'settings', url: '' };
  }

  async function openCobaltWebsite(tweetUrl) {
    const url = cobaltDownloadRoute({}, tweetUrl).url;
    const gm = typeof GM !== 'undefined' ? GM : global.GM;
    try {
      if (typeof gm?.openInTab === 'function') {
        await gm.openInTab(url, { active: true, insert: true });
        return;
      }
    } catch (_) { /* Keep a user-clickable link if the manager rejects opening. */ }
    openCobaltDownload(tweetUrl, { webFallback: url });
  }

  let routing = false;
  async function startCobaltDownload(tweetUrl) {
    if (routing) return;
    routing = true;
    try {
      const gm = typeof GM !== 'undefined' ? GM : global.GM;
      // A failed read is not evidence that the user selected public processing.
      const config = gm?.getValue ? await gm.getValue(STORAGE_KEY, {}) : {};
      const route = cobaltDownloadRoute(config, tweetUrl);
      if (route.mode === 'web') await openCobaltWebsite(tweetUrl);
      else openCobaltDownload(tweetUrl, { autoParse: route.mode === 'api' });
    } catch (_) {
      openCobaltDownload(tweetUrl);
    } finally { routing = false; }
  }

  let closeCurrent = null;
  function openCobaltDownload(tweetUrl, options = {}) {
    closeCurrent?.();
    const document = global.document;
    const gm = typeof GM !== 'undefined' ? GM : global.GM;
    document.querySelector('[data-mxga-cobalt]')?.dispatchEvent(new global.Event('mxga-cobalt-close'));
    const settingsOnly = !tweetUrl;
    const previousFocus = document.activeElement;
    const host = document.createElement('div');
    host.setAttribute('data-mxga-cobalt', '');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host{all:initial;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#18212b}
      *{box-sizing:border-box}.backdrop{position:fixed;inset:0;z-index:2147483647;background:#0008;display:flex;align-items:center;justify-content:center;padding:16px}
      .panel{background:#fff;border:1px solid #cdd5dd;border-radius:16px;padding:22px;width:440px;min-width:0;max-width:100%;max-height:90dvh;overflow:auto}
      header{display:flex;align-items:center;justify-content:space-between;gap:12px}h2{font-size:19px;margin:0}
      button,a{font:inherit;cursor:pointer;border-radius:9px;padding:9px 14px}button{border:1px solid #cdd5dd;background:#f3f6f8;color:inherit}
      button:disabled{opacity:.55;cursor:wait}label{display:block;margin-top:14px}input{font:inherit;width:100%;padding:10px;margin-top:5px;border:1px solid #a9b5c1;border-radius:8px;background:#fff;color:inherit}
      :focus-visible{outline:2px solid #1675d1;outline-offset:3px}p{margin:12px 0;color:#536471;font-size:13px;overflow-wrap:anywhere}
      .submit,a{background:#1675d1;color:white;border:0}.submit{margin-top:16px}a{display:block;text-decoration:none;margin-top:10px;text-align:center}.results:empty{display:none}
      .status{white-space:pre-wrap}small{display:block;overflow-wrap:anywhere;color:#536471}
      @media(prefers-color-scheme:dark){:host{color:#e7e9ea}.panel{background:#15202b;border-color:#536471}input,button{background:#22303c;color:#e7e9ea}p,small{color:#a7b5c1}.submit{background:#1675d1}}
    </style><div class="backdrop"><section class="panel" role="dialog" aria-modal="true" aria-labelledby="cobalt-title">
      <header><h2 id="cobalt-title">${settingsOnly ? '视频下载设置' : '下载视频'}</h2><button type="button" class="close" aria-label="关闭">✕</button></header>
      <p>默认打开 cobalt 网页并带入帖子链接。填写自建 API 后，改由该服务解析视频。</p>
      <form><label>cobalt API 地址<input name="endpoint" type="url" placeholder="留空使用 cobalt 网页" autocomplete="off"></label>
      <label>API Key（可选）<input name="key" type="password" autocomplete="off"></label>
      <p>地址和 API Key 默认仅在本机保存；在 MXGA 设置中启用配置加密同步后可跨设备同步。清空地址并保存可恢复默认。</p>
      <button class="submit" type="submit" disabled>${settingsOnly ? '保存设置' : '保存并解析'}</button></form>
      <p class="status" role="status" aria-live="polite">正在读取配置…</p><div class="results"></div>
    </section></div>`;
    document.body.append(host);
    const form = shadow.querySelector('form');
    const endpoint = form.elements.endpoint;
    const key = form.elements.key;
    const button = shadow.querySelector('.submit');
    const status = shadow.querySelector('.status');
    const results = shadow.querySelector('.results');
    let closed = false;
    let controller;
    const close = () => {
      if (closed) return;
      closed = true;
      controller?.abort();
      host.remove();
      if (closeCurrent === close) closeCurrent = null;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
    closeCurrent = close;
    host.addEventListener('mxga-cobalt-close', close, { once: true });
    shadow.querySelector('.close').onclick = close;
    shadow.querySelector('.backdrop').onclick = (event) => { if (event.target.className === 'backdrop') close(); };
    shadow.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); close(); }
      if (event.key === 'Tab') {
        const controls = [...shadow.querySelectorAll('button:not(:disabled), input, a[href]')];
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && shadow.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && shadow.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    shadow.querySelector('.close').focus();
    let busy = false;
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (busy || closed) return;
      const url = normalizeCobaltUrl(endpoint.value);
      if (endpoint.value.trim() && !url) { status.textContent = '请输入有效的 HTTPS API 地址，不含查询参数或密钥'; endpoint.focus(); return; }
      if (!gm?.setValue) { status.textContent = '当前脚本管理器不支持配置存储'; return; }
      busy = true;
      button.disabled = true;
      endpoint.disabled = key.disabled = true;
      results.replaceChildren();
      controller = new global.AbortController();
      status.textContent = settingsOnly ? '正在保存…' : '正在解析视频…';
      try {
        const apiKey = url ? key.value.trim() : '';
        await gm.setValue(STORAGE_KEY, { endpoint: url, apiKey });
        document.dispatchEvent(new global.Event('mxga-cobalt-config-saved'));
        if (closed) return;
        if (settingsOnly) {
          key.value = apiKey;
          status.textContent = url ? '已保存，下载视频时将使用自建服务。' : '已恢复默认，下载视频时将打开 cobalt 网页。';
          return;
        }
        if (!url) { close(); await openCobaltWebsite(tweetUrl); return; }
        const items = await requestCobalt(gm, url, apiKey, tweetUrl, controller.signal);
        if (closed) return;
        for (const item of items) {
          const link = document.createElement('a');
          link.href = item.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.referrerPolicy = 'no-referrer';
          link.textContent = item.label;
          results.append(link);
        }
        status.textContent = '解析完成。点击下载，交由浏览器保存；链接失效时请重新解析。';
      } catch (error) {
        if (!closed) status.textContent = error.message || '解析失败，请重试';
      } finally {
        busy = false;
        if (!closed) { button.disabled = false; endpoint.disabled = key.disabled = false; button.textContent = settingsOnly ? '保存设置' : '重新解析'; }
      }
    };
    (async () => {
      try {
        if (!gm?.getValue) throw new Error('当前脚本管理器不支持配置存储');
        const config = await gm.getValue(STORAGE_KEY, {});
        if (closed) return;
        endpoint.value = typeof config?.endpoint === 'string' ? config.endpoint.trim() : '';
        key.value = typeof config?.apiKey === 'string' ? config.apiKey : '';
        status.textContent = !endpoint.value ? '当前使用 cobalt 网页，无需配置。'
          : normalizeCobaltUrl(endpoint.value) ? '已配置自建服务。' : '已保存的 API 地址无效，请修正或清空后保存。';
        button.disabled = false;
        endpoint.focus();
        if (options.autoParse && endpoint.value) form.requestSubmit();
      } catch (_) { if (!closed) status.textContent = '无法读取本地配置，请检查脚本管理器存储权限'; }
    })();
    if (options.webFallback) {
      const link = document.createElement('a');
      link.href = options.webFallback;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = '打开 cobalt 网页';
      results.append(link);
    }
  }
  return { normalizeCobaltUrl, cobaltRequestBody, parseCobaltResponse, requestCobalt, cobaltDownloadRoute, startCobaltDownload, openCobaltDownload };
}
if (typeof module !== 'undefined' && module.exports) Object.assign(module.exports, createMxgaCobalt(globalThis));
