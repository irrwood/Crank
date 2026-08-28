/**
 * Which platform a scheme can actually be run on.
 *
 * An Xcode project is not one kind of project: the same scheme may build for
 * the Simulator, for this Mac, or for both. Everything after this point differs
 * by that answer — the SDK, where the product lands, how it is launched, and
 * what a screenshot is — so it is asked once, of Xcode, rather than guessed
 * from the project file.
 */

const IOS_DESTINATION = /platform:\s*iOS Simulator/i;
const MAC_DESTINATION = /platform:\s*macOS/i;

/**
 * Reads the destinations Xcode offers for a scheme.
 *
 * A scheme that can run on both stays on the Simulator: a phone screen is what
 * the export was built around, and a project that also builds for the Mac has
 * not asked to be captured as a desktop app.
 */
async function detectSchemePlatform(run, { projectPath, scheme, env } = {}) {
  const output = await run(["-project", projectPath, "-scheme", scheme, "-showdestinations"], { env })
    .catch(() => "");
  if (IOS_DESTINATION.test(output)) return "ios";
  if (MAC_DESTINATION.test(output)) return "macos";
  // Xcode answering with neither is not the same as answering "macOS". The
  // Simulator is what every earlier export used, so that is what an unreadable
  // answer falls back to, failing later with a build error that says why.
  return "ios";
}

/**
 * The build settings that put a scheme on one platform or the other.
 *
 * A Mac build is signed to run locally — an unsigned binary is killed on sight
 * on Apple silicon — and it drops the App Sandbox, or the app could not reach
 * the local runtime bridge that the whole capture is carried over.
 */
function platformBuildArguments(platform) {
  return platform === "macos"
    ? {
      destination: ["-destination", "platform=macOS"],
      settings: ["CODE_SIGN_IDENTITY=-", "CODE_SIGN_ENTITLEMENTS=", "ENABLE_APP_SANDBOX=NO"],
      productsDirectory: "Debug"
    }
    : {
      // Xcode may reject a slightly older installed runtime as a destination
      // (for example SDK 26.5 with Runtime 26.4.1). Selecting the simulator SDK
      // directly builds the same deployment-compatible app without that check.
      destination: ["-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator"],
      settings: ["CODE_SIGNING_ALLOWED=NO"],
      productsDirectory: "Debug-iphonesimulator"
    };
}

/** What the Figma side calls the system a Mac capture was taken on. */
function appleDesignKitForMacOs(productVersion) {
  const majorVersion = Number(String(productVersion || "").split(".")[0]);
  if (!Number.isInteger(majorVersion) || majorVersion < 1) return null;
  return {
    designKit: `macOS ${majorVersion}`,
    appearance: majorVersion >= 26 ? "liquid-glass" : "classic"
  };
}

module.exports = { appleDesignKitForMacOs, detectSchemePlatform, platformBuildArguments };
