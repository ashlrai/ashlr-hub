/**
 * core/mcp-argv-safety.ts — shared MCP argv redaction and launch safety.
 *
 * MCP child process argv is visible to local process inspection tools. Secrets
 * must travel through env, Phantom-managed wrappers, or server-specific config,
 * not command-line arguments.
 */

const SENSITIVE_FLAG = /(?:^|[-_])(?:token|key|secret|password|passwd|auth|credential|api[-_]?key|access[-_]?token|bearer|dsn|pat)$/i;
const SECRET_TOKEN = /(?:sk-|sk_live_|sk_test_|rk_live_|rk_test_|sbp_|pk_live_|gh[poursa]_|github_pat_|glpat-|hf_|npm_|xox[baprs]-|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{10,}|eyJ[A-Za-z0-9_-]{10,})/;

export function redactArgs(args: string[]): string[] {
  const out: string[] = [];
  let redactNext = false;
  for (const arg of args) {
    if (redactNext) { out.push('<redacted>'); redactNext = false; continue; }
    const eq = arg.match(/^(--?[A-Za-z0-9][\w-]*)=(.+)$/);
    if (eq && SENSITIVE_FLAG.test(eq[1])) { out.push(`${eq[1]}=<redacted>`); continue; }
    if (/^--?[A-Za-z]/.test(arg) && SENSITIVE_FLAG.test(arg.replace(/^--?/, ''))) {
      out.push(arg);
      redactNext = true;
      continue;
    }
    if (SECRET_TOKEN.test(arg)) { out.push('<redacted>'); continue; }
    out.push(arg);
  }
  return out;
}

export function hasSecretLikeArgv(args: string[]): boolean {
  for (const arg of args) {
    const eq = arg.match(/^(--?[A-Za-z0-9][\w-]*)=(.+)$/);
    if (eq && SENSITIVE_FLAG.test(eq[1])) return true;
    if (/^--?[A-Za-z]/.test(arg) && SENSITIVE_FLAG.test(arg.replace(/^--?/, ''))) {
      return true;
    }
    if (SECRET_TOKEN.test(arg)) return true;
  }
  return false;
}

export function redactedCommand(command: string, args: string[]): string {
  return [command, ...redactArgs(args)].join(' ');
}
