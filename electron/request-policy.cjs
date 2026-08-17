const { isFrameworkInternalPath } = require("./state-discovery.cjs");

/**
 * Decides what a crawl is allowed to request.
 *
 * Two things are worth preventing: writing to someone's project, and running a
 * third party's code inside it. So non-GET requests are cancelled unless they
 * are framework tooling, and off-host scripts and data calls are cancelled too.
 * Together with skipping destructive controls, a crawl cannot change anything.
 *
 * Everything off-host used to be cancelled, which protected nothing further and
 * quietly ruined the capture. A page that loads its typeface or its photographs
 * from a CDN would be photographed and measured without them — the same page
 * that renders perfectly if you simply open it in a browser. Capture has to at
 * least match what a browser does with the page; a stylesheet, a font, an image
 * or a video is fetched, drawn, and can do nothing else.
 *
 * A subresource fetched from off-host is also inlined into the captured markup,
 * so fetching it once removes an external dependency from the handoff page
 * rather than adding one.
 *
 * The rule lives here rather than in either session because both enforce it —
 * one through Electron's own request handler, the other through the debugging
 * protocol on an app it did not launch. Attaching to a real running app is
 * exactly where this matters most, and the two must not drift.
 */
// Fetched and then drawn. Anything that executes, or that can carry data in
// either direction, is deliberately absent.
const passiveAssets = new Set(["font", "stylesheet", "image", "media", "imageset"]);
function requestVerdict(url, method, resourceType, originHost, drawn = null) {
  if (["data:", "blob:"].some((scheme) => String(url).startsWith(scheme))) {
    return { allow: true, isFetch: false };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { allow: false, reason: "malformed" };
  }
  // Not origin, and not host either: Vite serves HMR from a separate port
  // (127.0.0.1:24678), so anything on the loopback interface counts as local.
  const isLoopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname);
  const isLocal = parsed.host === originHost || isLoopback;
  const kind = String(resourceType || "").toLowerCase();
  const verb = String(method || "GET").toUpperCase();
  if (!isLocal || !["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
    const readable = ["GET", "HEAD"].includes(verb) && ["http:", "https:"].includes(parsed.protocol);
    // Reading back something the page already displayed. Capture inlines its
    // assets by re-fetching them, and a cross-origin stylesheet cannot be read
    // any other way — the browser refuses to hand over its rules. Without this
    // the typeface stays a link to a font host, which the app's own preview
    // will not load, so the captured page looked different inside UI Sync than
    // it does anywhere else. Confined to addresses already fetched as passive
    // assets, so it opens nothing that was not already on screen.
    const isReRead = readable && drawn?.has(parsed.href);
    const isPassive = passiveAssets.has(kind) && readable;
    if (!isPassive && !isReRead) return { allow: false, reason: "external", host: parsed.host };
    return { allow: true, isFetch: false, fetchedFrom: parsed.host, drawnUrl: isPassive ? parsed.href : null };
  }
  if (!["GET", "HEAD"].includes(verb) && !isFrameworkInternalPath(parsed.pathname)) {
    return { allow: false, reason: "mutation", label: `${verb} ${parsed.pathname}` };
  }
  // Tracked apart from other traffic: a page that fetched data is still working
  // after the response lands, because something has to render it. Documents,
  // styles and images carry no such follow-on work.
  return { allow: true, isFetch: ["xhr", "fetch"].includes(kind) };
}

module.exports = { requestVerdict };
