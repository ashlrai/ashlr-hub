/**
 * core/swarm/gate.ts — M17 escalation gate.
 *
 * Two pure, deterministic, never-throwing exports:
 *   riskScan       — heuristic detection of destructive/outward ops in text
 *   shouldEscalate — priority-ordered escalation kind selector
 *
 * Neither function has side-effects; the caller is responsible for persisting
 * EscalationEvent records, setting status 'needs-approval', and stopping the
 * swarm. No auto-approval path exists here.
 */

import type { EscalationReasonKind } from '../types.js';

// ---------------------------------------------------------------------------
// Risk patterns
// Each entry is [pattern, humanReason]. Matched case-insensitively in order;
// returns on first hit. Patterns are deliberately broad — false positives are
// safer than false negatives for unattended runs.
// ---------------------------------------------------------------------------

interface RiskPattern {
  re: RegExp;
  reason: string;
}

const RISK_PATTERNS: RiskPattern[] = [
  // Filesystem destruction
  { re: /rm\s+-[a-z]*r[a-z]*f|rm\s+-[a-z]*f[a-z]*r/i, reason: 'rm -rf (recursive force delete) detected' },
  { re: /\brm\b.*--no-preserve-root/i, reason: 'rm --no-preserve-root detected' },

  // Git destructive / outward ops
  { re: /git\s+push\s+.*--force(?:-with-lease)?(?:\s|$)/i, reason: 'git push --force detected' },
  { re: /git\s+push\s+.*-f(?:\s|$)/i, reason: 'git push -f detected' },
  { re: /force.?push/i, reason: 'force-push pattern detected' },
  { re: /git\s+reset\s+--hard/i, reason: 'git reset --hard detected' },
  { re: /git\s+clean\s+.*-[a-z]*f/i, reason: 'git clean -f detected' },

  // Deploy / release ops
  // Deploy/release intent. Tightened to match an ACTUAL deploy ACTION rather
  // than the bare noun, so benign goal text ("Implement a deployment pipeline
  // module", "Add deployment docs", "Create a deploy script that prints
  // instructions") does NOT escalate. We require one of:
  //   • "deploy to <env>"        — e.g. "deploy to production"
  //   • a deploy CLI token       — vercel/netlify/fly/wrangler/heroku/kubectl
  //                                + deploy/apply/publish, in either order
  //   • "git push" (covered by the force-push patterns above; bare push below)
  // The previous bare-noun pattern over-fired on legitimate work (verified:
  // "deployment pipeline configuration module" flagged), which — combined with
  // the goal-risk approve flow — could strand benign tasks. False positives on
  // softer noun mentions are now left to explicit deploy-action phrasing.
  { re: /\bdeploy(?:s|ed|ing)?\s+to\s+\w/i, reason: 'deploy to <target> operation detected' },
  { re: /\b(?:vercel|netlify|fly|flyctl|wrangler|heroku|kubectl|serverless|sst)\b[^\n]{0,40}\b(?:deploy|apply|publish|push|release)\b/i, reason: 'deploy CLI command detected' },
  { re: /\b(?:deploy|publish|ship|release)\b[^\n]{0,30}\b(?:to\s+)?(?:prod|production|staging|live)\b/i, reason: 'deploy/release to environment detected' },
  { re: /\bvercel\b.*--prod/i, reason: 'vercel --prod deployment detected' },
  { re: /\bnpm\s+publish\b/i, reason: 'npm publish detected' },

  // SQL destructive ops
  { re: /\bDROP\s+(?:TABLE|DATABASE|SCHEMA|INDEX|VIEW)\b/i, reason: 'SQL DROP statement detected' },
  { re: /\bTRUNCATE\s+TABLE\b/i, reason: 'SQL TRUNCATE TABLE detected' },
  { re: /\bDELETE\s+FROM\b.*(?:WHERE\s+1|WHERE\s+true|;\s*$)/i, reason: 'potentially unbounded SQL DELETE detected' },

  // Shell pipe executions (curl/wget | sh/bash)
  { re: /(?:curl|wget)\b.*\|\s*(?:ba)?sh\b/i, reason: 'remote script execution (curl|sh) detected' },
  { re: /\beval\s*\$\(/i, reason: 'eval $(...) shell injection pattern detected' },

  // Dangerous permissions
  { re: /\bchmod\s+(?:a\+[rwx]*|[0-7]*7[0-7][0-7])\b/i, reason: 'chmod 777 or world-writable permission detected' },

  // Secret / credential exfiltration patterns
  { re: /\bcurl\b.*(?:Authorization|Bearer|api.?key|secret|token|password|passwd|credential)/i, reason: 'potential credential exfiltration via curl detected' },
  { re: /\bwget\b.*(?:Authorization|Bearer|api.?key|secret|token|password|passwd|credential)/i, reason: 'potential credential exfiltration via wget detected' },
  { re: /(?:export|echo|print)\s+.*(?:SECRET|API_KEY|PASSWORD|TOKEN|PRIVATE_KEY)/i, reason: 'potential secret variable exposure detected' },
  // Well-known credential identifiers paired with an EXPOSURE/EXFIL verb. The
  // prior pattern flagged the bare identifier regardless of context, which
  // over-fired on benign goals (verified: "Build a tokenizer for the API_KEY
  // header field" flagged). We now require a read/print/send/leak-style verb
  // near the identifier so handling-by-name is a signal but mere mention is not.
  // (Direct exposure via export/echo/print is also covered by the pattern above,
  // and exfil via curl/wget by the patterns above that.)
  { re: /\b(?:print|echo|log|dump|leak|expose|reveal|send|post|upload|exfil(?:trate)?|cat|read|copy|email|curl|wget|fetch)\b[^\n]{0,40}\b(?:[A-Z][A-Z0-9]*_)*(?:API_KEY|SECRET_ACCESS_KEY|ACCESS_KEY_ID|SECRET_KEY|PRIVATE_KEY|AUTH_TOKEN|ACCESS_TOKEN)\b/i, reason: 'potential credential identifier exposure detected' },
  { re: /\b(?:[A-Z][A-Z0-9]*_)*(?:API_KEY|SECRET_ACCESS_KEY|ACCESS_KEY_ID|SECRET_KEY|PRIVATE_KEY|AUTH_TOKEN|ACCESS_TOKEN)\b[^\n]{0,30}\b(?:to\s+)?(?:stdout|console|file|disk|remote|endpoint|url|http)\b/i, reason: 'potential credential identifier exposure detected' },
  { re: /\bcat\b.*(?:\.env|id_rsa|id_ed25519|\.pem|\.key)\b/i, reason: 'potential secret file read detected' },
  { re: /\bcp\b.*(?:id_rsa|id_ed25519|\.pem|\.key)\b/i, reason: 'potential private key copy detected' },
];

/**
 * Scan `text` for destructive or outward-facing operation patterns.
 *
 * Returns `{ risky: true, reason }` on the first match, or
 * `{ risky: false, reason: '' }` if no pattern matches.
 *
 * Pure, case-insensitive, never throws.
 */
export function riskScan(text: string): { risky: boolean; reason: string } {
  try {
    for (const { re, reason } of RISK_PATTERNS) {
      if (re.test(text)) {
        return { risky: true, reason };
      }
    }
    return { risky: false, reason: '' };
  } catch {
    // Defensive: should never reach here given static regexes, but never throw.
    return { risky: false, reason: '' };
  }
}

/**
 * Determine whether an escalation is needed, and which kind.
 *
 * Priority order (highest → lowest):
 *   tamper → verify-failed → over-budget → risk → low-confidence
 *
 * Returns the first applicable `EscalationReasonKind`, or `null` if none apply.
 *
 * PURE — no side-effects. The caller must:
 *   1. Persist the EscalationEvent
 *   2. Set swarm status to 'needs-approval'
 *   3. STOP the swarm
 * Never auto-approves; never throws.
 */
export function shouldEscalate(ctx: {
  verifyFailed?: boolean;
  overBudget?: boolean;
  tamper?: boolean;
  risk?: boolean;
  lowConfidence?: boolean;
}): EscalationReasonKind | null {
  if (ctx.tamper) return 'tamper';
  if (ctx.verifyFailed) return 'verify-failed';
  if (ctx.overBudget) return 'over-budget';
  if (ctx.risk) return 'risk';
  if (ctx.lowConfidence) return 'low-confidence';
  return null;
}
