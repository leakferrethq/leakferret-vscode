# leakferret for VS Code

> AI agents shouldn't commit live secrets. Neither should you.

`leakferret` is a context-aware secret scanner that runs the moment you
save a file. The moment a hardcoded AWS key, GitHub token, or Stripe
secret hits disk, the IDE flags it with a red squiggle and offers a one-
click Quick Fix: replace the literal with `ENV.fetch("...")` (or the
equivalent for your language) and add the variable to `.env.example`.

The killer feature: **classification runs on your own LLM** via
`vscode.lm.sendRequest`. If you already have GitHub Copilot Chat, Claude
in VS Code, or any other provider that ships a `vscode.lm` chat model,
the extension uses it. No extra API key. No SaaS account. No new bill.

## What it does

- **Scan on save.** Every save of a supported file shells out to the
  `leakferret` binary, which regex-scans the file and produces a
  redacted-preview JSON report.
- **Classify with your own LLM.** Each candidate is sent to your host
  language model with the redacted preview (first 4 + last 4 chars) and
  a few lines of surrounding context — never the secret itself. The model
  returns a verdict: `REAL`, `FIXTURE`, or `UNKNOWN`.
- **Surface as diagnostics.**
  - `REAL` → Error (red squiggle, shows in Problems pane)
  - `UNKNOWN` → Warning (yellow squiggle)
  - `FIXTURE` → suppressed (no nag for known test data)
- **Quick Fix on every finding.**
  - "Replace with ENV.fetch (leakferret)" — invokes
    `leakferret rewrite --apply --only <file>`, which rewrites the
    literal to an env-var lookup in the right idiom for your language
    (`ENV.fetch` in Ruby, `process.env.X` in JS/TS, `os.environ` in
    Python, and so on).
  - "Add to allowlist (this line)" — inserts a `# leakferret:allow`
    comment so the scanner skips this line next time.

## Privacy

The extension never sends the actual secret value anywhere. The binary
redacts every match to first 4 + last 4 characters before any output
leaves the process. The LM classification call receives only that
redacted preview and a handful of surrounding lines.

## Install

This extension is not yet published to the Marketplace. To run from
source:

```bash
git clone https://github.com/leakferrethq/leakferret-vscode.git
cd leakferret-vscode
npm install
npm run compile
```

Then open the folder in VS Code and press `F5` to launch the Extension
Development Host. Once published the install link will be
`https://marketplace.visualstudio.com/items?itemName=leakferrethq.leakferret`.

The `npm install` postinstall step downloads the platform-specific
`leakferret` binary into `dist/bin/`. If the download fails (release not
yet published, offline machine, etc.) the extension still installs — set
`leakferret.binaryPath` to point at a local copy of the binary.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `leakferret.binaryPath` | `""` | Absolute path to the `leakferret` binary. Empty = use the bundled binary. |
| `leakferret.scanOnSave` | `true` | Scan every save automatically. |
| `leakferret.classifierModel` | `""` | Preferred LM family (e.g. `gpt-4o`, `claude-3.5-sonnet`). Empty = pick the first available. |
| `leakferret.verifyMode` | `"best-effort"` | Verifier mode for `leakferret verify`. One of `off`, `best-effort`, `strict`. |

## Commands

All commands are available from the Command Palette (`Ctrl+Shift+P` /
`Cmd+Shift+P`).

- `leakferret: Scan current file`
- `leakferret: Verify findings against providers`
- `leakferret: Rewrite literals to ENV.fetch`

## Known limitations

- The `vscode.lm` chat-model API is only available in VS Code **1.90+**.
  On older versions the extension still surfaces findings, but they all
  come through as Warnings (no LM classification).
- There is no JetBrains / IntelliJ port yet. The classification flow is
  VS Code-specific because it depends on the `vscode.lm` API.
- The binary is downloaded by `scripts/postinstall.js`. Air-gapped
  installs need to either ship the binary manually and point
  `leakferret.binaryPath` at it, or set `LEAKFERRET_SKIP_DOWNLOAD=1`
  during `npm install` and provide the binary out of band.

## Image / icon

The marketplace icon at `images/icon.png` is a placeholder. Before
publishing, replace it with a 128x128 PNG.

## License

MIT. See [LICENSE](./LICENSE).
