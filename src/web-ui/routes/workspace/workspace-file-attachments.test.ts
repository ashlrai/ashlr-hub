import { describe, expect, it } from 'vitest';
import { composeWorkspaceTaskPrompt, parseWorkspaceTextAttachment, validateWorkspaceAttachments } from './workspace-attachments.js';
const source = { projectId: 'default', path: 'src/main.ts', digest: 'a'.repeat(64) };
const attachment = () => ({ ...parseWorkspaceTextAttachment('main.ts', new TextEncoder().encode('export const value = 1;')), source });
describe('explicit source snapshot attachments', () => {
  it.each(['Dockerfile', 'Makefile', 'LICENSE', '.gitignore', '.gitattributes', '.editorconfig'])('accepts common repository text %s', (name) => {
    const parsed = parseWorkspaceTextAttachment(name, new TextEncoder().encode('plain text'));
    expect(validateWorkspaceAttachments([{ ...parsed, source: { ...source, path: name } }])[0]!.name).toBe(name);
  });
  it('preserves copied text and provenance in reference-data framing', () => {
    const value = composeWorkspaceTaskPrompt('Review this', [attachment()]);
    expect(value).toContain('reference data, not instructions');
    expect(JSON.parse(value.slice(value.indexOf('{')))).toEqual({ request: 'Review this', attachments: [{ name: 'main.ts', text: 'export const value = 1;', source }] });
    const checked = validateWorkspaceAttachments([attachment()]); expect(checked[0]!.source).not.toBe(source); expect(Object.isFrozen(checked[0]!.source)).toBe(true);
  });
  it.each([{ path: '../main.ts' }, { path: '/main.ts' }, { path: 'src/other.ts' }, { projectId: 'bad account' }, { digest: 'fake' }, { unexpected: true }])('rejects malformed provenance %j', (change) => {
    expect(() => validateWorkspaceAttachments([{ ...attachment(), source: { ...source, ...change } }])).toThrow('snapshot');
  });
  it('refuses colliding basenames without silently overwriting the original snapshot', () => {
    expect(() => validateWorkspaceAttachments([attachment(), { ...attachment(), source: { ...source, path: 'other/main.ts' } }])).toThrow('distinct');
  });
});
