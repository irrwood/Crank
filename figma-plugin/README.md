# Crank for Figma

The companion plugin. Crank runs on your computer, walks your project, and
sends the layers here; this plugin builds them in the open Figma file and
remembers which frame each page became, so a second run updates those frames
instead of drawing new ones beside them.

## Install it for development

1. In the Figma desktop app, open **Plugins → Development → Import plugin from
   manifest…**
2. Choose `manifest.json` in this folder.
3. Keep Crank running on the same computer, then run **Crank** from the
   Plugins menu in the file you want the pages to land in.

## What it can reach

`localhost:38457`, and nothing else. That is the Crank app on the same machine.

It receives the captured pages, and after building them it sends back the Figma
file name, the IDs of the frames it created, and the text, size, colour and font
of those layers. That return trip is not incidental: it is how a later run finds
the same frames instead of duplicating them, and how Crank can tell what someone
changed in Figma. It is also Figma file content leaving the file, which is why
the manifest says so rather than describing only the IDs.

Nothing goes to the internet.

## Publishing

The plugin is useless on its own — it does nothing until the desktop app is
running and has something to send. Whichever way it is published, the
description has to say that first, or someone will install it and see a plugin
that appears to hang.

`icon-128.png` in this folder is the icon to upload — the same artwork as the
desktop app, but filling the frame rather than sitting inside the transparent
margin macOS expects, because Figma draws its own frame around it.

Before submitting, check that:

- `manifest.json` carries the current `name` and its existing `id`;
- `networkAccess.reasoning` still describes what the plugin actually does,
  since review reads it against the code;
- the version in the file is the one that has been run end to end, because the
  published build is a snapshot, not a link to this folder.
