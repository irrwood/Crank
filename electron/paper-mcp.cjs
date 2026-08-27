const { paperScreens } = require("./paper-export.cjs");
const { version } = require("../package.json");

/**
 * Pushes captured screens into the Paper file the person has open.
 *
 * Paper Desktop runs an MCP server of its own on a fixed local port while a
 * file is open, so this is the shortest of the three ways out of a scan: no
 * plugin to install and no pairing, unlike the Figma bridge, and no paste, so
 * a scan of thirty screens is one action rather than thirty. Crank is the
 * client here — the only place in the app that is, everything else about MCP
 * in this repo is Crank being a server for coding agents.
 *
 * Screens are matched to artboards by name, which is the only identity that
 * survives the trip: `write_html` parses markup into design nodes and keeps
 * none of its attributes, so the id written into a pasted document cannot be
 * relied on here. A matched artboard is emptied and refilled rather than
 * deleted and remade, so a screen the person has moved on the canvas stays
 * where they put it. An artboard they renamed is a new one on the next push,
 * and that is the honest consequence of naming being the identity.
 */

/** Where Paper Desktop listens while a file is open. Not configurable there. */
const ENDPOINT = "http://127.0.0.1:29979/mcp";

/** The space Paper's own instructions ask to be left between artboards. */
const GAP = 80;

/**
 * A screen bigger than this is not pushed. The markup crosses a JSON-RPC call
 * in one piece, and a screen carrying tens of megabytes of inlined pictures
 * fails somewhere inside Paper rather than here, where it can be named.
 */
const MAX_SCREEN_BYTES = 12_000_000;

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** A tool's answer, whether it came back structured or as JSON in text. */
function payloadOf(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = (result?.content ?? []).filter((part) => part?.type === "text").map((part) => part.text).join("");
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * The node a tool says it made.
 *
 * Read tolerantly rather than against one shape: this is someone else's
 * server, the id is the only thing needed from it, and a push that stops
 * because the field moved would be a worse answer than one that finds it.
 */
function nodeIdOf(payload) {
  if (typeof payload === "string") return payload.match(/[A-Za-z0-9_-]{6,}/)?.[0] ?? null;
  if (!payload || typeof payload !== "object") return null;
  for (const key of ["nodeId", "id", "artboardId"]) {
    if (typeof payload[key] === "string" && payload[key]) return payload[key];
  }
  for (const key of ["node", "artboard", "result"]) {
    const found = nodeIdOf(payload[key]);
    if (found) return found;
  }
  return null;
}

/** Whatever `get_children` calls its list. */
function childIdsOf(payload) {
  const list = Array.isArray(payload) ? payload : payload?.children ?? payload?.nodes ?? [];
  return (Array.isArray(list) ? list : []).map((child) => child?.id).filter((id) => typeof id === "string");
}

async function openPaperSession(endpoint) {
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "crank", version });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
  return {
    async call(name, args) {
      const result = await client.callTool({ arguments: args, name });
      if (result?.isError) {
        const said = (result.content ?? []).map((part) => part?.text).filter(Boolean).join(" ").slice(0, 300);
        throw new Error(said || `Paper refused ${name}.`);
      }
      return result;
    },
    async close() { await client.close().catch(() => {}); }
  };
}

/**
 * Draws every captured screen into the open file, and reports what happened to
 * each one. A screen that fails is named and the rest still go: a push that
 * abandons twenty-nine screens because the thirtieth was too big would be
 * throwing away work that had already succeeded.
 */
async function pushToPaper(inventory, { connect = openPaperSession, endpoint = ENDPOINT, pageId = null } = {}) {
  const found = await paperScreens(inventory, { pageId });
  if (!found.ok) return found;

  let session;
  try {
    session = await connect(endpoint);
  } catch {
    return {
      ok: false,
      message: "Paper is not answering. Open Paper Desktop and the file these screens should go into, then try again.",
      missing: found.missing,
      missingReasons: found.missingReasons
    };
  }

  const created = [];
  const updated = [];
  const failed = [];
  const placements = [];
  try {
    const info = payloadOf(await session.call("get_basic_info", {}));
    const artboards = Array.isArray(info?.artboards) ? info.artboards : [];
    // New artboards go to the right of everything already on the page, level
    // with the top of it, so a push never lands on the person's own work.
    // Paper places a new artboard wherever it likes and ignores a position
    // given to `create_artboard`; `update_styles` is what actually moves one.
    let nextX = artboards.reduce((right, board) => Math.max(right, number(board.worldX) + number(board.width) + GAP), 0);
    const topY = artboards.length > 0
      ? artboards.reduce((top, board) => Math.min(top, number(board.worldY)), Infinity)
      : 0;

    for (const screen of found.screens) {
      const bytes = Buffer.byteLength(screen.html, "utf8");
      if (bytes > MAX_SCREEN_BYTES) {
        const megabytes = Math.round(bytes / 100_000) / 10;
        failed.push({ name: screen.name, reason: `${megabytes}MB of markup, more than one write carries.` });
        continue;
      }
      try {
        const existing = artboards.find((board) => board?.name === screen.name && typeof board.id === "string");
        if (existing) {
          const children = childIdsOf(payloadOf(await session.call("get_children", { nodeId: existing.id })));
          if (children.length > 0) await session.call("delete_nodes", { nodeIds: children });
          await session.call("write_html", { html: screen.html, mode: "insert-children", targetNodeId: existing.id });
          updated.push(screen.name);
          continue;
        }
        const made = nodeIdOf(payloadOf(await session.call("create_artboard", {
          name: screen.name,
          styles: { height: `${screen.height}px`, overflow: "hidden", width: `${screen.width}px` }
        })));
        if (!made) {
          failed.push({ name: screen.name, reason: "Paper made the artboard but did not say which node it is." });
          continue;
        }
        // Where each board sits is settled in one call at the end. Paper
        // meters MCP use by the call, and a scan is thirty screens: spending a
        // third of that budget on placement would be paying tool calls for
        // tidiness.
        placements.push({ nodeIds: [made], styles: { left: `${nextX}px`, top: `${topY}px` } });
        await session.call("write_html", { html: screen.html, mode: "insert-children", targetNodeId: made });
        nextX += screen.width + GAP;
        created.push(screen.name);
      } catch (cause) {
        failed.push({ name: screen.name, reason: cause instanceof Error ? cause.message : String(cause) });
      }
    }

    // A push that drew its screens and could not place them is a push that
    // worked, so the placement is allowed to fail on its own.
    if (placements.length > 0) await session.call("update_styles", { updates: placements }).catch(() => {});

    // Paper draws a "being worked on" mark while an agent holds an artboard,
    // and asks to have it taken off. A push that left it on would leave every
    // screen looking busy for as long as the file stays open.
    await session.call("finish_working_on_nodes", {}).catch(() => {});

    return {
      ok: created.length > 0 || updated.length > 0,
      created,
      dropped: found.dropped,
      failed,
      fileName: typeof info?.fileName === "string" ? info.fileName : null,
      message: created.length > 0 || updated.length > 0
        ? null
        : `No screen reached Paper. ${failed[0]?.reason ?? "Paper accepted nothing."}`,
      missing: found.missing,
      missingReasons: found.missingReasons,
      updated
    };
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : String(cause),
      created,
      failed,
      missing: found.missing,
      missingReasons: found.missingReasons,
      updated
    };
  } finally {
    await session.close();
  }
}

module.exports = { ENDPOINT, GAP, MAX_SCREEN_BYTES, childIdsOf, nodeIdOf, payloadOf, pushToPaper };
