// Entry point. Owns the extension lifecycle:
//
//   activate()
//     - registers the diagnostic collection
//     - wires the CodeActionProvider for supported languages
//     - subscribes to onDidSaveTextDocument (scan-on-save flow)
//     - registers the three palette commands
//
//   deactivate()
//     - disposes the diagnostic collection (subscriptions handle the rest)
//
// On every save of a supported file (and if `leakferret.scanOnSave` is
// true), we:
//   1. spawn the binary's `scan` subcommand against the saved file
//   2. ask the host LM to classify each candidate as REAL / FIXTURE / UNKNOWN
//   3. publish the resulting diagnostics
//
// Commands:
//   leakferret.scan      — manual scan of the active editor
//   leakferret.verify    — run `leakferret verify` over the workspace
//   leakferret.rewrite   — run `leakferret rewrite --apply` on the active file

import * as path from 'node:path';

import * as vscode from 'vscode';
import { resolveBinary, spawnBinary } from './binary';
import { classify } from './classifier';
import {
  createDiagnosticCollection,
  setFindingsForUri,
} from './diagnostics';
import {
  ALLOWLIST_COMMAND,
  REWRITE_COMMAND,
  LeakferretCodeActionProvider,
  applyAllowlistEdit,
} from './quickFix';
import { rewriteFile } from './rewriter';
import { rewriteFindingInteractive } from './inlineRewrite';
import { scanFile } from './scanner';
import { Finding } from './types';

const SUPPORTED_LANGUAGES = [
  'javascript',
  'typescript',
  'python',
  'ruby',
  'go',
  'yaml',
  'json',
];

const SUPPORTED_EXTENSIONS = new Set<string>([
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.py',
  '.rb',
  '.go',
  '.yaml',
  '.yml',
  '.json',
]);

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = createDiagnosticCollection();
  context.subscriptions.push(diagnostics);

  // Quick-fix provider — registered for the supported languages plus
  // any file-scheme document so .env files (which have no languageId
  // by default) still get fixes.
  const selector: vscode.DocumentSelector = [
    ...SUPPORTED_LANGUAGES.map((language) => ({ scheme: 'file', language })),
    { scheme: 'file', pattern: '**/.env*' },
  ];
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      selector,
      new LeakferretCodeActionProvider(),
      { providedCodeActionKinds: LeakferretCodeActionProvider.providedKinds },
    ),
  );

  // Scan on save.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const cfg = vscode.workspace.getConfiguration('leakferret');
      if (!cfg.get<boolean>('scanOnSave', true)) {
        return;
      }
      if (!isSupportedDocument(doc)) {
        return;
      }
      await runScanFlow(context, diagnostics, doc);
    }),
  );

  // Palette commands.
  context.subscriptions.push(
    vscode.commands.registerCommand('leakferret.scan', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(
          'leakferret: open a file in the editor first.',
        );
        return;
      }
      await runScanFlow(context, diagnostics, editor.document);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('leakferret.verify', async () => {
      await runVerifyCommand(context, diagnostics);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('leakferret.rewrite', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(
          'leakferret: open a file in the editor first.',
        );
        return;
      }
      await runRewriteCommand(context, editor.document.uri);
    }),
  );

  // Quick-fix-invoked commands.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      REWRITE_COMMAND,
      async (uri: vscode.Uri, range: vscode.Range) => {
        try {
          // Per-finding interactive rewrite (asks for the env-var name and
          // offers to move the secret into .env). Falls back to the whole-file
          // CLI rewrite for languages it doesn't handle inline.
          const handled = range ? await rewriteFindingInteractive(uri, range) : false;
          if (!handled) {
            await runRewriteCommand(context, uri);
          }
        } catch (err) {
          vscode.window.showErrorMessage(
            `leakferret: rewrite failed: ${(err as Error).message}`,
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      ALLOWLIST_COMMAND,
      async (uri: vscode.Uri, range: vscode.Range) => {
        try {
          await applyAllowlistEdit(uri, range);
        } catch (err) {
          vscode.window.showErrorMessage(
            `leakferret: allowlist edit failed: ${(err as Error).message}`,
          );
        }
      },
    ),
  );
}

export function deactivate(): void {
  // Subscriptions auto-dispose. Nothing else to clean up.
}

