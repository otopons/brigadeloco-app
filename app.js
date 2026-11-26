// Brigade Loco · Merch — la app.
// Apartados: Ventas (vender y resumen), Stock, Productos y Ajustes.
// Los datos viven en Store (store.js); los textos en i18n.js.
"use strict";

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
const COL = {
  products: "produktuak",
  stock: "stocka",
  sales: "salmentak",
  concerts: "kontzertuak",
  settings: "ezarpenak",
};
const SETTINGS_ID = "orokorra";
const METHODS = ["cash", "card", "bizum"];
const METHOD_KEY = { cash: "pay.cash", card: "pay.card", bizum: "pay.bizum" };
const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "Bakarra"];
const ONE_SIZE = "Bakarra";
const DEFAULT_SETTINGS = { aktiboa: null, moduak: { cash: true, card: true, bizum: true }, baxua: 3, sumup: {} };

const state = {
  tab: "sales",
  salesView: "sell", // "sell" | "summary"
  search: "",
  onlyLow: false,
  summaryConcert: null, // null = el actual
  cart: [], // { pid, size, qty }
  products: [],
  stock: new Map(),
  sales: [],
  concerts: [],
  settings: { ...DEFAULT_SETTINGS },
  confirm: null, // id de lo que se está confirmando (anular venta, borrar…)
};

let stockCache = null; // Map "pid|talla" -> unidades disponibles

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function money(cents) {
  const n = (Number(cents) || 0) / 100;
  return n.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " \u20AC";
}

function moneyShort(cents) {
  const n = (Number(cents) || 0) / 100;
  return n.toLocaleString("es-ES", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }) + " \u20AC";
}

// "20,5" / "20.50" / "15" -> céntimos
function parseMoney(text) {
  const s = String(text ?? "").trim().replace(/\s|€/g, "").replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

function initials(name) {
  return String(name || "?").replace(/brigade\s*loco/i, "").replace(/[^\p{L}\p{N}\s]/gu, " ").trim()
    .split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "BL";
}

function sortSizes(sizes) {
  return [...sizes].sort((a, b) => {
    const ia = SIZE_ORDER.indexOf(a), ib = SIZE_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

function sizeLabel(size) { return size === ONE_SIZE ? t("prod.oneSize") : size; }

function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = String(iso).split("-").map(Number);
  if (!y) return String(iso);
  return new Date(y, m - 1, d).toLocaleDateString(getLang() === "es" ? "es-ES" : "eu-ES", { day: "numeric", month: "short", year: "numeric" });
}

function fmtTime(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}

function fmtDateTime(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit" }) + " " + fmtTime(ms);
}

function today() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function photoHtml(p) {
  const url = p && Store.photoUrl(p.argazkia);
  return url
    ? `<div class="photo"><img src="${esc(url)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ph',textContent:'${esc(initials(p.izena))}'}))"></div>`
    : `<div class="photo"><span class="ph">${esc(initials(p && p.izena))}</span></div>`;
}

// ---------------------------------------------------------------------------
// Datos derivados
// ---------------------------------------------------------------------------
function productById(id) { return state.products.find((p) => p.id === id); }
function concertById(id) { return state.concerts.find((c) => c.id === id); }
function activeConcert() { return concertById(state.settings.aktiboa) || null; }

function sortedProducts() {
  return [...state.products].sort((a, b) => (a.ordena ?? 0) - (b.ordena ?? 0) || String(a.izena).localeCompare(String(b.izena)));
}

// Stock disponible = unidades contadas en el último ajuste − lo vendido después (sin contar anuladas).
function computeStock() {
  const map = new Map();
  for (const p of state.products) {
    const st = state.stock.get(p.id);
    for (const size of p.tallak || []) {
      const base = st && st.tallak && st.tallak[size];
      map.set(p.id + "|" + size, { n: base ? Number(base.n) || 0 : 0, at: base ? Number(base.at) || 0 : 0 });
    }
  }
  for (const s of state.sales) {
    if (s.ezeztatua) continue;
    for (const l of s.lerroak || []) {
      const e = map.get(l.p + "|" + l.talla);
      if (e && Number(s.at) > e.at) e.n -= Number(l.kop) || 0;
    }
  }
  const out = new Map();
  map.forEach((v, k) => out.set(k, v.n));
  return out;
}

function stockOf(pid, size) {
  if (!stockCache) stockCache = computeStock();
  return stockCache.get(pid + "|" + size) ?? 0;
}

function isLow(n) { return n <= (Number(state.settings.baxua) || 0); }

function cartQty(pid, size) {
  const l = state.cart.find((c) => c.pid === pid && c.size === size);
  return l ? l.qty : 0;
}

function cartTotal() {
  return state.cart.reduce((sum, l) => {
    const p = productById(l.pid);
    return sum + (p ? (Number(p.prezioa) || 0) * l.qty : 0);
  }, 0);
}

function cartUnits() { return state.cart.reduce((s, l) => s + l.qty, 0); }

function enabledMethods() { return METHODS.filter((m) => state.settings.moduak && state.settings.moduak[m] !== false); }

// ---------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------
function guardWrite() {
  if (!Store.canWrite) { toast(t("common.readonly")); return false; }
  return true;
}

function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  Store.set(COL.settings, SETTINGS_ID, { ...state.settings });
}

// Fija las unidades de una talla a partir de ahora.
function setStock(pid, size, n) {
  const entry = { n: Math.max(0, Math.round(Number(n) || 0)), at: Date.now() };
  const existing = state.stock.get(pid);
  if (existing && !existing._pending) {
    Store.update(COL.stock, pid, { tallak: { [size]: entry } });
  } else {
    const tallak = { ...((existing && existing.tallak) || {}), [size]: entry };
    Store.set(COL.stock, pid, { tallak });
  }
}

function saveProduct(p) {
  const { id, _pending, ...data } = p;
  Store.set(COL.products, id, data);
}

// ---------------------------------------------------------------------------
// Pintado
// ---------------------------------------------------------------------------
let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    // No repintamos mientras alguien escribe en un campo de la página.
    const ae = document.activeElement;
    if (ae && $("#main").contains(ae) && ae.matches("input, select, textarea")) {
      ae.addEventListener("blur", render, { once: true });
      renderChrome();
      return;
    }
    stockCache = null;
    renderChrome();
    renderMain();
  });
}

