// Permite abrir la app sin cobertura: guarda una copia de sus archivos.
// Las ventas no pasan por aquí (van a la hoja de Google y, sin conexión, esperan en la cola de store.js).
const CACHE = "bl-merch-e60628a";
const FILES = [
  "./", "index.html", "styles.css", "config.js", "i18n.js", "store.js", "app.js", "pwa.js",
  "manifest.webmanifest", "img/logo-10.png", "img/logo-cabecera.png",
  "img/icon-192.png", "img/icon-512.png", "img/apple-touch-icon.png", "produktuak.csv",
  ...["bisera", "camiseta-away-beltza", "camiseta-away-txuria", "cd-amets-bati-lotuta", "cd-bide-baten-esanahia",
    "kamiseta-acab-beltza", "kamiseta-acab-txuria", "sudadera-beltza", "sudadera-grisa", "tote-bag", "txapela",
    "vinilo-bide-baten-esanahia"].map((f) => "img/produktuak/" + f + ".jpg"),
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Primero internet (para tener siempre la última versión); si no hay, la copia guardada.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isFont = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (!sameOrigin && !isFont) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok || res.type === "opaque") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("index.html"))),
  );
});
