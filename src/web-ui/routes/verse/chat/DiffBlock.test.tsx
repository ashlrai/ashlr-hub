import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DiffBlock } from './DiffBlock.js';
import { readToolFacts } from './tool-semantics.js';

const anchored = (text: string) => ({ text, anchored: true, multiFile: false, origin: 'output' as const });

describe('DiffBlock', () => {
  it('renders a single-file change as a diff, not as raw text', () => {
    const diff = anchored('--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n const keep = 1;\n-const gone = 2;\n+const added = 2;');
    render(<DiffBlock diff={diff} />);
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
    expect(screen.getByText('−1')).toBeInTheDocument();
    // Highlighting is per token, so the text is split — assert on the row.
    const rows = document.querySelectorAll('tr');
    expect([...rows].some((r) => r.className.includes('diffRow_add'))).toBe(true);
    expect([...rows].some((r) => r.className.includes('diffRow_del'))).toBe(true);
    // Anchored: the line-number gutter is present and no caveat is shown.
    expect(document.querySelectorAll('td[class*="diffNo"]').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Line numbers are not shown/)).not.toBeInTheDocument();
  });

  it('hides the line-number gutter and says why when the offsets are synthetic', () => {
    const facts = readToolFacts({
      name: 'Edit',
      input: { file_path: 'src/a.ts', old_string: 'before', new_string: 'after' },
      result: { output: 'ok', isError: false },
    });
    render(<DiffBlock diff={facts.diff!} path="src/a.ts" />);
    expect(document.querySelectorAll('td[class*="diffNo"]')).toHaveLength(0);
    expect(screen.getByText(/No line numbers — the tool didn.t report where in the file/)).toBeInTheDocument();
  });

  it('collapses a long diff behind an exact count and expands on demand', async () => {
    const user = userEvent.setup();
    const lines = Array.from({ length: 60 }, (_, i) => `+line ${i}`).join('\n');
    render(<DiffBlock diff={anchored(`--- /dev/null\n+++ b/big.ts\n@@ -0,0 +1,60 @@\n${lines}`)} />);
    // 60 changed lines, 18 shown: the count in the control is exact.
    expect(document.querySelectorAll('tbody tr')).toHaveLength(18);
    expect(screen.getByRole('button', { name: 'Show 42 more lines' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show 42 more lines' }));
    expect(document.querySelectorAll('tbody tr')).toHaveLength(60);
    expect(screen.getByRole('button', { name: 'Collapse diff' })).toBeInTheDocument();
  });

  it('hands a multi-file patch to the inbox file-tree viewer rather than flattening it', () => {
    const text = [
      'diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -1,1 +1,1 @@', '-a', '+b',
      'diff --git a/y.ts b/y.ts', '--- a/y.ts', '+++ b/y.ts', '@@ -1,1 +1,1 @@', '-c', '+d',
    ].join('\n');
    render(<DiffBlock diff={{ text, anchored: true, multiFile: true, origin: 'output' }} />);
    const tree = screen.getByRole('tree', { name: 'Changed files' });
    expect(tree).toBeInTheDocument();
    expect(screen.getAllByRole('treeitem')).toHaveLength(2);
    // And its split/unified toggle comes with it — not reimplemented here.
    expect(screen.getByRole('group', { name: 'Diff view mode' })).toBeInTheDocument();
  });

  it('renders nothing at all when the diff parses to no files', () => {
    const { container } = render(<DiffBlock diff={anchored('')} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('DiffBlock — changes that are not line changes', () => {
  /**
   * A rename-only `diff --git` entry has no `@@` hunk. It used to render as
   * "No line-level changes in this call." under the NEW path alone: the
   * operator was told nothing happened, and the old location — the one fact
   * that makes a rename legible — was thrown away.
   */
  const RENAME =
    'diff --git a/src/old-name.ts b/src/new-name.ts\n' +
    'similarity index 100%\n' +
    'rename from src/old-name.ts\n' +
    'rename to src/new-name.ts\n';

  it('treats a hunkless git diff as a diff at all', () => {
    const facts = readToolFacts({
      name: 'Bash',
      input: { command: 'git show --stat HEAD' },
      result: { output: RENAME, isError: false },
    });
    expect(facts.diff).not.toBeNull();
  });

  it('names both sides of a rename and does not claim nothing happened', () => {
    render(<DiffBlock diff={anchored(RENAME)} />);
    expect(screen.getByText('src/old-name.ts')).toBeInTheDocument();
    expect(screen.getByText('src/new-name.ts')).toBeInTheDocument();
    expect(screen.getByText('renamed')).toBeInTheDocument();
    expect(screen.queryByText('No line-level changes in this call.')).not.toBeInTheDocument();
    expect(screen.getByText(/Renamed\./)).toBeInTheDocument();
  });

  it('keeps a binary-file notice instead of dropping it into raw terminal text', () => {
    const binary =
      'diff --git a/assets/logo.png b/assets/logo.png\n' +
      'Binary files a/assets/logo.png and b/assets/logo.png differ\n';
    const facts = readToolFacts({
      name: 'Bash',
      input: { command: 'git diff' },
      result: { output: binary, isError: false },
    });
    expect(facts.diff).not.toBeNull();
    render(<DiffBlock diff={anchored(binary)} />);
    expect(screen.getByText(/Binary files/)).toBeInTheDocument();
  });
});
