# Crank

**Scan a running application into editable Figma layers.**

Not screenshots — real text, vectors, images and layout you can select and edit. Scan the same project again and it updates the frames it made last time instead of drawing another set beside them.

Crank does not rebuild your interface. A web app runs in Chromium and Crank reads what the browser actually laid out; a SwiftUI app is built, launched and asked to render itself. Either way what arrives is what the application draws.

**[crank website →](https://irrwood.github.io/Crank/)** · [中文说明 →](README.zh-CN.md)

---

## Download

**[Crank 0.3.0 · macOS (Apple Silicon)](https://github.com/irrwood/Crank/releases/latest)** · 126MB

Early build for testing. No Intel build yet.

### Opening it the first time

This build is **not signed or notarized**, so macOS blocks it and says the app is damaged. The file is fine — that message is Gatekeeper. Either:

- Right-click `Crank.app` → Open → Open again, or
- run this once:

```bash
xattr -dr com.apple.quarantine /Applications/Crank.app
```

---

## Using it

**Drop a project folder on the window.** Crank starts the project the way the project already declares: npm and pnpm projects run their own dev script, Electron projects serve the renderer without opening a window, Python and Ruby projects use the command their Dockerfile, Procfile or README already gives. It never invents a start command — a half-working start produces a confusing scan rather than an honest failure.

Then it walks every page it can reach. Routes, tabs and overlays each count as a page. A theme or language switch is not a new page; it is the same page wearing a different look, and is grouped with it. Every page records the exact steps to reach it again from a fresh load, so a page that takes a click is not a page that can only be found once.

Take the result as a self-contained HTML handoff page, or push the layers straight into a Figma file.

### When there is no folder to give

- **Drop a built `.app`.** Someone handed a build has no project to run — Crank opens the bundle with a debugging port, scans it, and closes it again. Electron-based desktop apps today.
- **Scan an address.** If the app is already running, give it the URL. Discovery only ever talks HTTP, so what the project is written in does not come into it.
- **Attach to the app you are using.** Serving an interface on its own usually gets an empty shell; the screens worth handing to a designer are the ones with real data in them, and those live in the copy you are actually running. Start it with a debugging port and Crank reads that window.
- **Click through it once and let Crank record.** For pages behind a login or a form.

### SwiftUI apps — iPhone and Mac (beta)

An Xcode project has no address to serve and no page to walk, so it takes a different road to the same place. Drop the folder and Crank copies the project into a workspace of its own, instruments the views in that copy, builds it with `xcodebuild`, and runs it — on the Simulator for an iPhone project, on this Mac for a desktop app. Each screen is exported through SwiftUI's own renderer as vectors, and arrives in Figma with text that is still text. Your project is never touched.

The folder you drop does not have to be the one the `.xcodeproj` sits in: the app's source folder, or a repository with the project in a subfolder, finds it either way.

It is beta because it asks more of the machine than the web path does:

- The full Xcode app, not the Command Line Tools, and an iOS Simulator runtime for iPhone projects
- Poppler, for turning exported pages into vectors: `brew install poppler`
- A first scan builds the whole project, so it takes minutes rather than seconds

Screens are found from the SwiftUI in the project — tabs, navigation destinations, sheets. An app that assembles its screens somewhere that cannot be read statically will export fewer than it has.

---

## The Figma plugin

Crank draws nothing in Figma by itself. The other half is a plugin, and it is not on the Figma Community yet — it ships inside the app and is imported by hand. This is a one-time setup.

**You need the Figma desktop app.** Figma in a browser cannot import a local plugin.

1. **Find the plugin.** In Crank, click **Figma plugin** at the bottom of the sidebar, then **Show plugin in Finder**. A `manifest.json` is revealed — it lives inside the app bundle, which is why the button exists.
2. **Import it.** In Figma: menu **Plugins → Development → Import plugin from manifest…**. In the dialog that opens, drag the revealed `manifest.json` onto it (or press ⌘⇧G and paste the path).
3. **Pair once.** Open the Figma file you want the pages in, run **Plugins → Development → Crank**, then back in Crank click **Get a pairing code** and type the six digits into the plugin. This Mac is remembered from then on — no code next time.

### Sending pages

1. Scan a project in Crank.
2. Paste the URL of the Figma design file you want them in (`https://www.figma.com/design/…`).
3. Open that same file in Figma and run the Crank plugin — it only writes to the file you named. If a different file is open, the plugin says which one it expected.
4. Press send. Frames are created the first time and updated on every run after, rather than drawn again beside the old ones.

If the plugin says something that does not match what Crank shows, re-import the manifest — Figma caches plugin code, and an old copy of the plugin talking to a new copy of Crank is the usual cause.

---

## Your data

Scans, the project list and the Figma connection all stay **on your machine** (`~/Library/Application Support/Crank/`). Nothing is uploaded anywhere.

Capture only ever reads what the page has already drawn. Requests that would write are cancelled, third-party scripts and data calls are cancelled, and controls that read as destructive — delete, sign out, pay — are skipped. **It does not change your project.**

Those are checkable claims rather than assurances: the files that enforce them are published in **[`privacy/`](privacy/)**, along with a script that compares them byte for byte with the copy inside the app you downloaded.

---

## Current limits

- Apple Silicon only
- Web, Electron and SwiftUI applications. A native Mac app that is neither built on a web runtime nor written in SwiftUI cannot be scanned, and Crank says so rather than trying
- A large project takes minutes to scan
- The interface follows the system language; both English and Chinese are still being polished
- The Swift parts — the SwiftUI scanner and the PDF compositor — are closed and kept in a private repository. They ship compiled inside the app, so scanning works; they cannot be built from this repository

---

## Building it yourself

```sh
npm install
npm test        # 373 tests, no network, no Electron window
npm run dev     # the app, from source
npm run package # a .app in release/
```

The interface can also run on its own, in a browser, with demo data — `npm run dev` and open the Vite address without Electron. Everything the app does to a page lives in `electron/`; [`privacy/`](privacy/) points at the files that decide what leaves your machine, and its `verify.sh` compares them with a build you downloaded.

## Feedback

Something broke, something came back wrong, or a page was missed — [open an issue](https://github.com/irrwood/Crank/issues) and paste the error text. Crank tries to name which page and which step failed, and that sentence is the useful part.

Apache-2.0
