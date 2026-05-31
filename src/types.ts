// Type definitions for the JSON shapes exchanged with the `leakferret`
// Rust binary and with the host language model.
//
// Keep the field names in lock-step with the Rust serde structs at
// `leakferret/crates/scanner/src/finding.rs` (canonical source of truth).

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'unknown';
export type Verdict = 'real' | 'fixture' | 'unknown';

/**
 * A single finding as produced by `leakferret scan --format json`.
 *
 * `line` and `column` are 1-based (the Rust convention). The extension
 * converts to 0-based VS Code positions in `diagnostics.ts`.
 */
export interface Finding {
  path: string;
  line: number;
  column: number;
  pattern: string;
  severity: Severity;
  match_redacted: string;
  context: string[];
  verdict?: Verdict;
  reason?: string;
  confidence?: number;
  verification?: { status: string; provider?: string };
}

/**
 * The payload shape sent to the host LM for classification. Mirrors the
 * Rust `HostPromptCandidate` struct.
 */
export interface HostPromptCandidate {
  id: string;
  path: string;
  pattern: string;
  severity: Severity;
  match_redacted: string;
  context: string[];
}

/**
 * The response shape the LM is asked to produce — one entry per candidate.
 */
export interface ClassifierVerdict {
  id: string;
  verdict: 'REAL' | 'FIXTURE' | 'UNKNOWN';
  reason?: string;
  confidence?: number;
}
