/** Browser-safe typed question parser, loaded only by consumers that submit or reconcile. */
import { LEADER_QUESTION_FORM_LIMITS, LEADER_QUESTION_REVISION_RE, type LeaderQuestionSubmission } from './leader-thread-types.js';

// Constants are read only inside functions, preserving the contract module's re-export cycle.
/** Copy only ordinary own data: in-memory callers must not invoke accessors while parsing. */
function questionSubmissionData(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string') ||
    Object.values(descriptors).some((descriptor) => !('value' in descriptor))) return null;
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

/** Shared strict wire parser: no channel, authority, unknown keys or hidden suffix. */
export function parseLeaderQuestionSubmission(value: unknown): LeaderQuestionSubmission | null {
  try {
    const row = questionSubmissionData(value);
    if (!row || row['schemaVersion'] !== 1 || typeof row['formRevision'] !== 'string' ||
      !LEADER_QUESTION_REVISION_RE.test(row['formRevision'])) return null;
    if (row['kind'] === 'options') {
      if (Object.keys(row).sort().join(',') !== 'formRevision,kind,optionIndices,schemaVersion' ||
        !Array.isArray(row['optionIndices']) || Object.getPrototypeOf(row['optionIndices']) !== Array.prototype) return null;
      const descriptors = Object.getOwnPropertyDescriptors(row['optionIndices']);
      const lengthDescriptor = Object.getOwnPropertyDescriptor(row['optionIndices'], 'length');
      const length: unknown = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined;
      if (typeof length !== 'number' || length < 1 || length > LEADER_QUESTION_FORM_LIMITS.maxOptions ||
        Reflect.ownKeys(descriptors).length !== length + 1) return null;
      const optionIndices: number[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        const selected: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
        if (typeof selected !== 'number' || !Number.isInteger(selected) || selected < 0 ||
          selected >= LEADER_QUESTION_FORM_LIMITS.maxOptions) return null;
        optionIndices.push(selected);
      }
      if (new Set(optionIndices).size !== optionIndices.length) return null;
      return { schemaVersion: 1, formRevision: row['formRevision'], kind: 'options', optionIndices };
    }
    if (row['kind'] === 'text') {
      if (Object.keys(row).sort().join(',') !== 'formRevision,kind,schemaVersion,text' ||
        typeof row['text'] !== 'string' || !row['text'].trim() ||
        row['text'].length > LEADER_QUESTION_FORM_LIMITS.answerMaxChars) return null;
      return { schemaVersion: 1, formRevision: row['formRevision'], kind: 'text', text: row['text'] };
    }
    return null;
  } catch {
    // Proxies may throw during introspection; malformed data is never an executable fallback.
    return null;
  }
}
