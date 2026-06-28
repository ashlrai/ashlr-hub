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
 * Patterns covered (8 categories):
 *   1. sk-  API keys (Anthropic, OpenAI, etc.)
 *   2. GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_, gha_
 *   3. Bearer / Token / Authorization header values
 *   4. Generic key=value secrets: api_key, secret, token, password, passwd,
 *      auth, credential (including ASHLR_* env vars)
 *   5. Slack tokens: xox[baprs]-…
 *   6. AWS access key IDs: AKIA…
 *   7. JWTs: eyJ….<sig>
 *   8. Bare hex-64 (SHA-256 / API key hex form)
 *
 * PURITY: no I/O, no side-effects. Pure string transform.
 */

/**
 * Scrub recognised secret patterns from `text`.
 * Returns the scrubbed string with secrets replaced by `[REDACTED]`.
 * Never throws.
 */
export function scrubSecrets(text: string): string {
  try {
    return text
      // 1. sk- API keys (Anthropic, OpenAI, etc.)
      .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
      // 2. GitHub tokens
      .replace(/\bgh[poursa]_[A-Za-z0-9]{16,}/g, '[REDACTED]')
      // 3. Bearer / Token / Authorization header values
      .replace(/\b(Bearer|Token|Authorization)\s+[A-Za-z0-9\-._~+/]+=*/gi, '$1 [REDACTED]')
      // 4. Generic key=value secret patterns (covers ASHLR_* and common names)
      .replace(
        /\b(api[_-]?key|secret|token|password|passwd|auth|credential|ASHLR_[A-Z_]+)[=:\s]+[^\s,;'"]{8,}/gi,
        '$1=[REDACTED]',
      )
      // 5. Slack tokens
      .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/gi, '[REDACTED]')
      // 6. AWS access key IDs
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
      // 7. JWTs (eyJ header.payload.sig)
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
      // 8. Bare hex-64 strings (SHA-256 / hex API keys)
      .replace(/\b[0-9a-fA-F]{64,}\b/g, '[REDACTED]');
  } catch {
    // Never throws — return original text on unexpected error.
    return text;
  }
}
