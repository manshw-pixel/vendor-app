import { describe, it, expect } from "vitest";
import { assetList } from "../offline/assetList";
describe("assetList", () => {
  it("keeps the shell and hashed assets under the base, nothing else", () => {
    expect(assetList(["assets/b-2.js", "index.html", "assets/a-1.css", "sw.js", "assets/b-2.js"], "/vendor-app/"))
      .toEqual(["/vendor-app/", "/vendor-app/index.html", "/vendor-app/assets/a-1.css", "/vendor-app/assets/b-2.js"]);
  });
});
