// Host-LM classifier. For each candidate finding produced by the scanner,
// asks the user's already-configured language model (Copilot, Claude in
// VS Code, etc.) to label it REAL / FIXTURE / UNKNOWN.
//
// The system prompt is intentionally embedded here as a constant rather
// than fetched from the binary's MCP `prompts/get classify` endpoint. The
// binary remains the source of truth — see
// `leakferret/crates/mcp/src/prompts.rs::SYSTEM_PROMPT` — and the two
// should be kept in sync at release time.
//
// We never send the actual secret value to the model. The scanner already
// redacts to first-4 + last-4, and we forward only that redacted preview
// plus a few lines of surrounding context.

import * as vscode from 'vscode';
import { ClassifierVerdict, Finding, HostPromptCandidate } from './types';

// Mirrors `SYSTEM_PROMPT` in the Rust MCP prompts module.
export const SYSTEM_PROMPT = `
You're reviewing regex hits that may be hardcoded secrets in source code.
For each candidate you'll get: file path, pattern name, a redacted preview
of the matched value (first 4 + last 4 chars only), and a few lines of
surrounding context.

Classify each candidate as one of:
  REAL    — looks like a live secret that shipped in production source
  FIXTURE — looks like a test fixture, mock, stub, example, doc, or
            obvious dummy (EXAMPLE / xxxx / placeholder / CHANGEME)
  UNKNOWN — can't tell from this context alone

Bias toward FIXTURE on paths containing spec/, test/, tests/, fixtures/,
examples/, docs/, demo/, sample/, mock/, dummy/, or filenames like
.env.example / .env.sample.

Bias toward REAL on paths under app/, lib/, src/, config/ (except
config/credentials.yml.enc), cmd/, services/ with live provider structure.

Default to UNKNOWN on genuine ambiguity. Don't guess.

Output strict JSON only, no prose, no markdown fences:
[{"id":"0","verdict":"REAL|FIXTURE|UNKNOWN","reason":"...","confidence":0.0}]
`.trim();

/**
 * Build the payload sent to the LM. One `HostPromptCandidate` per finding.
 */
function toCandidates(findings: Finding[]): HostPromptCandidate[] {
  return findings.map((f, idx) => ({
    id: String(idx),
    path: f.path,
    pattern: f.pattern,
    severity: f.severity,
    match_redacted: f.match_redacted,
    context: f.context,
  }));
}

/**
 * Returns the findings with `verdict` / `reason` / `confidence` populated
 * by the host LM. If no LM is available (older VS Code, no Copilot, the
 * provider refused), findings come back unchanged with verdict `unknown`
 * — they'll surface as Warning diagnostics rather than Errors.
 */
export async function classify(
  findings: Finding[],
  preferredFamily: string,
  token: vscode.CancellationToken,
): Promise<Finding[]> {
  if (findings.length === 0) {
    return [];
  }

  // The `vscode.lm` namespace requires VS Code >= 1.90. The package.json
  // pins that, but we double-check at runtime in case the user is on an
  // older Insiders / Code-Server build.
  const lm = vscode.lm;
  if (!lm || typeof lm.selectChatModels !== 'function') {
    return offlineFallback(findings);
  }

  let model: vscode.LanguageModelChat | undefined;
  try {
    const candidates = preferredFamily
      ? await lm.selectChatModels({ family: preferredFamily })
      : await lm.selectChatModels();
    model = candidates[0] ?? (await lm.selectChatModels())[0];
  } catch {
    return offlineFallback(findings);
  }
  if (!model) {
    return offlineFallback(findings);
  }

  const payload = toCandidates(findings);
  const userMessage = JSON.stringify(payload, null, 2);

  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(SYSTEM_PROMPT),
    vscode.LanguageModelChatMessage.User(userMessage),
  ];

  let text = '';
  try {
    const response = await model.sendRequest(messages, {}, token);
    for await (const chunk of response.text) {
      text += chunk;
    }
  } catch (err) {
    console.warn('[leakferret] LM request failed:', err);
    return offlineFallback(findings);
  }

  return applyVerdicts(findings, text);
}

function applyVerdicts(findings: Finding[], rawText: string): Finding[] {
  // Strip Markdown code fences if the model added them despite the
  // "no fences" instruction.
  const stripped = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let parsed: ClassifierVerdict[];
  try {
    // JSON-parse boundary.
    const raw: unknown = JSON.parse(stripped);
    if (!Array.isArray(raw)) {
      throw new Error('expected array');
    }
    parsed = raw as ClassifierVerdict[];
  } catch (err) {
    console.warn('[leakferret] LM returned non-JSON:', err, stripped);
    return offlineFallback(findings);
  }

  const out = findings.map((f) => ({ ...f }));
  for (const v of parsed) {
    const idx = Number.parseInt(v.id, 10);
    if (!Number.isFinite(idx) || !out[idx]) {
      continue;
    }
    const verdict = String(v.verdict || '').toLowerCase();
    if (verdict === 'real' || verdict === 'fixture' || verdict === 'unknown') {
      out[idx].verdict = verdict;
    }
    if (typeof v.reason === 'string') {
      out[idx].reason = v.reason;
    }
    if (typeof v.confidence === 'number') {
      out[idx].confidence = v.confidence;
    }
  }
  return out;
}

function offlineFallback(findings: Finding[]): Finding[] {
  return findings.map((f) => ({
    ...f,
    verdict: f.verdict ?? 'unknown',
    reason: f.reason ?? 'LM unavailable — finding shown unverified.',
  }));
}
