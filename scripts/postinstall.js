'use strict';

// Post-install: download the platform-specific `leakferret` binary into
// `dist/bin/`. Mirrors `src/download.ts` (the runtime, .vsix code path) so the
// two stay in lockstep: same pinned binary version, same pinned checksums, and
// the same pure-JS extraction — no shelling out to `tar`, which on Windows
// mis-reads `C:\...` as a remote host and fails.
//
// Behavior:
//   - If LEAKFERRET_BIN is set, skip the download (the user has their own).
//   - If LEAKFERRET_SKIP_DOWNLOAD=1, skip (CI / offline builds, .vsix packaging).
//   - Otherwise download from the release host, verify the SHA256, and extract.
//
// The script must be idempotent: re-running it after a successful download is a
// no-op. It never exits non-zero — VS Code rejects extensions whose postinstall
// fails, and the binary is fetched on first use anyway (src/download.ts).

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const BIN_DIR = path.join(ROOT, 'dist', 'bin');

// The leakferret core release this extension pulls its binary from. Tracked
// independently of the extension's own version, and kept in sync with the
// BINARY_VERSION constant in src/download.ts. Bump both (and CHECKSUMS) on
// every binary release.
const BINARY_VERSION = '0.1.8';

// SHA256 of each release tarball, pinned to BINARY_VERSION. Must match the
// CHECKSUMS in src/download.ts. The download is verified against these before
// extraction, so a tampered or corrupted release asset is rejected rather than
// executed. Regenerate on every binary bump from the release's *.tar.gz.sha256.
const CHECKSUMS = {
  'aarch64-apple-darwin': '32c627059543edcc417021992c572765a4d05400cf00427f3f8054cb40ff59b8',
  'aarch64-pc-windows-msvc': '2c60bceeb07f44d8f8cb47175763cef4e06e7f81b13e39e83a67627e01828c9a',
  'x86_64-apple-darwin': '1ed1e72561a11fd562927f8e212c687fb6f6945109416baaae1b42cead27af2c',
  'x86_64-pc-windows-msvc': 'ab641bec8c3edcdfdd3484f28cca6df73f837d703f0884dfbbbb01941109da6a',
  'x86_64-unknown-linux-gnu': '403bff50678b9e5d566e3cb774046b30bc58e0fcc0b9a4c54f63507bed8a625a',
};

function detectPlatform() {
  const arch = process.arch;
  const platform = process.platform;
  let cpu;
  if (arch === 'x64') {
    cpu = 'x86_64';
  } else if (arch === 'arm64') {
    cpu = 'aarch64';
  } else {
    throw new Error(`unsupported CPU arch: ${arch}`);
  }
  if (platform === 'linux') {
    if (cpu === 'aarch64') throw new Error('aarch64-linux has no prebuilt binary yet; build from source');
    return `${cpu}-unknown-linux-gnu`;
  }
  if (platform === 'darwin') return `${cpu}-apple-darwin`;
  if (platform === 'win32') return `${cpu}-pc-windows-msvc`;
  throw new Error(`unsupported platform: ${platform}`);
}

function binaryName() {
  return process.platform === 'win32' ? 'leakferret.exe' : 'leakferret';
}

function tarballUrl(version, triple) {
  // Releases publish .tar.gz for every target (including Windows), and the
  // filename has no leading `v` before the version (only the path segment does).
  const base =
    process.env.LEAKFERRET_RELEASE_BASE ||
    'https://github.com/leakferrethq/leakferret/releases/download';
  return `${base}/v${version}/leakferret-${version}-${triple}.tar.gz`;
}

function fetchBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error(`too many redirects fetching ${url}`));
      return;
    }
    https
      .get(url, (res) => {
        const code = res.statusCode || 0;
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
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

// Minimal tar reader: return the contents of the first entry whose basename
// matches `want`. The archive nests files under leakferret-<ver>-<triple>/.
function extractFromTarGz(gzBuf, want) {
  const buf = zlib.gunzipSync(gzBuf);
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (name === '') break; // end-of-archive padding
    const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeOctal, 8) || 0;
    const dataStart = offset + 512;
    if (name.split('/').pop() === want && size > 0) {
      return buf.subarray(dataStart, dataStart + size);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

async function main() {
  if (process.env.LEAKFERRET_SKIP_DOWNLOAD === '1') {
    console.log('[leakferret] LEAKFERRET_SKIP_DOWNLOAD=1 — skipping.');
    return;
  }
  if (process.env.LEAKFERRET_BIN) {
    console.log(
      `[leakferret] LEAKFERRET_BIN set (${process.env.LEAKFERRET_BIN}) — skipping download.`,
    );
    return;
  }
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const target = path.join(BIN_DIR, binaryName());
  if (fs.existsSync(target)) {
    console.log(`[leakferret] binary already present at ${target}`);
    return;
  }

  const triple = detectPlatform();
  const url = tarballUrl(BINARY_VERSION, triple);

  console.log(`[leakferret] downloading ${url}`);
  try {
    const gz = await fetchBuffer(url);

    // Verify the tarball against the pinned hash before extracting or writing
    // anything, so tampered or corrupted bytes are never executed.
    const expected = CHECKSUMS[triple];
    if (!expected) {
      throw new Error(`no pinned checksum for ${triple}; refusing to install an unverified binary`);
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
      throw new Error(`binary ${binaryName()} not found inside ${url}`);
    }
    fs.writeFileSync(target, bin);
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(target, 0o755);
      } catch (err) {
        console.warn(`[leakferret] chmod 755 failed for ${target}: ${err.message}`);
      }
    }
    console.log(`[leakferret] installed binary at ${target}`);
  } catch (err) {
    console.warn(`[leakferret] postinstall could not fetch the binary: ${err.message}`);
    console.warn(
      '[leakferret] the extension will still install. Set "leakferret.binaryPath" to a local binary, or re-run install when the release is published.',
    );
    // Never fail the install — VS Code rejects extensions whose postinstall
    // scripts exit non-zero, and src/download.ts fetches on first use anyway.
  }
}

main().catch((err) => {
  console.warn(`[leakferret] postinstall error (non-fatal): ${err.message}`);
});
