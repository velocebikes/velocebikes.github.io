// ═══════════════════════════════════════════════════════════════════
//  Sincronización del CRM con el servidor (api/index.php)
//
//  El CRM sigue leyendo y escribiendo en localStorage como siempre, pero
//  aquí se vigila cada cambio en las claves "vcr_*" y se envía al
//  servidor, y cada pocos segundos se traen los cambios de los demás
//  dispositivos. localStorage queda como copia temporal y se borra al
//  cerrar sesión.
//
//  Si dos personas cambian la misma lista a la vez, se juntan los
//  cambios registro a registro (por id) en lugar de pisarse.
// ═══════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  const API = 'api/index.php';
  const POLL_MS = 15000;
  const isKey = k => typeof k === 'string' && /^vcr_[a-z0-9_]{1,40}$/.test(k);

  const rawSet = Storage.prototype.setItem;
  const rawRemove = Storage.prototype.removeItem;
  let bypass = false;

  const st = {
    user: null,
    rev: 0,
    base: {},          // clave -> {rev, v}: último valor conocido del servidor
    dirty: new Set(),  // claves con cambios locales sin subir
    pushing: null,
    timer: null,
    poll: null,
    retryMs: 2000,
    pendingRender: false,
  };

  // ── Vigilar localStorage ──
  Storage.prototype.setItem = function (k, v) {
    rawSet.call(this, k, v);
    if (this === window.localStorage && !bypass && st.user && isKey(k)) markDirty(k);
  };
  Storage.prototype.removeItem = function (k) {
    rawRemove.call(this, k);
    if (this === window.localStorage && !bypass && st.user && isKey(k)) markDirty(k);
  };
  function setLocal(k, v) {
    bypass = true;
    try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } finally { bypass = false; }
  }
  function localKeys() {
    const ks = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (isKey(k)) ks.push(k); }
    return ks;
  }
  function clearLocal() { localKeys().forEach(k => setLocal(k, null)); }

  // ── Llamadas al servidor ──
  class ApiError extends Error { constructor(msg, status, data) { super(msg); this.status = status; this.data = data; } }
  async function api(action, { method, body, form, query } = {}) {
    const qs = new URLSearchParams({ a: action, ...(query || {}) });
    const opts = { method: method || (body || form ? 'POST' : 'GET'), credentials: 'same-origin', headers: { 'X-CRM': '1' }, cache: 'no-store' };
    if (form) opts.body = form;
    else if (body) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
    let res;
    try { res = await fetch(API + '?' + qs, opts); }
    catch (e) { throw new ApiError('Sin conexión con el servidor.', 0); }
    let data = null;
    try { data = await res.json(); } catch (e) { }
    if (res.status === 401 && action !== 'login' && action !== 'me') { expired(); }
    if (!res.ok) throw new ApiError((data && data.error) || 'Error del servidor.', res.status, data);
    return data;
  }

  // ── Estado visible ──
  function status(txt, warn) {
    const el = document.getElementById('sync-status');
    if (!el) return;
    el.textContent = txt;
    el.style.color = warn ? '#e07070' : '';
  }
  function refreshStatus() {
    if (!st.user) return;
    if (st.dirty.size) status(st.retryMs > 2000 ? '⚠ Sin conexión · cambios pendientes' : 'Guardando…', st.retryMs > 2000);
    else status('✓ Guardado');
  }

  // ── Subir cambios ──
  function markDirty(k) {
    st.dirty.add(k);
    refreshStatus();
    clearTimeout(st.timer);
    st.timer = setTimeout(flush, 400);
  }

  function flush() {
    if (st.pushing) return st.pushing;
    if (!st.dirty.size) return Promise.resolve();
    st.pushing = (async () => {
      await null; // que st.pushing quede asignado antes de poder liberarse en finally
      try {
        while (st.dirty.size) {
          const k = st.dirty.values().next().value;
          const v = localStorage.getItem(k);
          const b = st.base[k] || { rev: 0, v: null };
          try {
            const r = await api('put', { body: { k, v, base: b.rev } });
            st.base[k] = { rev: r.rev, v };
            if (localStorage.getItem(k) === v) st.dirty.delete(k);
          } catch (e) {
            if (e.status === 409 && e.data) {
              // Otro dispositivo cambió esta clave: juntar y reintentar.
              const merged = merge(b.v, v, e.data.v);
              st.base[k] = { rev: e.data.rev, v: e.data.v };
              setLocal(k, merged);
              st.pendingRender = true;
              continue;
            }
            if (e.status === 403 || e.status === 400) {
              // No se puede guardar (sin permiso): se descarta el cambio.
              st.dirty.delete(k);
              if (st.base[k]) setLocal(k, st.base[k].v);
              alert('No se ha podido guardar: ' + e.message);
              continue;
            }
            throw e;
          }
        }
        st.retryMs = 2000;
      } catch (e) {
        st.retryMs = Math.min(st.retryMs * 2, 60000);
        clearTimeout(st.timer);
        st.timer = setTimeout(flush, st.retryMs);
      } finally {
        st.pushing = null;
        refreshStatus();
        if (st.pendingRender) rerender();
      }
    })();
    return st.pushing;
  }

  // Unión a tres bandas: base = lo que había, mine = lo mío, theirs = lo del servidor.
  function merge(baseStr, mineStr, theirsStr) {
    if (mineStr === null || theirsStr === null) return mineStr;
    let b, m, t;
    try { b = JSON.parse(baseStr || 'null'); m = JSON.parse(mineStr); t = JSON.parse(theirsStr); } catch (e) { return mineStr; }
    return JSON.stringify(merge3(b, m, t));
  }
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const hasIds = a => Array.isArray(a) && a.every(x => x && typeof x === 'object' && 'id' in x);
  function merge3(b, m, t) {
    if (hasIds(m) && hasIds(t)) {
      const bm = new Map((hasIds(b) ? b : []).map(x => [String(x.id), x]));
      const mm = new Map(m.map(x => [String(x.id), x]));
      const out = t.slice();
      const idx = id => out.findIndex(x => String(x.id) === id);
      m.forEach(x => {
        const id = String(x.id), old = bm.get(id);
        if (old && same(old, x)) return; // no lo he tocado yo
        const i = idx(id);
        if (i >= 0) out[i] = x; else out.push(x);
      });
      bm.forEach((x, id) => { if (!mm.has(id)) { const i = idx(id); if (i >= 0) out.splice(i, 1); } });
      return out;
    }
    if (m && t && typeof m === 'object' && typeof t === 'object' && !Array.isArray(m) && !Array.isArray(t)) {
      const bo = b && typeof b === 'object' && !Array.isArray(b) ? b : {};
      const out = { ...t };
      new Set([...Object.keys(m), ...Object.keys(bo)]).forEach(k => {
        if (same(m[k], bo[k])) return;
        if (m[k] === undefined) delete out[k];
        else out[k] = typeof m[k] === 'object' && typeof t[k] === 'object' ? merge3(bo[k], m[k], t[k]) : m[k];
      });
      return out;
    }
    return m;
  }

  // ── Bajar cambios ──
  async function pull(full) {
    const r = await api('pull', { query: { since: full ? 0 : st.rev } });
    let changed = false;
    const seen = new Set();
    Object.entries(r.keys || {}).forEach(([k, x]) => {
      seen.add(k);
      if (st.dirty.has(k)) return; // lo junta flush() al subir
      st.base[k] = { rev: x.rev, v: x.v };
      if (localStorage.getItem(k) !== x.v) { setLocal(k, x.v); changed = true; }
    });
    if (full && !r.empty) {
      localKeys().forEach(k => { if (!seen.has(k) && !st.dirty.has(k)) { setLocal(k, null); changed = true; } });
    }
    st.rev = Math.max(st.rev, r.rev);
    return { changed, empty: r.empty };
  }

  async function poll() {
    if (!st.user || document.hidden) return;
    try {
      const { changed } = await pull(false);
      if (changed) st.pendingRender = true;
      if (st.pendingRender) rerender();
    } catch (e) { }
  }

  function rerender() {
    if (document.querySelector('.modal-bg.open') || document.getElementById('pw-overlay')) { st.pendingRender = true; return; }
    st.pendingRender = false;
    const page = document.querySelector('.page.active');
    const name = page ? page.id.replace(/^page-/, '') : 'dashboard';
    try { window.goTo(name, document.querySelector('.nav-item.active')); } catch (e) { }
  }

  // ── Sesión ──
  function showLogin(msg) {
    st.user = null;
    clearInterval(st.poll);
    const app = document.getElementById('crm-app'), ls = document.getElementById('login-screen');
    if (app) app.style.display = 'none';
    if (ls) ls.style.display = 'flex';
    const err = document.getElementById('ls-error');
    if (err) { err.textContent = msg || 'Usuario o contraseña incorrectos.'; err.style.display = msg ? 'block' : 'none'; }
  }
  function expired() {
    if (!st.user) return;
    showLogin('Tu sesión ha caducado. Vuelve a entrar.');
  }

  async function startApp(u) {
    if (u.mustChange) {
      const ok = await forcePasswordChange();
      if (!ok) { showLogin(); return; }
    }
    status('Cargando datos…');
    st.user = u;
    let res;
    try { res = await pull(true); } catch (e) { st.user = null; showLogin(e.message); return; }

    if (res.empty && localKeys().length) {
      const subir = confirm('El servidor todavía no tiene datos.\n\n¿Subir los datos que hay guardados en ESTE navegador (clientes, vehículos, contratos, documentos…) para tenerlos en todos tus dispositivos?\n\nPulsa "Cancelar" si este no es el ordenador donde tienes tus datos.');
      if (!subir) { await api('logout', { method: 'POST' }).catch(() => { }); st.user = null; showLogin('No se ha subido nada. Entra desde el ordenador donde tienes tus datos.'); return; }
      localKeys().forEach(k => st.dirty.add(k));
      status('Subiendo datos…');
      await flush();
      await migrateOldDocs();
    }

    window.currentUser = { user: u.user, nombre: u.nombre, conta: u.conta };
    try { currentUser = window.currentUser; } catch (e) { }
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('crm-app').style.display = 'block';
    document.getElementById('topbar-user').textContent = u.nombre;
    document.getElementById('dash-name').textContent = u.nombre;
    if (window.applyContaAccess) applyContaAccess();
    if (window.renderAvisos) renderAvisos();
    rerender();
    refreshStatus();
    clearInterval(st.poll);
    st.poll = setInterval(poll, POLL_MS);
  }

  async function login() {
    const user = document.getElementById('ls-user').value.trim().toLowerCase();
    const pass = document.getElementById('ls-pass').value;
    const err = document.getElementById('ls-error');
    err.style.display = 'none';
    try {
      const u = await api('login', { body: { user, pass } });
      document.getElementById('ls-pass').value = '';
      await startApp(u);
    } catch (e) {
      err.textContent = e.message;
      err.style.display = 'block';
    }
  }

  async function logout() {
    if (st.dirty.size) {
      await flush();
      if (st.dirty.size && !confirm('Hay cambios que todavía no se han guardado en el servidor (¿sin conexión?). Si cierras sesión se perderán.\n\n¿Cerrar sesión igualmente?')) return;
    }
    await api('logout', { method: 'POST' }).catch(() => { });
    st.user = null;
    st.dirty.clear();
    clearLocal();
    window.location.href = 'index.html';
  }

  async function init() {
    showLogin();
    try {
      const u = await api('me');
      await startApp(u);
    } catch (e) {
      if (e.status !== 401) showLogin(e.message);
    }
  }

  // ── Cambio de contraseña ──
  function passwordDialog(forced) {
    return new Promise(resolve => {
      const ov = document.createElement('div');
      ov.id = 'pw-overlay';
      ov.style.cssText = 'position:fixed;inset:0;z-index:10000;background:#080807;display:flex;align-items:center;justify-content:center;padding:1rem;';
      const inp = 'width:100%;background:#1a1a1a;border:0.5px solid #333;color:#f0ede8;padding:0.8rem 1rem;font-size:0.88rem;outline:none;box-sizing:border-box;margin-bottom:1rem;';
      const lab = 'display:block;font-size:0.6rem;letter-spacing:0.18em;text-transform:uppercase;color:#888;margin-bottom:0.4rem;';
      ov.innerHTML = `<div style="width:100%;max-width:360px;color:#f0ede8;font-family:inherit;">
        <div style="font-size:1.1rem;margin-bottom:0.5rem;">${forced ? 'Crea tu contraseña' : 'Cambiar contraseña'}</div>
        <p style="font-size:0.78rem;color:#888;margin:0 0 1.2rem;">${forced ? 'Es tu primera vez. Cambia la contraseña inicial por una solo tuya.' : ''} Mínimo 10 caracteres.</p>
        <label style="${lab}">Contraseña actual</label><input type="password" id="pw-old" autocomplete="current-password" style="${inp}"/>
        <label style="${lab}">Contraseña nueva</label><input type="password" id="pw-new" autocomplete="new-password" style="${inp}"/>
        <label style="${lab}">Repite la nueva</label><input type="password" id="pw-new2" autocomplete="new-password" style="${inp}"/>
        <div id="pw-err" style="display:none;font-size:0.75rem;color:#e07070;margin-bottom:1rem;"></div>
        <button id="pw-ok" style="width:100%;background:#c9a84c;color:#080807;border:none;padding:0.9rem;font-size:0.7rem;font-weight:600;letter-spacing:0.2em;text-transform:uppercase;cursor:pointer;">Guardar</button>
        <button id="pw-cancel" style="width:100%;background:none;color:#888;border:none;padding:0.8rem;font-size:0.7rem;letter-spacing:0.15em;text-transform:uppercase;cursor:pointer;">Cancelar</button>
      </div>`;
      document.body.appendChild(ov);
      const $ = id => ov.querySelector('#' + id);
      const showErr = m => { $('pw-err').textContent = m; $('pw-err').style.display = 'block'; };
      const close = ok => { ov.remove(); resolve(ok); if (st.pendingRender) rerender(); };
      $('pw-old').focus();
      $('pw-cancel').onclick = () => close(false);
      $('pw-ok').onclick = async () => {
        const o = $('pw-old').value, n = $('pw-new').value, n2 = $('pw-new2').value;
        if (n.length < 10) return showErr('La contraseña nueva debe tener al menos 10 caracteres.');
        if (n !== n2) return showErr('Las dos contraseñas nuevas no coinciden.');
        try { await api('password', { body: { old: o, new: n } }); alert('Contraseña cambiada.'); close(true); }
        catch (e) { showErr(e.message); }
      };
      ov.addEventListener('keydown', e => { if (e.key === 'Enter') $('pw-ok').click(); });
    });
  }
  const forcePasswordChange = () => passwordDialog(true);

  // ── Documentos (en el servidor) ──
  const docUrl = (id, dl) => API + '?' + new URLSearchParams({ a: 'doc', id, ...(dl ? { dl: '1' } : {}) });
  const DOCDB = {
    async put(d) {
      const { blob, ...meta } = d;
      const fd = new FormData();
      fd.append('meta', JSON.stringify(meta));
      fd.append('file', blob, meta.nombre || 'documento');
      await api('doc_upload', { form: fd });
    },
    async del(id) { await api('doc_delete', { body: { id } }); },
    async list() { return api('docs'); },
    async byVeh(v) { return api('docs', { query: { veh: String(v) } }); },
    async get(id) {
      const meta = (await this.list()).find(x => x.id === id);
      if (!meta) return undefined;
      const r = await fetch(docUrl(id), { credentials: 'same-origin' });
      if (!r.ok) return undefined;
      return { ...meta, blob: await r.blob() };
    },
    async all() {
      const l = await this.list();
      return Promise.all(l.map(async m => ({ ...m, blob: await (await fetch(docUrl(m.id), { credentials: 'same-origin' })).blob() })));
    },
    async clear() { await api('doc_clear', { method: 'POST' }); },
  };

  // Documentos que estaban guardados solo en este navegador (versión anterior del CRM).
  function migrateOldDocs() {
    return new Promise(resolve => {
      let req;
      try { req = indexedDB.open('veloce-docs', 1); } catch (e) { return resolve(); }
      req.onupgradeneeded = () => { try { req.result.createObjectStore('docs', { keyPath: 'id' }).createIndex('vehId', 'vehId'); } catch (e) { } };
      req.onerror = () => resolve();
      req.onsuccess = () => {
        const db = req.result;
        let g;
        try { g = db.transaction('docs', 'readonly').objectStore('docs').getAll(); } catch (e) { db.close(); return resolve(); }
        g.onerror = () => { db.close(); resolve(); };
        g.onsuccess = async () => {
          const docs = g.result || [];
          let fallos = 0;
          for (let i = 0; i < docs.length; i++) {
            status(`Subiendo documentos ${i + 1}/${docs.length}…`);
            try { await DOCDB.put(docs[i]); } catch (e) { fallos++; }
          }
          if (!fallos && docs.length) { try { db.transaction('docs', 'readwrite').objectStore('docs').clear(); } catch (e) { } }
          db.close();
          if (fallos) alert(`No se pudieron subir ${fallos} documentos. Siguen guardados en este navegador; avisa para revisarlo.`);
          resolve();
        };
      };
    });
  }

  window.addEventListener('beforeunload', e => { if (st.dirty.size) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  window.addEventListener('online', () => { flush(); poll(); });

  window.CRMSYNC = {
    api, init, login, logout, flush, DOCDB, docUrl,
    changePassword: () => passwordDialog(false),
    async reload() { await flush(); location.reload(); },
  };
})();
