// DiagnosticCollection management for `leakferret`.
//
// Mapping from finding verdict to diagnostic severity:
//   real     → Error    (red squiggle, surfaces in Problems pane)
//   unknown  → Warning  (yellow squiggle)
//   fixture  → suppressed entirely (the developer doesn't need a nag for
//              a known test fixture)
//
// The `code` on each diagnostic is set to the pattern ID — that gives the
// quick-fix provider a stable key to decide whether the rewrite Quick Fix
// applies to a given pattern.

import * as vscode from 'vscode';
import { Finding } from './types';

export const DIAGNOSTIC_SOURCE = 'leakferret';

export function createDiagnosticCollection(): vscode.DiagnosticCollection {
  return vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);
}

/**
 * Replace the diagnostics for a single document with those derived from
 * `findings`. Pass an empty array to clear.
 */
export function setFindingsForUri(
  collection: vscode.DiagnosticCollection,
  uri: vscode.Uri,
  findings: Finding[],
): void {
  collection.set(uri, findingsToDiagnostics(findings));
}

export function findingsToDiagnostics(findings: Finding[]): vscode.Diagnostic[] {
  const out: vscode.Diagnostic[] = [];
  for (const f of findings) {
    if (f.verdict === 'fixture') {
      continue;
    }
    out.push(toDiagnostic(f));
  }
  return out;
}

function toDiagnostic(f: Finding): vscode.Diagnostic {
  // Rust emits 1-based line/column; VS Code expects 0-based.
  const line = Math.max(f.line - 1, 0);
  const column = Math.max(f.column - 1, 0);
  const length = Math.max(f.match_redacted?.length ?? 16, 1);
  const range = new vscode.Range(
    new vscode.Position(line, column),
    new vscode.Position(line, column + length),
  );

  const severity =
    f.verdict === 'real'
      ? vscode.DiagnosticSeverity.Error
      : vscode.DiagnosticSeverity.Warning;

  const verdictLabel = (f.verdict ?? 'unknown').toUpperCase();
  const reason = f.reason ? ` — ${f.reason}` : '';
  const message = `[leakferret] ${f.pattern} (${f.severity}) — ${verdictLabel}${reason}`;

  const diag = new vscode.Diagnostic(range, message, severity);
  diag.source = DIAGNOSTIC_SOURCE;
  diag.code = f.pattern;
  return diag;
}
