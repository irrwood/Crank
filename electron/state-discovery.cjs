const { createHash } = require("node:crypto");

/**
 * Discovers the visual states of a running app: routes, tabs, modals, view
 * modes and similar. A "page" in UI Sync is one visual state, not one URL,
 * because a single URL commonly maps to several Figma frames.
 *
 * Every discovered state carries a replay recipe — the exact steps to reach it
 * from a fresh load. Without a deterministic recipe a state cannot be captured
 * again later, and change status would have nothing stable to compare against.
 */

const destructiveWords = [
  "delete", "remove", "destroy", "drop", "erase", "clear all", "reset",
  "sign out", "log out", "logout", "unsubscribe", "cancel subscription",
  "pay", "purchase", "checkout", "buy", "send", "publish", "submit",
  "删除", "移除", "清空", "退出登录", "注销", "支付", "购买", "提交", "发送", "发布"
];

/**
 * Clicking through a real application can mutate real data. Anything that
 * reads as destructive is skipped even though non-GET requests are also
 * blocked while crawling — one guard is not enough for someone's real project.
 */
function isDestructiveLabel(label) {
  const value = String(label ?? "").trim().toLowerCase();
  if (!value) return false;
  return destructiveWords.some((word) => value.includes(word));
}

/**
 * Dev-server and framework internals (Vite's /@…, Next/vinext's /__…) are
 * tooling, not application writes. Blocking them does not protect any data and
 * actively breaks the app: blocking vinext's stack-trace endpoint put its error
 * overlay into a retry loop that issued ~11k requests in three seconds.
 */
function isFrameworkInternalPath(pathname) {
  return /^\/(?:@|__|_next\/|\.vite\/|node_modules\/)/.test(String(pathname ?? ""));
}

/**
 * An endpoint that answers with JSON or XML is not a page, however well it
 * renders in a browser window.
 */
/**
 * True when two addresses are the same page at a different scroll position.
 * Following anchors recorded "copper.html#overview", "#mobile" and
 * "#clearloop" as three pages of one document.
 */
function isSameDocument(before, after) {
  const strip = (value) => String(value ?? "").split("#")[0];
  const hashOf = (value) => String(value ?? "").split("#")[1] ?? "";
  if (strip(before) !== strip(after)) return false;
  // Hash routing genuinely changes page; a bare anchor does not.
  return !hashOf(after).startsWith("/");
}

function isHtmlContentType(contentType) {
  const value = String(contentType ?? "").toLowerCase();
  if (!value) return true;
  return value.includes("text/html") || value.includes("application/xhtml");
}

function signatureOf(snapshot) {
  return createHash("sha256").update(JSON.stringify(snapshot ?? null)).digest("hex").slice(0, 24);
}

/**
 * What a page *is*: the address it lives at and the clicks that reach it.
 *
 * The identity used to be a hash of the page's own content, which made every
 * edit to the page a different page. The frame it was pushed to and the
 * baseline recorded against it were keyed by that id, so changing a heading
 * orphaned both — a second push drew the page again beside itself, and a pull
 * had nothing to compare. That is the same silent drift node identity was
 * rewritten to remove, one level up.
 *
 * Content still decides whether two visits are the same state; it just no
 * longer decides what that state is called. A directly addressable page is its
 * address alone, so the common case is as stable as the URL itself.
 */
function identityOf(route, recipe) {
  return `page-${createHash("sha256").update(`${route}::${recipeKey(recipe)}`).digest("hex").slice(0, 16)}`;
}

/**
 * Ranks what to try first. Navigation-like controls are far more likely to
 * reveal a distinct visual state than an arbitrary button.
 */
function rankCandidates(candidates) {
  const weight = (candidate) => {
    const role = String(candidate.role ?? "").toLowerCase();
    if (role === "tab") return 0;
    if (role === "menuitem" || role === "menuitemradio") return 1;
    if (candidate.inNav) return 2;
    if (candidate.hasExpanded) return 3;
    if (role === "link") return 4;
    if (role === "button") return 5;
    return 6;
  };
  return [...candidates]
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => weight(a.candidate) - weight(b.candidate) || a.index - b.index)
    .map((entry) => entry.candidate);
}

