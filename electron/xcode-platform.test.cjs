const assert = require("node:assert/strict");
const test = require("node:test");
const { appleDesignKitForMacOs, detectSchemePlatform, platformBuildArguments } = require("./xcode-platform.cjs");

const destinations = (lines) => async () => `\tAvailable destinations for the "App" scheme:\n${lines.join("\n")}\n`;

test("keeps a scheme that can run on the Simulator on the Simulator", async () => {
  const platform = await detectSchemePlatform(destinations([
    "\t\t{ platform:macOS, arch:arm64, id:00000000-0000-0000-0000-000000000000 }",
    "\t\t{ platform:iOS Simulator, arch:arm64, id:1E22, OS:26.5, name:iPhone 17 Pro }"
  ]), { projectPath: "/tmp/App.xcodeproj", scheme: "App" });
  assert.equal(platform, "ios");
});

test("takes a Mac-only scheme to this Mac", async () => {
  const platform = await detectSchemePlatform(destinations([
    "\t\t{ platform:macOS, arch:arm64, id:00000000-0000-0000-0000-000000000000, name:My Mac }"
  ]), { projectPath: "/tmp/App.xcodeproj", scheme: "App" });
  assert.equal(platform, "macos");
});

test("falls back to the Simulator when Xcode cannot say", async () => {
  const platform = await detectSchemePlatform(async () => { throw new Error("xcodebuild exploded"); }, {
    projectPath: "/tmp/App.xcodeproj",
    scheme: "App"
  });
  assert.equal(platform, "ios");
});

test("signs a Mac build to run locally and leaves the sandbox off", () => {
  const mac = platformBuildArguments("macos");
  assert.deepEqual(mac.destination, ["-destination", "platform=macOS"]);
  assert.equal(mac.productsDirectory, "Debug");
  assert.ok(mac.settings.includes("CODE_SIGN_IDENTITY=-"), "an unsigned binary is killed on Apple silicon");
  assert.ok(mac.settings.includes("ENABLE_APP_SANDBOX=NO"), "the sandbox would block the runtime bridge");

  const ios = platformBuildArguments("ios");
  assert.deepEqual(ios.destination, ["-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator"]);
  assert.equal(ios.productsDirectory, "Debug-iphonesimulator");
});

test("names the design kit after the running system", () => {
  assert.deepEqual(appleDesignKitForMacOs("26.6.1"), { designKit: "macOS 26", appearance: "liquid-glass" });
  assert.deepEqual(appleDesignKitForMacOs("14.2"), { designKit: "macOS 14", appearance: "classic" });
  assert.equal(appleDesignKitForMacOs(""), null);
});
