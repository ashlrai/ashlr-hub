import { describe, expect, it } from 'vitest';
import { workModeForSection, workModeSection } from './work-mode.js';

describe('work intent navigation', () => {
  it('groups interactive chats and autonomous work without changing section identities', () => {
    expect(workModeForSection('chat')).toBe('with-me');
    for (const section of ['fleet', 'agents', 'command', 'mind', 'growth'] as const) {
      expect(workModeForSection(section)).toBe('for-me');
    }
    expect(workModeSection('with-me')).toBe('chat');
    expect(workModeSection('for-me')).toBe('fleet');
  });

  it('does not imply an intent or permission change for shared tools', () => {
    for (const section of ['apps', 'usage', 'wiki', 'playbooks', 'automations', 'settings'] as const) {
      expect(workModeForSection(section)).toBeNull();
    }
  });
});
