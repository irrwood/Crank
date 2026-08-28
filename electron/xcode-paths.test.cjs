const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { mkdtemp, mkdir, writeFile } = require("node:fs/promises");
const { requireXcodePaths, resetXcodePathCache, resolveXcodePaths } = require("./xcode-paths.cjs");

async function fakeDeveloperDirectory({ complete = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ui-sync-xcode-"));
  const developer = path.join(root, "Xcode-beta.app", "Contents", "Developer");
  const toolchain = path.join(developer, "Toolchains", "XcodeDefault.xctoolchain", "usr", "bin");
  await mkdir(path.join(developer, "usr", "bin"), { recursive: true });
  await mkdir(toolchain, { recursive: true });
  await mkdir(path.join(developer, "Platforms", "MacOSX.platform", "Developer", "SDKs", "MacOSX.sdk"), { recursive: true });
  await writeFile(path.join(developer, "usr", "bin", "xcodebuild"), "", { mode: 0o755 });
  await writeFile(path.join(toolchain, "swiftc"), "", { mode: 0o755 });
  if (complete) await writeFile(path.join(developer, "usr", "bin", "simctl"), "", { mode: 0o755 });
  return developer;
}

test("resolves a relocated Xcode from DEVELOPER_DIR", async () => {
  const developer = await fakeDeveloperDirectory();
  const previous = process.env.DEVELOPER_DIR;
  process.env.DEVELOPER_DIR = developer;
  resetXcodePathCache();
  try {
    const paths = await resolveXcodePaths();
    assert.equal(paths.developerDirectory, developer);
    assert.equal(paths.xcodebuild, path.join(developer, "usr", "bin", "xcodebuild"));
    assert.equal(paths.simctl, path.join(developer, "usr", "bin", "simctl"));
    assert.equal(paths.swiftc, path.join(developer, "Toolchains", "XcodeDefault.xctoolchain", "usr", "bin", "swiftc"));
    assert.equal(paths.macosSdk, path.join(developer, "Platforms", "MacOSX.platform", "Developer", "SDKs", "MacOSX.sdk"));
  } finally {
    if (previous === undefined) delete process.env.DEVELOPER_DIR;
    else process.env.DEVELOPER_DIR = previous;
    resetXcodePathCache();
  }
});

test("rejects a Command Line Tools directory that cannot drive the Simulator", async () => {
  const developer = await fakeDeveloperDirectory({ complete: false });
  const previous = process.env.DEVELOPER_DIR;
  process.env.DEVELOPER_DIR = developer;
  resetXcodePathCache();
  try {
    const paths = await resolveXcodePaths();
    // Falls through to xcode-select or the default install, never to the
    // incomplete directory it was pointed at.
    assert.notEqual(paths?.developerDirectory, developer);
    if (!paths) await assert.rejects(requireXcodePaths("Install the full Xcode app"), /Install the full Xcode app/);
  } finally {
    if (previous === undefined) delete process.env.DEVELOPER_DIR;
    else process.env.DEVELOPER_DIR = previous;
    resetXcodePathCache();
  }
});
