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
import * as vscode from 'vscode';

import { detectPlatform, binaryName } from './platform';

// The leakferret core release this extension pulls its binary from. Tracked
// independently of the extension's own version.
export const BINARY_VERSION = '0.1.3';

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
