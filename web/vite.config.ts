import { createHash } from "node:crypto";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";
import { assetList } from "./src/offline/assetList.ts";

// Published under https://manshw-pixel.github.io/vendor-app/ , so assets must use an
// absolute base matching that subpath -- a bare "/assets/..." (base: "/") would 404,
// but "./" breaks BrowserRouter's basename (it normalises to "/./", which no real
// pathname starts with, so the router renders nothing at every URL).
const BASE = "/vendor-app/";

/** Emits precache.json listing every file the service worker should cache for offline
 *  install, plus a version hash so the worker knows when to replace its cache. */
function precache(): Plugin {
  return {
    name: "precache-manifest",
    apply: "build",
    generateBundle(_opts, bundle) {
      const files = assetList(Object.keys(bundle), BASE);
      const version = createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 12);
      this.emitFile({ type: "asset", fileName: "precache.json", source: JSON.stringify({ version, files }) });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), precache()],
  base: BASE,
  test: {
    environment: "jsdom",
    globals: true,
  },
});
