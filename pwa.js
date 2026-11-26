// Fuera de Claude, la app se puede añadir a la pantalla de inicio y abrir sin cobertura.
"use strict";
(function () {
  const insideClaude = !!(window.claude && typeof window.claude.use === "function");
  const secure = location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (insideClaude || !secure || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("Sin modo sin conexión:", e));
  });
})();
