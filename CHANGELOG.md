# Changelog

All notable changes to the `leakferret` VS Code extension are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.14] - 2026-06-03

### Changed
- Targets the leakferret `0.1.8` binary, which adds two MCP resources
  (`leakferret://secret-types` and `leakferret://verifiers`). Updates the pinned
  SHA256 checksums in `src/download.ts` and `scripts/postinstall.js`.

## [0.1.13] - 2026-06-03

### Fixed
- Postinstall now downloads the pinned core binary version (`0.1.7`) instead of
  deriving the URL from the extension version, which 404'd after the extension
  was bumped past the latest core release. It also verifies the release tarball
  against the pinned SHA256 and extracts in pure JS, matching `src/download.ts`.

## [0.1.11] - 2026-06-02

### Changed
- Enabled the Marketplace Q&A tab so users can ask questions on the listing.

## [0.1.1] - 2026-05-31

### Changed
- Targets the leakferret `0.1.1` binary (cosign-signed release, classifier
  precision and read-only-baseline fixes).

## [0.1.0] - 2026-05-27

### Added
- Initial release.
- Scan-on-save flow: runs the `leakferret` binary against each saved file
  and surfaces findings as diagnostics.
- Host-LM classification via `vscode.lm.sendRequest` — uses the user's
  Copilot / Claude / OpenAI provider, no extra API key required.
- Quick Fix: "Replace with ENV.fetch" invokes
  `leakferret rewrite --apply --only <file>`.
- Quick Fix: "Add to allowlist (this line)" inserts a `# leakferret:allow`
  comment.
- Commands: `leakferret.scan`, `leakferret.verify`, `leakferret.rewrite`.
- Configurable binary path, scan-on-save, classifier model, and verify mode.
- Bundled-binary download flow via `scripts/postinstall.js`.