function renderChrome() {
  document.querySelectorAll("[data-t]").forEach((el) => { el.textContent = t(el.dataset.t); });
  document.querySelectorAll(".tabbar button").forEach((b) => {
    if (b.dataset.tab === state.tab) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });

  const c = activeConcert();
  const chip = $("#concertChip");
  chip.textContent = c ? c.izena : t("concert.none");
  chip.classList.toggle("none", !c);
  chip.title = c ? fmtDate(c.data) : t("concert.choose");

  const st = Store.status;
  const sync = $("#sync");
  let cls = "", txt = t("sync.ok");
  if (Store.mode === "local") { cls = "local"; txt = t("sync.local"); }
  else if (st.loading) { cls = "loading"; txt = st.slow ? t("sync.slow") : t("sync.loading"); }
  else if (st.offline) { cls = "offline"; txt = st.pending ? t("sync.offline") + " · " + t("sync.pending", { n: st.pending }) : t("sync.offline"); }
  else if (st.pending) { cls = "pending"; txt = t("sync.pending", { n: st.pending }); }
  sync.className = "sync " + cls;
  sync.textContent = txt;

  renderCart();
}

function renderMain() {
  const main = $("#main");
  if (state.tab === "sales") main.innerHTML = state.salesView === "sell" ? viewSell() : viewSummary();
  else if (state.tab === "stock") main.innerHTML = viewStock();
  else if (state.tab === "products") main.innerHTML = viewProducts();
  else main.innerHTML = viewSettings();
}

function salesSwitch() {
  return `<div class="seg" role="group">
    <button type="button" data-act="salesView" data-view="sell" aria-pressed="${state.salesView === "sell"}">${esc(t("sell.sell"))}</button>
    <button type="button" data-act="salesView" data-view="summary" aria-pressed="${state.salesView === "summary"}">${esc(t("sell.summary"))}</button>
  </div>`;
}

// ---------- Vender ----------
function viewSell() {
  const products = sortedProducts();
  let html = salesSwitch();
  if (!activeConcert()) {
    html += `<div class="notice warn row spread"><span>${esc(t("concert.choose"))}</span>
      <button class="btn small secondary" type="button" data-act="go" data-tab="settings">${esc(t("tab.settings"))}</button></div>`;
  }
  if (!products.length) {
    return html + `<div class="empty"><p>${esc(t("sell.noProducts"))}</p>
      <button class="btn" type="button" data-act="loadCatalog">${esc(t("set.catalog"))}</button>
      <button class="btn secondary" type="button" data-act="go" data-tab="products">${esc(t("sell.goProducts"))}</button></div>`;
  }
  html += `<input type="search" id="search" placeholder="${esc(t("sell.search"))}" value="${esc(state.search)}" autocomplete="off">`;
  html += `<div class="grid" id="sellGrid">${sellCards()}</div>`;
  return html;
}

function sellCards() {
  const q = state.search.trim().toLowerCase();
  return sortedProducts()
    .filter((p) => !q || String(p.izena).toLowerCase().includes(q))
    .map((p) => {
      const sizes = sortSizes(p.tallak || []).map((size) => {
        const n = stockOf(p.id, size) - cartQty(p.id, size);
        const inCart = cartQty(p.id, size) > 0;
        const cls = ["size", n <= 0 ? "out" : isLow(n) ? "low" : "", inCart ? "incart" : ""].join(" ");
        return `<button type="button" class="${cls}" data-act="add" data-pid="${esc(p.id)}" data-size="${esc(size)}"
          aria-label="${esc(p.izena)} ${esc(sizeLabel(size))}">
          <b>${esc(sizeLabel(size))}</b><small>${esc(Math.max(0, n))}</small></button>`;
      }).join("");
      return `<article class="card">${photoHtml(p)}
        <div class="body"><div class="title"><b>${esc(p.izena)}</b><span class="price">${esc(moneyShort(p.prezioa))}</span></div>
        <div class="sizes">${sizes}</div></div></article>`;
    }).join("") || `<p class="muted">—</p>`;
}

function renderCart() {
  const bar = $("#cartbar");
  const show = state.tab === "sales" && state.salesView === "sell" && state.cart.length > 0;
  document.body.classList.toggle("has-cart", show);
  if (!show) { bar.hidden = true; bar.innerHTML = ""; return; }
  bar.hidden = false;
  const lines = state.cart.map((l, i) => {
    const p = productById(l.pid);
    return `<div class="cart-line"><span>${esc(p ? p.izena : "?")} · <b>${esc(sizeLabel(l.size))}</b></span>
      <span class="qty"><button type="button" data-act="qty" data-i="${i}" data-d="-1" aria-label="−">−</button><span>${l.qty}</span>
      <button type="button" data-act="qty" data-i="${i}" data-d="1" aria-label="+">+</button></span>
      <span class="amount">${esc(money((p ? p.prezioa : 0) * l.qty))}</span></div>`;
  }).join("");
  bar.innerHTML = `<div class="wrap">
    <div class="cart-lines">${lines}</div>
    <div class="cart-sum">
      <button class="btn small secondary" type="button" data-act="clearCart">${esc(t("sell.clear"))}</button>
      <span class="muted small">${esc(t("sell.items", { n: cartUnits() }))}</span>
      <span class="total">${esc(money(cartTotal()))}</span>
      <button class="btn dark" type="button" data-act="openPay">${esc(t("sell.charge"))}</button>
    </div></div>`;
}

// ---------- Cobro ----------
const pay = { method: null, received: "" };

function openPay() {
  if (!state.cart.length) return;
  const methods = enabledMethods();
  if (!methods.length) { toast(t("sell.noMethods")); return; }
  if (!methods.includes(pay.method)) pay.method = methods[0];
  pay.received = "";
  openSheet(sheetPay());
}

