import React from "react";
import ReactDOM from "react-dom/client";
import WebApp from "./WebApp";

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
