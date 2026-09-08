import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Published under https://manshw-pixel.github.io/vendor-app/ , so assets must use an
  // absolute base matching that subpath -- a bare "/assets/..." (base: "/") would 404,
  // but "./" breaks BrowserRouter's basename (it normalises to "/./", which no real
  // pathname starts with, so the router renders nothing at every URL).
  base: "/vendor-app/",
  test: {
    environment: "jsdom",
    globals: true,
  },
});
