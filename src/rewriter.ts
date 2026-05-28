// Invokes the Rust binary's `rewrite` subcommand to convert hardcoded
// secret literals into language-aware env-var lookups
// (e.g. `ENV.fetch("AWS_ACCESS_KEY_ID")` in Ruby, `process.env.X` in JS).
//
// The CLI handles language detection per-file; we just point it at the
// specific path with `--only` and pass `--apply` to mutate on disk.

import { resolveBinary, spawnBinary } from './binary';

export interface RewriteOptions {
  /** When true, writes changes to disk. When false, dry-run. */
  apply: boolean;
  /** Working directory for the spawned process. */
  cwd?: string;
}

export interface RewriteResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export async function rewriteFile(
  extensionPath: string,
  filePath: string,
  options: RewriteOptions,
): Promise<RewriteResult> {
  const bin = resolveBinary(extensionPath);
  const args = [
    'rewrite',
    filePath,
    '--format',
    'json',
    '--backend',
    'env',
    '--only',
    filePath,
  ];
  if (options.apply) {
    args.push('--apply');
  }
  const result = await spawnBinary(bin, args, { cwd: options.cwd });
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(
      `leakferret rewrite exited ${result.code}: ${result.stderr.trim()}`,
    );
  }
  return result;
}
