// SPDX-License-Identifier: AGPL-3.0-or-later
// Only ciphertext leaves GM storage. The encryption passphrase is separate from the server write token.
function normalizeCobaltSyncEvent(value) {
  const base64 = (text, length) => typeof text === 'string' && text.length === length && /^[A-Za-z0-9+/]+={0,2}$/.test(text);
  if (!value || value.v !== 1 || !Number.isSafeInteger(value.updatedAt) || value.updatedAt <= 0
    || !/^[A-Za-z0-9_-]{8,80}$/.test(value.source || '')
    || !base64(value.salt, 24) || !base64(value.iv, 16)
    || typeof value.data !== 'string' || value.data.length < 24 || value.data.length > 8192
    || value.data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) return null;
  return { v: 1, updatedAt: value.updatedAt, source: value.source, salt: value.salt, iv: value.iv, data: value.data };
}

function newestCobaltSyncEvent(left, right) {
  const a = normalizeCobaltSyncEvent(left), b = normalizeCobaltSyncEvent(right);
  if (!a) return b;
  if (!b) return a;
  if (b.updatedAt !== a.updatedAt) return b.updatedAt > a.updatedAt ? b : a;
  if (b.source !== a.source) return b.source > a.source ? b : a;
  return JSON.stringify(b) > JSON.stringify(a) ? b : a;
}

function createCobaltConfigSync(gm, webCrypto = globalThis.crypto) {
  const CONFIG_KEY = 'mxga:cobalt:v1';
  const PRIVATE_KEY = 'mxga:cobalt-sync:v1';
  const text = new TextEncoder();
  const encode = (bytes) => btoa(String.fromCharCode(...bytes));
  const decode = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  let preparedHash = null;
  function configValue(value) {
    const endpoint = String(value?.endpoint || '').trim();
    const apiKey = endpoint ? String(value?.apiKey || '').trim() : '';
    if (endpoint.length > 2048 || apiKey.length > 2048) throw new Error('cobalt 配置过长，无法同步。');
    if (endpoint) {
      let url;
      try { url = new URL(endpoint); } catch (_) { throw new Error('cobalt 地址无效，未同步。'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('cobalt 地址必须是无凭据、无查询参数的 HTTPS 地址。');
      return { endpoint: url.href, apiKey };
    }
    return { endpoint: '', apiKey: '' };
  }
  const fingerprint = async (config) => encode(new Uint8Array(await webCrypto.subtle.digest('SHA-256', text.encode(JSON.stringify(config)))));
  const aad = (event) => text.encode(`mxga-cobalt-v1:${event.source}:${event.updatedAt}`);
  async function derive(passphrase, salt) {
    const material = await webCrypto.subtle.importKey('raw', text.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return webCrypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 210000 }, material,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function encrypt(config, passphrase, source, updatedAt) {
    const salt = webCrypto.getRandomValues(new Uint8Array(16));
    const iv = webCrypto.getRandomValues(new Uint8Array(12));
    const event = { v: 1, source, updatedAt, salt: encode(salt), iv: encode(iv) };
    const key = await derive(passphrase, salt);
    const data = await webCrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(event) }, key, text.encode(JSON.stringify(configValue(config))));
    return { ...event, data: encode(new Uint8Array(data)) };
  }
  async function decrypt(value, passphrase) {
    const event = normalizeCobaltSyncEvent(value);
    if (!event) throw new Error('cobalt 同步密文格式无效，本地配置未更改。');
    try {
      const key = await derive(passphrase, decode(event.salt));
      const clear = await webCrypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(event.iv), additionalData: aad(event) }, key, decode(event.data));
      return configValue(JSON.parse(new TextDecoder().decode(clear)));
    } catch (_) { throw new Error('cobalt 配置解密失败，请检查配置加密口令；本地配置未更改。'); }
  }
  async function configure(passphrase) {
    if (passphrase && (passphrase.length < 12 || passphrase.length > 1024)) throw new Error('配置加密口令须为 12–1024 个字符，建议使用密码管理器生成。');
    const state = await gm.getValue(PRIVATE_KEY, {});
    await gm.setValue(PRIVATE_KEY, { ...state, passphrase });
  }
  async function enabled() { return Boolean((await gm.getValue(PRIVATE_KEY, {}))?.passphrase); }
  async function markChanged() {
    const state = await gm.getValue(PRIVATE_KEY, {});
    if (state?.passphrase && state.fingerprint !== await fingerprint(configValue(await gm.getValue(CONFIG_KEY, {})))) {
      await gm.setValue(PRIVATE_KEY, { ...state, dirty: true });
    }
  }
  async function prepare(local, remote, source, syncToken = '') {
    const state = await gm.getValue(PRIVATE_KEY, {});
    if (!state?.passphrase) { preparedHash = null; return local; }
    if (state.passphrase === syncToken) throw new Error('配置加密口令必须与同步密钥不同。');
    const config = configValue(await gm.getValue(CONFIG_KEY, {}));
    preparedHash = await fingerprint(config);
    let event = newestCobaltSyncEvent(newestCobaltSyncEvent(local.cobalt, remote.cobalt), state.pending);
    // Verify the shared passphrase before any overwrite, including on a fresh device.
    if (event) await decrypt(event, state.passphrase);
    const changed = state.dirty || (state.fingerprint && state.fingerprint !== preparedHash)
      || (!event && Boolean(config.endpoint));
    if (changed) {
      event = await encrypt(config, state.passphrase, source, Math.max(Date.now(), (event?.updatedAt || 0) + 1));
      // Keep an encrypted outbox across failed requests and browser restarts.
      await gm.setValue(PRIVATE_KEY, { ...state, dirty: false, fingerprint: preparedHash, pending: event });
    }
    return event ? { ...local, cobalt: event } : local;
  }
  async function apply(event) {
    const state = await gm.getValue(PRIVATE_KEY, {});
    if (!state?.passphrase || !event || preparedHash === null) return true;
    const config = await decrypt(event, state.passphrase);
    const current = configValue(await gm.getValue(CONFIG_KEY, {}));
    // A local edit while the request was in flight must get its own later sync.
    if (await fingerprint(current) !== preparedHash || state.dirty) return false;
    await gm.setValue(CONFIG_KEY, config);
    await gm.setValue(PRIVATE_KEY, { ...state, dirty: false, fingerprint: await fingerprint(config), pending: null });
    return true;
  }
  return { encrypt, decrypt, configure, enabled, markChanged, prepare, apply };
}
