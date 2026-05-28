'use strict';

// Post-install: download the platform-specific `leakferret` binary into
// `dist/bin/`. Mirrors the strategy used by `@leakferret/cli` so users
// who already have that npm package installed share the binary cache.
//
// Behavior:
//   - If LEAKFERRET_BIN is set, skip the download (the user has their own).
//   - If LEAKFERRET_SKIP_DOWNLOAD=1, skip (CI / offline builds).
//   - Otherwise download from the release host, verify, and chmod.
//
// The script must be idempotent: re-running it after a successful download
// should be a no-op.

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BIN_DIR = path.join(ROOT, 'dist', 'bin');
const PACKAGE_JSON = require(path.join(ROOT, 'package.json'));

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
  if (platform === 'linux') return `${cpu}-unknown-linux-gnu`;
  if (platform === 'darwin') return `${cpu}-apple-darwin`;
  if (platform === 'win32') return `${cpu}-pc-windows-gnu`;
  throw new Error(`unsupported platform: ${platform}`);
}

function binaryName() {
  return process.platform === 'win32' ? 'leakferret.exe' : 'leakferret';
}

function tarballUrl(version, triple) {
  const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
  const base =
    process.env.LEAKFERRET_RELEASE_BASE ||
    'https://github.com/leakferrethq/leakferret/releases/download';
  return `${base}/v${version}/leakferret-v${version}-${triple}.${ext}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function fetchToFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error(`too many redirects fetching ${url}`));
      return;
    }
    https
      .get(url, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          fetchToFile(res.headers.location, dest, redirects + 1).then(
            resolve,
            reject,
          );
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', reject);
      })
      .on('error', reject);
  });
}

function unpack(archivePath, destDir) {
  if (archivePath.endsWith('.zip')) {
    // Windows: use PowerShell's Expand-Archive (always available on 5.1+).
    const res = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`,
      ],
      { stdio: 'inherit' },
    );
    if (res.status !== 0) {
      throw new Error(`Expand-Archive failed (exit ${res.status})`);
    }
    return;
  }
  const res = spawnSync('tar', ['-xzf', archivePath, '-C', destDir], {
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    throw new Error(`tar -xzf failed (exit ${res.status})`);
  }
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
  ensureDir(BIN_DIR);
  const target = path.join(BIN_DIR, binaryName());
  if (fs.existsSync(target)) {
    console.log(`[leakferret] binary already present at ${target}`);
    return;
  }

  const triple = detectPlatform();
  const url = tarballUrl(PACKAGE_JSON.version, triple);
  const archive = path.join(
    BIN_DIR,
    `leakferret.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`,
  );

  console.log(`[leakferret] downloading ${url}`);
  try {
    await fetchToFile(url, archive);
    unpack(archive, BIN_DIR);
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(target, 0o755);
      } catch (err) {
        console.warn(
          `[leakferret] chmod 755 failed for ${target}: ${err.message}`,
        );
      }
    }
    fs.unlinkSync(archive);
    console.log(`[leakferret] installed binary at ${target}`);
  } catch (err) {
    console.warn(
      `[leakferret] postinstall could not fetch the binary: ${err.message}`,
    );
    console.warn(
      '[leakferret] the extension will still install. Set "leakferret.binaryPath" to a local binary, or re-run install when the release is published.',
    );
    // Never fail the install — VS Code rejects extensions whose
    // postinstall scripts exit non-zero.
  }
}

main().catch((err) => {
  console.warn(`[leakferret] postinstall error (non-fatal): ${err.message}`);
});
