const { isFrameworkInternalPath } = require("./state-discovery.cjs");

/**
 * Decides what a crawl is allowed to request.
 *
 * Crawling clicks through someone's actual project, so application writes are
 * cancelled: any non-GET request that is not framework tooling is blocked, and
 * everything off-host is blocked too. Together with skipping destructive
 * controls, a crawl cannot write to a database or call a mutating endpoint.
 *
 * The rule lives here rather than in either session because both enforce it —
 * one through Electron's own request handler, the other through the debugging
 * protocol on an app it did not launch. Attaching to a real running app is
 * exactly where this matters most, and the two must not drift.
 */
function requestVerdict(url, method, resourceType, originHost) {
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
  if (!isLocal || !["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
    return { allow: false, reason: "external", host: parsed.host };
  }
  const verb = String(method || "GET").toUpperCase();
  if (!["GET", "HEAD"].includes(verb) && !isFrameworkInternalPath(parsed.pathname)) {
    return { allow: false, reason: "mutation", label: `${verb} ${parsed.pathname}` };
  }
  // Tracked apart from other traffic: a page that fetched data is still working
  // after the response lands, because something has to render it. Documents,
  // styles and images carry no such follow-on work.
  return { allow: true, isFetch: ["xhr", "fetch", "XHR", "Fetch"].includes(String(resourceType)) };
}

module.exports = { requestVerdict };
