import { defineConfig } from '@vscode/test-cli';

// Runs the compiled Mocha suite inside a real VS Code Extension Host.
// The extension resolves its binary via LEAKFERRET_BIN (set when running
// locally) or the vendored dist/bin copy (downloaded by postinstall in CI).
//
// Set VSCODE_TEST_EXE to an installed Code.exe to reuse it instead of
// downloading a fresh VS Code (handy on bandwidth-limited machines). CI
// leaves it unset and downloads its own.
const fromPath = process.env.VSCODE_TEST_EXE;

export default defineConfig({
  files: 'out/test/**/*.test.js',
  version: 'stable',
  ...(fromPath ? { useInstallation: { fromPath } } : {}),
  mocha: {
    ui: 'tdd',
    timeout: 60000,
  },
});
