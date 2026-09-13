import { describe, expect, it } from 'vitest';
import { validateResourceConsoleProjectBindings, validateResourceConsoleProjects } from '../src/core/resources/console-projects.js';

const project = { id: 'other', label: 'Other workspace', workspace: '/explicit/project' };
describe('explicit resource project catalog syntax', () => {
  it('accepts a detached additional-only catalog without reading or creating directories', () => {
    const value = [project]; const parsed = validateResourceConsoleProjects(value);
    expect(parsed).toEqual(value); parsed[0]!.workspace = '/changed'; expect(value[0]!.workspace).toBe('/explicit/project');
    expect(validateResourceConsoleProjects([])).toEqual([]);
  });
  it.each([
    null, {}, [null], [{ ...project, id: 'default' }], [{ ...project, id: '../other' }],
    [{ ...project, id: 'Uppercase' }], [{ ...project, label: '' }], [{ ...project, label: ' padded ' }],
    [{ ...project, label: 'x\n' }], [{ ...project, label: 'x'.repeat(129) }],
    [{ ...project, workspace: '/' }], [{ ...project, workspace: 'relative' }],
    [{ ...project, workspace: '/a/../b' }], [{ ...project, workspace: '/a\u0000b' }],
    [{ ...project, executable: '/not-accepted' }], [project, project],
    [project, { ...project, id: 'alias' }],
  ])('rejects malformed or ambiguous catalog %#', (value) => {
    expect(() => validateResourceConsoleProjects(value)).toThrow();
  });
  it('reserves one of 32 total entries for default', () => {
    const values = Array.from({ length: 31 }, (_, index) => ({ id: `p-${index}`, label: `Project ${index}`, workspace: `/p-${index}` }));
    expect(validateResourceConsoleProjects(values)).toHaveLength(31);
    expect(() => validateResourceConsoleProjects([...values, { id: 'overflow', label: 'Overflow', workspace: '/overflow' }])).toThrow();
  });
  it('rejects accessors and sparse arrays without invoking catalog getters', () => {
    let called = false;
    const value = { ...project, get workspace() { called = true; return '/changed'; } };
    expect(() => validateResourceConsoleProjects([value])).toThrow(); expect(called).toBe(false);
    expect(() => validateResourceConsoleProjects(new Array(1))).toThrow();
  });
  it('validates historical identity strings without requiring enabled or present directories', () => {
    const bindings = [{ id: 'default', label: 'Default workspace', workspace: '/legacy', dev: '1', ino: '2' },
      { ...project, dev: '1', ino: '3' }];
    expect(validateResourceConsoleProjectBindings(bindings, '/legacy')).toEqual(bindings);
    expect(() => validateResourceConsoleProjectBindings(bindings, '/different')).toThrow();
    expect(() => validateResourceConsoleProjectBindings([{ ...bindings[0], ino: '2e3' }], '/legacy')).toThrow();
    expect(() => validateResourceConsoleProjectBindings([{ ...bindings[0], dev: 1 }], '/legacy')).toThrow();
  });
});
