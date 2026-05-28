# Changelog

All notable changes to the `leakferret` VS Code extension are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
