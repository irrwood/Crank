# Crank for Codex

This directory is Crank's native MCP App canvas inside Codex. It is not a
desktop App embedded in an iframe: the widget is the infinite-canvas UI layer,
while the MCP server owns repository state, source context, capture, and change
manifests. Its single-file build is served by `electron/mcp-server.cjs`.

The intended product/package boundary between the independent Desktop app,
the independent Codex plugin, and their shared engine is documented in
[`docs/desktop-codex-shared-engine.md`](../docs/desktop-codex-shared-engine.md).

Run `npm run build:codex`, then open `codex/dist/flow-widget.html` in a browser
to exercise the standalone sample. Inside Codex, `open_crank_canvas` restores
the repo-bound scene and intent without rescanning; `get_page_image` and
`get_page_document` hydrate real captures. `get_selection`,
`get_flow_selection`, and `get_source_context` keep model context bounded to
what the user selected.

Repository state:

```text
.crank/
  scene.json
  flow.json
  changes.json
  assets/
```

`sync_from_code` is the only normal refresh path. `apply_change` stages the
manifest back into the repository and current Codex task; it never sends to
Figma.
