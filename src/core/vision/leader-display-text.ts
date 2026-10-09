/** Provider-neutral generated Leader display text. Pure, zero imports; never storage or authority. */
const LEADER_DISPLAY_ID = String.raw`(?:lm-\d{14}-[a-f0-9]{6}(?::\d{1,2})?|la-\d{14}-[a-f0-9]{6}-\d{1,3}|lt-\d{14}-[a-f0-9]{6}|od-\d{14}-[a-f0-9]{6})`;
// Source-owned action summaries end in an ID, optionally followed by the
// existing advisory label. A filename such as file(id).ts is not that field.
const DISPLAY_ID_PARENS = new RegExp(String.raw`(^|\n)([ \t]*[•-]\s+\[[ABC]\][^\n]*)[ \t]+\(${LEADER_DISPLAY_ID}\)(?= — Jev suggests|\r?$)`, 'gm');
const DISPLAY_ID_LABEL = new RegExp(String.raw`\b((?:Leader\s+)?(?:memo|action|message|directive|question))\s+${LEADER_DISPLAY_ID}(?![\w./-])`, 'gi');
const DISPLAY_ID_OUTCOME = new RegExp(String.raw`\b(Approved|Not approved|Vetoed|Could not veto)\s+${LEADER_DISPLAY_ID}(?![\w./-])`, 'g');
const DISPLAY_ID_ITEM = new RegExp(String.raw`(^|\n)([ \t]*[•-]\s*)(${LEADER_DISPLAY_ID})(?![\w./-])`, 'g');
const DISPLAY_UUID_LABEL = /\b(task|run|session|trajectory|proposal)\s+[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\w/-]|\.[\w])/gi;
const DISPLAY_COMMIT = /\b(commit(?: SHA)?)\s+([a-f0-9]{40})(?![\w/-]|\.[\w])/gi;
const DISPLAY_ISO = /(?<![\w./-])\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})(?![\w./-])/g;
const DISPLAY_LITERAL = /(https?:\/\/[^\s]+|```[\s\S]*?```|`[^`\r\n]*`|"[^"\r\n]*")/g;

/**
 * Generated Leader prose only, at the display boundary. Human labels replace
 * known source-owned ID contexts; identifiers in literal answers, links,
 * filenames and code are not display labels and must stay exact. Callers
 * must not feed the result back into the thread, prompts or callback data.
 */
export function formatLeaderDisplayText(text: string, formatInstant?: (iso: string) => string | null, readableMemoFooter: boolean = false): string {
  const literalSpans = Array.from(text.matchAll(DISPLAY_LITERAL), (match) => [match.index, match.index + match[0].length] as const);
  // Keep the complete action-line context when its summary contains a quote,
  // filename or URL. Only remove a terminal metadata field outside literals:
  // an action-shaped line inside a code fence is still code, not metadata.
  const withoutActionIds = text.replace(DISPLAY_ID_PARENS, (match, start: string, summary: string, offset: number) => {
    const idStart = offset + start.length + summary.length;
    const idEnd = offset + match.length;
    if (literalSpans.some(([from, to]) => idStart < to && idEnd > from)) return match;
    return `${start}${summary}`;
  });
  // Only the exact source-built memo footer outside literals gets neutral review wording.
  let withReadableFooter = withoutActionIds;
  if (readableMemoFooter) {
    const footerLiteralSpans = Array.from(withoutActionIds.matchAll(DISPLAY_LITERAL), (match) => [match.index, match.index + match[0].length] as const);
    withReadableFooter = withoutActionIds.replace(/^Approve or veto any of them by id\.$/gm, (match, offset: number) =>
      footerLiteralSpans.some(([from, to]) => offset < to && offset + match.length > from)
        ? match
        : 'Review these actions before deciding.');
  }
  return withReadableFooter.split(DISPLAY_LITERAL).map((part, index) => {
    if (index % 2 === 1) return part;
    return part
      // Current product prose only; compatibility commands and literal history stay exact.
      .replace(/\b(?:Ashlr[ -]?[Vv]erse|ashlr[Vv]erse)\b/g, 'Phantom')
      .replace(DISPLAY_ID_LABEL, '$1')
      .replace(DISPLAY_UUID_LABEL, '$1')
      .replace(DISPLAY_COMMIT, (_match, label: string, sha: string) => `${label} ${sha.slice(0, 7)}`)
      .replace(DISPLAY_ID_OUTCOME, '$1 action')
      .replace(DISPLAY_ID_ITEM, (_match, start: string, bullet: string, id: string) => {
        const label = id.startsWith('la-') ? 'action' : id.startsWith('od-') ? 'directive' : id.startsWith('lt-') ? 'message' : 'memo';
        return `${start}${bullet}${label}`;
      })
      .replace(DISPLAY_ISO, (iso) => formatInstant?.(iso) ?? iso);
  }).join('');
}
