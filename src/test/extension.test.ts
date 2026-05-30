import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { scanFile } from '../scanner';
import { findingsToDiagnostics } from '../diagnostics';

const EXT_ID = 'leakferrethq.leakferret';

suite('leakferret extension host', () => {
  test('activates and registers its commands', async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} not found`);
    await ext.activate();

    const commands = await vscode.commands.getCommands(true);
    for (const id of ['leakferret.scan', 'leakferret.verify', 'leakferret.rewrite']) {
      assert.ok(commands.includes(id), `command not registered: ${id}`);
    }
  });

  test('scans a planted secret and renders it as a diagnostic', async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-vscode-'));
    const file = path.join(dir, 'config.rb');
    fs.writeFileSync(file, "AWS_ACCESS_KEY = 'AKIAQ7W2E3R4T5Y6U7I8'\n");

    // Drives the binary through the extension's own scanner (resolveBinary
    // honours LEAKFERRET_BIN / the vendored binary).
    const findings = await scanFile(ext.extensionPath, file);
    assert.ok(findings.length >= 1, 'scanner returned no findings');
    assert.ok(
      findings.some((f) => f.pattern === 'aws_access_key'),
      'aws_access_key not detected',
    );

    const diagnostics = findingsToDiagnostics(findings);
    assert.ok(diagnostics.length >= 1, 'no diagnostics produced');
    assert.ok(
      diagnostics.some((d) => d.code === 'aws_access_key'),
      'no aws_access_key diagnostic',
    );
  });
});
