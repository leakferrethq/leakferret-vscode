// Platform detection helpers. Mirrors `leakferret-npm/packages/cli/lib/platform.js`.
//
// The Rust binary is published as one tarball per (arch, os) triple. These
// helpers compute the triple at runtime so we know which binary to download
// (postinstall) and which one to resolve (`binary.ts`).

export type Arch = 'x86_64' | 'aarch64';
export type Triple =
  | 'x86_64-unknown-linux-gnu'
  | 'x86_64-apple-darwin'
  | 'aarch64-apple-darwin'
  | 'x86_64-pc-windows-msvc'
  | 'aarch64-pc-windows-msvc';

export function detectPlatform(): Triple {
  const arch = process.arch;
  const platform = process.platform;

  let cpu: Arch;
  if (arch === 'x64') {
    cpu = 'x86_64';
  } else if (arch === 'arm64') {
    cpu = 'aarch64';
  } else {
    throw new Error(`unsupported CPU arch: ${arch}`);
  }

  if (platform === 'linux') {
    if (cpu === 'aarch64') throw new Error('aarch64-linux has no prebuilt binary yet; build from source');
    return `${cpu}-unknown-linux-gnu` as Triple;
  }
  if (platform === 'darwin') {
    return `${cpu}-apple-darwin` as Triple;
  }
  if (platform === 'win32') {
    return `${cpu}-pc-windows-msvc` as Triple;
  }
  throw new Error(`unsupported platform: ${platform}`);
}

export function binaryName(): string {
  return process.platform === 'win32' ? 'leakferret.exe' : 'leakferret';
}
