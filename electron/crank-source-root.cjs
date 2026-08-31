const { access, readFile } = require("node:fs/promises");
const path = require("node:path");

/**
 * Recognises Crank's source checkout when capture runs from the plugin's
 * packaged Runtime. In that process app.getAppPath() points at the temporary
 * packaged runtime, not at the checkout the user selected, so equality with
 * the app path made Crank scan itself as an ordinary Vite site. That copy has
 * no preload bridge and can only draw the empty "Add a project" state.
 */
async function isCrankSourceRoot(root) {
  try {
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    if (packageJson.name !== "crank-desktop"
      || packageJson.productName !== "Crank"
      || packageJson.main !== "electron/main.cjs") return false;
    await Promise.all([
      access(path.join(root, "electron", "self-scan-preload.cjs")),
      access(path.join(root, "src", "PageInventoryView.tsx")),
      access(path.join(root, "dist", "index.html"))
    ]);
    return true;
  } catch {
    return false;
  }
}

module.exports = { isCrankSourceRoot };
