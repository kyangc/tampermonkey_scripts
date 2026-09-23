// SPDX-License-Identifier: AGPL-3.0-or-later
// Desktop panel for MXGA. Bundled with the userscript entry; no external UI dependencies.
function normalizeMxgaPosition(value) {
  return {
    side: value?.side === 'left' ? 'left' : 'right',
    ratio: Number.isFinite(value?.ratio) ? Math.min(1, Math.max(0, value.ratio)) : 0.85,
  };
}

function getMxgaDock(position, viewport, control) {
  const { side, ratio } = normalizeMxgaPosition(position);
  const margin = 12;
  return {
    left: side === 'left' ? margin : Math.max(margin, viewport.width - control.width - margin),
    top: margin + ratio * Math.max(0, viewport.height - control.height - margin * 2),
  };
}

function createMxgaUi(global, callbacks, initialPosition) {
  const document = global.document;
  const host = document.createElement('div');
  host.id = 'mxga-userscript-root';
  host.style.cssText = 'all:initial;font:14px/1.5 system-ui,-apple-system,sans-serif;color:var(--text);color-scheme:light dark';
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host{color-scheme:light dark;--bg:#fff;--soft:#f3f5f7;--text:#17202a;--muted:#657181;--line:#dce2e8;--accent:#1769aa;--danger:#c23242;font:14px/1.5 system-ui,-apple-system,sans-serif;color:var(--text)}
      @media(prefers-color-scheme:dark){:host{--bg:#192027;--soft:#232d36;--text:#e8edf2;--muted:#a0adba;--line:#35414d;--accent:#8cc8f4;--danger:#ff8994}}
      *{box-sizing:border-box} [hidden]{display:none!important}
      button,input,textarea{font:inherit} button{cursor:pointer;color:inherit} button:disabled{opacity:.5;cursor:default}
      button:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
      button{transition:background .15s} button:hover:not(:disabled){background:var(--line)}
      .control{position:fixed;z-index:2147483003;display:flex;gap:8px;align-items:center;height:40px;padding:0 14px;border:1px solid var(--line);border-radius:12px;background:var(--bg);box-shadow:0 4px 16px #14253522;user-select:none;touch-action:none;cursor:grab;font-weight:650}
      .control.dragging{cursor:grabbing}.dot{width:7px;height:7px;border-radius:50%;background:var(--accent)}.dot.paused{background:var(--muted)}
      .backdrop{position:fixed;inset:0;z-index:2147483001;background:transparent}
      .panel{position:fixed;z-index:2147483002;width:min(400px,calc(100vw - 24px));max-height:min(720px,calc(100vh - 24px));display:flex;flex-direction:column;border:1px solid var(--line);border-radius:16px;background:var(--bg);box-shadow:0 16px 48px #14253533;overflow:hidden}
      header{display:flex;align-items:center;gap:12px;padding:18px 20px 12px}h2{font-size:18px;letter-spacing:-.4px;margin:0;flex:1}h3{font-size:14px;margin:0}p{margin:8px 0 16px}
      .enabled{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--muted)}input[type=checkbox]{accent-color:var(--accent)}
      .icon-button{border:0;background:transparent;border-radius:6px;font-size:18px;width:28px;height:28px}
      .tabs{display:flex;padding:0 20px;border-bottom:1px solid var(--line);gap:20px}.tab{border:0;border-bottom:2px solid transparent;background:transparent;padding:10px 0;color:var(--muted)}.tab[aria-selected=true]{color:var(--accent);border-bottom-color:var(--accent);font-weight:650}
      .body{overflow:auto;overscroll-behavior:contain;padding:20px;min-height:0}.help,.privacy,.empty{font-size:12px;color:var(--muted)}
      textarea,input:not([type=checkbox]){width:100%;border:1px solid var(--line);background:var(--soft);color:var(--text);border-radius:8px;padding:10px 12px}
      .keyword-editor{min-height:230px;resize:vertical;line-height:1.65}.actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px}.button{border:1px solid var(--line);background:var(--soft);border-radius:8px;padding:7px 12px;font-size:12px}.primary{background:var(--accent);color:var(--bg);border-color:transparent}.primary:hover:not(:disabled){background:var(--accent);filter:brightness(.93)}
      .save-state{font-size:12px;color:var(--muted);flex:1}.notice{font-size:12px;color:var(--danger);margin-bottom:12px;overflow-wrap:anywhere}
      .section-heading{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}.count{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
      .add-account{display:flex;gap:8px;margin:12px 0}.add-account input{min-width:0}.add-account button{flex:none}
      .hidden-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 0;border-bottom:1px solid var(--line)}.hidden-account strong{font-size:13px}.hidden-account small{display:block;color:var(--muted);font-size:11px}.restore{background:none}.pagination{justify-content:space-between}.pagination span{font-size:12px;color:var(--muted)}
      details{border-bottom:1px solid var(--line);padding:12px 0}summary{cursor:pointer;font-weight:600;font-size:13px}.sync-status{color:var(--muted);font-size:12px;margin:8px 0}.sync-error{color:var(--danger);font-size:12px;overflow-wrap:anywhere}
      .settings-row{padding:16px 0;border-bottom:1px solid var(--line)}.settings-row .help{margin:6px 0 10px}.links{display:flex;gap:12px;margin-top:20px;font-size:11px;color:var(--muted)}.link-button{border:0;background:none;color:var(--accent);padding:0;font-size:11px}
      .avatar-block{position:fixed;z-index:2147483005;display:grid;place-items:center;width:26px;height:26px;padding:0;border:1px solid var(--danger);border-radius:50%;background:var(--bg);color:var(--danger)}.avatar-block svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8}
      .selection-toolbar{position:fixed;z-index:2147483005;transform:translateX(-50%)}.selection-toolbar button{background:var(--bg);color:var(--danger);box-shadow:0 4px 14px #14253522}
      .toast{position:fixed;z-index:2147483005;bottom:24px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:16px;border:1px solid var(--line);padding:10px 16px;border-radius:10px;background:var(--bg);box-shadow:0 6px 24px #14253533;font-size:13px}.toast button{border:0;background:none;color:var(--accent)}
      @media(prefers-reduced-motion:reduce){button{transition:none}}
    </style>
    <button class="control" type="button" data-action="toggle-panel" aria-expanded="false" aria-controls="mxga-panel" title="点击打开 · 拖动可调整位置"><span class="dot"></span>MXGA</button>
    <div class="backdrop" hidden></div>
    <section class="panel" id="mxga-panel" role="dialog" aria-modal="true" aria-label="MXGA 设置" hidden>
      <header><h2>MXGA</h2><label class="enabled"><input type="checkbox" data-role="enabled">启用过滤</label><button class="icon-button" data-action="close-panel" aria-label="关闭">×</button></header>
      <nav class="tabs" role="tablist" aria-label="设置分类">
        <button class="tab" id="mxga-tab-keywords" role="tab" aria-controls="mxga-keywords" aria-selected="true" data-tab="keywords">关键词</button>
        <button class="tab" id="mxga-tab-accounts" role="tab" aria-controls="mxga-accounts" aria-selected="false" tabindex="-1" data-tab="accounts">屏蔽账号</button>
        <button class="tab" id="mxga-tab-settings" role="tab" aria-controls="mxga-settings" aria-selected="false" tabindex="-1" data-tab="settings">设置</button>
      </nav>
      <div class="body">
        <div class="notice" role="status" aria-live="polite" hidden></div>
        <section id="mxga-keywords" role="tabpanel" aria-labelledby="mxga-tab-keywords" data-page="keywords">
          <div class="section-heading"><h3>关键词屏蔽</h3><span class="count" data-role="keyword-count"></span></div>
          <p class="help">每行一个词或短语。仅匹配推文正文，忽略大小写与连续空白；清空并保存即可停用。</p>
          <textarea class="keyword-editor" data-role="blocked-keywords" aria-label="关键词屏蔽列表" placeholder="每行一个关键词或完整短语" spellcheck="false"></textarea>
          <div class="actions"><span class="save-state" role="status" data-role="save-state">已保存</span><button class="button primary" data-action="save-keywords">保存并应用</button></div>
          <p class="help">也可以在推文中划选文字，点击“屏蔽”直接添加。</p>
        </section>
        <section id="mxga-accounts" role="tabpanel" aria-labelledby="mxga-tab-accounts" data-page="accounts" hidden>
          <div class="section-heading"><h3>屏蔽账号</h3><span class="count" data-role="hidden-count"></span></div>
          <p class="help">隐藏这些账号的内容，不操作 X 的拉黑或静音。也可悬停作者头像快速屏蔽。</p>
          <input type="search" data-role="account-search" aria-label="搜索屏蔽账号" placeholder="搜索已屏蔽账号">
          <form class="add-account"><input data-role="account-input" aria-label="添加屏蔽账号" placeholder="@账号" maxlength="16" required><button class="button" type="submit">添加</button></form>
          <div class="hidden-list" data-role="hidden-list"></div>
          <div class="actions pagination"><button class="button" data-action="previous-page">上一页</button><span data-role="page-count"></span><button class="button" data-action="next-page">下一页</button></div>
        </section>
        <section id="mxga-settings" role="tabpanel" aria-labelledby="mxga-tab-settings" data-page="settings" hidden>
          <details><summary>个人规则同步</summary><div class="sync-status" data-role="filter-sync-status"></div>
            <p class="help">屏蔽词和账号列表公开可读；同步密钥只用于防止他人写入。未连接时仅保存在本机。</p>
            <input type="password" data-role="filter-sync-token" aria-label="多端同步密钥" placeholder="粘贴同步密钥" autocomplete="off" spellcheck="false">
            <div class="sync-error" role="status" data-role="filter-sync-error"></div>
            <div class="actions"><button class="button" data-action="save-filter-sync">保存并同步</button><button class="button" data-action="sync-filters" hidden>立即同步</button><button class="button" data-action="disconnect-filter-sync" hidden>断开</button></div>
            <hr><h3>cobalt 配置加密同步</h3>
            <p class="help">地址和 API Key 使用独立口令加密。所有设备填写相同口令（至少 12 字符）；口令只留在本机，不能找回。首次启用优先读取已有云端配置。</p>
            <input type="password" data-role="cobalt-passphrase" aria-label="配置加密口令" placeholder="独立于同步密钥的加密口令" autocomplete="off">
            <div class="sync-status" data-role="cobalt-sync-status"></div>
            <div class="actions"><button class="button" data-action="enable-cobalt-sync">启用配置同步</button><button class="button" data-action="disable-cobalt-sync" hidden>暂停配置同步</button></div>
          </details>
          <div class="settings-row"><h3>视频下载</h3><p class="help">默认打开 cobalt 网页，也可连接自建 API 自动解析。</p><button class="button" data-action="configure-cobalt">视频下载设置</button></div>
          <div class="settings-row"><h3>浮窗位置</h3><p class="help">拖动 MXGA 按钮，松手后吸附到左右边缘。</p><button class="button" data-action="reset-position">重置位置</button></div>
          <p class="privacy">启用过滤只影响页面隐藏；分享图和下载始终可用。同步不包含浏览页面或命中结果；cobalt 凭据仅在启用配置同步后以密文上传。</p>
          <div class="links"><span>MXGA 0.7.1</span><button class="link-button" data-action="open-source">源码 ↗</button><button class="link-button" data-action="open-upstream">原始项目 ↗</button></div>
        </section>
      </div>
    </section>
    <button class="avatar-block" type="button" data-role="avatar-block" data-action="block-avatar" aria-label="屏蔽用户" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle><path d="M6.5 6.5l11 11"></path></svg></button>
    <section class="selection-toolbar" role="toolbar" aria-label="选中文本操作" hidden><button class="button" data-action="block-selection">屏蔽</button></section>
    <div class="toast" hidden role="status" aria-live="polite"><span></span><button data-action="undo">撤销</button></div>`;
  const role = (name) => root.querySelector(`[data-role="${name}"]`);
  const action = (name) => root.querySelector(`[data-action="${name}"]`);
  const elements = {
    control: root.querySelector('.control'), panel: root.querySelector('.panel'),
    backdrop: root.querySelector('.backdrop'), notice: root.querySelector('.notice'),
    enabled: role('enabled'), blockedKeywords: role('blocked-keywords'),
    filterSyncToken: role('filter-sync-token'), avatarBlock: role('avatar-block'),
    selectionToolbar: root.querySelector('.selection-toolbar'), toast: root.querySelector('.toast'),
  };
  let view = null;
  let position = normalizeMxgaPosition(initialPosition);
  let keywordDirty = false;
  let tokenDirty = false;
  let saving = false;
  let page = 0;
  let selectedTab = 'keywords';
  let drag = null;
  let suppressClick = false;
  let avatarTimer = 0;
  let currentAvatar = null;
  let currentSelectionKeyword = '';
  let toastTimer = 0;
  let undoHandle = '';
  const avatarContexts = new WeakMap();
  const dateLabel = (value) => value ? new Date(value).toLocaleString() : '尚未同步';
  function reportError(message) {
    elements.notice.textContent = message;
    elements.notice.hidden = !message;
  }
  function placePanel() {
    if (elements.panel.hidden) return;
    const rect = elements.control.getBoundingClientRect();
    const panel = elements.panel.getBoundingClientRect();
    const x = position.side === 'left' ? rect.right + 8 : rect.left - panel.width - 8;
    elements.panel.style.left = Math.max(12, Math.min(x, global.innerWidth - panel.width - 12)) + 'px';
    elements.panel.style.top = Math.max(12, Math.min(rect.top, global.innerHeight - panel.height - 12)) + 'px';
  }
  function placeControl() {
    const point = getMxgaDock(position, { width: global.innerWidth, height: global.innerHeight }, elements.control.getBoundingClientRect());
    elements.control.style.left = point.left + 'px';
    elements.control.style.top = point.top + 'px';
    placePanel();
  }
  async function savePosition() {
    try { await callbacks.onPositionChange(position); }
    catch (error) { reportError('浮窗位置保存失败：' + (error?.message || '请重试')); }
  }
  function setPanel(open) {
    elements.panel.hidden = !open;
    elements.backdrop.hidden = !open;
    elements.control.setAttribute('aria-expanded', String(open));
    if (open) {
      hideAvatarBlock(); hideSelectionToolbar(); placePanel();
      root.querySelector(`[data-tab="${selectedTab}"]`).focus();
    } else elements.control.focus({ preventScroll: true });
  }
  function selectTab(tab, focus = false) {
    selectedTab = tab;
    for (const button of root.querySelectorAll('[data-tab]')) {
      const selected = button.dataset.tab === tab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected && focus) button.focus();
    }
    for (const section of root.querySelectorAll('[data-page]')) section.hidden = section.dataset.page !== tab;
    placePanel();
  }
  root.querySelector('.tabs').addEventListener('keydown', (event) => {
    const tabs = ['keywords', 'accounts', 'settings'];
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (tabs.indexOf(selectedTab) + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
    selectTab(tabs[index], true);
  });
  document.addEventListener('keydown', (event) => {
    if (elements.panel.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setPanel(false); }
    if (event.key === 'Tab') {
      const focusable = [...elements.panel.querySelectorAll('button,input,textarea,summary')]
        .filter((el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (!elements.panel.contains(root.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && root.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && root.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }, true);
  elements.control.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    suppressClick = false;
    const rect = elements.control.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
    elements.control.setPointerCapture(event.pointerId);
  });
  elements.control.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    elements.control.classList.add('dragging');
    const rect = elements.control.getBoundingClientRect();
    elements.control.style.left = Math.max(12, Math.min(drag.left + dx, global.innerWidth - rect.width - 12)) + 'px';
    elements.control.style.top = Math.max(12, Math.min(drag.top + dy, global.innerHeight - rect.height - 12)) + 'px';
    placePanel();
  });
  function finishDrag(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const moved = drag.moved;
    drag = null;
    elements.control.classList.remove('dragging');
    if (moved) {
      suppressClick = true;
      const rect = elements.control.getBoundingClientRect();
      position = normalizeMxgaPosition({
        side: rect.left + rect.width / 2 < global.innerWidth / 2 ? 'left' : 'right',
        ratio: (rect.top - 12) / Math.max(1, global.innerHeight - rect.height - 24),
      });
      placeControl(); void savePosition();
    }
    if (elements.control.hasPointerCapture(event.pointerId)) elements.control.releasePointerCapture(event.pointerId);
  }
  elements.control.addEventListener('pointerup', finishDrag);
  elements.control.addEventListener('pointercancel', finishDrag);
  elements.control.addEventListener('lostpointercapture', finishDrag);
  global.addEventListener('resize', placeControl, { passive: true });
  new global.ResizeObserver(placePanel).observe(elements.panel);

  function renderAccounts() {
    const records = view?.hiddenRecords || [];
    const query = role('account-search').value.trim().replace(/^@/, '').toLowerCase();
    const filtered = records.filter((record) => record.handle.toLowerCase().includes(query));
    const pages = Math.max(1, Math.ceil(filtered.length / 20));
    page = Math.max(0, Math.min(page, pages - 1));
    role('hidden-count').textContent = records.length + ' 个';
    const list = role('hidden-list'); list.replaceChildren();
    if (!filtered.length) {
      const empty = document.createElement('p'); empty.className = 'empty';
      empty.textContent = query ? '没有匹配的账号。' : '还没有屏蔽账号。'; list.appendChild(empty);
    }
    for (const record of filtered.slice(page * 20, page * 20 + 20)) {
      const row = document.createElement('div'); row.className = 'hidden-row';
      const account = document.createElement('div'); account.className = 'hidden-account';
      const name = document.createElement('strong'); name.textContent = '@' + record.handle;
      const time = document.createElement('small'); time.textContent = dateLabel(record.hiddenAt);
      account.append(name, time);
      const restore = document.createElement('button'); restore.className = 'button restore';
      restore.dataset.action = 'restore'; restore.dataset.handle = record.handle; restore.textContent = '恢复';
      restore.setAttribute('aria-label', '恢复 @' + record.handle);
      row.append(account, restore); list.appendChild(row);
    }
    role('page-count').textContent = `${page + 1} / ${pages}`;
    action('previous-page').disabled = page === 0; action('next-page').disabled = page >= pages - 1;
    placePanel();
  }
  role('account-search').addEventListener('input', () => { page = 0; renderAccounts(); });
  root.querySelector('.add-account').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = role('account-input'); const handle = input.value.trim().replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) { input.setCustomValidity('请输入有效的 X 账号名'); input.reportValidity(); return; }
    await callbacks.onHide(handle); input.value = '';
  });
  role('account-input').addEventListener('input', (event) => event.target.setCustomValidity(''));
  elements.blockedKeywords.addEventListener('input', () => {
    keywordDirty = true; role('save-state').textContent = '未保存';
  });
  elements.filterSyncToken.addEventListener('input', () => { tokenDirty = true; });
  function render(next) {
    view = next;
    elements.enabled.checked = view.settings.enabled;
    root.querySelector('.dot').classList.toggle('paused', !view.settings.enabled);
    elements.control.setAttribute('aria-label', 'MXGA · ' + (view.settings.enabled ? '过滤已开启' : '过滤已暂停'));
    role('keyword-count').textContent = view.settings.blockedKeywords.length + ' 条';
    if (!keywordDirty) elements.blockedKeywords.value = view.settings.blockedKeywords.join('\n');
    role('cobalt-sync-status').textContent = view.cobaltSyncEnabled ? '已启用 · 需要同时连接个人规则同步' : '未启用 · cobalt 配置仅本机';
    action('disable-cobalt-sync').hidden = !view.cobaltSyncEnabled;
    const sync = view.filterSync;
    if (!tokenDirty) elements.filterSyncToken.value = sync.token || '';
    role('filter-sync-status').textContent = sync.syncing ? '同步中…' : sync.token ? '已连接 · ' + dateLabel(sync.lastSyncAt) : '未连接 · 仅本机';
    role('filter-sync-error').textContent = sync.error || '';
    action('save-filter-sync').disabled = sync.syncing;
    action('sync-filters').disabled = sync.syncing;
    action('disconnect-filter-sync').disabled = sync.syncing;
    action('sync-filters').hidden = !sync.token; action('disconnect-filter-sync').hidden = !sync.token;
    if (!view.settings.enabled) { hideAvatarBlock(); hideSelectionToolbar(); }
    reportError(view.error || ''); renderAccounts();
  }
  function hideAvatarBlock() {
    global.clearTimeout(avatarTimer); elements.avatarBlock.hidden = true; currentAvatar = null;
  }
  function mountAvatarTrigger(anchor, handle) {
    avatarContexts.set(anchor, { handle });
    if (anchor.hasAttribute('data-mxga-avatar-trigger')) return;
    anchor.setAttribute('data-mxga-avatar-trigger', '1');
    anchor.addEventListener('mouseenter', () => {
      if (!view?.settings.enabled) return;
      global.clearTimeout(avatarTimer); currentAvatar = avatarContexts.get(anchor);
      const rect = anchor.getBoundingClientRect();
      elements.avatarBlock.title = '屏蔽 @' + currentAvatar.handle;
      elements.avatarBlock.style.left = Math.max(4, Math.min(rect.right - 17, global.innerWidth - 30)) + 'px';
      elements.avatarBlock.style.top = Math.max(4, Math.min(rect.top - 7, global.innerHeight - 30)) + 'px';
      elements.avatarBlock.hidden = false;
    });
    anchor.addEventListener('mouseleave', () => { avatarTimer = global.setTimeout(hideAvatarBlock, 140); });
  }
  elements.avatarBlock.addEventListener('mouseenter', () => global.clearTimeout(avatarTimer));
  elements.avatarBlock.addEventListener('mouseleave', hideAvatarBlock);
  global.addEventListener('scroll', hideAvatarBlock, { capture: true, passive: true });
  function hideSelectionToolbar() { elements.selectionToolbar.hidden = true; currentSelectionKeyword = ''; }
  function showSelectionToolbar(candidate) {
    if (!candidate?.keyword || !candidate.rect) { hideSelectionToolbar(); return; }
    currentSelectionKeyword = candidate.keyword;
    const rect = candidate.rect;
    elements.selectionToolbar.hidden = false;
    action('block-selection').title = '屏蔽“' + candidate.keyword + '”';
    elements.selectionToolbar.style.left = Math.max(48, Math.min(rect.left + rect.width / 2, global.innerWidth - 48)) + 'px';
    elements.selectionToolbar.style.top = Math.max(8, Math.min(rect.top < 48 ? rect.bottom + 8 : rect.top - 40, global.innerHeight - 40)) + 'px';
  }
  elements.selectionToolbar.addEventListener('pointerdown', (event) => event.preventDefault());
  function showUndo(handle) {
    global.clearTimeout(toastTimer); undoHandle = handle;
    elements.toast.querySelector('span').textContent = '已屏蔽 @' + handle;
    elements.toast.hidden = false;
    toastTimer = global.setTimeout(() => { elements.toast.hidden = true; undoHandle = ''; }, 5000);
  }
  root.addEventListener('click', async (event) => {
    if (event.target === elements.backdrop) { event.preventDefault(); event.stopPropagation(); setPanel(false); return; }
    const tab = event.target.closest('[data-tab]');
    if (tab) { selectTab(tab.dataset.tab); return; }
    const target = event.target.closest('[data-action]');
    const name = target?.dataset.action;
    if (name === 'toggle-panel') {
      if (suppressClick && event.detail !== 0) { suppressClick = false; return; }
      suppressClick = false; setPanel(elements.panel.hidden);
    } else if (name === 'close-panel') setPanel(false);
    else if (name === 'save-keywords' && !saving) {
      const draft = elements.blockedKeywords.value; saving = true; target.disabled = true;
      try {
        const saved = await callbacks.onBlockedKeywordsChange(elements.blockedKeywords.value);
        if (saved && elements.blockedKeywords.value === draft) {
          keywordDirty = false; render(view); role('save-state').textContent = '已保存';
        }
      } finally { saving = false; target.disabled = false; }
    } else if (name === 'save-filter-sync') { tokenDirty = false; callbacks.onFilterSyncTokenChange(elements.filterSyncToken.value); }
    else if (name === 'enable-cobalt-sync') { const phrase = role('cobalt-passphrase').value; if (!phrase) { reportError('请填写至少 12 字符的配置加密口令。'); return; } await callbacks.onConfigureCobaltSync(phrase); role('cobalt-passphrase').value = ''; }
    else if (name === 'disable-cobalt-sync') { await callbacks.onConfigureCobaltSync(''); action('enable-cobalt-sync').focus(); }
    else if (name === 'sync-filters') callbacks.onFilterSync();
    else if (name === 'disconnect-filter-sync') { tokenDirty = false; elements.filterSyncToken.value = ''; callbacks.onFilterSyncTokenChange(''); }
    else if (name === 'configure-cobalt') { setPanel(false); callbacks.onConfigureCobalt(); }
    else if (name === 'reset-position') { position = normalizeMxgaPosition(null); placeControl(); await savePosition(); }
    else if (name === 'previous-page') { page--; renderAccounts(); }
    else if (name === 'next-page') { page++; renderAccounts(); }
    else if (name === 'restore') { callbacks.onRestore(target.dataset.handle); role('account-search').focus(); }
    else if (name === 'block-avatar' && currentAvatar) { const selected = currentAvatar; hideAvatarBlock(); callbacks.onHide(selected.handle); }
    else if (name === 'block-selection' && currentSelectionKeyword) {
      const keyword = currentSelectionKeyword; hideSelectionToolbar(); global.getSelection()?.removeAllRanges(); callbacks.onBlockKeyword(keyword);
    } else if (name === 'undo' && undoHandle) {
      const handle = undoHandle; undoHandle = ''; global.clearTimeout(toastTimer); elements.toast.hidden = true; callbacks.onRestore(handle);
    } else if (name === 'open-source') callbacks.onOpenUrl('https://github.com/kyangc/tampermonkey_scripts');
    else if (name === 'open-upstream') callbacks.onOpenUrl('https://github.com/foru17/make-x-great-again');
  });
  elements.enabled.addEventListener('change', () => callbacks.onEnabledChange(elements.enabled.checked));
  placeControl();
  return { host, render, mountAvatarTrigger, hideAvatarBlock, showSelectionToolbar, hideSelectionToolbar, showUndo };
}
