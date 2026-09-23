// SPDX-License-Identifier: AGPL-3.0-or-later
// Cobalt settings share the authenticated preferences snapshot and sync token.
function cobaltSyncConfig(value) {
  if (!value || typeof value.endpoint !== 'string' || typeof value.apiKey !== 'string') {
    throw new Error('cobalt 配置格式无效。');
  }
  const endpoint = value.endpoint.trim();
  const apiKey = endpoint ? value.apiKey.trim() : '';
  if (endpoint.length > 2048 || apiKey.length > 2048) throw new Error('cobalt 配置过长，无法同步。');
  if (!endpoint) return { endpoint: '', apiKey: '' };
  let url;
  try { url = new URL(endpoint); } catch (_) { throw new Error('cobalt 地址无效，未同步。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('cobalt 地址必须是无凭据、无查询参数的 HTTPS 地址。');
  }
  return { endpoint: url.href, apiKey };
}

function normalizeCobaltSyncEvent(value) {
  if (!value || value.v !== 2 || !Number.isSafeInteger(value.updatedAt) || value.updatedAt <= 0
    || !/^[A-Za-z0-9_-]{8,80}$/.test(value.source || '')) return null;
  try {
    return { v: 2, updatedAt: value.updatedAt, source: value.source, config: cobaltSyncConfig(value.config) };
  } catch (_) { return null; }
}

function newestCobaltSyncEvent(left, right) {
  const a = normalizeCobaltSyncEvent(left), b = normalizeCobaltSyncEvent(right);
  if (!a) return b;
  if (!b) return a;
  if (b.updatedAt !== a.updatedAt) return b.updatedAt > a.updatedAt ? b : a;
  if (b.source !== a.source) return b.source > a.source ? b : a;
  return JSON.stringify(b) > JSON.stringify(a) ? b : a;
}

function createCobaltConfigSync(gm) {
  const CONFIG_KEY = 'mxga:cobalt:v1';
  const STATE_KEY = 'mxga:cobalt-sync:v2';
  let preparedHash = null;
  const readConfig = async () => cobaltSyncConfig(await gm.getValue(CONFIG_KEY, { endpoint: '', apiKey: '' }));
  const fingerprint = (config) => JSON.stringify(config);
  async function markChanged() {
    const state = await gm.getValue(STATE_KEY, {});
    if (state.fingerprint !== fingerprint(await readConfig())) {
      await gm.setValue(STATE_KEY, { ...state, dirty: true });
    }
  }
  async function prepare(local, remote, source) {
    const state = await gm.getValue(STATE_KEY, {});
    const config = await readConfig();
    preparedHash = fingerprint(config);
    let event = newestCobaltSyncEvent(newestCobaltSyncEvent(local.cobalt, remote.cobalt), state.pending);
    const changed = state.dirty || (state.fingerprint && state.fingerprint !== preparedHash)
      || (!event && Boolean(config.endpoint));
    if (changed) {
      event = { v: 2, source, updatedAt: Math.max(Date.now(), (event?.updatedAt || 0) + 1), config };
      // Persist pending edits before the request so retry/restart cannot lose them.
      await gm.setValue(STATE_KEY, { dirty: false, fingerprint: preparedHash, pending: event });
    }
    return event ? { ...local, cobalt: event } : local;
  }
  async function apply(value) {
    if (!value || preparedHash === null) return true;
    const event = normalizeCobaltSyncEvent(value);
    if (!event) throw new Error('cobalt 同步配置格式无效，本地配置未更改。');
    const state = await gm.getValue(STATE_KEY, {});
    // A local edit while the request was in flight needs its own later sync.
    if (fingerprint(await readConfig()) !== preparedHash || state.dirty) return false;
    await gm.setValue(CONFIG_KEY, event.config);
    await gm.setValue(STATE_KEY, { dirty: false, fingerprint: fingerprint(event.config), pending: null });
    return true;
  }
  return { markChanged, prepare, apply };
}
