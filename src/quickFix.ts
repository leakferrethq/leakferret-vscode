// CodeActionProvider exposing two Quick Fixes per `leakferret` diagnostic:
//
//   1. "Replace with ENV.fetch" — defers to the binary's `rewrite --apply`
//      subcommand, which knows how to render the right idiom for each
//      language (ENV.fetch in Ruby, process.env.X in JS, os.environ in
//      Python, etc.).
//   2. "Add to allowlist (this line)" — inserts the comment marker
//      `# leakferret:allow` (or the language-appropriate prefix) on the
//      offending line so the scanner skips it next run.
//
// Both actions are wired through commands so the binary call stays in
// `extension.ts` (single place that owns the spawn lifecycle).

import * as vscode from 'vscode';
import { DIAGNOSTIC_SOURCE } from './diagnostics';

export const REWRITE_COMMAND = 'leakferret.applyRewrite';
export const ALLOWLIST_COMMAND = 'leakferret.addToAllowlist';

/**
 * Pattern IDs the binary knows how to rewrite. Anything else gets the
 * allowlist action only. We keep the list permissive — the binary itself
 * is the authority on whether a rewrite is actually possible; the CodeAction
 * just decides whether to offer the option.
 */
const REWRITEABLE_PATTERNS = new Set<string>([
  'aws_access_key_id',
  'aws_secret_access_key',
  'gcp_service_account_key',
  'github_pat',
  'github_oauth',
  'slack_token',
  'stripe_live_key',
  'stripe_test_key',
  'openai_api_key',
  'anthropic_api_key',
  'generic_api_key',
  'generic_high_entropy',
  'private_key_pem',
]);

export class LeakferretCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedKinds = [vscode.CodeActionKind.QuickFix];

  public provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diag of context.diagnostics) {
      if (diag.source !== DIAGNOSTIC_SOURCE) {
        continue;
      }
      const patternId = typeof diag.code === 'string' ? diag.code : '';

      if (!patternId || REWRITEABLE_PATTERNS.has(patternId)) {
        actions.push(this.buildRewriteAction(document, diag));
      }
      actions.push(this.buildAllowlistAction(document, diag));
    }
    return actions;
  }

  private buildRewriteAction(
    document: vscode.TextDocument,
    diag: vscode.Diagnostic,
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(
      'Replace with ENV.fetch (leakferret)',
      vscode.CodeActionKind.QuickFix,
    );
    action.diagnostics = [diag];
    action.isPreferred = true;
    action.command = {
      title: 'leakferret: rewrite',
      command: REWRITE_COMMAND,
      arguments: [document.uri, diag.range],
    };
    return action;
  }

  private buildAllowlistAction(
    document: vscode.TextDocument,
    diag: vscode.Diagnostic,
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(
      'Add to allowlist (this line)',
      vscode.CodeActionKind.QuickFix,
    );
    action.diagnostics = [diag];
    action.command = {
      title: 'leakferret: allowlist',
      command: ALLOWLIST_COMMAND,
      arguments: [document.uri, diag.range],
    };
    return action;
  }
}

/**
 * Build a WorkspaceEdit that appends `# leakferret:allow` (or the
 * language-appropriate equivalent) to the end of the offending line.
 */
export async function applyAllowlistEdit(
  uri: vscode.Uri,
  range: vscode.Range,
): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const line = doc.lineAt(range.start.line);
  const commentMarker = allowlistMarkerForLanguage(doc.languageId);
  const trimmed = line.text.replace(/\s+$/, '');
  const newText = `${trimmed} ${commentMarker}`;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, line.range, newText);
  await vscode.workspace.applyEdit(edit);
  await doc.save();
}

function allowlistMarkerForLanguage(languageId: string): string {
  switch (languageId) {
    case 'javascript':
    case 'typescript':
    case 'go':
    case 'json':
      return '// leakferret:allow';
    case 'python':
    case 'ruby':
    case 'yaml':
    case 'dotenv':
    case 'shellscript':
      return '# leakferret:allow';
    default:
      return '# leakferret:allow';
  }
}
