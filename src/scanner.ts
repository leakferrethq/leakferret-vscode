// Invokes the Rust binary's `scan` subcommand against a single file.
//
// The contract:
//   leakferret scan <root> --format json --only <file>
//
// stdout is a JSON array of `Finding` records. Exit code 0 = clean,
// exit code 1 = findings present (still a successful run), anything
// else = real failure.

import { resolveBinary, spawnBinary } from './binary';
import { Finding } from './types';

export interface ScanOptions {
  /** Restrict scan to these file paths (passed as --only). */
  only?: string[];
  /** Override the working directory the binary runs in. */
  cwd?: string;
}

export async function scanFile(
  extensionPath: string,
  filePath: string,
  options: ScanOptions = {},
): Promise<Finding[]> {
  const bin = resolveBinary(extensionPath);
  const args = ['scan', filePath, '--format', 'json'];
  const only = options.only ?? [filePath];
  for (const o of only) {
    args.push('--only', o);
  }

  const result = await spawnBinary(bin, args, { cwd: options.cwd });
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(
      `leakferret scan exited ${result.code}: ${result.stderr.trim()}`,
    );
  }
  const text = result.stdout.trim();
  if (!text) {
    return [];
  }
  try {
    // JSON-parse boundary — the only place we accept `unknown`.
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error('expected JSON array');
    }
    return parsed as Finding[];
  } catch (err) {
    throw new Error(
      `leakferret scan: malformed JSON output: ${(err as Error).message}`,
    );
  }
}
