// Resolves the path to the `leakferret` binary and provides a typed
// `spawn` helper. Resolution order (first hit wins):
//
//   1. `leakferret.binaryPath` VS Code setting (if non-empty)
//   2. `LEAKFERRET_BIN` environment variable
//   3. The vendored binary downloaded by `scripts/postinstall.js` into
//      `<extensionRoot>/dist/bin/<binaryName>`
//   4. A binary named `leakferret` on the user's PATH (PATH lookup via
//      shell-free spawn — the caller may pass `shell: true` if needed)
//
// All paths are resolved relative to the extension installation directory,
// which the caller provides as `extensionPath`.

import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { binaryName } from './platform';

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function resolveBinary(extensionPath: string): string {
  const cfg = vscode.workspace.getConfiguration('leakferret');
  const override = cfg.get<string>('binaryPath', '').trim();
  if (override) {
    return override;
  }
  const envOverride = process.env.LEAKFERRET_BIN;
  if (envOverride) {
    return envOverride;
  }
  const vendored = path.join(extensionPath, 'dist', 'bin', binaryName());
  if (fs.existsSync(vendored)) {
    return vendored;
  }
  // Fall back to PATH lookup. spawn() will throw ENOENT if it isn't there,
  // and the caller surfaces that as a user-visible error.
  return binaryName();
}

/**
 * Spawn the binary with the given args and collect stdout/stderr.
 *
 * The binary uses exit code 1 to mean "findings present" — that's still a
 * successful run from our perspective, so the caller can distinguish on
 * `result.code`.
 */
export function spawnBinary(
  binary: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = cp.spawn(binary, args, {
      shell: false,
      cwd: options.cwd,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b: Buffer) => {
      stdout += b.toString();
    });
    proc.stderr.on('data', (b: Buffer) => {
      stderr += b.toString();
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
