/**
 * GitHub App installation tokens are opaque. Current stateless tokens can be
 * over 500 bytes and contain dots and hyphens; neither their length nor their
 * JWT structure should be fixed to one GitHub issuance format. Keep the
 * transport value bounded and free of whitespace/control characters.
 */
export function isGitHubInstallationToken(value: unknown): value is string {
  return typeof value === 'string'
    && value.startsWith('ghs_')
    && value.length >= 24
    && value.length <= 4096
    && /^ghs_[A-Za-z0-9._-]+$/.test(value);
}
