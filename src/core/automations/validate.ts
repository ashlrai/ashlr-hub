/**
 * Strict validation of automation definitions (pure). Every write path — the
 * Verse route, the CLI, a hand-edited automations.json on read — goes
 * through `normaliseAutomation`, so a definition on disk is either fully
 * valid or ignored. Unknown keys are refused, never dropped silently.
 */
import { parseRrule } from './rrule.js';
import {
  AUTOMATION_DEFAULTS,
  AUTOMATION_ID_PATTERN,
  AUTOMATION_LABEL_PATTERN,
  AUTOMATION_LANES,
  AUTOMATION_LIMITS,
  AUTOMATION_PLAYBOOK_ID_PATTERN,
  AUTOMATION_REPO_PATTERN,
  AUTOMATION_SCHEMA_VERSION,
  AUTOMATION_TRIGGER_KINDS,
  AUTOMATION_ALL_GRANT_REPOS,
  AUTOMATION_TRIAGE_DEFAULT_CONFIDENCE,
  type AutomationLane,
  type AutomationTriageConfig,
  type AutomationTrigger,
  type AutomationV1,
} from './types.js';

export class AutomationInputError extends Error {}

const fail = (message: string): never => {
  throw new AutomationInputError(message);
};

const INPUT_KEYS = new Set([
  'id', 'name', 'enabled', 'trigger', 'lane', 'playbookId', 'repos', 'instructions',
  'maxConcurrent', 'maxPerDay', 'queueDepth', 'spendCapUsd', 'dedupeKey', 'triage',
]);
const TRIAGE_KEYS = new Set(['lanes', 'playbooks', 'minConfidence']);
const STORED_KEYS = new Set([...INPUT_KEYS, 'v', 'createdAt', 'updatedAt']);
const TRIGGER_KEYS: Record<AutomationTrigger['kind'], ReadonlySet<string>> = {
  'github-issues': new Set(['kind', 'labels', 'query', 'includePrs', 'pollMinutes']),
  'ci-red': new Set(['kind', 'branch', 'pollMinutes']),
  schedule: new Set(['kind', 'rrule']),
  webhook: new Set(['kind']),
  telegram: new Set(['kind']),
};
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const DEDUPE_PLACEHOLDERS = new Set(['repo', 'number', 'sha', 'occurrence', 'key']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknown(body: Record<string, unknown>, allowed: ReadonlySet<string>, where: string): void {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) fail(`Unknown field ${where}${key}.`);
  }
}

/** Strip control characters (keep newlines/tabs when multi-line), collapse, cap. */
export function cleanText(value: string, max: number, singleLine: boolean): string {
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(singleLine ? /[\u0000-\u001f\u007f]+/g : /[\u0000-\u0008\u000b-\u001f\u007f]+/g, singleLine ? ' ' : '');
  const shaped = singleLine ? stripped.replace(/\s+/g, ' ').trim() : stripped.replace(/\n{4,}/g, '\n\n\n').trim();
  return shaped.length > max ? `${shaped.slice(0, max - 1)}…` : shaped;
}

function int(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) return fail(`${name} must be a whole number.`);
  if (value < min || value > max) return fail(`${name} must be between ${min} and ${max}.`);
  return value;
}

function money(value: unknown, name: string, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) return fail(`${name} must be a number from 0 to ${max}.`);
  return Math.round(value * 100) / 100;
}

export function slugifyAutomationId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
  return `au_${slug.length >= 2 ? slug : `automation-${slug}`.slice(0, 40)}`;
}

