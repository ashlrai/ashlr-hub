/** Preserve a valid GitHub UTC timestamp without synthesizing local time. */
export function sanitizeGithubMergedAt(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return undefined;
  const normalized = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === normalized ? value : undefined;
}