function sheetPay() {
  const total = cartTotal();
  const methods = enabledMethods();
  let extra = "";
  if (pay.method === "cash") {
    const rec = parseMoney(pay.received);
    const notes = [500, 1000, 2000, 5000, 10000].filter((v) => v >= total).slice(0, 3);
    const quick = [total, ...notes].slice(0, 4);
    let box = "";
    if (rec != null) {
      const diff = rec - total;
      box = diff >= 0
        ? `<div class="change-box ok"><span>${esc(t("pay.change"))}</span><b>${esc(money(diff))}</b></div>`
        : `<div class="change-box missing"><span>${esc(t("pay.missing"))}</span><b>${esc(money(-diff))}</b></div>`;
    }
    extra = `<div class="field"><label for="received">${esc(t("pay.received"))}</label>
      <input type="text" inputmode="decimal" id="received" value="${esc(pay.received)}" placeholder="0,00" autocomplete="off"></div>
      <div class="quick">${quick.map((v) => `<button type="button" data-act="quickCash" data-v="${v}">${esc(moneyShort(v))}</button>`).join("")}</div>
      <div id="changeBox">${box}</div>`;
  } else if (pay.method === "card") {
    extra = `<p class="notice">${esc(t("pay.cardHelp"))}</p>`;
  } else if (pay.method === "bizum") {
    extra = `<p class="notice">${esc(t("pay.bizumHelp"))}</p>`;
  }
  return `<h2 id="sheetTitle">${esc(t("pay.title"))}</h2>
    <div class="big-amount">${esc(money(total))}</div>
    <div class="methods" role="group">${methods.map((m) =>
      `<button type="button" data-act="payMethod" data-m="${m}" aria-pressed="${pay.method === m}">${esc(t(METHOD_KEY[m]))}</button>`).join("")}</div>
    ${extra}
    <div class="row"><button class="btn secondary grow" type="button" data-act="closeSheet">${esc(t("pay.cancel"))}</button>
    <button class="btn grow" type="button" data-act="confirmPay">${esc(t("pay.done"))}</button></div>`;
}

function updateChangeBox() {
  const box = $("#changeBox");
  if (!box) return;
  const rec = parseMoney(pay.received);
  const total = cartTotal();
  if (rec == null) { box.innerHTML = ""; return; }
  const diff = rec - total;
  box.innerHTML = diff >= 0
    ? `<div class="change-box ok"><span>${esc(t("pay.change"))}</span><b>${esc(money(diff))}</b></div>`
    : `<div class="change-box missing"><span>${esc(t("pay.missing"))}</span><b>${esc(money(-diff))}</b></div>`;
}

function confirmPay() {
  if (!guardWrite()) return;
  const lines = state.cart.map((l) => {
    const p = productById(l.pid);
    return { p: l.pid, izena: p ? p.izena : "?", talla: l.size, kop: l.qty, prezioa: p ? Number(p.prezioa) || 0 : 0 };
  });
  const total = lines.reduce((s, l) => s + l.prezioa * l.kop, 0);
  const sale = {
    at: Date.now(),
    kontzertua: state.settings.aktiboa || null,
    lerroak: lines,
    guztira: total,
    modua: pay.method,
    ezeztatua: false,
  };
  if (pay.method === "cash") {
    const rec = parseMoney(pay.received);
    if (rec != null) sale.jasotakoa = rec;
  }
  // Aviso si alguna talla se queda en negativo (el stock puede estar mal contado: no bloqueamos la venta).
  const warn = lines.find((l) => stockOf(l.p, l.talla) - l.kop < 0);
  Store.set(COL.sales, Store.newId(), sale);
  state.cart = [];
  closeSheet();
  toast(warn ? t("pay.stockWarn", { name: warn.izena, size: sizeLabel(warn.talla) }) : t("pay.saved", { total: money(total) }));
  render();
}

