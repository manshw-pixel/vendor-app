import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
// Must come before the first render: i18next initialises as a side effect of this
// import, and without it every t() call returns a raw key like "nav.bill" on first paint.
import "./i18n";
import "./index.css";

const el = document.getElementById("root");
if (!el) throw new Error("no #root element");
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register(import.meta.env.BASE_URL + "sw.js").then((reg) => {
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      w?.addEventListener("statechange", () => {
        if (w.state === "installed" && navigator.serviceWorker.controller) {
          window.dispatchEvent(new CustomEvent("app-update-ready", { detail: reg }));
        }
      });
    });
  });
}
