// Interactive single-finding rewrite for the "Replace with ENV.fetch" Quick Fix.
//
// Unlike the whole-file CLI rewrite (still used by the `leakferret: Rewrite`
// command), this gives the developer control over the env-var name and offers
// to move the secret into `.env` in one step:
//
//   1. find the string literal on the finding's line,
//   2. ask for the env-var name (pre-filled with a sensible guess),
//   3. replace the literal with the language-appropriate lookup,
//   4. append the name to `.env.example`,
//   5. optionally append `NAME=<the secret>` to `.env` (and gitignore it).
//
// Everything is local: the secret is read from the open document and written to
// the developer's own `.env`. Nothing leaves the machine.

import * as vscode from 'vscode';
import * as path from 'node:path';

/** Languages we render an inline idiom for. Others fall back to the CLI. */
const INLINE_LANGS = new Set(['ruby', 'javascript', 'typescript', 'python', 'go']);

export function supportsInlineRewrite(languageId: string): boolean {
  return INLINE_LANGS.has(languageId);
}

/** Build the env-var lookup for a language. */
function lookupFor(languageId: string, name: string): string {
  switch (languageId) {
    case 'javascript':
    case 'typescript':
      return `process.env.${name}`;
    case 'python':
      return `os.environ[${JSON.stringify(name)}]`;
    case 'go':
      return `os.Getenv(${JSON.stringify(name)})`;
    case 'ruby':
    default:
      return `ENV.fetch(${JSON.stringify(name)})`;
  }
}

/** Locate the quoted string literal on `lineText` nearest `column` (0-based). */
function findLiteral(
  lineText: string,
  column: number,
): { start: number; end: number; value: string } | null {
  const re = /(['"`])((?:\\.|(?!\1).)*)\1/g;
  let best: { start: number; end: number; value: string } | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let m = re.exec(lineText); m; m = re.exec(lineText)) {
    const start = m.index;
    const end = m.index + m[0].length;
    // Prefer a literal that contains the reported column, else the closest one.
    const dist = column >= start && column <= end ? 0 : Math.min(Math.abs(column - start), Math.abs(column - end));
    if (dist < bestDist) {
      bestDist = dist;
      best = { start, end, value: m[2] };
    }
  }
  return best;
}

/** Guess an env-var name from the assignment to the left of the literal. */
function suggestName(lineText: string, literalStart: number, pattern: string): string {
  const before = lineText.slice(0, literalStart);
  // Last identifier before `=` / `:` / `(` / `,` and the literal.
  const m = before.match(/([A-Za-z_][A-Za-z0-9_]*)\s*[:=(,]?\s*$/);
  const raw = m?.[1] ?? pattern ?? 'SECRET';
  return toScreamingSnake(raw);
}

function toScreamingSnake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2') // camelCase -> camel_Case
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

async function appendLineIfMissing(
  dir: string,
  file: string,
  prefix: string,
  full: string,
): Promise<void> {
  const uri = vscode.Uri.file(path.join(dir, file));
  let text = '';
  try {
    text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch {
    text = '';
  }
  // Skip if a line for this key already exists.
  const exists = text.split(/\r?\n/).some((l) => l.trimStart().startsWith(prefix));
  if (exists) {
    return;
  }
  const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n';
  await vscode.workspace.fs.writeFile(uri, Buffer.from(`${text}${sep}${full}\n`, 'utf8'));
}

async function ensureGitignored(dir: string): Promise<void> {
  const uri = vscode.Uri.file(path.join(dir, '.gitignore'));
  let text = '';
  try {
    text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch {
    return; // no .gitignore — don't create one, just leave it
  }
  if (text.split(/\r?\n/).some((l) => l.trim() === '.env')) {
    return;
  }
  const sep = text.endsWith('\n') ? '' : '\n';
  await vscode.workspace.fs.writeFile(uri, Buffer.from(`${text}${sep}.env\n`, 'utf8'));
}

/**
 * Run the interactive rewrite for one finding. Returns true if it rewrote,
 * false if the caller should fall back to the CLI rewrite (unsupported
 * language, or no literal found).
 */
export async function rewriteFindingInteractive(
  uri: vscode.Uri,
  range: vscode.Range,
): Promise<boolean> {
  const doc = await vscode.workspace.openTextDocument(uri);
  if (!supportsInlineRewrite(doc.languageId)) {
    return false;
  }
  const lineText = doc.lineAt(range.start.line).text;
  const literal = findLiteral(lineText, range.start.character);
  if (!literal) {
    return false;
  }

  const suggested = suggestName(lineText, literal.start, '');
  const name = await vscode.window.showInputBox({
    title: 'leakferret: rewrite to environment variable',
    prompt: 'Environment variable name to read the secret from',
    value: suggested,
    validateInput: (v) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.trim())
        ? undefined
        : 'Use letters, digits and underscores; cannot start with a digit.',
  });
  if (!name) {
    return true; // user cancelled — treat as handled (don't fall back)
  }
  const envName = name.trim();
  const secretValue = literal.value;

  // 1) Replace the literal in code with the env lookup.
  const litStart = new vscode.Position(range.start.line, literal.start);
  const litEnd = new vscode.Position(range.start.line, literal.end);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(litStart, litEnd), lookupFor(doc.languageId, envName));
  await vscode.workspace.applyEdit(edit);
  await doc.save();

  // 2) .env.example always; .env on request.
  const dir = path.dirname(uri.fsPath);
  await appendLineIfMissing(dir, '.env.example', `${envName}=`, `${envName}=`);

  const choice = await vscode.window.showInformationMessage(
    `Rewrote the secret to read from ${envName}. Save the value to your .env now?`,
    'Add to .env',
    'Skip',
  );
  if (choice === 'Add to .env') {
    await appendLineIfMissing(dir, '.env', `${envName}=`, `${envName}=${secretValue}`);
    await ensureGitignored(dir);
    vscode.window.showInformationMessage(
      `Added ${envName} to .env (gitignored). Remove it from any committed history if it was ever pushed.`,
    );
  }
  return true;
}