function humanizeStateName(parts) {
  const seen = new Set();
  const unique = parts
    .map((part) => String(part ?? "").replace(/\s+/g, " ").trim())
    .filter((part) => part && !seen.has(part) && seen.add(part));
  return unique.join(" · ").slice(0, 80) || "State";
}

const volatilePatterns = [
  /\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b/i,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i,
  /\b(?:today|yesterday|tomorrow|now|just now)\b/i,
  /今天|昨天|明天|刚刚|星期|周[一二三四五六日天]|\d+\s*(?:年|月|日|分钟|小时)前/,
  /\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}/
];

/**
 * Text that changes on its own is unusable as a page name: this app's <h1> is
 * "Today, Sunday, 16 August", so names taken from it would rename every page
 * tomorrow and break the identity that baselines depend on.
 */
function isVolatileText(text) {
  const value = String(text ?? "").trim();
  if (!value) return true;
  if (volatilePatterns.some((pattern) => pattern.test(value))) return true;
  const digits = (value.match(/\d/g) ?? []).length;
  return digits > 0 && digits / value.length > 0.3;
}

const appearanceWords = [
  "light mode", "dark mode", "light theme", "dark theme", "toggle theme",
  "switch to", "language", "english", "中文", "简体", "繁體", "日本語", "한국어",
  "深色", "浅色", "夜间", "日间", "主题", "语言", "切换"
];

/**
 * A control that changes how the app looks describes an appearance, not a
 * page. Naming a page "Light Mode" after the button that reached it hides
 * which page it actually is.
 */
function isAppearanceLabel(label) {
  const value = String(label ?? "").trim().toLowerCase();
  if (!value) return false;
  return appearanceWords.some((word) => value.includes(word));
}

function humanizeRoute(route) {
  const value = String(route ?? "").trim();
  if (!value || value === "/") return "Home";
  const [path, query] = value.split("?");
  const fromQuery = query ? query.split("&").map((pair) => pair.split("=").pop()).join(" ") : "";
  const fromPath = path.split("/").filter(Boolean).join(" ");
  return (fromPath || fromQuery || "Home")
    .replace(/[-_]+/g, " ")
    .replace(/\.\w+$/, "")
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim();
}

/**
 * Names a state from the most stable signal available. The label of the
 * control that opened it ("全部记录", "常规") is written by the app's authors
 * and does not drift; headings and titles are used only when they look stable.
 */
function chooseStateName({ recipe = [], route, heading, title }) {
  const label = recipe.length > 0 ? recipe[recipe.length - 1].label : null;
  const parts = [];
  if (label && !isVolatileText(label) && !isAppearanceLabel(label)) parts.push(label);
  if (parts.length === 0 && route) parts.push(humanizeRoute(route));
  for (const candidate of [heading, title]) {
    if (parts.length >= 2) break;
    if (candidate && !isVolatileText(candidate)) parts.push(candidate);
  }
  return humanizeStateName(parts);
}

function areaOfFingerprintEntry(entry) {
  const match = String(entry ?? "").match(/\|(\d+)x(\d+)$/);
  if (!match) return 0;
  // Stored in eighth-of-a-pixel buckets by collectUiState.
  return Number(match[1]) * 8 * Number(match[2]) * 8;
}

/**
 * How much of the screen a state changed, as a fraction of the viewport, using
 * the largest single changed element rather than a sum so nesting does not
 * inflate it. A dropdown or tooltip moves a sliver; a tab, modal or route
 * change moves a large region.
 */
function changeMagnitude(before, after, viewport) {
  const viewportArea = Math.max(1, (viewport?.width ?? 1220) * (viewport?.height ?? 790));
  const previous = new Set(before ?? []);
  let largest = 0;
  for (const entry of after ?? []) {
    if (previous.has(entry)) continue;
    largest = Math.max(largest, areaOfFingerprintEntry(entry));
  }
  return Math.min(1, largest / viewportArea);
}

function recipeKey(recipe) {
  return recipe.map((step) => `${step.kind}:${step.locator ?? step.path ?? ""}`).join(">");
}

/**
 * Decides the next unexplored action, breadth-first so shallow states (the ones
 * a user actually reaches) are found before deep ones when the budget runs out.
 */
