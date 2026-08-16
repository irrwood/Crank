# UI Sync Bridge for Figma

This local companion plugin creates missing screen frames and restores existing mappings by stable shared plugin data.

Install it once in the Figma desktop app:

1. Open **Plugins → Development → Import plugin from manifest…**
2. Choose `manifest.json` in this folder.
3. Keep UI Sync Desktop running, then launch **UI Sync Bridge** in the connected Figma Design file.

The plugin only connects to `localhost:38457`. It receives screen names and opaque stable IDs, not Swift source code.
