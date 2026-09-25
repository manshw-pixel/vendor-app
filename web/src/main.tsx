import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
// Must come before the first render: i18next initialises as a side effect of this
// import, and without it every t() call returns a raw key like "nav.bill" on first paint.
import "./i18n";
import "./index.css";
import { setUpdateReady } from "./offline/updateReady";

const el = document.getElementById("root");
if (!el) throw new Error("no #root element");
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register(import.meta.env.BASE_URL + "sw.js").then((reg) => {
    // A worker can finish installing (and sit waiting) before this page ever registers --
    // e.g. another tab triggered the install. Check for that case immediately rather than
    // only reacting to future updatefound events.
    if (reg.waiting && navigator.serviceWorker.controller) {
      setUpdateReady(reg);
    }
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      w?.addEventListener("statechange", () => {
        if (w.state === "installed" && navigator.serviceWorker.controller) {
          setUpdateReady(reg);
        }
      });
    });
  });
}
