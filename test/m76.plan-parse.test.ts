/**
 * M76 — parseTaskList robustness tests.
 *
 * Covers every tolerance added in M76:
 *   1. Strict JSON still works (no regression)
 *   2. JSON wrapped in ```json…``` fences parses
 *   3. JSON wrapped in plain ```…``` fences parses
 *   4. Trailing commas before ] / } parse
 *   5. Alternate field names: task/description (goal), name (id)
 *   6. dependsOn / dependencies accepted as deps alias
 *   7. Synthesised ids (no id field) → t1, t2, …
 *   8. Numbered list "1. …\n2. …" → 2 tasks, synthesised ids
 *   9. Bulleted list with - and * bullets → tasks
 *  10. Pure prose (no list, no JSON) → null
 *  11. Empty string → null
 *  12. Empty JSON array → null
 *  13. Not-an-array JSON → null
 *  14. Missing goal field → null
 *  15. Duplicate ids → null
 *  16. Unknown dep reference → null
 *  17. Self-dep → null
 *  18. Cyclic deps → null
 *  19. Malformed JSON after fence strip → null (no throw)
 */

import { describe, it, expect } from 'vitest';
import { parseTaskList } from '../src/core/run/orchestrator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ids(tasks: ReturnType<typeof parseTaskList>): string[] {
  return (tasks ?? []).map((t) => t.id);
}

function goals(tasks: ReturnType<typeof parseTaskList>): string[] {
  return (tasks ?? []).map((t) => t.goal);
}

// ---------------------------------------------------------------------------
// 1. Strict path — no regression
// ---------------------------------------------------------------------------

