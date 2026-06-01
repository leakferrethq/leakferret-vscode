// Runtime download of the native `leakferret` binary.
//
// A `.vsix` installed from a marketplace never runs `scripts/postinstall.js`
// (that only runs on `npm install`), so the binary must be fetched on first
// use. We download straight into `<extensionRoot>/dist/bin/` — the installed
// extension directory is user-writable.
//
// Extraction is done in pure JS (gunzip + a minimal tar reader) rather than
// shelling out to `tar`, which on Windows mis-reads `C:\...` as a remote host.

import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';

import { detectPlatform, binaryName } from './platform';

// The leakferret core release this extension pulls its binary from. Tracked
// independently of the extension's own version.
export const BINARY_VERSION = '0.1.4';

// SHA256 of each release tarball, pinned to BINARY_VERSION. The download is
// verified against these before extraction, so a tampered or corrupted release
// asset is rejected rather than executed. Regenerate on every binary bump from
// the release's *.tar.gz.sha256 files.
const CHECKSUMS: Record<string, string> = {
  'aarch64-apple-darwin': '30539f730e84ec410d5adda34d0c0427002661e65706f5daa6b6739a10422ce0',
  'aarch64-pc-windows-msvc': 'ce1edb57bdeed1889a4c848b462432a8e888bdba7a7c7f4698dd62b1242697e4',
  'x86_64-apple-darwin': '50318959c66843b5cd2f1968aae58ae53f53890265374f9e70540d3b1f5710f6',
  'x86_64-pc-windows-msvc': '56b31c441b2f92ff4c708104dbfdb1bae65e25440cd95d2aeaaa08535a15a863',
  'x86_64-unknown-linux-gnu': 'bcb6ed3098379e794631c38d35037dc55c0d50e5645461faea574439cc477586',
};

function tarballUrl(version: string, triple: string): string {
  const base =
    process.env.LEAKFERRET_RELEASE_BASE ||
    'https://github.com/leakferrethq/leakferret/releases/download';
  return `${base}/v${version}/leakferret-${version}-${triple}.tar.gz`;
}

function fetchBuffer(url: string, redirects = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error(`too many redirects fetching ${url}`));
      return;
    }
    https
      .get(url, (res) => {
        const code = res.statusCode ?? 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          fetchBuffer(res.headers.location, redirects + 1).then(resolve, reject);
          return;
        }
        if (code !== 200) {
          res.resume();
          reject(new Error(`HTTP ${code} for ${url}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

// Minimal tar reader: return the contents of the first entry whose basename
// matches `want`. The archive nests files under leakferret-<ver>-<triple>/.
function extractFromTarGz(gzBuf: Buffer, want: string): Buffer | null {
  const buf = zlib.gunzipSync(gzBuf);
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (name === '') break; // end-of-archive padding
    const sizeOctal = header
      .subarray(124, 136)
      .toString('utf8')
      .replace(/\0.*$/, '')
      .trim();
    const size = parseInt(sizeOctal, 8) || 0;
    const dataStart = offset + 512;
    if (name.split('/').pop() === want && size > 0) {
      return buf.subarray(dataStart, dataStart + size);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

/**
 * Ensure the native binary is present in the extension, downloading it on
 * first use. Returns the absolute path, or null if the download failed (the
 * caller can then fall back to PATH / show an error).
 */
export async function ensureBinary(extensionRoot: string): Promise<string | null> {
  const binDir = path.join(extensionRoot, 'dist', 'bin');
  const target = path.join(binDir, binaryName());
  if (fs.existsSync(target)) {
    return target;
  }

  const triple = detectPlatform();
  const url = tarballUrl(BINARY_VERSION, triple);

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'leakferret: downloading scanner binary…',
      cancellable: false,
    },
    async () => {
      try {
        const gz = await fetchBuffer(url);

        // Verify the tarball against the pinned hash before extracting or
        // writing anything, so tampered or corrupted bytes are never executed.
        const expected = CHECKSUMS[triple];
        if (!expected) {
          throw new Error(
            `no pinned checksum for ${triple}; refusing to install an unverified binary`,
          );
        }
        const actual = crypto.createHash('sha256').update(gz).digest('hex');
        if (actual.toLowerCase() !== expected.toLowerCase()) {
          throw new Error(
            `checksum mismatch for ${url} (expected ${expected}, got ${actual}); ` +
              'refusing to install a binary that does not match the pinned hash',
          );
        }

        const bin = extractFromTarGz(gz, binaryName());
        if (!bin) {
          throw new Error(`binary not found inside ${url}`);
        }
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(target, bin);
        if (process.platform !== 'win32') {
          try {
            fs.chmodSync(target, 0o755);
          } catch {
            /* best effort */
          }
        }
        return target;
      } catch (err) {
        vscode.window.showErrorMessage(
          `leakferret: could not download the scanner binary — ${(err as Error).message}. ` +
            'Set "leakferret.binaryPath" to a local binary, or install the CLI on your PATH.',
        );
        return null;
      }
    },
  );
}
