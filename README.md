# Crank

**Scan a running application into editable Figma layers.**

Not screenshots — real text, vectors, images and layout you can select and edit. Scan the same project again and it updates the frames it made last time instead of drawing another set beside them.

Crank does not rebuild your interface. It runs the real one in Chromium and reads what the browser actually laid out, so what arrives is what the page renders.

[中文说明 →](README.zh-CN.md)

---

## Download

**[Crank 0.1.0 · macOS (Apple Silicon)](https://github.com/irrwood/Crank/releases/latest)** · 126MB

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

---

## Sending to Figma

The other half is a Figma plugin. The **Figma plugin** row at the bottom of the sidebar walks through it:

1. Get a pairing code
2. Import the plugin into Figma (the panel reveals the file in Finder)
3. Type the code once — this Mac is remembered from then on

---

## Your data

Scans, the project list and the Figma connection all stay **on your machine** (`~/Library/Application Support/Crank/`). Nothing is uploaded anywhere.

Capture only ever reads what the page has already drawn. Requests that would write are cancelled, third-party scripts and data calls are cancelled, and controls that read as destructive — delete, sign out, pay — are skipped. **It does not change your project.**

---

## Current limits

- Apple Silicon only
- Aimed at web and Electron applications; a native macOS app with no web runtime inside cannot be scanned, and Crank says so rather than trying
- A large project takes minutes to scan
- The interface follows the system language; both English and Chinese are still being polished
- The source is not published yet

---

## Feedback

Something broke, something came back wrong, or a page was missed — [open an issue](https://github.com/irrwood/Crank/issues) and paste the error text. Crank tries to name which page and which step failed, and that sentence is the useful part.

Apache-2.0
