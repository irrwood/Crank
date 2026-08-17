const { collectUiState } = require("./state-discovery.cjs");
const { DOWNSCALE_OVER_BYTES, DOWNSCALE_TO_WIDTH, MAX_ASSET_BYTES, MAX_TOTAL_ASSET_BYTES, captureHtmlDocument } = require("./html-snapshot.cjs");
const { serializeRenderedApplication } = require("./figma-tree.cjs");
const { assignKeys } = require("./node-identity.cjs");

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Everything a crawl does to a page, expressed over four primitives.
 *
 * Waiting for a page to settle, scrolling it through, reading its structure and
 * capturing it are the same work whether the page is in a window UI Sync opened
 * or in an app someone else is running that UI Sync merely attached to. Only
 * *how* a script is run, a page is navigated, a screenshot is taken and storage
 * is cleared differs, so only those are supplied by the driver.
 *
 * Keeping them together is not tidiness. The waiting rules in particular were
 * arrived at by measurement against real projects, and a second copy of them
 * would drift from the first without anyone noticing until a capture came back
 * half-rendered.
 */
function createBrowsingSession(origin, driver) {
  const { evaluate, navigate, screenshot, clearStorage, dispose, blocked, timing } = driver;

  /**
   * Waits for the page to stop changing, not for a fixed delay.
   *
   * Data arrives asynchronously and charts are built after it lands: this app's
   * analytics page had no chart at all 300ms in and six of them at two seconds.
   * A fixed wait captured the loading state and reported a clean snapshot,
   * which is worse than capturing nothing.
   */
  // Polling interval, not a delay: a page that is already finished should cost
  // three quick samples, not a fixed wait. A static page was costing 1.5s of
  // pure waiting while its capture took 127ms.
  const settle = async ({ quietFor = 1, interval = 120, maxWait = 3_000, grace = 0 } = {}) => {
    await evaluate("Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))])").catch(() => null);

    const measure = () => evaluate(
      `(() => {
        const body = document.body;
        return body ? \`\${document.querySelectorAll("*").length}:\${body.innerText.length}:\${document.querySelectorAll("canvas,svg,img").length}\` : "";
      })()`
    ).catch(() => null);

    const deadline = Date.now() + maxWait;
    let previous = await measure();
    let stable = 0;
    let seenRequestAt = timing.lastRequestAt;

    while (Date.now() < deadline) {
      await wait(interval);
      // Stillness only counts once the network has gone quiet. A page waiting
      // on a fetch sits perfectly still, and charts are drawn a few hundred
      // milliseconds *after* their data lands — counting that earlier calm
      // ended the wait before anything had been rendered.
      if (timing.lastRequestAt !== seenRequestAt) {
        seenRequestAt = timing.lastRequestAt;
        stable = 0;
      }
      const current = await measure();
      stable = current !== null && current === previous ? stable + 1 : 0;
      previous = current;
      if (stable < quietFor || Date.now() - timing.lastRequestAt <= interval) continue;

      // A page that fetched data is still working after the response lands —
      // charts are built from it. A page that only loaded markup is finished
      // the moment it stops changing, and waiting on those is the whole cost of
      // scanning a static site.
      if (timing.lastFetchAt === 0 || Date.now() - timing.lastFetchAt > grace) break;
    }
  };

  /**
   * Scrolls the page through once and returns to the top.
   *
   * Reveal-on-scroll animations leave everything below the fold hidden until it
   * comes into view, so a capture taken without scrolling holds only the first
   * screen: this portfolio's home page had 44 elements visible and 108 hidden,
   * and 134 visible after. Lazy images need the same pass.
   */
  const revealAll = async () => {
    await evaluate(`(async () => {
      const step = Math.max(200, window.innerHeight * 0.8);
      const height = document.documentElement.scrollHeight;
      for (let y = step, steps = 0; y < height + step && steps < 24; y += step, steps += 1) {
        window.scrollTo(0, y);
        await new Promise((resolve) => setTimeout(resolve, 140));
      }
      window.scrollTo(0, 0);
      await new Promise((resolve) => setTimeout(resolve, 220));
    })()`).catch(() => null);
  };

  const read = () => evaluate(`(${collectUiState.toString()})()`).catch(() => null);

  /** Discovery needs structure only; capture waits for data and scrolls. */
  const rest = async (patient) => {
    await settle(patient ? { quietFor: 3, interval: 150, maxWait: 15_000, grace: 1_200 } : undefined);
    if (!patient) return;
    await revealAll();
    await settle({ quietFor: 2, interval: 120, maxWait: 4_000 });
  };

  return {
    get blocked() {
      return { mutations: [...blocked.mutations], external: [...blocked.external], fetched: [...blocked.fetched] };
    },

    /**
     * Clears what the app remembered between visits.
     *
     * A language or theme switch is persisted, so once the crawl clicked one
     * every later page came back re-skinned and was recorded under a polluted
     * name. Replaying from the app's own default keeps each page comparable
     * with the last scan, which is what a baseline needs.
     */
    async reset() {
      await clearStorage().catch(() => null);
    },

    async goto(route, { patient = false } = {}) {
      // Resolve against the origin rather than assigning to pathname: a route
      // like "/?view=settings" would otherwise be encoded into the path as
      // "/%3Fview=settings" and silently load the wrong view.
      const path = typeof route === "string" && route ? route : "/";
      let target;
      try {
        target = new URL(path, origin);
      } catch {
        return null;
      }
      if (target.origin !== origin) return null;
      timing.forgetFetch();
      try {
        await navigate(target.toString());
      } catch {
        return null;
      }
      await rest(patient);
      return read();
    },

    async click(locator, { patient = false } = {}) {
      let clicked = false;
      try {
        clicked = await evaluate(`(() => {
          const element = document.querySelector(${JSON.stringify(locator)});
          if (!element) return false;
          element.scrollIntoView({ block: "center" });
          element.click();
          return true;
        })()`);
      } catch {
        return null;
      }
      if (!clicked) return null;
      await rest(patient);
      // A link can carry the window off-site even when its href looked local.
      // The load is blocked, leaving a dead page: report nothing rather than
      // fingerprinting the error.
      try {
        if (await evaluate("location.origin") !== origin) return null;
      } catch {
        return null;
      }
      return read();
    },

    async captureHtml() {
      try {
        const limits = {
          maxAssetBytes: MAX_ASSET_BYTES,
          maxTotalAssetBytes: MAX_TOTAL_ASSET_BYTES,
          downscaleOverBytes: DOWNSCALE_OVER_BYTES,
          downscaleToWidth: DOWNSCALE_TO_WIDTH
        };
        return await evaluate(`(${captureHtmlDocument.toString()})(${JSON.stringify(limits)})`);
      } catch (cause) {
        return { html: null, error: cause instanceof Error ? cause.message : String(cause) };
      }
    },

    /**
     * The layer tree the Figma plugin builds from. Same page, same session as
     * the HTML snapshot — one visit produces both.
     */
    /**
     * Handed back as text, not as an object.
     *
     * A layer tree is deep — one node per rendered element, nested as the page
     * is — and returning that graph across the process boundary means cloning
     * it structurally, which fails on a real page: two thirds of a portfolio
     * came back with no layers at all, reported only as "script failed to
     * execute". The markup capture beside it never had the problem because it
     * always returned a string. Serialising in the page and parsing here costs
     * one pass and cannot fail on depth.
     */
    async captureFigmaTree() {
      try {
        // Caught in the page, because the error that crosses the boundary is
        // only ever "script failed to execute" — which says nothing about which
        // page, which element, or why, and left two thirds of a real portfolio
        // silently arriving with no layers.
        const json = await evaluate(`(() => {
          try {
            return JSON.stringify((${serializeRenderedApplication.toString()})());
          } catch (cause) {
            return JSON.stringify({ error: String(cause && cause.message || cause).slice(0, 300) });
          }
        })()`);
        if (typeof json !== "string" || !json) return { error: "The page returned no layer tree." };
        const tree = JSON.parse(json);
        if (tree?.tree) assignKeys(tree.tree);
        return tree;
      } catch (cause) {
        return { error: cause instanceof Error ? cause.message : String(cause) };
      }
    },

    async capture() {
      try {
        return await screenshot();
      } catch {
        return null;
      }
    },

    close() {
      dispose();
    }
  };
}

module.exports = { createBrowsingSession };
