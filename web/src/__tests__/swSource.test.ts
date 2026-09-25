import { describe, it, expect } from "vitest";
import { buildServiceWorker } from "../offline/swSource";

describe("buildServiceWorker", () => {
  it("bakes the version and every file into the generated source", () => {
    const src = buildServiceWorker("abc123", ["/vendor-app/", "/vendor-app/index.html", "/vendor-app/assets/a-1.css"]);
    expect(src).toContain("abc123");
    expect(src).toContain("/vendor-app/");
    expect(src).toContain("/vendor-app/index.html");
    expect(src).toContain("/vendor-app/assets/a-1.css");
  });

  it("produces a different source for a different file list, so the browser re-installs it", () => {
    const a = buildServiceWorker("v1", ["/vendor-app/", "/vendor-app/index.html"]);
    const b = buildServiceWorker("v1", ["/vendor-app/", "/vendor-app/index.html", "/vendor-app/assets/new.js"]);
    expect(a).not.toBe(b);
  });

  it("produces a different source for a different version with the same files", () => {
    const files = ["/vendor-app/", "/vendor-app/index.html"];
    expect(buildServiceWorker("v1", files)).not.toBe(buildServiceWorker("v2", files));
  });
});

describe("asset caching", () => {
  it("only stores an asset response that came back ok", () => {
    const src = buildServiceWorker("v1", []);
    expect(src).toMatch(/if \(res\.ok\) await cache\.put\(req, res\.clone\(\)\)/);
  });
});
