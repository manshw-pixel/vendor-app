import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Published under https://manshw-pixel.github.io/vendor-app/ , so assets must be
  // referenced relatively -- an absolute /assets/... would 404 on Pages.
  base: "./",
  test: {
    environment: "jsdom",
    globals: true,
  },
});
