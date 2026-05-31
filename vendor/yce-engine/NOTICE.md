# Notice

The YCE search engine vendored in this directory is adapted from:

- Repository: https://github.com/SammySnake-d/fast-context-mcp
- Upstream version used for vendored core files: `v1.3.0-beta.2`
- Upstream commit: `af65ce77a408656c815444397ef6892c47a96c0a`
- Upstream license: MIT, preserved at `lib/LICENSE.fast-context-mcp`

The MCP server wrapper is not used. The runtime entry point is `yce-engine.mjs`, which calls the vendored core search code directly.
