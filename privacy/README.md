# What Crank is allowed to do

Crank makes three promises: your project is never written to, your scans never leave your machine, and nothing is reported anywhere. Promises are worth what they can be checked against, so the files that actually enforce them are here.

These are **copies of what the app runs** — not a summary of it, and not a reimplementation. [`verify.sh`](verify.sh) compares them byte for byte with the copy inside a `Crank.app` you downloaded:

```sh
./verify.sh /Applications/Crank.app
```

Electron ships its code as plain JavaScript inside `app.asar`. Nothing is minified or obfuscated, so this comparison is exact, and any drift between this folder and a build shows up as a `DIFFERS` line.

[中文](README.zh-CN.md)

---

## Where each promise lives

### Your project is never written to

[`electron/request-policy.cjs`](electron/request-policy.cjs) decides every request a scan is allowed to make. Anything that is not a `GET` or `HEAD` is cancelled — that is the whole of it, in one function you can read in a minute. Third-party scripts and data calls are cancelled too, so a page cannot run someone else's code inside your project while it is being scanned.

[`electron/state-discovery.cjs`](electron/state-discovery.cjs) walks the app by clicking. `isDestructiveLabel` is the list of words it refuses to click — delete, sign out, pay, publish, and their Chinese equivalents. Two guards for one risk, because a crawl is clicking around inside someone's real application.

The tests state the behaviour as claims:

```sh
node --test electron/request-policy.test.cjs electron/page-origin.test.cjs
```

### It does not wander off into the rest of your machine

[`electron/page-origin.cjs`](electron/page-origin.cjs) decides what counts as "the app being scanned". A page loaded from disk has no origin — every browser calls it `null` — so the folder the interface was loaded from stands in for one, and everything outside it is refused. A scan of an installed app cannot follow a link into your home folder.

### Nothing leaves the machine

[`electron/figma-bridge.cjs`](electron/figma-bridge.cjs) is the only server Crank runs. It binds to `localhost` and speaks to one thing: the Figma plugin, on the same computer. [`figma-plugin/manifest.json`](figma-plugin/manifest.json) declares `http://localhost:38457` as the plugin's only allowed address — that allowlist is enforced by Figma itself, not by us.

There is no telemetry, no analytics, no crash reporting and no update check anywhere in the app. That is a claim you can check with a grep over this folder, and over the whole `app.asar` if you extract it.

**One honest exception.** [`electron/html-snapshot.cjs`](electron/html-snapshot.cjs) re-fetches the fonts and images that the page being scanned already loaded, so the handoff page can carry them instead of pointing at a font host. A scan therefore does make requests to addresses the page itself uses — exactly the ones your browser requests when you open that page, and nothing else.

### Where scans are kept

[`electron/inventory-registry.cjs`](electron/inventory-registry.cjs) writes everything to `~/Library/Application Support/Crank/`. Removing a project from the list deletes its scan; deleting that folder deletes all of it. Nothing is written to your project's folder.

### What the interface can reach

[`electron/preload.cjs`](electron/preload.cjs) is the entire surface the window is given — one file, one list. Anything not on it, the interface cannot do.

### What is read from a page

[`electron/browsing-session.cjs`](electron/browsing-session.cjs) is everything a scan does to a page: wait, scroll, read, screenshot, click. [`electron/figma-tree.cjs`](electron/figma-tree.cjs) is what is read out of it — geometry, text, colour, and the images the page draws. [`electron/cdp-session.cjs`](electron/cdp-session.cjs) is the same work against an app you are already running, over its debugging port, with the same request policy enforced.

[`electron/app-bundle.cjs`](electron/app-bundle.cjs) is how a dropped `.app` is opened: your real app, with your real data, started with a debugging port and closed again afterwards. It is deliberately not given a fresh profile — a signed-out copy of an app is a tour of its login screen — which is also why nothing about it is sent anywhere.

---

## What is not here

The rest of the application: the scan pipeline, the interface, the Figma plugin's rendering. Those are not published yet. This folder is the part where a claim about your data can be checked, and it is complete for that purpose — if something here says a request is cancelled, that is the code that cancels it.
