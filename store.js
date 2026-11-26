// Dónde se guardan los datos.
//
// - Publicada como enlace de Claude (artifact) con las capacidades db, user, assets y downloads:
//   los datos se comparten entre todos los móviles que abren el enlace.
// - Publicada fuera de Claude (como web o icono en el móvil) con `sheetsUrl` en config.js:
//   los datos viven en una hoja de Google de Mikel (ver tools/google-sheets/Code.gs) y se
//   comparten entre todos los móviles. Cada móvil escribe una vez el PIN del grupo.
// - Abierta en el ordenador (servidor local) o sin nada de lo anterior: modo prueba,
//   los datos se guardan solo en este navegador (localStorage).
//
// Las escrituras pasan por una cola: si no hay conexión, se guardan en el móvil
// y se envían en cuanto vuelve.
"use strict";

const Store = (() => {
  const PREFIX = "bl-merch:";
  const QUEUE_KEY = PREFIX + "queue";
  const PIN_KEY = PREFIX + "pin";
  const SNAP_KEY = PREFIX + "sheets-snapshot";
  const CONFIG = (typeof window !== "undefined" && window.BL_CONFIG) || {};
  const SHEETS_URL = String(CONFIG.sheetsUrl || "").trim();
  let snapshot = null; // modo sheets: { colección: [docs] } tal como está en la hoja
  let mode = "loading"; // "db" | "sheets" | "local"
  let db = null;
  let assets = null;
  let downloads = null;
  let user = null;
  let canWrite = true;
  const watchers = new Map(); // colección -> { cb, docs }
  const statusListeners = new Set();
  let status = { loading: true, slow: false, pending: 0, offline: !navigator.onLine };

  // ---------- utilidades ----------
  function newId() {
    const rnd = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + String(Math.random()).slice(2))
      .replace(/[^a-z0-9]/gi, "").slice(0, 12);
    // Empieza por la hora para que se ordenen solos.
    return Date.now().toString(36) + rnd;
  }

  function readJSON(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  }

  function setStatus(patch) {
    status = { ...status, ...patch };
    statusListeners.forEach((fn) => fn(status));
  }

  // ---------- cola de escrituras pendientes ----------
  let queue = readJSON(QUEUE_KEY, []);
  let flushing = false;

  function saveQueue() {
    writeJSON(QUEUE_KEY, queue);
    setStatus({ pending: queue.length });
  }

  function pendingFor(col) {
    return queue.filter((op) => op.col === col);
  }

  async function runOp(op) {
    const ref = db.collection(op.col).doc(op.id);
    if (op.type === "set") await ref.set(op.data);
    else if (op.type === "update") await ref.update(op.data);
    else if (op.type === "delete") await ref.delete();
  }

  async function flush() {
    if (mode === "sheets") return flushSheets();
    if (mode !== "db" || flushing) return;
    flushing = true;
    try {
      while (queue.length) {
        const op = queue[0];
        try {
          await runOp(op);
        } catch (e) {
          const code = e && e.code;
          if (code === "invalid_argument" || code === "quota_exceeded" || code === "transform_error") {
            // No se va a arreglar reintentando: se descarta para no bloquear el resto.
            console.warn("Escritura descartada", op, e);
            if (code === "invalid_argument") canWrite = false;
          } else {
            setStatus({ offline: true });
            break; // se reintenta más tarde
          }
        }
        queue.shift();
        saveQueue();
      }
      if (!queue.length) setStatus({ offline: false });
    } finally {
      flushing = false;
    }
  }

  function enqueue(op) {
    if (mode === "local") {
      applyLocal(op);
      return;
    }
    queue.push(op);
    saveQueue();
    // Se muestra al momento aunque aún no haya llegado al servidor.
    refreshWatcher(op.col);
    flush();
  }

  // ---------- modo local ----------
  function localKey(col) { return PREFIX + "data:" + col; }

  function applyLocal(op) {
    const all = readJSON(localKey(op.col), {});
    if (op.type === "set") all[op.id] = op.data;
    else if (op.type === "update") all[op.id] = deepMerge(all[op.id] || {}, op.data);
    else if (op.type === "delete") delete all[op.id];
    writeJSON(localKey(op.col), all);
    refreshWatcher(op.col);
  }

  function deepMerge(a, b) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) {
      out[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k])
        ? deepMerge(a[k], v) : v;
    }
    return out;
  }

  // ---------- lectura ----------
  function mergedDocs(col) {
    const w = watchers.get(col);
    const base = new Map();
    if (mode === "local") {
      const all = readJSON(localKey(col), {});
      Object.entries(all).forEach(([id, data]) => base.set(id, { id, ...data }));
    } else if (w && w.docs) {
      w.docs.forEach((d) => base.set(d.id, d));
    }
    // Lo que aún está en la cola se ve como si ya estuviera guardado.
    for (const op of pendingFor(col)) {
      if (op.type === "set") base.set(op.id, { id: op.id, ...op.data, _pending: true });
      else if (op.type === "update") base.set(op.id, { ...deepMerge(base.get(op.id) || { id: op.id }, op.data), _pending: true });
      else if (op.type === "delete") base.delete(op.id);
    }
    return [...base.values()];
  }

  function refreshWatcher(col) {
    const w = watchers.get(col);
    if (w) w.cb(mergedDocs(col));
  }

  function watch(col, cb) {
    watchers.set(col, { cb, docs: null });
    if (mode === "local") {
      cb(mergedDocs(col));
      return;
    }
    if (mode === "sheets") {
      const w = watchers.get(col);
      if (snapshot) { w.docs = snapshot[col] || []; markLoaded(col); }
      cb(mergedDocs(col));
      return;
    }
    db.collection(col).onSnapshot(
      (snap) => {
        const w = watchers.get(col);
        w.docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        if (!snap.metadata.fromCache) markLoaded(col);
        cb(mergedDocs(col));
      },
      (err) => {
        console.warn("Error leyendo", col, err);
        markLoaded(col);
      },
    );
  }

  const loaded = new Set();
  function markLoaded(col) {
    loaded.add(col);
    if ([...watchers.keys()].every((c) => loaded.has(c))) setStatus({ loading: false, slow: false });
  }

  // ---------- arranque ----------
  async function init() {
    const api = window.claude && typeof window.claude.use === "function" ? window.claude : null;
    if (api) {
      try {
        db = await api.use("db");
        if (db) {
          [assets, downloads, user] = await Promise.all([api.use("assets"), api.use("downloads"), api.use("user")]);
          if (user && typeof user.can === "function") {
            try { const c = await user.can("data.write"); if (c === false) canWrite = false; } catch { /* sin dato */ }
          }
        }
      } catch {
        db = null;
      }
    }
    mode = db ? "db" : SHEETS_URL ? "sheets" : "local";
    setStatus({ loading: mode !== "local", pending: mode !== "local" ? queue.length : 0 });

    if (mode === "sheets") {
      snapshot = readJSON(SNAP_KEY, null); // lo último que se vio, para abrir sin conexión
      if (snapshot) setStatus({ loading: false });
      await ensurePin();
      window.addEventListener("online", () => { setStatus({ offline: false }); pull(); flush(); });
      window.addEventListener("offline", () => setStatus({ offline: true }));
      document.addEventListener("visibilitychange", () => { if (!document.hidden) { pull(); flush(); } });
      setInterval(() => { if (!document.hidden) { if (queue.length) flush(); else pull(); } }, 15000);
      setTimeout(() => { if (status.loading) setStatus({ slow: true }); }, 10000);
      pull();
      flush();
      return mode;
    }

    if (mode === "db") {
      setTimeout(() => { if (status.loading) setStatus({ slow: true }); }, 10000);
      window.addEventListener("online", () => { setStatus({ offline: false }); flush(); });
      window.addEventListener("offline", () => setStatus({ offline: true }));
      setInterval(() => { if (queue.length) flush(); }, 30000);
      flush();
    } else {
      // Otra pestaña del mismo navegador ha cambiado algo.
      window.addEventListener("storage", (e) => {
        if (!e.key || !e.key.startsWith(PREFIX + "data:")) return;
        refreshWatcher(e.key.slice((PREFIX + "data:").length));
      });
    }
    return mode;
  }

  // ---------- modo hoja de Google ----------
  function getPin() { try { return localStorage.getItem(PIN_KEY) || ""; } catch { return ""; } }
  function setPin(v) { try { if (v) localStorage.setItem(PIN_KEY, v); else localStorage.removeItem(PIN_KEY); } catch { /* sin almacenamiento */ } }

  async function call(body) {
    // Texto plano para que el navegador no haga una consulta previa (CORS) que Google no acepta.
    const res = await fetch(SHEETS_URL, { method: "POST", body: JSON.stringify({ pin: getPin(), ...body }) });
    if (!res.ok) throw Object.assign(new Error("http " + res.status), { code: "network" });
    const out = await res.json();
    if (!out.ok) throw Object.assign(new Error(out.error || "error"), { code: out.error || "server" });
    return out;
  }

  function applySnapshot(data) {
    if (!data) return;
    snapshot = data;
    writeJSON(SNAP_KEY, snapshot);
    for (const [col, w] of watchers) {
      w.docs = snapshot[col] || [];
      markLoaded(col);
      w.cb(mergedDocs(col));
    }
  }

  async function pull() {
    if (mode !== "sheets" || !getPin()) return;
    try {
      const out = await call({ op: "all" });
      setStatus({ offline: false });
      applySnapshot(out.data);
    } catch (e) {
      handleSheetsError(e);
    }
  }

  async function flushSheets() {
    if (flushing || !queue.length || !getPin()) return;
    flushing = true;
    const batch = queue.slice(0, 40);
    try {
      const out = await call({ op: "write", ops: batch });
      queue = queue.slice(batch.length);
      saveQueue();
      setStatus({ offline: false });
      applySnapshot(out.data);
    } catch (e) {
      handleSheetsError(e);
    } finally {
      flushing = false;
    }
    if (queue.length && !status.offline) flushSheets();
  }

  function handleSheetsError(e) {
    const code = e && e.code;
    if (code === "pin") {
      setPin("");
      ensurePin(true);
    } else {
      console.warn("Hoja de Google:", e);
      setStatus({ offline: true });
    }
  }

  // Pantalla del PIN: se muestra si este móvil aún no lo tiene guardado (o si ha cambiado).
  let pinGate = null;
  function ensurePin(wrong = false) {
    if (getPin() && !wrong) return Promise.resolve();
    if (pinGate) return pinGate.promise;
    const tr = (k) => (typeof t === "function" ? t(k) : k);
    const el = document.createElement("div");
    el.className = "pin-gate";
    el.innerHTML = `
      <form class="pin-card">
        <img src="img/logo-10.png" alt="" class="pin-logo">
        <h2></h2>
        <p class="pin-text"></p>
        <input id="pinInput" type="password" inputmode="numeric" autocomplete="off" required>
        <p class="pin-error" role="alert"></p>
        <button type="submit" class="btn"></button>
      </form>`;
    el.querySelector("h2").textContent = tr("pin.title");
    el.querySelector(".pin-text").textContent = tr("pin.text");
    el.querySelector("button").textContent = tr("pin.ok");
    const err = el.querySelector(".pin-error");
    if (wrong) err.textContent = tr("pin.wrong");
    document.body.appendChild(el);
    const input = el.querySelector("input");
    setTimeout(() => input.focus(), 50);
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    pinGate = { promise };
    el.querySelector("form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      const btn = el.querySelector("button");
      btn.disabled = true;
      err.textContent = "";
      setPin(value);
      try {
        await call({ op: "ping" });
        el.remove();
        pinGate = null;
        resolve();
        pull();
        flush();
      } catch (e) {
        if (e && e.code === "pin") { setPin(""); err.textContent = tr("pin.wrong"); }
        else { err.textContent = tr("pin.noNet"); }
        btn.disabled = false;
        input.select();
      }
    });
    return promise;
  }

  function forgetPin() { setPin(""); location.reload(); }

  // ---------- escritura ----------
  function set(col, id, data) { enqueue({ type: "set", col, id, data }); }
  function update(col, id, data) { enqueue({ type: "update", col, id, data }); }
  function remove(col, id) { enqueue({ type: "delete", col, id }); }

  // ---------- fotos ----------
  function canUploadPhotos() { return mode === "local" || mode === "sheets" || !!assets; }

  async function shrinkImage(file, maxSide = 700, quality = 0.82) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = url;
      });
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff"; // las fotos con fondo transparente no salen negras
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Devuelve la referencia que se guarda en el producto.
  async function uploadPhoto(file) {
    if (mode === "local") {
      const small = await shrinkImage(file, 400);
      return await new Promise((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.readAsDataURL(small);
      });
    }
    if (mode === "sheets") {
      // La foto va dentro del producto en la hoja: cada celda admite unos 50.000 caracteres.
      for (const [side, q] of [[420, 0.72], [340, 0.68], [260, 0.62]]) {
        const blob = await shrinkImage(file, side, q);
        const dataUrl = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(blob); });
        if (dataUrl.length < 38000) return dataUrl;
      }
      throw new Error("photo_too_big");
    }
    if (!assets) throw new Error("no_assets");
    const small = await shrinkImage(file);
    const res = await assets.upload(small, { type: "image/jpeg" });
    return res.id;
  }

  function photoUrl(ref) {
    if (!ref || typeof ref !== "string") return "";
    if (ref.startsWith("data:image/")) return ref;
    if (/^img\/[\w.-]+\.(jpe?g|png|webp)$/i.test(ref)) return ref; // fotos que vienen con la app
    if (/^[0-9a-f]{32}$/i.test(ref)) return "/_blob/" + ref;
    return "";
  }

  // ---------- descargas ----------
  async function download(filename, text, type = "text/csv") {
    const blob = new Blob([text], { type });
    if (downloads) {
      await downloads.save({ filename, data: blob });
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  return {
    init, watch, set, update, remove, newId, forgetPin,
    uploadPhoto, photoUrl, canUploadPhotos, download,
    get mode() { return mode; },
    get canWrite() { return canWrite; },
    get status() { return status; },
    onStatus(fn) { statusListeners.add(fn); fn(status); },
  };
})();
