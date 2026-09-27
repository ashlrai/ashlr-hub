/**
 * The Leader's founder-operator voice (3.15).
 *
 * Mason asked for a Leader that talks like a relentless, self-starting
 * founder: first principles, extreme ownership and urgency, bias to action,
 * "the best part is no part", ambitious bets with numbers — blunt, brief and
 * always pushing Ashlr Verse forward. This module is that voice, shared by the
 * memo prompt (leader.ts), the conversation prompt (leader-thread.ts) and the
 * Telegram line (comms/leader-line.ts), so the three never drift apart.
 *
 * NO REAL PERSON (SPEC-310B §4). The style is described by its traits, never
 * by a name: the prompts name no real person, and the Leader speaks as "the
 * Leader" — an AI agent. `guardPersonaText` is the deterministic backstop for
 * model output that claims otherwise ("I'm <famous founder>", a signature),
 * applied to every reply before it is stored or sent.
 *
 * BROWSER-SAFE and dependency-free: plain constants and pure functions.
 */

/**
 * The voice, as prompt text. Kept free of real names on purpose (the prompt
 * tests assert it) — the traits carry the style, not an impersonation.
 */
export const LEADER_FOUNDER_VOICE = `VOICE — a founder-operator who owns the outcome
- Ownership and urgency: Ashlr Verse getting better, more useful and more capable is YOUR job, every day. What ships today beats what is perfect next month.
- Bias to action: when the next step is obvious and inside the grant, take it and report it; do not ask permission for what you are allowed to do. Ask Mason only for genuine forks.
- First principles: reason from what is actually true — evidence, time, money, compute — not from habit. Every requirement is wrong until proven right.
- The best part is no part: delete, then simplify, then speed up, then automate — in that order.
- Ambitious bets, sized with numbers: expected delta, cost, date. 10x or kill it.
- Blunt and brief: lead with the answer. No filler, no flattery, no hedging paragraphs. A dry line of wit is fine; clarity wins.
- Always end with forward motion: the next move, who does it, when.
- You are "the Leader", an AI agent. Never claim to be, or speak as, any real person.`;

/** Telegram replies stay at or under this many lines unless Mason asks for detail. */
export const LEADER_TELEGRAM_MAX_LINES = 6;
/** Hard ceiling for a detailed answer (Telegram splits long messages anyway). */
export const LEADER_TELEGRAM_DETAIL_MAX_LINES = 30;

/** Mason asked for the long version ("details", "explain", "full", "why", "more"). */
export function wantsDetail(text: string): boolean {
  return /\b(detail(?:s|ed)?|explain|full|elaborate|deep ?dive|long version|walk me through|in depth|more)\b/i.test(text);
}

// ---------------------------------------------------------------------------
// Real-person guard
// ---------------------------------------------------------------------------

/**
 * Names the founder-operator style is most often associated with. The guard
 * only rewrites CLAIMS of identity ("I'm X", "X here", a "— X" signature);
 * mentioning a person ("X would delete this") is left alone.
 */
const IDENTITY_NAMES = String.raw`(?:elon(?:\s+musk)?|musk|steve\s+jobs|jeff\s+bezos|mark\s+zuckerberg|sam\s+altman|jensen\s+huang)`;

const CLAIM_PATTERNS: ReadonlyArray<{ re: RegExp; to: string }> = [
  // "I am Elon", "I'm Elon Musk", "this is Elon", "speaking as Elon", "Elon here"
  { re: new RegExp(String.raw`\b(?:i\s*am|i'm|i’m|im|this\s+is|it'?s|it’s|speaking\s+as|signed,?)\s+${IDENTITY_NAMES}\b`, 'gi'), to: "I'm the Leader" },
  { re: new RegExp(String.raw`\b${IDENTITY_NAMES}\s+here\b`, 'gi'), to: 'the Leader here' },
  // A signature line: "— Elon", "- Elon Musk", "~Elon"
  { re: new RegExp(String.raw`(^|\n)[ \t]*[-–—~][ \t]*${IDENTITY_NAMES}[ \t]*(?=\n|$)`, 'gi'), to: '$1— the Leader' },
  // Claims of being human.
  { re: /\bi\s*(?:am|'m|’m)\s+(?:a\s+)?(?:real\s+)?(?:human(?:\s+being)?|person|man|woman)\b/gi, to: "I'm an AI agent" },
];

/** Every identity claim in `text` (empty = clean). Used by tests and the prompt guard. */
export function personaViolations(text: string): string[] {
  const out: string[] = [];
  for (const { re } of CLAIM_PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) out.push(m[0].trim());
  }
  return out;
}

/**
 * Rewrite identity claims so the Leader always speaks as itself. Pure and
 * idempotent: guard(guard(x)) === guard(x).
 */
export function guardPersonaText(text: string): string {
  let out = text;
  for (const { re, to } of CLAIM_PATTERNS) out = out.replace(new RegExp(re.source, re.flags), to);
  return out;
}

// ---------------------------------------------------------------------------
// Telegram shape
// ---------------------------------------------------------------------------

export interface FitResult {
  text: string;
  /** True when lines were dropped (the full text is worth keeping for "more"). */
  truncated: boolean;
}

/**
 * Keep a reply phone-sized: at most `maxLines` non-blank lines (blank lines
 * between blocks are kept but not counted), each line capped. A dropped tail
 * is replaced by one hint line — so the result is at most maxLines + 1.
 */
export function fitTelegram(text: string, maxLines: number = LEADER_TELEGRAM_MAX_LINES, maxLineChars = 400): FitResult {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd());
  const kept: string[] = [];
  let count = 0;
  let truncated = false;
  for (const line of lines) {
    if (line.trim().length === 0) {
      if (kept.length > 0 && kept[kept.length - 1] !== '') kept.push('');
      continue;
    }
    if (count >= maxLines) {
      truncated = true;
      break;
    }
    kept.push(line.length > maxLineChars ? `${line.slice(0, maxLineChars - 1)}…` : line);
    count += 1;
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  if (truncated) kept.push('… (say "more" for the rest)');
  return { text: kept.join('\n'), truncated };
}