// ---------- Resumen ----------
function viewSummary() {
  const sel = state.summaryConcert ?? state.settings.aktiboa ?? "all";
  const concerts = [...state.concerts].sort((a, b) => String(b.data).localeCompare(String(a.data)));
  const options = [`<option value="all" ${sel === "all" ? "selected" : ""}>${esc(t("sum.all"))}</option>`]
    .concat(concerts.map((c) => `<option value="${esc(c.id)}" ${sel === c.id ? "selected" : ""}>${esc(c.izena)} · ${esc(fmtDate(c.data))}</option>`))
    .concat([`<option value="none" ${sel === "none" ? "selected" : ""}>${esc(t("sum.noConcert"))}</option>`]);

  const sales = state.sales
    .filter((s) => sel === "all" || (sel === "none" ? !s.kontzertua || !concertById(s.kontzertua) : s.kontzertua === sel))
    .sort((a, b) => b.at - a.at);
  const valid = sales.filter((s) => !s.ezeztatua);
  const total = valid.reduce((s, x) => s + (Number(x.guztira) || 0), 0);
  const units = valid.reduce((s, x) => s + (x.lerroak || []).reduce((u, l) => u + (Number(l.kop) || 0), 0), 0);
  const byMethod = Object.fromEntries(METHODS.map((m) => [m, 0]));
  valid.forEach((s) => { byMethod[s.modua] = (byMethod[s.modua] || 0) + (Number(s.guztira) || 0); });

  const top = new Map();
  valid.forEach((s) => (s.lerroak || []).forEach((l) => {
    const k = l.izena;
    top.set(k, (top.get(k) || 0) + (Number(l.kop) || 0));
  }));
  const topList = [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topMax = topList.length ? topList[0][1] : 1;

  let html = salesSwitch();
  html += `<div class="field"><label for="sumConcert">${esc(t("sum.concert"))}</label><select id="sumConcert">${options.join("")}</select></div>`;
  html += `<div class="kpis">
    <div class="kpi main"><small>${esc(t("sum.total"))}</small><b>${esc(money(total))}</b></div>
    <div class="kpi"><small>${esc(t("sum.count"))}</small><b>${valid.length}</b></div>
    <div class="kpi"><small>${esc(t("sum.units"))}</small><b>${units}</b></div>
  </div>`;
  html += `<section class="panel"><h3>${esc(t("sum.byMethod"))}</h3><div class="kpis">${METHODS.map((m) =>
    `<div class="kpi"><small>${esc(t(METHOD_KEY[m]))}</small><b>${esc(money(byMethod[m]))}</b></div>`).join("")}</div></section>`;

  // Comparar con SumUp (solo para un concierto concreto)
  if (sel !== "all" && sel !== "none") {
    const app = state.settings.sumup && state.settings.sumup[sel];
    let result = "";
    if (app != null) {
      const diff = app - byMethod.card;
      result = diff === 0 ? `<span class="pill">${esc(t("sum.sumupOk"))}</span>`
        : `<span class="pill bad">${esc(t("sum.sumupDiff", { diff: (diff > 0 ? "+" : "−") + money(Math.abs(diff)) }))}</span>`;
    }
    html += `<section class="panel"><h3>${esc(t("sum.sumupTitle"))}</h3>
      <p class="muted small">${esc(t("sum.sumupHelp"))}</p>
      <div class="row"><div class="field grow"><label for="sumupInput">${esc(t("sum.sumupApp"))}</label>
      <input type="text" inputmode="decimal" id="sumupInput" data-concert="${esc(sel)}" value="${app != null ? esc((app / 100).toFixed(2).replace(".", ",")) : ""}" placeholder="0,00"></div>
      <div>${result}</div></div></section>`;
  }

  if (topList.length) {
    html += `<section class="panel"><h3>${esc(t("sum.top"))}</h3><div class="list">${topList.map(([name, n]) =>
      `<div class="list-item"><span>${esc(name)}</span><span class="amount">${n}</span>
       <div class="bar" style="grid-column:1/-1"><i style="width:${Math.round((n / topMax) * 100)}%"></i></div></div>`).join("")}</div></section>`;
  }

  html += `<section class="panel"><h3>${esc(t("sum.list"))}</h3>`;
  if (!sales.length) html += `<p class="muted">${esc(t("sum.none"))}</p>`;
  else {
    html += `<div class="list">${sales.map((s) => {
      const items = (s.lerroak || []).map((l) => `${l.kop}× ${esc(l.izena)} (${esc(sizeLabel(l.talla))})`).join(", ");
      const tags = [
        `<span class="pill">${esc(t(METHOD_KEY[s.modua] || "pay.cash"))}</span>`,
        s.ezeztatua ? `<span class="pill bad">${esc(t("sum.cancelled"))}</span>` : "",
        s._pending ? `<span class="pill warn">${esc(t("sum.pending"))}</span>` : "",
      ].join(" ");
      const confirming = state.confirm === "sale:" + s.id;
      return `<div class="list-item ${s.ezeztatua ? "cancelled" : ""}">
        <div><div class="small muted">${esc(fmtDateTime(s.at))} ${tags}</div><div>${items}</div></div>
        <div class="amount">${esc(money(s.guztira))}
          ${s.ezeztatua ? "" : `<div><button class="btn small danger" type="button" data-act="askCancel" data-id="${esc(s.id)}">${esc(t("sum.cancel"))}</button></div>`}</div>
        ${confirming ? `<div class="confirm"><span>${esc(t("sum.cancelAsk"))}</span>
          <button class="btn small danger" type="button" data-act="doCancel" data-id="${esc(s.id)}">${esc(t("sum.cancelYes"))}</button>
          <button class="btn small secondary" type="button" data-act="noConfirm">${esc(t("common.cancel"))}</button></div>` : ""}
      </div>`;
    }).join("")}</div>`;
  }
  html += `</section>`;
  return html;
}

function cancelSale(id) {
  if (!guardWrite()) return;
  const s = state.sales.find((x) => x.id === id);
  if (!s || s.ezeztatua) return;
  // Si el stock se volvió a contar después de esta venta, devolvemos las prendas a mano.
  for (const l of s.lerroak || []) {
    const st = state.stock.get(l.p);
    const base = st && st.tallak && st.tallak[l.talla];
    if (base && Number(base.at) >= Number(s.at) && productById(l.p)) {
      setStock(l.p, l.talla, stockOf(l.p, l.talla) + (Number(l.kop) || 0));
      stockCache = null;
    }
  }
  Store.update(COL.sales, id, { ezeztatua: true, ezeztatuAt: Date.now() });
  state.confirm = null;
}

// ---------- Stock ----------
function viewStock() {
  const products = sortedProducts();
  let units = 0, value = 0, lowCount = 0;
  products.forEach((p) => (p.tallak || []).forEach((size) => {
    const n = Math.max(0, stockOf(p.id, size));
    units += n;
    value += n * (Number(p.prezioa) || 0);
    if (isLow(stockOf(p.id, size))) lowCount++;
  }));
  let html = `<h2>${esc(t("stock.title"))}</h2>
    <div class="kpis">
      <div class="kpi main"><small>${esc(t("stock.value"))}</small><b>${esc(money(value))}</b></div>
      <div class="kpi"><small>${esc(t("stock.units"))}</small><b>${units}</b></div>
      <div class="kpi"><small>${esc(t("stock.low"))}</small><b style="color:var(--warn)">${lowCount}</b></div>
    </div>`;
  if (!products.length) return html + `<div class="empty"><p>${esc(t("stock.none"))}</p>
    <button class="btn" type="button" data-act="go" data-tab="products">${esc(t("sell.goProducts"))}</button></div>`;
  html += `<label class="check"><input type="checkbox" id="onlyLow" ${state.onlyLow ? "checked" : ""}> ${esc(t("stock.onlyLow"))}</label>`;
  const items = products.map((p) => {
    const sizes = sortSizes(p.tallak || []).filter((s) => !state.onlyLow || isLow(stockOf(p.id, s)));
    if (!sizes.length) return "";
    return `<section class="panel stock-item">${photoHtml(p)}
      <div><div class="row spread"><b>${esc(p.izena)}</b><span class="muted small">${esc(moneyShort(p.prezioa))}</span></div>
      <div class="stock-sizes">${sizes.map((size) => {
        const n = stockOf(p.id, size);
        return `<div class="stock-size ${isLow(n) ? "low" : ""}"><b>${esc(sizeLabel(size))}</b>
          <span class="qty"><button type="button" data-act="stockStep" data-pid="${esc(p.id)}" data-size="${esc(size)}" data-d="-1" aria-label="−">−</button></span>
          <input type="number" inputmode="numeric" min="0" value="${n}" data-stock-pid="${esc(p.id)}" data-stock-size="${esc(size)}" aria-label="${esc(p.izena)} ${esc(sizeLabel(size))}">
          <span class="qty"><button type="button" data-act="stockStep" data-pid="${esc(p.id)}" data-size="${esc(size)}" data-d="1" aria-label="+">+</button></span>
        </div>`;
      }).join("")}</div></div></section>`;
  }).join("");
  html += items || `<p class="muted">${esc(t("stock.allGood"))}</p>`;
  return html;
}

// ---------- Productos ----------
function viewProducts() {
  const products = sortedProducts();
  let html = `<div class="row spread"><h2>${esc(t("prod.title"))}</h2>
    <button class="btn" type="button" data-act="newProduct">+ ${esc(t("prod.new"))}</button></div>`;
  if (!products.length) {
    return html + `<div class="empty"><p>${esc(t("prod.none"))}</p>
      <button class="btn" type="button" data-act="loadCatalog">${esc(t("set.catalog"))}</button>
      <p class="small">${esc(t("prod.importHint"))}</p>
      <button class="btn secondary" type="button" data-act="go" data-tab="settings">${esc(t("tab.settings"))}</button></div>`;
  }
  html += `<section class="panel"><div class="list">${products.map((p) => `
    <div class="prod-row">${photoHtml(p)}
      <div><b>${esc(p.izena)}</b><div class="small muted">${esc(moneyShort(p.prezioa))} · ${sortSizes(p.tallak || []).map((s) => esc(sizeLabel(s))).join(" · ")}</div></div>
      <button class="btn small secondary" type="button" data-act="editProduct" data-id="${esc(p.id)}">${esc(t("prod.edit").split(" ")[0])}</button>
    </div>`).join("")}</div></section>`;
  return html;
}

let editing = null; // copia del producto que se edita

function openProduct(id) {
  const p = id ? productById(id) : null;
  editing = p
    ? { id: p.id, izena: p.izena, prezioa: p.prezioa, tallak: [...(p.tallak || [])], argazkia: p.argazkia || null, ordena: p.ordena ?? 0, isNew: false, confirmDelete: false }
    : { id: Store.newId(), izena: "", prezioa: 1500, tallak: ["S", "M", "L", "XL"], argazkia: null, ordena: Date.now(), isNew: true, confirmDelete: false };
  openSheet(sheetProduct());
}

function sheetProduct() {
  const e = editing;
  const sizes = [...SIZE_ORDER, ...e.tallak.filter((s) => !SIZE_ORDER.includes(s))];
  const canPhoto = Store.canUploadPhotos();
  return `<h2 id="sheetTitle">${esc(e.isNew ? t("prod.new") : t("prod.edit"))}</h2>
    <div class="photo-edit">${photoHtml(e)}
      <div class="row">${canPhoto
        ? `<button class="btn small secondary" type="button" data-act="pickPhoto">${esc(t("prod.photoPick"))}</button>
           ${e.argazkia ? `<button class="btn small secondary" type="button" data-act="removePhoto">${esc(t("prod.photoRemove"))}</button>` : ""}`
        : `<span class="small muted">${esc(t("prod.photoNoPerm"))}</span>`}</div></div>
    <div class="field"><label for="pName">${esc(t("prod.name"))}</label><input type="text" id="pName" value="${esc(e.izena)}" autocomplete="off"></div>
    <div class="field"><label for="pPrice">${esc(t("prod.price"))}</label>
      <input type="text" inputmode="decimal" id="pPrice" value="${esc((e.prezioa / 100).toFixed(2).replace(".", ","))}"></div>
    <div class="field"><span class="label">${esc(t("prod.sizes"))}</span>
      <div class="size-picker">${sizes.map((s) =>
        `<button type="button" data-act="toggleSize" data-size="${esc(s)}" aria-pressed="${e.tallak.includes(s)}">${esc(sizeLabel(s))}</button>`).join("")}</div>
      <div class="row"><input type="text" id="pOtherSize" placeholder="${esc(t("prod.otherSize"))}" class="grow" style="flex:1 1 120px">
        <button class="btn small secondary" type="button" data-act="addSize">${esc(t("prod.add"))}</button></div></div>
    <div class="row"><button class="btn secondary grow" type="button" data-act="closeSheet">${esc(t("common.cancel"))}</button>
      <button class="btn grow" type="button" data-act="saveProduct">${esc(t("prod.save"))}</button></div>
    ${e.isNew ? "" : e.confirmDelete
      ? `<div class="confirm"><span>${esc(t("prod.deleteAsk"))}</span>
         <button class="btn small danger" type="button" data-act="deleteProduct">${esc(t("prod.deleteYes"))}</button>
         <button class="btn small secondary" type="button" data-act="noDelete">${esc(t("common.cancel"))}</button></div>`
      : `<button class="btn danger" type="button" data-act="askDelete">${esc(t("prod.delete"))}</button>`}`;
}

// Guarda lo que hay escrito en el formulario antes de repintarlo.
function readProductForm() {
  if (!editing) return;
  const n = $("#pName"), pr = $("#pPrice");
  if (n) editing.izena = n.value;
  if (pr) { const v = parseMoney(pr.value); if (v != null) editing.prezioa = v; }
}

function refreshProductSheet() {
  readProductForm();
  $("#sheetBody").innerHTML = sheetProduct();
}

function commitProduct() {
  if (!guardWrite()) return;
  readProductForm();
  const e = editing;
  const name = e.izena.trim();
  if (!name) { toast(t("prod.needName")); $("#pName")?.focus(); return; }
  if (!e.tallak.length) { toast(t("prod.needSize")); return; }
  // "Bakarra" no se mezcla con otras tallas.
  const tallak = e.tallak.includes(ONE_SIZE) && e.tallak.length > 1 ? e.tallak.filter((s) => s !== ONE_SIZE) : e.tallak;
  saveProduct({ id: e.id, izena: name, prezioa: e.prezioa, tallak: sortSizes(tallak), argazkia: e.argazkia || null, ordena: e.ordena });
  if (e.isNew) {
    Store.set(COL.stock, e.id, { tallak: Object.fromEntries(tallak.map((s) => [s, { n: 0, at: Date.now() }])) });
  }
  editing = null;
  closeSheet();
  toast(t("prod.saved"));
}

function deleteProduct() {
  if (!guardWrite() || !editing) return;
  Store.remove(COL.products, editing.id);
  Store.remove(COL.stock, editing.id);
  state.cart = state.cart.filter((l) => l.pid !== editing.id);
  editing = null;
  closeSheet();
  toast(t("prod.deleted"));
}

// ---------- Ajustes ----------
function viewSettings() {
  const s = state.settings;
  const concerts = [...state.concerts].sort((a, b) => String(b.data).localeCompare(String(a.data)));
  let html = `<h2>${esc(t("set.title"))}</h2>`;

  html += `<section class="panel"><h3>${esc(t("set.concerts"))}</h3>
    <p class="small muted">${esc(t("set.concertHelp"))}</p>
    <div class="row"><div class="field grow" style="flex:2 1 160px"><label for="cName">${esc(t("set.concertName"))}</label><input type="text" id="cName" autocomplete="off"></div>
    <div class="field grow" style="flex:1 1 130px"><label for="cDate">${esc(t("set.concertDate"))}</label><input type="date" id="cDate" value="${today()}"></div></div>
    <button class="btn" type="button" data-act="addConcert">${esc(t("set.concertAdd"))}</button>
    <div class="list">${concerts.length ? concerts.map((c) => {
      const active = c.id === s.aktiboa;
      const confirming = state.confirm === "concert:" + c.id;
      return `<div class="concert-row ${active ? "active" : ""}">
        <div><b>${esc(c.izena)}</b><div class="small muted">${esc(fmtDate(c.data))}</div></div>
        <div class="row">${active ? `<span class="pill">${esc(t("set.concertActive"))}</span>`
          : `<button class="btn small secondary" type="button" data-act="useConcert" data-id="${esc(c.id)}">${esc(t("set.concertUse"))}</button>`}
          <button class="btn small danger" type="button" data-act="askDelConcert" data-id="${esc(c.id)}" aria-label="${esc(t("set.concertDelete"))}">✕</button></div>
        ${confirming ? `<div class="confirm"><span>${esc(t("set.concertDeleteAsk"))}</span>
          <button class="btn small danger" type="button" data-act="delConcert" data-id="${esc(c.id)}">${esc(t("set.concertDelete"))}</button>
          <button class="btn small secondary" type="button" data-act="noConfirm">${esc(t("common.cancel"))}</button></div>` : ""}
      </div>`;
    }).join("") : `<p class="muted">${esc(t("set.concertNone"))}</p>`}</div></section>`;

  html += `<section class="panel"><h3>${esc(t("set.methods"))}</h3>${METHODS.map((m) =>
    `<label class="check"><input type="checkbox" data-method="${m}" ${s.moduak && s.moduak[m] === false ? "" : "checked"}> ${esc(t(METHOD_KEY[m]))}</label>`).join("")}
    <p class="small muted">${esc(t("pay.cardHelp"))}</p></section>`;

  html += `<section class="panel"><h3>${esc(t("set.lowStock"))}</h3>
    <div class="field"><label for="lowStock">${esc(t("set.lowStockHelp"))}</label>
    <input type="number" inputmode="numeric" min="0" id="lowStock" value="${esc(s.baxua)}" style="max-width:120px"></div></section>`;

  html += `<section class="panel"><h3>${esc(t("set.language"))}</h3>
    <div class="seg" role="group">
      <button type="button" data-act="lang" data-lang="eu" aria-pressed="${getLang() === "eu"}">Euskara</button>
      <button type="button" data-act="lang" data-lang="es" aria-pressed="${getLang() === "es"}">Castellano</button>
    </div></section>`;

  html += `<section class="panel"><h3>${esc(t("set.data"))}</h3>
    <div class="row"><button class="btn secondary" type="button" data-act="exportSales">${esc(t("set.exportSales"))}</button>
    <button class="btn secondary" type="button" data-act="exportStock">${esc(t("set.exportStock"))}</button></div>
    <button class="btn secondary" type="button" data-act="loadCatalog">${esc(t("set.catalog"))}</button>
    <button class="btn secondary" type="button" data-act="importCsv">${esc(t("set.import"))}</button>
    <p class="small muted">${esc(t("set.importHelp"))}</p></section>`;

  html += `<section class="panel"><h3>${esc(t("set.about"))}</h3>
    <p class="small muted">${esc(Store.mode === "local" ? t("set.aboutLocal") : t("set.aboutDb"))}</p>
    ${Store.mode === "sheets" ? `<button class="btn secondary" type="button" data-act="forgetPin">${esc(t("pin.forget"))}</button>` : ""}</section>`;
  return html;
}

// ---------- CSV (Excel) ----------
function csvCell(v) {
  const s = String(v ?? "");
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvMoney(cents) { return ((Number(cents) || 0) / 100).toFixed(2).replace(".", ","); }
function csv(rows) { return "﻿" + rows.map((r) => r.map(csvCell).join(";")).join("\r\n") + "\r\n"; }

function exportSales() {
  const rows = [["Data", "Ordua", "Kontzertua", "Produktua", "Talla", "Kopurua", "Prezioa", "Guztira", "Ordainketa", "Egoera"]];
  [...state.sales].sort((a, b) => a.at - b.at).forEach((s) => {
    const c = concertById(s.kontzertua);
    const d = new Date(s.at);
    const date = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    (s.lerroak || []).forEach((l) => rows.push([
      date, fmtTime(s.at), c ? c.izena : "", l.izena, sizeLabel(l.talla), l.kop, csvMoney(l.prezioa), csvMoney(l.prezioa * l.kop),
      t(METHOD_KEY[s.modua] || "pay.cash"), s.ezeztatua ? t("sum.cancelled") : "OK",
    ]));
  });
  Store.download("salmentak-" + today() + ".csv", csv(rows)).then(() => toast(t("set.exported"))).catch(() => {});
}

function exportStock() {
  const rows = [["Produktua", "Talla", "Unitateak", "Prezioa", "Balioa"]];
  sortedProducts().forEach((p) => sortSizes(p.tallak || []).forEach((size) => {
    const n = Math.max(0, stockOf(p.id, size));
    rows.push([p.izena, sizeLabel(size), n, csvMoney(p.prezioa), csvMoney(n * p.prezioa)]);
  }));
  Store.download("stocka-" + today() + ".csv", csv(rows)).then(() => toast(t("set.exported"))).catch(() => {});
}

function parseCsv(text) {
  text = text.replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/)[0] || "";
  const sep = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ";" : ",";
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

function importCsv(text) {
  if (!guardWrite()) return;
  const rows = parseCsv(text);
  if (rows.length < 2) { toast(t("set.importNone")); return; }
  const head = rows[0].map((h) => h.toLowerCase());
  const find = (re) => head.findIndex((h) => re.test(h));
  const iName = find(/produc|produk|izena|nombre|name/);
  const iPrice = find(/preci|prezio|price/);
  const iSizes = find(/talla|size/);
  const iUnits = find(/unidad|unitate|kopuru|stock|units/);
  const iPhoto = find(/argazki|foto|photo/);
  if (iName < 0) { toast(t("set.importNone")); return; }

  const byName = new Map(state.products.map((p) => [String(p.izena).trim().toLowerCase(), p]));
  const existing = new Set(byName.keys());
  let order = Date.now();
  let count = 0;
  let photos = 0;
  for (const r of rows.slice(1)) {
    const name = String(r[iName] || "").replace(/\s*\(añadida por .*?\)\s*$/i, "").trim();
    if (!name) continue;
    // Foto: nombre de un archivo de img/produktuak/ (las fotos que vienen con la app)
    const photo = iPhoto >= 0 ? String(r[iPhoto] || "").trim() : "";
    const argazkia = /^[\w.-]+\.(jpe?g|png|webp)$/i.test(photo) ? "img/produktuak/" + photo : null;
    if (existing.has(name.toLowerCase())) {
      // Ya existe: no se duplica, pero si no tiene foto se le pone la de la lista.
      const p = byName.get(name.toLowerCase());
      if (p && !p.argazkia && argazkia) { saveProduct({ ...p, argazkia }); photos++; }
      continue;
    }
    const price = iPrice >= 0 ? parseMoney(r[iPrice]) ?? 0 : 0;
    let sizes = iSizes >= 0 ? String(r[iSizes] || "").split(/[,/·|]+/).map((s) => s.trim()).filter(Boolean) : [];
    sizes = sizes.map((s) => (/^(bakarra|única|unica|one size|tu)$/i.test(s) ? ONE_SIZE : s.toUpperCase()));
    if (!sizes.length) sizes = [ONE_SIZE];
    // Unidades: "0", "12" (una sola talla) o "S 10 · M 10 · L 2"
    const units = {};
    const raw = iUnits >= 0 ? String(r[iUnits] || "").trim() : "";
    if (/^\d+$/.test(raw) && sizes.length === 1) units[sizes[0]] = Number(raw);
    else raw.split(/[·,;|]+/).forEach((part) => {
      const m = part.trim().match(/^(\S+)\s*[:=]?\s*(\d+)$/);
      if (m) units[m[1].toUpperCase() === "BAKARRA" ? ONE_SIZE : m[1].toUpperCase()] = Number(m[2]);
    });
    const id = Store.newId();
    const now = Date.now();
    saveProduct({ id, izena: name, prezioa: price, tallak: sortSizes([...new Set(sizes)]), argazkia, ordena: order++ });
    Store.set(COL.stock, id, { tallak: Object.fromEntries(sizes.map((s) => [s, { n: units[s] || 0, at: now }])) });
    existing.add(name.toLowerCase());
    count++;
  }
  if (count) toast(t("set.imported", { n: count }));
  else if (photos) toast(t("set.photosAdded", { n: photos }));
  else toast(t("set.importNone"));
}

// Lista de productos del grupo que viene con la app (app/produktuak.csv), con sus fotos.
async function loadCatalog() {
  if (!guardWrite()) return;
  try {
    const res = await fetch("produktuak.csv", { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    importCsv(await res.text());
  } catch (err) {
    toast(t("set.catalogError"));
  }
}

// ---------- Hoja inferior ----------
function openSheet(html) {
  $("#sheetBody").innerHTML = html;
  $("#sheet").hidden = false;
  document.body.style.overflow = "hidden";
}
function closeSheet() {
  $("#sheet").hidden = true;
  $("#sheetBody").innerHTML = "";
  document.body.style.overflow = "";
  editing = null;
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------
document.addEventListener("click", (ev) => {
  if (ev.target.id === "sheet") { closeSheet(); return; }
  const el = ev.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  const d = el.dataset;

  switch (act) {
    case "go":
      state.tab = d.tab;
      state.confirm = null;
      window.scrollTo(0, 0);
      render();
      break;
    case "salesView":
      state.salesView = d.view;
      state.confirm = null;
      render();
      break;

    // vender
    case "add": {
      const line = state.cart.find((l) => l.pid === d.pid && l.size === d.size);
      if (line) line.qty++;
      else state.cart.push({ pid: d.pid, size: d.size, qty: 1 });
      try { if (navigator.userActivation?.hasBeenActive && navigator.vibrate) navigator.vibrate(10); } catch { /* sin vibración */ }
      render();
      break;
    }
    case "qty": {
      const line = state.cart[Number(d.i)];
      if (!line) break;
      line.qty += Number(d.d);
      if (line.qty <= 0) state.cart.splice(Number(d.i), 1);
      render();
      break;
    }
    case "clearCart":
      state.cart = [];
      render();
      break;
    case "openPay": openPay(); break;
    case "payMethod":
      pay.method = d.m;
      $("#sheetBody").innerHTML = sheetPay();
      break;
    case "quickCash":
      pay.received = (Number(d.v) / 100).toFixed(2).replace(".", ",");
      $("#sheetBody").innerHTML = sheetPay();
      break;
    case "confirmPay": confirmPay(); break;
    case "closeSheet": closeSheet(); break;

    // resumen
    case "askCancel": state.confirm = "sale:" + d.id; render(); break;
    case "doCancel": cancelSale(d.id); render(); break;
    case "noConfirm": state.confirm = null; render(); break;

    // stock
    case "stockStep": {
      if (!guardWrite()) break;
      setStock(d.pid, d.size, Math.max(0, stockOf(d.pid, d.size) + Number(d.d)));
      break;
    }

    // productos
    case "newProduct": openProduct(null); break;
    case "editProduct": openProduct(d.id); break;
    case "toggleSize": {
      readProductForm();
      const s = d.size;
      if (editing.tallak.includes(s)) editing.tallak = editing.tallak.filter((x) => x !== s);
      else editing.tallak = s === ONE_SIZE ? [ONE_SIZE] : [...editing.tallak.filter((x) => x !== ONE_SIZE), s];
      refreshProductSheet();
      break;
    }
    case "addSize": {
      const input = $("#pOtherSize");
      const s = input && input.value.trim().toUpperCase();
      if (s && !editing.tallak.includes(s)) editing.tallak = [...editing.tallak.filter((x) => x !== ONE_SIZE), s];
      refreshProductSheet();
      break;
    }
    case "pickPhoto": readProductForm(); $("#photoInput").click(); break;
    case "removePhoto": editing.argazkia = null; refreshProductSheet(); break;
    case "saveProduct": commitProduct(); break;
    case "askDelete": editing.confirmDelete = true; refreshProductSheet(); break;
    case "noDelete": editing.confirmDelete = false; refreshProductSheet(); break;
    case "deleteProduct": deleteProduct(); break;

    // ajustes
    case "addConcert": {
      if (!guardWrite()) break;
      const name = $("#cName").value.trim();
      if (!name) { $("#cName").focus(); break; }
      const id = Store.newId();
      Store.set(COL.concerts, id, { izena: name, data: $("#cDate").value || today() });
      saveSettings({ aktiboa: id });
      $("#cName").value = "";
      $("#cName").blur();
      render();
      break;
    }
    case "useConcert":
      if (!guardWrite()) break;
      saveSettings({ aktiboa: d.id });
      render();
      break;
    case "askDelConcert": state.confirm = "concert:" + d.id; render(); break;
    case "delConcert":
      if (!guardWrite()) break;
      Store.remove(COL.concerts, d.id);
      if (state.settings.aktiboa === d.id) saveSettings({ aktiboa: null });
      state.confirm = null;
      render();
      break;
    case "lang":
      setLang(d.lang);
      render();
      break;
    case "exportSales": exportSales(); break;
    case "exportStock": exportStock(); break;
    case "importCsv": $("#csvInput").click(); break;
    case "loadCatalog": loadCatalog(); break;
    case "forgetPin": Store.forgetPin(); break;
  }
});

document.addEventListener("input", (ev) => {
  const el = ev.target;
  if (el.id === "search") {
    state.search = el.value;
    stockCache = null;
    $("#sellGrid").innerHTML = sellCards();
  } else if (el.id === "received") {
    pay.received = el.value;
    updateChangeBox();
  }
});

document.addEventListener("change", (ev) => {
  const el = ev.target;
  if (el.dataset.stockPid) {
    if (!guardWrite()) return;
    const v = Math.max(0, Math.round(Number(el.value) || 0));
    if (v !== stockOf(el.dataset.stockPid, el.dataset.stockSize)) setStock(el.dataset.stockPid, el.dataset.stockSize, v);
  } else if (el.id === "onlyLow") {
    state.onlyLow = el.checked;
    el.blur();
    render();
  } else if (el.id === "sumConcert") {
    state.summaryConcert = el.value;
    state.confirm = null;
    el.blur();
    render();
  } else if (el.id === "sumupInput") {
    if (!guardWrite()) return;
    const v = parseMoney(el.value);
    const sumup = { ...(state.settings.sumup || {}) };
    if (v == null) delete sumup[el.dataset.concert]; else sumup[el.dataset.concert] = v;
    saveSettings({ sumup });
    el.blur();
    render();
  } else if (el.dataset.method) {
    if (!guardWrite()) return;
    saveSettings({ moduak: { ...state.settings.moduak, [el.dataset.method]: el.checked } });
    el.blur();
    render();
  } else if (el.id === "lowStock") {
    if (!guardWrite()) return;
    saveSettings({ baxua: Math.max(0, Math.round(Number(el.value) || 0)) });
    el.blur();
    render();
  } else if (el.id === "photoInput") {
    const file = el.files && el.files[0];
    el.value = "";
    if (!file || !editing) return;
    const target = editing;
    toast(t("prod.uploading"));
    Store.uploadPhoto(file)
      .then((ref) => { target.argazkia = ref; if (editing === target) refreshProductSheet(); })
      .catch((e) => { console.warn(e); toast(t("prod.photoError")); });
  } else if (el.id === "csvInput") {
    const file = el.files && el.files[0];
    el.value = "";
    if (!file) return;
    file.text().then(importCsv).catch(() => toast(t("common.error")));
  }
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !$("#sheet").hidden) closeSheet();
  if (ev.key === "Enter" && ev.target.id === "cName") { ev.preventDefault(); $('[data-act="addConcert"]').click(); }
});

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
(async function start() {
  setLang(getLang());
  renderChrome();
  $("#main").innerHTML = `<p class="muted">${esc(t("sync.loading"))}</p>`;
  await Store.init();
  Store.onStatus(() => renderChrome());

  Store.watch(COL.products, (docs) => { state.products = docs; render(); });
  Store.watch(COL.stock, (docs) => { state.stock = new Map(docs.map((d) => [d.id, d])); render(); });
  Store.watch(COL.sales, (docs) => { state.sales = docs; render(); });
  Store.watch(COL.concerts, (docs) => { state.concerts = docs; render(); });
  Store.watch(COL.settings, (docs) => {
    const s = docs.find((d) => d.id === SETTINGS_ID);
    state.settings = { ...DEFAULT_SETTINGS, ...(s || {}), moduak: { ...DEFAULT_SETTINGS.moduak, ...((s && s.moduak) || {}) } };
    delete state.settings.id;
    delete state.settings._pending;
    render();
  });
  render();
})();
