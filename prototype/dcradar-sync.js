/* DC Radar 同步引擎（纯 JavaScript，浏览器可直接加载）
 * 协议：fetch manifest -> 比对 release_id -> 逐分片下载 -> SHA-256 校验 -> IndexedDB 单事务写入
 *      -> 原子切换活动版本；任一步失败保留上一版并回报错误。
 * 候选源顺序：用户指定 -> Release 内公网地址 -> 本机 CORS 服务。
 */
window.DCRSync = (function () {
  const DB = 'dcradar', STORE = 'shards', META = 'meta';
  const DEFAULT_ORIGIN = 'https://fengzhenqi-jason.github.io/dcradar/dcradar';
  const FALLBACK_ORIGINS = ['http://127.0.0.1:8767/dcradar'];
  let dbp = null;
  const ls = {
    get: function (k, d) { try { const v = localStorage.getItem('dcradar.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('dcradar.' + k, JSON.stringify(v)); } catch (e) { } }
  };
  function open(attempt) {
    attempt = attempt || 0;
    if (dbp) return Promise.resolve(dbp);
    return new Promise(function (res, rej) {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = function (e) {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
        if (!d.objectStoreNames.contains(META)) d.createObjectStore(META);
      };
      r.onsuccess = function (e) {
        const d = e.target.result;
        const ok = d.objectStoreNames.contains(STORE) && d.objectStoreNames.contains(META);
        if (ok) { dbp = d; res(dbp); return; }
        d.close(); dbp = null;
        if (attempt > 0) { rej(new Error('IndexedDB 缺少对象仓库且无法重建')); return; }
        const del = indexedDB.deleteDatabase(DB);
        del.onsuccess = function () { res(open(attempt + 1)); };
        del.onerror = function () { rej(del.error); };
      };
      r.onerror = function () { rej(r.error); };
      r.onblocked = function () { rej(new Error('IndexedDB 被其他标签页占用')); };
    });
  }
  function idbPut(store, entries) {
    return open().then(function (db) { return new Promise(function (res, rej) {
      const t = db.transaction(store, 'readwrite'); const s = t.objectStore(store);
      Object.keys(entries).forEach(function (k) { s.put(entries[k], k); });
      t.oncomplete = function () { res(true); }; t.onerror = function () { rej(t.error); }; t.onabort = function () { rej(t.error); };
    }); });
  }
  function idbGet(store, key) {
    return open().then(function (db) { return new Promise(function (res, rej) {
      const t = db.transaction(store, 'readonly'); const q = t.objectStore(store).get(key);
      q.onsuccess = function () { res(q.result); }; q.onerror = function () { rej(q.error); };
    }); });
  }
  function idbKeys(store) {
    return open().then(function (db) { return new Promise(function (res, rej) {
      const t = db.transaction(store, 'readonly'); const q = t.objectStore(store).getAllKeys();
      q.onsuccess = function () { res(q.result || []); }; q.onerror = function () { rej(q.error); };
    }); });
  }
  function bundledMeta() { return (window.DCR_RELEASE && window.DCR_RELEASE.meta) || {}; }
  function bundledRelease() { return bundledMeta().release_id || 'bundled'; }
  async function sha256hex(buf) {
    const d = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(d)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  async function state() {
    const active = ls.get('activeRelease', null);
    return {
      bundled: bundledRelease(),
      active: active || bundledRelease(),
      source: active ? 'remote' : 'bundled',
      lastSync: ls.get('lastSync', null),
      lastError: ls.get('lastError', null),
      pending: !!ls.get('pendingRelease', null),
      origin: ls.get('origin', null) || bundledMeta().public_origin || DEFAULT_ORIGIN
    };
  }
  async function fetchManifest(base) {
    const r = await fetch(base.replace(/\/+$/, '') + '/manifest.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('manifest HTTP ' + r.status);
    return await r.json();
  }
  async function check(origin) {
    const candidates = [];
    function push(o) { if (o && candidates.indexOf(o) < 0) candidates.push(String(o).replace(/\/+$/, '')); }
    push(origin); push(ls.get('origin', null)); push(bundledMeta().public_origin);
    FALLBACK_ORIGINS.forEach(push);
    let man = null, base = '', err = '';
    for (const c of candidates) {
      try { man = await fetchManifest(c); base = c; break; }
      catch (e) { err = '拉取manifest失败(' + c + '): ' + (e && e.message ? e.message : String(e)); }
    }
    if (!man) { ls.set('lastError', err); return { updated: false, error: err }; }
    ls.set('origin', base);
    const cur = ls.get('activeRelease', null) || bundledRelease();
    if (man.release_id === cur) { ls.set('lastError', null); return { updated: false, upToDate: true, release_id: man.release_id, counts: man.counts }; }
    return { updated: false, available: true, release_id: man.release_id, manifest: man, base: base };
  }
  async function apply(origin) {
    const chk = await check(origin);
    if (chk.upToDate) return { updated: false, upToDate: true, release_id: chk.release_id };
    if (!chk.available) return { updated: false, error: chk.error };
    const man = chk.manifest, base = chk.base, staged = {};
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
      await idbPut(STORE, staged);
      await idbPut(META, { release_id: man.release_id, applied_at: new Date().toISOString(), counts: man.counts });
      ls.set('activeRelease', man.release_id);
      if (man.public_origin) ls.set('origin', man.public_origin);
      ls.set('lastSync', new Date().toISOString());
      ls.set('lastError', null);
      ls.set('pendingRelease', null);
      return { updated: true, release_id: man.release_id, counts: man.counts };
    } catch (e) {
      const err = '更新失败（已保留上一版本）: ' + (e && e.message ? e.message : String(e));
      ls.set('lastError', err); ls.set('pendingRelease', man.release_id);
      return { updated: false, error: err };
    }
  }
  async function hydrate() {
    await open().catch(function () { });
    const active = ls.get('activeRelease', null);
    if (!active) return false;
    try {
      const names = ['sites.json', 'capacities.json', 'events.json', 'milestones.json', 'meta.json', 'news.json', 'map_paths.json'];
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
  async function inspect() {
    await open();
    return { stores: Array.prototype.slice.call(dbp.objectStoreNames), shard_names: await idbKeys(STORE) };
  }
  async function reset() {
    await idbPut(STORE, {}); await idbPut(META, {});
    ls.set('activeRelease', null); ls.set('lastSync', null); ls.set('lastError', null); ls.set('pendingRelease', null);
    return true;
  }
  return { state: state, check: check, apply: apply, hydrate: hydrate, reset: reset, inspect: inspect, DEFAULT_ORIGIN: DEFAULT_ORIGIN };
})();
