
/* DC Radar 同步引擎（客户端）
 * 协议：fetch manifest -> 比对 release_id -> 逐分片下载 -> SHA-256 校验 -> IndexedDB 单事务写入
 *      -> 原子切换活动版本；任一步失败保留上一版并回报错误。
 * 存储：IndexedDB（shards 存分片，meta 存状态），localStorage 只放轻量状态。
 */
window.DCRSync = (function () {
  const DB = 'dcradar', STORE = 'shards', META = 'meta';
  const DEFAULT_ORIGIN = 'http://127.0.0.1:8767/dcradar';
  let dbp = null;
  const ls = {
    get(k, d) { try { const v = localStorage.getItem('dcradar.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('dcradar.' + k, JSON.stringify(v)); } catch (e) { } }
  };
  function open(attempt) {
    attempt = attempt || 0;
    if (dbp) return Promise.resolve(dbp);
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = e => { const d = e.target.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
        if (!d.objectStoreNames.contains(META)) d.createObjectStore(META); };
      r.onsuccess = e => {
        const d = e.target.result;
        const ok = d.objectStoreNames.contains(STORE) && d.objectStoreNames.contains(META);
        if (ok) { dbp = d; res(dbp); return; }
        // 自愈：同名库被其它代码以更高版本建过但缺 store -> 删除后重建
        d.close(); dbp = null;
        if (attempt > 0) { rej(new Error('IndexedDB 缺少对象仓库且无法重建')); return; }
        const del = indexedDB.deleteDatabase(DB);
        del.onsuccess = () => { del.onsuccess = null; del.onerror = null; res(open(attempt + 1)); };
        del.onerror = () => rej(del.error);
      };
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('IndexedDB 被其他标签页占用'));
    });
  }
  async function idbAll(store) { const db = await open(); return new Promise((res, rej) => {
    const t = db.transaction(store, 'readonly'); const q = t.objectStore(store).getAll();
    q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error); }); }
  async function idbPut(store, entries) { const db = await open(); return new Promise((res, rej) => {
    const t = db.transaction(store, 'readwrite'); const s = t.objectStore(store);
    for (const [k, v] of Object.entries(entries)) s.put(v, k);
    t.oncomplete = () => res(true); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); }
  async function idbGetKeys(store) { const db = await open(); return new Promise((res, rej) => {
    const t = db.transaction(store, 'readonly'); const q = t.objectStore(store).getAllKeys();
    q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error); }); }
  async function idbGet(store, key) { const db = await open(); return new Promise((res, rej) => {
    const t = db.transaction(store, 'readonly'); const q = t.objectStore(store).get(key);
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }

  async function sha256hex(buf) {
    const d = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function bundledMeta() { return (window.DCR_RELEASE && window.DCR_RELEASE.meta) || {}; }
  function bundledRelease() { return bundledMeta().release_id || 'bundled'; }

  async function state() {
    const active = ls.get('activeRelease', null);
    return {
      bundled: bundledRelease(),
      active: active || bundledRelease(),
      source: active ? 'remote' : 'bundled',
      lastSync: ls.get('lastSync', null),
      lastError: ls.get('lastError', null),
      pending: !!ls.get('pendingRelease', null),
      // 优先用"上一次手动设定"，否则用Release里带的公网地址（隧道换域名后自动学习）
      origin: ls.get('origin', null) || bundledMeta().public_origin || DEFAULT_ORIGIN
    };
  }

  // 候选源：用户指定 -> Release内公网地址 -> 本机CORS服务；第一个可用的即生效
  const FALLBACK_ORIGINS: string[] = ['http://127.0.0.1:8767/dcradar'];

  async function fetchManifest(base: string): Promise<Object> {
    const r = await fetch(base.replace(/\/+$/, '') + '/manifest.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('manifest HTTP ' + r.status);
    return await r.json();
  }

  async function check(origin?: string) {
    const candidates: string[] = [];
    const push = (o?: string | null) => { if (o && candidates.indexOf(o) < 0) candidates.push(o.replace(/\/+$/, '')); };
    push(origin);
    push(ls.get('origin', null));
    push(bundledMeta().public_origin);
    FALLBACK_ORIGINS.forEach(push);
    let man: any = null; let base = ''; let err = '';
    for (const c of candidates) {
      try { man = await fetchManifest(c); base = c; break; }
      catch (e) { err = '拉取manifest失败(' + c + '): ' + (e instanceof Error ? e.message : String(e)); }
    }
    if (!man) { ls.set('lastError', err); return { updated: false, error: err }; }
    ls.set('origin', base);
    const cur = ls.get('activeRelease', null) || bundledRelease();
    if (man.release_id === cur) {
      ls.set('lastError', null);
      return { updated: false, upToDate: true, release_id: man.release_id, counts: man.counts };
    }
    return { updated: false, available: true, release_id: man.release_id, manifest: man, base: base };
  }

  async function apply(origin) {
    const chk = await check(origin);
    if (chk.upToDate) return { updated: false, upToDate: true, release_id: chk.release_id };
    if (!chk.available) return { updated: false, error: chk.error };
    const man = chk.manifest, base = chk.base;
    const staged = {};
    try {
      const names = Object.keys(man.files || {});
      for (const fn of names) {
        const r = await fetch(base + '/' + fn, { cache: 'no-store' });
        if (!r.ok) throw new Error(fn + ' HTTP ' + r.status);
        const buf = await r.arrayBuffer();
        const want = man.files[fn].sha256;
        const got = await sha256hex(buf);
        if (want && want !== got) throw new Error(fn + ' 校验失败(hash不一致)，保留旧版本');
        staged[fn] = JSON.parse(new TextDecoder('utf-8').decode(buf));
      }
      // 单事务写入：任何失败都不会污染已生效版本
      await idbPut(STORE, staged);
      await idbPut(META, { release_id: man.release_id, applied_at: new Date().toISOString(), counts: man.counts });
      ls.set('activeRelease', man.release_id);
      if (man.public_origin) ls.set('origin', man.public_origin);   // 学习新的公网地址
      ls.set('lastSync', new Date().toISOString());
      ls.set('lastError', null);
      ls.set('pendingRelease', null);
      return { updated: true, release_id: man.release_id, counts: man.counts };
    } catch (e) {
      const err = '更新失败（已保留上一版本）: ' + e.message;
      ls.set('lastError', err);
      ls.set('pendingRelease', man.release_id);
      return { updated: false, error: err };
    }
  }

  async function hydrate() {
    // 无论是否有已同步版本，都确保对象仓库存在，避免被外部以同名空库创建后无法升级
    try { await open(); } catch (e) { }
    // 用IDB中已生效版本覆盖内置版本（若更新）
    const active = ls.get('activeRelease', null);
    if (!active) return false;
    try {
      const names = ['sites.json','capacities.json','events.json','milestones.json','meta.json','news.json','map_paths.json'];
      const shards = {};
      for (const fn of names) { const v = await idbGet(STORE, fn); if (v !== undefined) shards[fn] = v; }
      if (!shards['meta.json']) return false;
      window.DCR_RELEASE = Object.assign({}, window.DCR_RELEASE, {
        sites: shards['sites.json'] || window.DCR_RELEASE.sites,
        capacities: shards['capacities.json'] || {},
        events: shards['events.json'] || [],
        milestones: shards['milestones.json'] || [],
        meta: shards['meta.json'],
        news: shards['news.json'] || { articles: [], events: [] }
      });
      if (shards['map_paths.json']) window.DCR_PATHS = shards['map_paths.json'];
      window.DCR_RELEASE.activeRelease = active;
      return true;
    } catch (e) { return false; }
  }

  async function reset() {
    await idbPut(STORE, {}); await idbPut(META, {});
    ls.set('activeRelease', null); ls.set('lastSync', null); ls.set('lastError', null); ls.set('pendingRelease', null);
    return true;
  }
  async function inspect() {
    await open();
    const keys = await idbGetKeys(STORE);
    const meta = await idbAll(META);
    return { stores: [...dbp.objectStoreNames], shard_names: keys, meta_count: meta.length };
  }
  return { state, check, apply, hydrate, reset, inspect, DEFAULT_ORIGIN };
})();
