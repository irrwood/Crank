/**
 * What counts as "the same app" for a page that has no origin.
 *
 * Only http and https pages have one. A packaged desktop app loads its
 * interface either from its own files or from a scheme it registered for
 * itself — `file:///Applications/Ledger.app/…`, `client://app/`, `app://-/` —
 * and the browser reports the origin of every one of those as the string
 * "null". Taken at face value that is either the whole machine or nothing, and
 * it is not even a URL: `new URL("null")` throws, which is how a real app
 * (ChatWise, serving `client://app/`) turned a scan into "Invalid URL".
 *
 * So the origin is worked out from the address instead. A scheme with a host
 * of its own is that scheme and host; a file has no host, so it is the folder
 * the interface was loaded from, which is where the app's pages live and
 * excludes the rest of the disk.
 *
 * Anything served over http keeps the origin it already had; this only widens
 * the idea of an origin, it does not change it.
 */

function asUrl(value) {
  if (value instanceof URL) return value;
  try {
    return new URL(String(value));
  } catch {
    return null;
  }
}

/** The one kind of origin the browser hands over usable. */
function isHttpOrigin(origin) {
  return /^https?:\/\//.test(String(origin ?? ""));
}

/**
 * True when the pages belong to an installed app rather than to a server:
 * loaded from disk, or from a scheme the app registered for itself.
 */
function isAppOrigin(origin) {
  return Boolean(origin) && !isHttpOrigin(origin);
}

/** An app with no host has a folder instead, and its origin keeps the trailing slash. */
function isFileOrigin(origin) {
  return String(origin ?? "").startsWith("file://");
}

function originOf(value) {
  const url = asUrl(value);
  if (!url) return null;
  if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
  // A scheme the app registered for itself: "client://app", "app://-".
  if (url.host) return `${url.protocol}//${url.host}`;
  // No host to name it by — the folder the interface was loaded from is the
  // app, and the trailing slash is what makes a route resolve inside it rather
  // than replace it.
  return `${url.protocol}//${url.pathname.replace(/[^/]*$/, "")}`;
}

/** The part of a hostless origin that a page's own `location.pathname` starts with. */
function pathOfOrigin(origin) {
  if (!isFileOrigin(origin)) return "";
  return asUrl(origin)?.pathname ?? "";
}

/** True when an address belongs to the app being scanned. */
function withinOrigin(value, origin) {
  const url = asUrl(value);
  if (!url || !origin) return false;
  if (isHttpOrigin(origin)) return url.origin === origin;
  if (url.href === origin) return true;
  if (!url.href.startsWith(origin)) return false;
  // "client://app" must not swallow "client://application": what follows the
  // origin has to be a boundary, unless the origin is a folder and ends in one.
  return origin.endsWith("/") || ["/", "?", "#"].includes(url.href.slice(origin.length)[0]);
}

/**
 * A page's address relative to the app it belongs to.
 *
 * Recorded routes travel into page names, and the pages of an app loaded from
 * disk all share the same long prefix — `/Applications/Ledger.app/Contents/…`,
 * which says where the app was installed and nothing about the page. Only the
 * part below the app's own folder is the route.
 */
function routeWithin(pathname, origin) {
  const value = String(pathname ?? "");
  const base = pathOfOrigin(origin);
  if (!base || !value.startsWith(base)) return value;
  return value.slice(base.length);
}

module.exports = { isAppOrigin, isFileOrigin, isHttpOrigin, originOf, pathOfOrigin, routeWithin, withinOrigin };
