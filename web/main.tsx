import React from "react";
import ReactDOM from "react-dom/client";
import WebApp from "./WebApp";
// Import for side effect: googleConfig calls setGoogleClientId() with the
// configured CLIENT_ID (from .env or the hardcoded fallback). Because other
// modules read the id from the shared drive layer, this must run at startup.
import "./googleConfig";

// Register the service worker so the app can be installed (PWA) and opened
// offline from a secure origin (HTTPS, e.g. GitHub Pages). The LAN server
// (plain http://) can't register a service worker — browsers require HTTPS —
// so this is a no-op there, which is fine.
if ("serviceWorker" in navigator) {
  const host = window.location.hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {
        /* non-secure origin or unsupported — offline install not available */
      });
    });
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WebApp />
  </React.StrictMode>
);