function planNextStep(frontier, { maxDepth }) {
  while (frontier.length > 0) {
    const item = frontier[0];
    if (item.recipe.length >= maxDepth || item.pending.length === 0) {
      frontier.shift();
      continue;
    }
    const action = item.pending.shift();
    return { from: item, action };
  }
  return null;
}

/**
 * Runs inside the page. Returns a structural fingerprint plus the controls
 * worth trying. Kept dependency-free because it is serialized into the page.
 */
function collectUiState() {
  const visible = (element) => {
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  };

  const locatorFor = (element) => {
    if (element.id && !/^[0-9]/.test(element.id)) return `#${CSS.escape(element.id)}`;
    const testId = element.getAttribute("data-testid") || element.getAttribute("data-test-id");
    if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
    const parts = [];
    let node = element;
    let depth = 0;
    while (node && node.nodeType === 1 && node !== document.body && depth < 8) {
      const parent = node.parentElement;
      if (!parent) break;
      const siblings = [...parent.children].filter((child) => child.tagName === node.tagName);
      const index = siblings.indexOf(node) + 1;
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${index})`);
      node = parent;
      depth += 1;
    }
    return parts.length > 0 ? `body ${parts.join(" > ")}` : null;
  };

  const root = document.querySelector("[data-ui-sync-root], #root, #app, main") || document.body;

  // Structure only: text is included but volatile values (times, counters) are
  // normalized away so the same state does not look different on every visit.
  const fingerprint = [];
  // The skeleton is the tag structure alone — no text, no classes, and no
  // geometry. Translating a page changes every string width and therefore
  // every box, so geometry cannot be part of it; the tag sequence survives
  // both translation and a theme change, and is what makes it the same page.
  const skeleton = [];
  const walk = (element, depth) => {
    if (depth > 12 || fingerprint.length > 1200) return;
    if (!(element instanceof Element) || !visible(element)) return;
    const tag = element.tagName.toLowerCase();
    if (tag === "script" || tag === "style") return;
    const own = [...element.childNodes]
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent.trim())
      .join(" ")
      .replace(/\d[\d.,:/-]*/g, "#")
      .slice(0, 60);
    const rect = element.getBoundingClientRect();
    const box = `${Math.round(rect.width / 8)}x${Math.round(rect.height / 8)}`;
    fingerprint.push(`${tag}|${element.className && typeof element.className === "string" ? element.className.slice(0, 40) : ""}|${own}|${box}`);
    skeleton.push(`${tag}@${depth}`);
    for (const child of element.children) walk(child, depth + 1);
  };
  walk(root, 0);

  const accessibleName = (element) => (
    element.getAttribute("aria-label")
    || element.getAttribute("title")
    || (element.innerText || element.textContent || "").trim()
  ).replace(/\s+/g, " ").slice(0, 60);

  const interactiveSelector = [
    "[role=tab]", "[role=menuitem]", "[role=menuitemradio]", "[role=option]",
    "button", "a[href]", "[aria-expanded]", "[aria-selected]",
    "nav [class*=item]", "[class*=tab]:not([role])"
  ].join(",");

  const seen = new Set();
  const candidates = [];
  for (const element of document.querySelectorAll(interactiveSelector)) {
    if (!visible(element) || element.hasAttribute("disabled")) continue;
    const locator = locatorFor(element);
    if (!locator || seen.has(locator)) continue;
    seen.add(locator);
    const href = element.getAttribute("href");
    // Anything leaving the origin is navigation away from the app, not a state.
    if (href && /^(?:[a-z]+:)?\/\//i.test(href) && !href.startsWith(location.origin)) continue;
    // A plain anchor scrolls the page it is already on. Hash routing is the
    // exception and is written "#/somewhere".
    if (href && href.startsWith("#") && !href.startsWith("#/")) continue;
    candidates.push({
      locator,
      label: accessibleName(element),
      role: element.getAttribute("role") || (element.tagName === "A" ? "link" : element.tagName === "BUTTON" ? "button" : ""),
      href: href && href.startsWith("/") ? href : null,
      inNav: Boolean(element.closest("nav,[role=navigation],header,aside")),
      hasExpanded: element.hasAttribute("aria-expanded")
    });
    if (candidates.length >= 60) break;
  }

  return {
    // Chrome renders a JSON response as a <pre> block, which walks and
    // fingerprints like any other document. The declared type is the only
    // honest way to tell an API endpoint from a page.
    contentType: (document.contentType || "").toLowerCase(),
    title: document.title || "",
    heading: (document.querySelector("h1,h2")?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
    url: location.pathname + location.search + location.hash,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    fingerprint,
    skeleton,
    candidates
  };
}

/**
 * Walks the app in an offscreen window and returns one entry per distinct
 * visual state. `open` is injected so the traversal logic stays testable
 * without Electron: it must expose { goto, click, read, close }.
 */
async function discoverStates(session, {
  routes = ["/"],
  maxStates = 40,
  maxDepth = 1,
  maxActionsPerState = 12,
  minChangeRatio = 0.12,
  onProgress
} = {}) {
  const states = [];
  const bySignature = new Map();
  const bySkeleton = new Map();
  const frontier = [];
  const skipped = [];
  const filtered = [];
  // Every page carries the same navigation. Clicking a link whose destination
  // is already in the inventory re-walks a known page from every other page —
  // wasted time, and near-duplicates when the arrival state differs slightly.
  const knownAddresses = new Set();
  // A page that draws itself differently on each visit can reach the same
  // address by the same clicks and still be recorded twice. Rather than let the
  // two share an id, the second is told apart — one page keeps the identity a
  // rescan will find, and nothing silently overwrites anything.
  const claimed = new Set();
  const claimIdentity = (route, recipe) => {
    const base = identityOf(route, recipe);
    let identity = base;
    for (let attempt = 2; claimed.has(identity); attempt += 1) identity = `${base}-${attempt}`;
    claimed.add(identity);
    return identity;
  };
  // Set when a click may have persisted a preference the next replay would inherit.
  let dirty = false;
  const remember = (address) => {
    if (typeof address !== "string" || !address) return;
    const [withoutHash] = address.split("#");
    knownAddresses.add(withoutHash || "/");
  };
  for (const route of routes) remember(route);

  /**
   * A state reached by clicking may simply be another address. Directly
   * addressable states get the shortest possible recipe, which makes them
   * cheap to recapture and independent of the path that first found them.
   */
  const simplify = async (snapshot, recipe, entryRoute, signature) => {
    if (recipe.length === 0 || !snapshot.url || snapshot.url === entryRoute) return { recipe, entryRoute };
    const direct = await session.goto(snapshot.url);
    if (direct && signatureOf(direct.fingerprint) === signature) return { recipe: [], entryRoute: snapshot.url };
    return { recipe, entryRoute };
  };

  const record = async (snapshot, recipe, entryRoute) => {
    if (snapshot.contentType && !isHtmlContentType(snapshot.contentType)) {
      filtered.push({
        label: recipe.length > 0 ? recipe[recipe.length - 1].label : entryRoute,
        from: entryRoute,
        reason: `serves ${snapshot.contentType}, not a page`,
        magnitude: 0
      });
      return null;
    }
    const signature = signatureOf(snapshot.fingerprint);
    if (bySignature.has(signature)) return null;
    ({ recipe, entryRoute } = await simplify(snapshot, recipe, entryRoute, signature));

    // Same structure, different text and colours: a theme or language switch
    // re-skins every page, which would otherwise double the whole inventory.
    // Keyed by address as well: a templated site can give two different pages
    // the same tag structure, and those are separate pages, not re-skins.
    const skeleton = `${snapshot.url ?? entryRoute}::${signatureOf(snapshot.skeleton)}`;
    const existing = bySkeleton.get(skeleton);
    if (existing) {
      const label = recipe.length > 0 ? recipe[recipe.length - 1].label : null;
      const variant = {
        // A variant is a state like any other: the same page reached another
        // way. Numbering them by arrival order would move every id below one
        // that stops appearing.
        id: claimIdentity(entryRoute, recipe),
        name: label && !isVolatileText(label)
          ? label
          : (snapshot.title || snapshot.heading || `Variant ${existing.variants.length + 2}`).slice(0, 40),
        signature,
        route: entryRoute,
        recipe
      };
      existing.variants.push(variant);
      bySignature.set(signature, existing);
      return null;
    }
    const name = chooseStateName({
      recipe,
      route: entryRoute,
      heading: snapshot.heading,
      title: snapshot.title
    });
    const state = {
      id: claimIdentity(entryRoute, recipe),
      name,
      signature,
      route: entryRoute,
      url: snapshot.url,
      recipe,
      depth: recipe.length,
      fingerprint: snapshot.fingerprint,
      variants: []
    };
    bySignature.set(signature, state);
    bySkeleton.set(skeleton, state);
    states.push(state);
    onProgress?.(state);
    remember(state.route);
    remember(snapshot.url);

    const pending = rankCandidates(snapshot.candidates)
      .filter((candidate) => {
        if (isDestructiveLabel(candidate.label)) {
          skipped.push({ label: candidate.label, reason: "looks destructive" });
          return false;
        }
        if (candidate.href && knownAddresses.has(candidate.href.split("#")[0])) return false;
        return true;
      })
      .slice(0, maxActionsPerState);
    frontier.push({ state, recipe, entryRoute, pending });
    return state;
  };

  for (const route of routes) {
    if (states.length >= maxStates) break;
    const snapshot = await session.goto(route);
    if (snapshot) await record(snapshot, [], route);
  }

  while (states.length < maxStates) {
    const step = planNextStep(frontier, { maxDepth });
    if (!step) break;
    // The address may have become known since this action was queued.
    if (step.action.href && knownAddresses.has(step.action.href.split("#")[0])) continue;
    const recipe = [...step.from.recipe, { kind: "click", locator: step.action.locator, label: step.action.label }];

    // Replay from a fresh load every time. A state that cannot be reached
    // deterministically is worthless as a baseline, so determinism beats speed.
    //
    // Clearing storage is what stops an earlier language or theme click from
    // colouring every page found afterwards, but it is expensive, and a crawl
    // makes hundreds of replays. Only the clicks that can persist anything
    // warrant it.
    if (dirty) {
      await session.reset?.();
      dirty = false;
    }
    let snapshot = await session.goto(step.from.entryRoute);
    if (!snapshot) continue;
    let reached = true;
    for (const action of recipe) {
      snapshot = await session.click(action.locator);
      if (!snapshot) { reached = false; break; }
    }
    if (!reached) continue;
    if (isAppearanceLabel(step.action.label)) dirty = true;

    // A control that only opened a dropdown or a tooltip did not produce a
    // page. Judge by how much of the screen moved, not by whether the DOM
    // differs at all — almost any click changes something.
    //
    // Navigation is exempt: a different address is a different page however
    // similar it looks. Sibling pages of one template can differ by a single
    // heading, and judging those by pixels would delete a whole nav bar.
    const scrolledOnly = isSameDocument(step.from.state.url, snapshot.url);
    if (scrolledOnly && snapshot.url !== step.from.state.url) {
      filtered.push({
        label: step.action.label,
        from: step.from.state.name,
        reason: "an anchor on the same page",
        magnitude: 0
      });
      continue;
    }
    const navigated = Boolean(snapshot.url) && snapshot.url !== step.from.state.url;
    const magnitude = changeMagnitude(step.from.state.fingerprint, snapshot.fingerprint, snapshot.viewport);
    if (!navigated && magnitude < minChangeRatio) {
      filtered.push({
        label: step.action.label,
        from: step.from.state.name,
        reason: "changed too little to be a page",
        magnitude: Number(magnitude.toFixed(3))
      });
      continue;
    }
    await record(snapshot, recipe, step.from.entryRoute);
  }

  return { states, skipped, filtered };
}

module.exports = {
  collectUiState,
  discoverStates,
  changeMagnitude,
  chooseStateName,
  humanizeRoute,
  humanizeStateName,
  identityOf,
  isAppearanceLabel,
  isDestructiveLabel,
  isVolatileText,
  isFrameworkInternalPath,
  isHtmlContentType,
  isSameDocument,
  planNextStep,
  rankCandidates,
  recipeKey,
  signatureOf
};
