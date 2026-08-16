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

function signatureOf(snapshot) {
  return createHash("sha256").update(JSON.stringify(snapshot ?? null)).digest("hex").slice(0, 24);
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
  const label = parts.filter(Boolean).join(" · ").replace(/\s+/g, " ").trim();
  return label.slice(0, 80) || "State";
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
    fingerprint.push(`${tag}|${element.className && typeof element.className === "string" ? element.className.slice(0, 40) : ""}|${own}|${Math.round(rect.width / 8)}x${Math.round(rect.height / 8)}`);
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
    title: document.title || "",
    heading: (document.querySelector("h1,h2")?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
    url: location.pathname + location.search + location.hash,
    fingerprint,
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
  onProgress
} = {}) {
  const states = [];
  const bySignature = new Map();
  const frontier = [];
  const skipped = [];

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
    const signature = signatureOf(snapshot.fingerprint);
    if (bySignature.has(signature)) return null;
    ({ recipe, entryRoute } = await simplify(snapshot, recipe, entryRoute, signature));
    const name = humanizeStateName(
      recipe.length === 0
        ? [snapshot.heading || snapshot.title, snapshot.url === "/" ? "" : snapshot.url]
        : [snapshot.heading || snapshot.title, recipe[recipe.length - 1].label]
    );
    const state = {
      id: `state-${signature}`,
      name,
      signature,
      route: entryRoute,
      url: snapshot.url,
      recipe,
      depth: recipe.length
    };
    bySignature.set(signature, state);
    states.push(state);
    onProgress?.(state);
    const pending = rankCandidates(snapshot.candidates)
      .filter((candidate) => {
        if (!isDestructiveLabel(candidate.label)) return true;
        skipped.push({ label: candidate.label, reason: "looks destructive" });
        return false;
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
    const recipe = [...step.from.recipe, { kind: "click", locator: step.action.locator, label: step.action.label }];

    // Replay from a fresh load every time. A state that cannot be reached
    // deterministically is worthless as a baseline, so determinism beats speed.
    let snapshot = await session.goto(step.from.entryRoute);
    if (!snapshot) continue;
    let reached = true;
    for (const action of recipe) {
      snapshot = await session.click(action.locator);
      if (!snapshot) { reached = false; break; }
    }
    if (!reached) continue;
    await record(snapshot, recipe, step.from.entryRoute);
  }

  return { states, skipped };
}

module.exports = {
  collectUiState,
  discoverStates,
  humanizeStateName,
  isDestructiveLabel,
  isFrameworkInternalPath,
  planNextStep,
  rankCandidates,
  recipeKey,
  signatureOf
};
