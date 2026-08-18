const { collectUiState } = require("./state-discovery.cjs");
const { DOWNSCALE_OVER_BYTES, DOWNSCALE_TO_WIDTH, MAX_ASSET_BYTES, MAX_TOTAL_ASSET_BYTES, captureHtmlDocument } = require("./html-snapshot.cjs");
const { serializeRenderedApplication } = require("./figma-tree.cjs");
const { assignKeys } = require("./node-identity.cjs");
const { isFileOrigin, routeWithin, withinOrigin } = require("./page-origin.cjs");

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

  const read = async () => {
    const snapshot = await evaluate(`(${collectUiState.toString()})()`).catch(() => null);
    if (!snapshot || !isFileOrigin(origin)) return snapshot;
    // The page reports where it is as a path on disk, and every page of an
    // installed app shares the same long prefix — where it happens to have been
    // installed. The route is what is left below the app's own folder, which is
    // also what a page ends up named after.
    return { ...snapshot, url: routeWithin(snapshot.url, origin) };
  };

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
      // An app loaded from disk has a folder for an origin and routes relative
      // to it, so its own root is "" — "/" would resolve to the root of the
      // file system rather than to the app.
      const path = typeof route === "string" && route ? route : isFileOrigin(origin) ? "" : "/";
      let target;
      try {
        target = new URL(path, origin);
      } catch {
        return null;
      }
      if (!withinOrigin(target, origin)) return null;
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
      // fingerprinting the error. Asked as an address rather than as an origin,
      // because a page loaded from disk reports its origin as the string
      // "null" — which matches every other file on the machine and no app.
      try {
        if (!withinOrigin(await evaluate("location.href"), origin)) return null;
      } catch {
        return null;
      }
      return read();
    },

    /**
     * The application's own icon, as the page declares it.
     *
     * Every project otherwise wears the same placeholder in the list, which
     * says only "this is a project" — and the thing that tells them apart is
     * already sitting in the page being scanned. Drawn to a canvas so an .ico,
     * an .svg and a .png all come back the same way.
     */
    async captureIcon() {
      try {
        return await evaluate(`(async () => {
          const links = [...document.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]')];
          // Largest declared size first: a 16px favicon looks like mud at 26.
          const sized = (link) => Math.max(0, ...String(link.sizes?.value || link.getAttribute("sizes") || "")
            .split(/\s+/).map((part) => parseInt(part, 10)).filter(Number.isFinite));
          const candidates = links.sort((a, b) => sized(b) - sized(a)).map((link) => link.href);
          candidates.push(new URL("/favicon.ico", location.href).href);

          for (const href of candidates) {
            const drawn = await new Promise((resolve) => {
              const image = new Image();
              image.crossOrigin = "anonymous";
              const done = (value) => resolve(value);
              image.onload = () => {
                try {
                  const canvas = document.createElement("canvas");
                  canvas.width = 64;
                  canvas.height = 64;
                  const context = canvas.getContext("2d");
                  if (!context) return done(null);
                  context.drawImage(image, 0, 0, 64, 64);
                  done(canvas.toDataURL("image/png"));
                } catch { done(null); }
              };
              image.onerror = () => done(null);
              setTimeout(() => done(null), 2500);
              image.src = href;
            });
            if (drawn && drawn.length > 200) return drawn;
          }
          return null;
        })()`);
      } catch {
        return null;
      }
    },

    /**
     * The page's own markup, kept beside the layers.
     *
     * The layer tree is what reaches Figma and what a card in the grid draws,
     * and it is an approximation: it has the boxes, the type and the colours,
     * not the gradient or the ::before. Opening one page to look closely at it
     * is exactly when that difference matters, so the real document is kept for
     * that. Its images are stored in the same place every other picture is, so
     * keeping it costs the markup and not a second copy of the pictures.
     */
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

    /**
     * A picture of the page, encoded where the encoder is.
     *
     * Electron's nativeImage writes PNG and JPEG; the page has WebP, and for a
     * screenshot the difference is not marginal — at 1220 wide, WebP costs what
     * the old 420-wide PNG cost, so the raster gains three times the resolution
     * for the same bytes. Which is what makes it usable for anything but a
     * thumbnail.
     */
    async captureRaster({ width = 1220, quality = 0.82 } = {}) {
      const image = await screenshot().catch(() => null);
      if (!image || image.isEmpty()) return null;
      const size = image.getSize();
      const scaled = width && size.width > width
        ? image.resize({ width, height: Math.max(1, Math.round(size.height * (width / size.width))) })
        : image;
      const png = scaled.toDataURL();
      const webp = await evaluate(`(async () => {
        const image = new Image();
        await new Promise((resolve) => { image.onload = resolve; image.onerror = resolve; image.src = ${JSON.stringify(png)}; });
        if (!image.naturalWidth) return null;
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext("2d")?.drawImage(image, 0, 0);
        const encoded = canvas.toDataURL("image/webp", ${quality});
        return encoded.startsWith("data:image/webp") ? encoded : null;
      })()`).catch(() => null);
      const chosen = webp ?? png;
      const drawn = scaled.getSize();
      return { dataUrl: chosen, width: drawn.width, height: drawn.height };
    },

    close() {
      dispose();
    }
  };
}

module.exports = { createBrowsingSession };