export function normaliseTrigger(value: unknown): AutomationTrigger {
  if (!isRecord(value)) return fail('trigger must be an object with a kind.');
  const kind = value['kind'];
  if (typeof kind !== 'string' || !(AUTOMATION_TRIGGER_KINDS as readonly string[]).includes(kind)) {
    return fail(`trigger.kind must be one of ${AUTOMATION_TRIGGER_KINDS.join(', ')}.`);
  }
  const k = kind as AutomationTrigger['kind'];
  rejectUnknown(value, TRIGGER_KEYS[k], 'trigger.');
  const poll = (): number => int(value['pollMinutes'], 'trigger.pollMinutes', AUTOMATION_LIMITS.pollMinutesMin, AUTOMATION_LIMITS.pollMinutesMax, AUTOMATION_DEFAULTS.pollMinutes);
  switch (k) {
    case 'github-issues': {
      const rawLabels = value['labels'] ?? [];
      if (!Array.isArray(rawLabels)) return fail('trigger.labels must be a list of label names.');
      if (rawLabels.length > AUTOMATION_LIMITS.maxLabels) return fail(`At most ${AUTOMATION_LIMITS.maxLabels} labels.`);
      const labels: string[] = [];
      for (const label of rawLabels) {
        if (typeof label !== 'string' || !AUTOMATION_LABEL_PATTERN.test(label.trim())) {
          return fail(`"${String(label).slice(0, 40)}" is not a label name this accepts.`);
        }
        if (!labels.includes(label.trim())) labels.push(label.trim());
      }
      const rawQuery = value['query'];
      let query: string | null = null;
      if (rawQuery !== undefined && rawQuery !== null) {
        if (typeof rawQuery !== 'string') return fail('trigger.query must be text.');
        const cleaned = cleanText(rawQuery, AUTOMATION_LIMITS.queryMaxChars + 1, true);
        if (cleaned.length > AUTOMATION_LIMITS.queryMaxChars) return fail(`trigger.query is longer than ${AUTOMATION_LIMITS.queryMaxChars} characters.`);
        // The repo is always added from the automation's scope; a query naming
        // other repos/orgs/users would widen it.
        if (/(^|\s)-?(repo|org|user):/i.test(cleaned)) return fail('trigger.query cannot name repo:, org: or user: — the automation\'s repos decide that.');
        query = cleaned === '' ? null : cleaned;
      }
      if (labels.length === 0 && query === null) return fail('An issue trigger needs at least one label or a query.');
      const includePrs = value['includePrs'] ?? false;
      if (typeof includePrs !== 'boolean') return fail('trigger.includePrs must be true or false.');
      return { kind: 'github-issues', labels, query, includePrs, pollMinutes: poll() };
    }
    case 'ci-red': {
      const rawBranch = value['branch'];
      let branch: string | null = null;
      if (rawBranch !== undefined && rawBranch !== null && rawBranch !== '') {
        if (typeof rawBranch !== 'string' || !BRANCH_RE.test(rawBranch) || rawBranch.includes('..')) return fail('trigger.branch is not a branch name this accepts.');
        branch = rawBranch;
      }
      return { kind: 'ci-red', branch, pollMinutes: poll() };
    }
    case 'schedule': {
      const parsed = parseRrule(value['rrule']);
      if (!parsed.ok) return fail(parsed.error);
      return { kind: 'schedule', rrule: String(value['rrule']).trim().replace(/^RRULE:/i, '').toUpperCase() };
    }
    case 'webhook':
      return { kind: 'webhook' };
    case 'telegram':
      return { kind: 'telegram' };
  }
}

function normaliseRepos(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return fail('repos must list at least one owner/name (or "*" for every repo in the standing grant).');
  if (value.length > AUTOMATION_LIMITS.maxRepos) return fail(`At most ${AUTOMATION_LIMITS.maxRepos} repos.`);
  const out: string[] = [];
  for (const raw of value) {
    const repo = typeof raw === 'string' ? raw.trim() : '';
    if (repo === AUTOMATION_ALL_GRANT_REPOS) {
      if (value.length !== 1) return fail('"*" (every repo in the standing grant) cannot be combined with named repos.');
      return [AUTOMATION_ALL_GRANT_REPOS];
    }
    if (!AUTOMATION_REPO_PATTERN.test(repo)) return fail(`"${repo.slice(0, 80)}" must look like owner/name.`);
    if (!out.some((r) => r.toLowerCase() === repo.toLowerCase())) out.push(repo);
  }
  return out;
}

function normaliseDedupe(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 120 || /\s/.test(value)) return fail('dedupeKey must be a short template without spaces, e.g. {repo}#{number}.');
  for (const m of value.matchAll(/\{([^}]*)\}/g)) {
    if (!DEDUPE_PLACEHOLDERS.has(m[1]!)) return fail(`dedupeKey placeholder {${m[1]!.slice(0, 20)}} is unknown (use ${[...DEDUPE_PLACEHOLDERS].map((p) => `{${p}}`).join(' ')}).`);
  }
  if (!/\{[a-z]+\}/.test(value)) return fail('dedupeKey needs at least one placeholder, otherwise it would fire only once ever.');
  return value;
}

function normaliseTriage(value: unknown, lane: AutomationLane, playbookId: string | null): AutomationTriageConfig | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return fail('triage must be an object or null.');
  rejectUnknown(value, TRIAGE_KEYS, 'triage.');
  const rawLanes = value['lanes'] ?? [lane];
  if (!Array.isArray(rawLanes) || rawLanes.length === 0) return fail('triage.lanes must list at least one lane.');
  const lanes: AutomationLane[] = [];
  for (const l of rawLanes) {
    if (typeof l !== 'string' || !(AUTOMATION_LANES as readonly string[]).includes(l)) return fail(`triage.lanes: "${String(l).slice(0, 20)}" is not a lane.`);
    if (!lanes.includes(l as AutomationLane)) lanes.push(l as AutomationLane);
  }
  if (!lanes.includes(lane)) return fail('triage.lanes must include the automation\'s own lane.');
  const rawPlaybooks = value['playbooks'] ?? [];
  if (!Array.isArray(rawPlaybooks) || rawPlaybooks.length > 20) return fail('triage.playbooks must be a list of at most 20 playbook ids.');
  const playbooks: string[] = [];
  for (const p of rawPlaybooks) {
    if (typeof p !== 'string' || !AUTOMATION_PLAYBOOK_ID_PATTERN.test(p)) return fail('triage.playbooks entries must be short ids without spaces.');
    if (!playbooks.includes(p)) playbooks.push(p);
  }
  if (playbookId && playbooks.length > 0 && !playbooks.includes(playbookId)) playbooks.unshift(playbookId);
  const rawMin = value['minConfidence'] ?? AUTOMATION_TRIAGE_DEFAULT_CONFIDENCE;
  if (typeof rawMin !== 'number' || !Number.isFinite(rawMin) || rawMin < 0.5 || rawMin > 1) return fail('triage.minConfidence must be between 0.5 and 1.');
  return { lanes, playbooks, minConfidence: rawMin };
}