describe('parseTaskList — strict JSON (regression)', () => {
  it('parses a well-formed array with id/goal/deps', () => {
    const json = JSON.stringify([
      { id: 't1', goal: 'Research', deps: [] },
      { id: 't2', goal: 'Write summary', deps: ['t1'] },
    ]);
    const result = parseTaskList(json);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    expect(ids(result)).toEqual(['t1', 't2']);
    expect(result![1]!.deps).toEqual(['t1']);
  });

  it('all tasks start pending', () => {
    const json = JSON.stringify([{ id: 't1', goal: 'Do a thing', deps: [] }]);
    const result = parseTaskList(json);
    expect(result![0]!.status).toBe('pending');
  });

  it('single-task array works', () => {
    const json = JSON.stringify([{ id: 'only', goal: 'Solo task', deps: [] }]);
    expect(parseTaskList(json)).toHaveLength(1);
  });

  it('prose surrounding a JSON array is tolerated (original behaviour)', () => {
    const text = 'Here is the plan:\n' + JSON.stringify([
      { id: 't1', goal: 'Step one', deps: [] },
    ]) + '\n\nLet me know if you want changes.';
    expect(parseTaskList(text)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2 & 3. Markdown code fence stripping
// ---------------------------------------------------------------------------

describe('parseTaskList — markdown fence stripping', () => {
  it('strips ```json … ``` and parses the array', () => {
    const text = '```json\n[\n  {"id":"t1","goal":"Step one","deps":[]}\n]\n```';
    const result = parseTaskList(text);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0]!.goal).toBe('Step one');
  });

  it('strips plain ``` … ``` and parses the array', () => {
    const text = '```\n[{"id":"t1","goal":"Only task","deps":[]}]\n```';
    const result = parseTaskList(text);
    expect(result).not.toBeNull();
    expect(result![0]!.id).toBe('t1');
  });

  it('handles fence + prose prefix', () => {
    const text =
      'Sure! Here is your plan:\n```json\n[{"id":"a","goal":"Do it","deps":[]}]\n```\nHope that helps!';
    // After fence strip the prose remains but the JSON array is still found
    expect(parseTaskList(text)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Trailing comma tolerance
// ---------------------------------------------------------------------------

describe('parseTaskList — trailing comma tolerance', () => {
  it('tolerates trailing comma after last array element', () => {
    const text = '[{"id":"t1","goal":"Thing","deps":[]},]';
    expect(parseTaskList(text)).toHaveLength(1);
  });

  it('tolerates trailing comma inside object', () => {
    const text = '[{"id":"t1","goal":"Thing","deps":[],}]';
    expect(parseTaskList(text)).toHaveLength(1);
  });

  it('handles both at once', () => {
    const text = '[{"id":"t1","goal":"A","deps":[],},{"id":"t2","goal":"B","deps":["t1"],},]';
    const result = parseTaskList(text);
    expect(result).toHaveLength(2);
    expect(result![1]!.deps).toEqual(['t1']);
  });
});

// ---------------------------------------------------------------------------
// 5. Alternate field names — goal aliases
// ---------------------------------------------------------------------------

describe('parseTaskList — alternate field names (goal)', () => {
  it('accepts "task" as goal field', () => {
    const text = JSON.stringify([{ id: 't1', task: 'Do research', deps: [] }]);
    const result = parseTaskList(text);
    expect(result).not.toBeNull();
    expect(result![0]!.goal).toBe('Do research');
  });

  it('accepts "description" as goal field', () => {
    const text = JSON.stringify([{ id: 't1', description: 'Analyze data', deps: [] }]);
    const result = parseTaskList(text);
    expect(result![0]!.goal).toBe('Analyze data');
  });

  it('accepts "title" as goal field', () => {
    const text = JSON.stringify([{ id: 't1', title: 'Write report', deps: [] }]);
    expect(parseTaskList(text)![0]!.goal).toBe('Write report');
  });

  it('accepts "summary" as goal field', () => {
    const text = JSON.stringify([{ id: 't1', summary: 'Summarize findings', deps: [] }]);
    expect(parseTaskList(text)![0]!.goal).toBe('Summarize findings');
  });

  it('accepts "text" as goal field', () => {
    const text = JSON.stringify([{ id: 't1', text: 'Deploy service', deps: [] }]);
    expect(parseTaskList(text)![0]!.goal).toBe('Deploy service');
  });
});

// ---------------------------------------------------------------------------
// 5b. Alternate field names — id aliases
// ---------------------------------------------------------------------------

describe('parseTaskList — alternate field names (id)', () => {
  it('accepts "name" as id field', () => {
    const text = JSON.stringify([{ name: 'step-a', goal: 'Do A', deps: [] }]);
    const result = parseTaskList(text);
    expect(result![0]!.id).toBe('step-a');
  });

  it('accepts "step" as id field', () => {
    const text = JSON.stringify([{ step: '1', goal: 'First step', deps: [] }]);
    expect(parseTaskList(text)![0]!.id).toBe('1');
  });

  it('accepts "key" as id field', () => {
    const text = JSON.stringify([{ key: 'init', goal: 'Initialise', deps: [] }]);
    expect(parseTaskList(text)![0]!.id).toBe('init');
  });
});

// ---------------------------------------------------------------------------
// 6. deps field aliases
// ---------------------------------------------------------------------------

describe('parseTaskList — alternate field names (deps)', () => {
  it('accepts "dependsOn" as deps', () => {
    const text = JSON.stringify([
      { id: 't1', goal: 'First', deps: [] },
      { id: 't2', goal: 'Second', dependsOn: ['t1'] },
    ]);
    const result = parseTaskList(text);
    expect(result![1]!.deps).toEqual(['t1']);
  });

  it('accepts "dependencies" as deps', () => {
    const text = JSON.stringify([
      { id: 't1', goal: 'First', deps: [] },
      { id: 't2', goal: 'Second', dependencies: ['t1'] },
    ]);
    const result = parseTaskList(text);
    expect(result![1]!.deps).toEqual(['t1']);
  });

  it('defaults to [] when no deps field present at all', () => {
    const text = JSON.stringify([{ id: 't1', goal: 'Solo' }]);
    expect(parseTaskList(text)![0]!.deps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. Synthesised ids (no id/name/step/key field)
// ---------------------------------------------------------------------------

describe('parseTaskList — synthesised ids', () => {
  it('synthesises t1, t2, … when no id field present', () => {
    const text = JSON.stringify([
      { goal: 'First thing' },
      { goal: 'Second thing' },
    ]);
    const result = parseTaskList(text);
    expect(result).toHaveLength(2);
    expect(ids(result)).toEqual(['t1', 't2']);
  });

  it('synthesised ids still validate goal presence', () => {
    const text = JSON.stringify([{ description: 'Step A' }]);
    const result = parseTaskList(text);
    expect(result![0]!.id).toBe('t1');
    expect(result![0]!.goal).toBe('Step A');
  });
});

// ---------------------------------------------------------------------------
// 8. Numbered list fallback
// ---------------------------------------------------------------------------

describe('parseTaskList — numbered list fallback', () => {
  it('parses "1. …\\n2. …" into 2 tasks with synthesised ids', () => {
    const text = '1. Research the codebase\n2. Write the implementation';
    const result = parseTaskList(text);
    expect(result).toHaveLength(2);
    expect(result![0]!.id).toBe('t1');
    expect(result![0]!.goal).toBe('Research the codebase');
    expect(result![1]!.id).toBe('t2');
    expect(result![1]!.goal).toBe('Write the implementation');
  });

  it('ignores blank lines and header-like lines', () => {
    const text = 'Plan:\n\n1. Step one\n2. Step two\n3. Step three\n';
    const result = parseTaskList(text);
    expect(result).toHaveLength(3);
  });

  it('numbered list tasks have empty deps', () => {
    const text = '1. Do A\n2. Do B';
    const result = parseTaskList(text);
    expect(result![0]!.deps).toEqual([]);
    expect(result![1]!.deps).toEqual([]);
  });

  it('numbered list tasks all start pending', () => {
    const text = '1. Alpha\n2. Beta';
    const result = parseTaskList(text);
    for (const t of result!) expect(t.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// 9. Bulleted list fallback
// ---------------------------------------------------------------------------

describe('parseTaskList — bulleted list fallback', () => {
  it('parses "- …" bullets into tasks', () => {
    const text = '- Scaffold the project\n- Write tests\n- Deploy';
    const result = parseTaskList(text);
    expect(result).toHaveLength(3);
    expect(goals(result)).toContain('Scaffold the project');
  });

  it('parses "* …" bullets into tasks', () => {
    const text = '* First item\n* Second item';
    const result = parseTaskList(text);
    expect(result).toHaveLength(2);
    expect(result![0]!.id).toBe('t1');
  });

  it('mixed bullets and numbered lines all parse', () => {
    const text = '1. Step one\n- Step two\n* Step three';
    const result = parseTaskList(text);
    expect(result).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 10 & 11. Null cases — pure prose and empty
// ---------------------------------------------------------------------------

describe('parseTaskList — null on prose/empty', () => {
  it('returns null for pure prose (no JSON, no list)', () => {
    const text = 'I will help you accomplish that goal by doing several things.';
    expect(parseTaskList(text)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseTaskList('')).toBeNull();
  });

  it('returns null for whitespace only', () => {
    expect(parseTaskList('   \n\t  ')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 12 & 13. Null cases — bad JSON shapes
// ---------------------------------------------------------------------------

describe('parseTaskList — null on bad JSON shapes', () => {
  it('returns null for empty JSON array', () => {
    expect(parseTaskList('[]')).toBeNull();
  });

  it('returns null when JSON is not an array', () => {
    expect(parseTaskList('{"notAnArray": true}')).toBeNull();
  });

  it('returns null for JSON number', () => {
    expect(parseTaskList('42')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 14. Null case — missing goal
// ---------------------------------------------------------------------------

describe('parseTaskList — null on missing goal', () => {
  it('returns null when no goal-like field exists', () => {
    const text = JSON.stringify([{ id: 't1', irrelevant: 'something' }]);
    expect(parseTaskList(text)).toBeNull();
  });

  it('returns null when goal is empty string', () => {
    const text = JSON.stringify([{ id: 't1', goal: '' }]);
    expect(parseTaskList(text)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 15. Null case — duplicate ids
// ---------------------------------------------------------------------------

describe('parseTaskList — null on duplicate ids', () => {
  it('returns null when two tasks share the same id', () => {
    const text = JSON.stringify([
      { id: 't1', goal: 'Task A', deps: [] },
      { id: 't1', goal: 'Task B', deps: [] },
    ]);
    expect(parseTaskList(text)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 16. Null case — unknown dep reference
// ---------------------------------------------------------------------------

describe('parseTaskList — null on unknown dep', () => {
  it('returns null when a dep references a non-existent task id', () => {
    const text = JSON.stringify([
      { id: 't1', goal: 'Task A', deps: ['t99'] },
    ]);
    expect(parseTaskList(text)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 17. Null case — self-dep
// ---------------------------------------------------------------------------

describe('parseTaskList — null on self-dep', () => {
  it('returns null when a task depends on itself', () => {
    const text = JSON.stringify([{ id: 't1', goal: 'Looping task', deps: ['t1'] }]);
    expect(parseTaskList(text)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 18. Null case — cyclic deps
// ---------------------------------------------------------------------------

describe('parseTaskList — null on cyclic deps', () => {
  it('returns null for a 2-node cycle (t1→t2→t1)', () => {
    const text = JSON.stringify([
      { id: 't1', goal: 'A', deps: ['t2'] },
      { id: 't2', goal: 'B', deps: ['t1'] },
    ]);
    expect(parseTaskList(text)).toBeNull();
  });

  it('returns null for a 3-node cycle', () => {
    const text = JSON.stringify([
      { id: 't1', goal: 'A', deps: ['t3'] },
      { id: 't2', goal: 'B', deps: ['t1'] },
      { id: 't3', goal: 'C', deps: ['t2'] },
    ]);
    expect(parseTaskList(text)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 19. No-throw guarantee on malformed input
// ---------------------------------------------------------------------------

describe('parseTaskList — never throws', () => {
  const malformed = [
    '[{bad json',
    '```json\n[{broken\n```',
    '[{"id":1,"goal":null}]',           // non-string id/goal
    '[null, undefined]',                // invalid elements
    '[[1,2,3]]',                        // nested arrays
    '{id:"t1",goal:"no quotes"}',       // JS object literal
  ];

  for (const input of malformed) {
    it(`does not throw on: ${JSON.stringify(input).slice(0, 60)}`, () => {
      expect(() => parseTaskList(input)).not.toThrow();
    });
  }
});
