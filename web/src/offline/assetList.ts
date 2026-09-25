/** What the service worker precaches: the page and every hashed asset. Pure so the build
 *  plugin and its test agree on one definition. */
export function assetList(fileNames: string[], base: string): string[] {
  const assets = [...new Set(fileNames.filter((f) => f.startsWith("assets/")))].sort();
  return [base, `${base}index.html`, ...assets.map((f) => base + f)];
}
