import { createHash } from "node:crypto";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";
import { assetList } from "./src/offline/assetList.ts";
import { buildServiceWorker } from "./src/offline/swSource.ts";

// Published under https://manshw-pixel.github.io/vendor-app/ , so assets must use an
// absolute base matching that subpath -- a bare "/assets/..." (base: "/") would 404,
// but "./" breaks BrowserRouter's basename (it normalises to "/./", which no real
// pathname starts with, so the router renders nothing at every URL).
const BASE = "/vendor-app/";

/** Generates sw.js at build time with the precache file list and a version hash baked
 *  into its source. The service worker's bytes must change whenever the asset list
 *  changes -- a static sw.js identical across deploys is never treated as "new" by the
 *  browser, so it would never re-install, never prompt for an update, and never clean up
 *  a stale cache. */
function precache(): Plugin {
  return {
    name: "precache-manifest",
    apply: "build",
    generateBundle(_opts, bundle) {
      const files = assetList(Object.keys(bundle), BASE);
      const version = createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 12);
      this.emitFile({ type: "asset", fileName: "sw.js", source: buildServiceWorker(version, files) });
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
