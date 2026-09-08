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
