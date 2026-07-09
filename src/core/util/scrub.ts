/**
 * src/core/util/scrub.ts — shared comprehensive secret-scrub utility.
 *
 * Extracted from judge-trace.ts (stripSecrets) and extended to cover all
 * patterns previously missing from handlers.ts (scrubDiffSecrets).
 *
 * Used by:
 *   - src/core/fleet/judge-trace.ts  (trace store, before JSONL write)
 *   - src/core/comms/handlers.ts     (diff-to-Telegram / diff-to-iMessage path)
 *
 * Patterns covered:
 *   0. PEM/private-key blocks
 *   1. sk-  API keys (Anthropic, OpenAI, etc.)
 *   2. GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_, gha_, github_pat_
 *   3. Bearer / Token / Authorization header values
 *   4. Generic key=value secrets: api_key, secret, token, password, passwd,
 *      auth, credential, client_secret, private_key, refresh_token,
 *      access_token, connection_string (including ASHLR_* env vars)
 *   5. Slack tokens: xox[baprs]-…
 *   6. AWS access key IDs: AKIA…
 *   7. JWTs: eyJ….<sig>
 *   8. Bare hex-64 (SHA-256 / API key hex form)
 *   9. GitLab/HuggingFace/npm/Google token prefixes
 *  10. URL authority passwords and long base64 blobs
 *
 * PURITY: no I/O, no side-effects. Pure string transform.
 */

function scrubLongBase64Like(match: string): string {
  // Preserve ordinary Git SHA-1 commit ids for forensic audit trails. The
  // explicit hex-64 rule above still redacts longer raw-key shapes.
  if (/^[0-9a-fA-F]{40}$/.test(match)) return match;
  return '[REDACTED]';
}

/**
 * Scrub recognised secret patterns from `text`.
 * Returns the scrubbed string with secrets replaced by `[REDACTED]`.
 * Never throws.
 */
export function scrubSecrets(text: string): string {
  try {
    return text
      // 0. PEM/private-key blocks. Run before generic/base64 redaction so
      // BEGIN/END markers do not survive with only the body removed.
      .replace(/-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g, '[REDACTED]')
      .replace(/-----BEGIN[ A-Z]*PRIVATE KEY-----[^\n]*/g, '[REDACTED]')
      // 1. sk- API keys (Anthropic, OpenAI, etc.)
      .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
      // 2. GitHub tokens
      .replace(/\bgh[poursa]_[A-Za-z0-9]{16,}/g, '[REDACTED]')
      .replace(/\bgithub_pat_[A-Za-z0-9_]{22,}/g, '[REDACTED]')
      // 3. Bearer / Token / Authorization header values
      .replace(/\b(Bearer|Token|Authorization)\s+[A-Za-z0-9\-._~+/]+=*/gi, '$1 [REDACTED]')
      // 4. Generic key=value secret patterns (covers ASHLR_* and common names)
      .replace(
        /\b(api[_-]?key|api[_-]?token|secret|secret[_-]?key|token|password|passwd|pwd|auth|credential|client[_-]?secret|private[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|connection[_-]?string|conn[_-]?str|_?auth[_-]?token|ASHLR_[A-Z_]+)[=:\s]+[^\s,;'"]{8,}/gi,
        '$1=[REDACTED]',
      )
      // 5. Slack tokens
      .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/gi, '[REDACTED]')
      // 6. AWS access key IDs
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
      // 7. JWTs (eyJ header.payload.sig)
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
      // 8. Bare hex-64 strings (SHA-256 / hex API keys)
      .replace(/\b[0-9a-fA-F]{64,}\b/g, '[REDACTED]')
      // 9. Other common provider token prefixes.
      .replace(/\bglpat-[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
      .replace(/\bhf_[A-Za-z0-9]{16,}\b/g, '[REDACTED]')
      .replace(/\bnpm_[A-Za-z0-9]{16,}\b/g, '[REDACTED]')
      .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED]')
      // 10. URL passwords and long base64-ish blobs.
      .replace(/(:\/\/[^:\s/@]+:)[^@\s]{8,}(@)/g, '$1[REDACTED]$2')
      .replace(/(?<![/\w])[A-Za-z0-9+/]{40,}={0,2}(?![/\w])/g, scrubLongBase64Like);
  } catch {
    // Never throws — return original text on unexpected error.
    return text;
  }
}