/**
 * Validate a create/update body into a stored definition. `existing` keeps id
 * and createdAt on update; `stored` accepts the on-disk fields (v, timestamps).
 */
export function normaliseAutomation(
  body: unknown,
  opts: { now: Date; existing?: AutomationV1 | null; stored?: boolean },
): AutomationV1 {
  if (!isRecord(body)) return fail('An automation must be a JSON object.');
  rejectUnknown(body, opts.stored ? STORED_KEYS : INPUT_KEYS, '');
  if (opts.stored && body['v'] !== AUTOMATION_SCHEMA_VERSION) return fail('Unsupported automation version.');

  const rawName = body['name'];
  if (typeof rawName !== 'string') return fail('name is required.');
  const name = cleanText(rawName, AUTOMATION_LIMITS.nameMaxChars, true);
  if (name.length === 0) return fail('name is required.');

  let id: string;
  if (opts.existing) {
    id = opts.existing.id;
  } else if (body['id'] !== undefined) {
    if (typeof body['id'] !== 'string' || !AUTOMATION_ID_PATTERN.test(body['id'])) return fail('id must look like au_nightly-flaky-tests.');
    id = body['id'];
  } else {
    id = slugifyAutomationId(name);
  }

  const lane = body['lane'];
  if (typeof lane !== 'string' || !(AUTOMATION_LANES as readonly string[]).includes(lane)) {
    return fail(`lane must be one of ${AUTOMATION_LANES.join(', ')}.`);
  }

  const enabled = body['enabled'] ?? false;
  if (typeof enabled !== 'boolean') return fail('enabled must be true or false.');

  const rawPlaybook = body['playbookId'];
  let playbookId: string | null = null;
  if (rawPlaybook !== undefined && rawPlaybook !== null && rawPlaybook !== '') {
    if (typeof rawPlaybook !== 'string' || !AUTOMATION_PLAYBOOK_ID_PATTERN.test(rawPlaybook)) return fail('playbookId must be a short id without spaces.');
    playbookId = rawPlaybook;
  }

  const rawInstructions = body['instructions'] ?? '';
  if (typeof rawInstructions !== 'string') return fail('instructions must be text.');
  const instructions = cleanText(rawInstructions, AUTOMATION_LIMITS.instructionsMaxChars, false);

  const trigger = normaliseTrigger(body['trigger']);
  const repos = normaliseRepos(body['repos']);

  const nowIso = opts.now.toISOString();
  const createdAt = opts.existing?.createdAt
    ?? (opts.stored && typeof body['createdAt'] === 'string' && !Number.isNaN(Date.parse(body['createdAt'])) ? body['createdAt'] : nowIso);
  const updatedAt = opts.stored && typeof body['updatedAt'] === 'string' && !Number.isNaN(Date.parse(body['updatedAt'])) ? body['updatedAt'] : nowIso;

  return {
    v: AUTOMATION_SCHEMA_VERSION,
    id,
    name,
    enabled,
    trigger,
    lane: lane as AutomationLane,
    playbookId,
    repos,
    instructions,
    maxConcurrent: int(body['maxConcurrent'], 'maxConcurrent', 1, AUTOMATION_LIMITS.maxConcurrentMax, AUTOMATION_DEFAULTS.maxConcurrent),
    maxPerDay: int(body['maxPerDay'], 'maxPerDay', 1, AUTOMATION_LIMITS.maxPerDayMax, AUTOMATION_DEFAULTS.maxPerDay),
    queueDepth: int(body['queueDepth'], 'queueDepth', 0, AUTOMATION_LIMITS.queueDepthMax, AUTOMATION_DEFAULTS.queueDepth),
    spendCapUsd: money(body['spendCapUsd'], 'spendCapUsd', AUTOMATION_LIMITS.spendCapUsdMax, AUTOMATION_DEFAULTS.spendCapUsd),
    dedupeKey: normaliseDedupe(body['dedupeKey']),
    triage: normaliseTriage(body['triage'], lane as AutomationLane, playbookId),
    createdAt,
    updatedAt,
  };
}
