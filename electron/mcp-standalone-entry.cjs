#!/usr/bin/env node

const path = require("node:path");
const { startCrankMcpServer } = require("./mcp-server.cjs");
const {
  createStandaloneMcpOperations,
  createWidgetHtmlLoader,
  defaultCrankUserDataDirectory
} = require("./mcp-standalone.cjs");
const { bundledRuntimeArchive, createBundledRuntimeConnector } = require("./mcp-runtime-client.cjs");
const { carryUserData } = require("./user-data-migration.cjs");

/**
 * The installed Codex plugin starts here with plain Node, not Electron.
 *
 * A saved flow is a local data read and an MCP Apps resource. Keeping those
 * behind an Electron lifecycle meant closing or crashing an optional window
 * also closed Codex's transport. Capture-only operations still discover the
 * authenticated runtime lazily through mcp-standalone.cjs.
 */

async function main() {
  const dataDirectory = defaultCrankUserDataDirectory();
  if (process.platform === "darwin") {
    await carryUserData(
      path.join(path.dirname(dataDirectory), "UI Sync"),
      dataDirectory
    );
  }
  const widgetPath = process.env.CRANK_WIDGET_PATH
    ? path.resolve(process.env.CRANK_WIDGET_PATH)
    : path.join(__dirname, "..", "resources", "flow-widget.html");
  // A missing or unreadable canvas file used to reject out of main(), which
  // only set an exit code: Codex saw the process leave and reported
  // `Transport closed`, hiding the real cause behind a transport error. Start
  // anyway, so every tool that does not need the canvas still works and the
  // failed read explains itself through MCP.
  const loadWidgetHtml = await createWidgetHtmlLoader(widgetPath).catch((error) => {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Crank could not read its canvas resource: ${reason}\n`);
    return async () => {
      throw new Error("Crank's canvas resource is missing from the installed plugin. Reinstall the Crank plugin.");
    };
  });
  const pluginRoot = path.join(__dirname, "..");
  const runtime = createBundledRuntimeConnector({
    ...(process.env.CRANK_CAPTURE_RUNTIME_EXECUTABLE
      ? { executable: path.resolve(process.env.CRANK_CAPTURE_RUNTIME_EXECUTABLE) }
      : { archive: bundledRuntimeArchive(pluginRoot) }),
    dataDirectory
  });
  process.once("exit", runtime.terminate);
  process.stdin.once("end", () => { void runtime.stop(); });
  await startCrankMcpServer(createStandaloneMcpOperations({
    dataDirectory,
    connectRuntime: () => runtime.connect()
  }), {
    loadWidgetHtml,
    // The standalone plugin opens its canvas through render_flow_canvas. If it
    // advertises the similarly named desktop action, agents can choose that
    // shortcut and relaunch Electron even when the user asked for the embedded
    // experience.
    includeDesktopWindowTool: false
  });
}

main().catch((error) => {
  process.stderr.write(`Crank MCP could not start: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