function isSupportedDocument(doc: vscode.TextDocument): boolean {
  if (doc.uri.scheme !== 'file') {
    return false;
  }
  if (SUPPORTED_LANGUAGES.includes(doc.languageId)) {
    return true;
  }
  const path = doc.uri.fsPath.toLowerCase();
  for (const ext of SUPPORTED_EXTENSIONS) {
    if (path.endsWith(ext)) {
      return true;
    }
  }
  // `.env`, `.env.local`, etc. — VS Code may classify these as 'dotenv',
  // 'plaintext', or nothing depending on the user's extensions.
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const basename = path.slice(lastSlash + 1);
  return basename.startsWith('.env');
}

async function runScanFlow(
  context: vscode.ExtensionContext,
  diagnostics: vscode.DiagnosticCollection,
  doc: vscode.TextDocument,
): Promise<void> {
  try {
    const findings = await scanFile(context.extensionPath, doc.uri.fsPath);
    if (findings.length === 0) {
      setFindingsForUri(diagnostics, doc.uri, []);
      return;
    }

    const cfg = vscode.workspace.getConfiguration('leakferret');
    const preferredFamily = cfg.get<string>('classifierModel', '').trim();

    const cts = new vscode.CancellationTokenSource();
    try {
      const classified = await classify(findings, preferredFamily, cts.token);
      setFindingsForUri(diagnostics, doc.uri, classified);
    } finally {
      cts.dispose();
    }
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    console.error('[leakferret] scan flow failed:', err);
    vscode.window.showErrorMessage(`leakferret: scan failed — ${message}`);
  }
}

async function runRewriteCommand(
  context: vscode.ExtensionContext,
  uri: vscode.Uri,
): Promise<void> {
  try {
    await rewriteFile(context.extensionPath, uri.fsPath, { apply: true });
    vscode.window.showInformationMessage(
      `leakferret: rewrote ${uri.fsPath}. Review the diff before committing.`,
    );
    // Reload the document so the editor reflects on-disk changes, then
    // re-scan so stale diagnostics clear.
    await vscode.workspace.openTextDocument(uri);
    const cfg = vscode.workspace.getConfiguration('leakferret');
    if (cfg.get<boolean>('scanOnSave', true)) {
      await vscode.commands.executeCommand('leakferret.scan');
    }
  } catch (err) {
    vscode.window.showErrorMessage(
      `leakferret: rewrite failed — ${(err as Error).message}`,
    );
  }
}

async function runVerifyCommand(
  context: vscode.ExtensionContext,
  diagnostics: vscode.DiagnosticCollection,
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage(
      'leakferret: open a workspace folder first.',
    );
    return;
  }
  const cfg = vscode.workspace.getConfiguration('leakferret');
  const mode = cfg.get<string>('verifyMode', 'best-effort');
  const bin = await resolveBinary(context.extensionPath);
  const root = folders[0].uri.fsPath;
  try {
    const result = await spawnBinary(
      bin,
      ['verify', root, '--format', 'json', '--verify-mode', mode],
      { cwd: root },
    );
    if (result.code !== 0 && result.code !== 1) {
      throw new Error(result.stderr.trim() || `exit ${result.code}`);
    }
    let findings: Finding[] = [];
    try {
      findings = JSON.parse(result.stdout || '[]') as Finding[];
    } catch {
      findings = [];
    }
    // Publish diagnostics per file so each finding is clickable (jumps to its
    // line in the Problems panel) and shows its severity.
    diagnostics.clear();
    const byFile = new Map<string, Finding[]>();
    for (const f of findings) {
      const abs = path.isAbsolute(f.path) ? f.path : path.join(root, f.path);
      byFile.set(abs, [...(byFile.get(abs) ?? []), f]);
    }
    for (const [file, group] of byFile) {
      setFindingsForUri(diagnostics, vscode.Uri.file(file), group);
    }
    const verified = findings.filter(
      (f) => f.verification?.status === 'verified',
    ).length;
    vscode.window.showInformationMessage(
      `leakferret: ${findings.length} finding(s), ${verified} verified live — see the Problems panel.`,
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `leakferret: verify failed — ${(err as Error).message}`,
    );
  }
}
