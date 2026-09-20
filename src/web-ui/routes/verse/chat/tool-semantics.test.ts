import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../../inbox/diff-parser.js';
import {
  actionForName,
  baseToolName,
  fileBasename,
  fileDirname,
  looksLikeUnifiedDiff,
  pathsIn,
  readToolFacts,
  statedExitCode,
  toolAnchorId,
} from './tool-semantics.js';

describe('baseToolName / actionForName', () => {
  it('sees through MCP transport prefixes', () => {
    expect(baseToolName('mcp__plugin_ashlr_ashlr__ashlr__edit')).toBe('edit');
    expect(actionForName('mcp__plugin_ashlr_ashlr__ashlr__edit')).toBe('edit');
    expect(actionForName('Read')).toBe('read');
    expect(actionForName('MultiEdit')).toBe('edit');
    expect(actionForName('Bash')).toBe('command');
    expect(actionForName('Grep')).toBe('search');
    expect(actionForName('Task')).toBe('task');
  });

  it('reports an unknown tool as unknown rather than guessing', () => {
    expect(actionForName('SomeVendorThing')).toBe('other');
  });
});

describe('pathsIn', () => {
  it('collects every path-ish key, de-duplicated, in first-seen order', () => {
    expect(pathsIn({ file_path: '/a.ts', path: '/a.ts' })).toEqual(['/a.ts']);
    expect(pathsIn({ notebook_path: '/n.ipynb' })).toEqual(['/n.ipynb']);
    expect(pathsIn({ file_paths: ['/a', '/b'] })).toEqual(['/a', '/b']);
    expect(pathsIn('not an object')).toEqual([]);
  });
});

describe('fileBasename / fileDirname', () => {
  it('splits a posix or windows path', () => {
    expect(fileBasename('src/web-ui/App.tsx')).toBe('App.tsx');
    expect(fileDirname('src/web-ui/App.tsx')).toBe('src/web-ui');
    expect(fileBasename('C:\\x\\y.ts')).toBe('y.ts');
    expect(fileDirname('a.ts')).toBe('');
  });
});

describe('statedExitCode', () => {
  it('reads a code the tool actually printed', () => {
    expect(statedExitCode('boom\nExit code: 1')).toBe(1);
    expect(statedExitCode('exited with code 137')).toBe(137);
    expect(statedExitCode('Command exited with code 2\n')).toBe(2);
  });

  it('does not mistake a shell script echoed in the output for an exit status', () => {
    // `exit 1` inside a heredoc is not this command's exit code, and
    // reporting it as one would be a lie in the place most trusted.
    expect(statedExitCode('if [ -z "$X" ]; then exit 1; fi')).toBeNull();
    expect(statedExitCode('all good')).toBeNull();
  });
});

describe('looksLikeUnifiedDiff', () => {
  it('recognizes git and plain unified diffs', () => {
    expect(looksLikeUnifiedDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b')).toBe(true);
    expect(looksLikeUnifiedDiff('--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b')).toBe(true);
  });

  it('does not claim ordinary prose is a diff', () => {
    expect(looksLikeUnifiedDiff('I changed x to y.')).toBe(false);
    expect(looksLikeUnifiedDiff('--- a/x\n+++ b/x')).toBe(false);
  });
});

describe('readToolFacts', () => {
  it('turns an Edit payload into a diff the inbox parser can read', () => {
    const facts = readToolFacts({
      name: 'Edit',
      input: { file_path: 'src/a.ts', old_string: 'const x = 1;', new_string: 'const x = 2;' },
      result: { output: 'ok', isError: false },
    });
    expect(facts.action).toBe('edit');
    expect(facts.paths).toEqual(['src/a.ts']);
    expect(facts.diff).not.toBeNull();
    // The payload said WHAT was replaced, never WHERE — the offsets are not
    // the file's, so the viewer must not print them.
    expect(facts.diff!.anchored).toBe(false);
    expect(facts.diff!.origin).toBe('payload');
    const parsed = parseUnifiedDiff(facts.diff!.text);
    expect(parsed.files[0]!.displayPath).toBe('src/a.ts');
    expect(parsed.files[0]!.additions).toBe(1);
    expect(parsed.files[0]!.deletions).toBe(1);
  });

  it('gives a MultiEdit one file header and a labelled hunk per edit', () => {
    const facts = readToolFacts({
      name: 'MultiEdit',
      input: {
        file_path: 'src/a.ts',
        edits: [
          { old_string: 'aaa', new_string: 'AAA' },
          { old_string: 'bbb', new_string: 'BBB' },
        ],
      },
      result: { output: 'Applied 2 edits', isError: false },
    });
    const parsed = parseUnifiedDiff(facts.diff!.text);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]!.hunks).toHaveLength(2);
    expect(parsed.files[0]!.hunks[0]!.header).toContain('edit 1 of 2');
    expect(parsed.files[0]!.hunks[1]!.header).toContain('edit 2 of 2');
    expect(parsed.files[0]!.additions).toBe(2);
  });

  it('renders a brand-new file as an anchored all-additions diff', () => {
    const facts = readToolFacts({
      name: 'Write',
      input: { file_path: 'src/new.ts', content: 'line one\nline two\n' },
      result: { output: 'File created successfully at: src/new.ts', isError: false },
    });
    expect(facts.action).toBe('create');
    expect(facts.diff!.anchored).toBe(true);
    const parsed = parseUnifiedDiff(facts.diff!.text);
    expect(parsed.files[0]!.status).toBe('added');
    expect(parsed.files[0]!.additions).toBe(2);
    expect(facts.written).toBeNull();
  });

  it('does not fake a diff when a Write overwrote a file whose old text it never saw', () => {
    const facts = readToolFacts({
      name: 'Write',
      input: { file_path: 'src/old.ts', content: 'replacement' },
      result: { output: 'The file src/old.ts has been updated.', isError: false },
    });
    expect(facts.action).toBe('edit');
    expect(facts.diff).toBeNull();
    expect(facts.written).toEqual({ path: 'src/old.ts', text: 'replacement' });
  });

  it('reads a Bash call as a command, with the exit code only when stated', () => {
    const ran = readToolFacts({
      name: 'Bash',
      input: { command: 'npm test', description: 'run tests' },
      result: { output: '2 failing\nExit code: 1', isError: true },
    });
    expect(ran.action).toBe('command');
    expect(ran.command).toEqual({ command: 'npm test', exitCode: 1 });
    expect(ran.failed).toBe(true);

    const quiet = readToolFacts({
      name: 'Bash',
      input: { command: 'ls' },
      result: { output: 'a\nb', isError: false },
    });
    expect(quiet.command).toEqual({ command: 'ls', exitCode: null });
    expect(quiet.failed).toBe(false);
  });

  it('treats a command whose output is a diff as both', () => {
    const output = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,1 @@\n-a\n+b';
    const facts = readToolFacts({ name: 'Bash', input: { command: 'git diff' }, result: { output, isError: false } });
    expect(facts.command!.command).toBe('git diff');
    expect(facts.diff).toEqual({ text: output, anchored: true, multiFile: false, origin: 'output' });
  });

  it('flags a multi-file diff so the file-tree viewer is used', () => {
    const output = [
      'diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -1,1 +1,1 @@', '-a', '+b',
      'diff --git a/y.ts b/y.ts', '--- a/y.ts', '+++ b/y.ts', '@@ -1,1 +1,1 @@', '-c', '+d',
    ].join('\n');
    const facts = readToolFacts({ name: 'Bash', input: { command: 'git show' }, result: { output, isError: false } });
    expect(facts.diff!.multiFile).toBe(true);
  });

  it('marks a call still waiting for its result as pending, never as failed', () => {
    const facts = readToolFacts({ name: 'Bash', input: { command: 'sleep 5' }, result: null });
    expect(facts.pending).toBe(true);
    expect(facts.failed).toBe(false);
    expect(facts.command).toEqual({ command: 'sleep 5', exitCode: null });
  });

  it('leaves a plain read with no diff and no command', () => {
    const facts = readToolFacts({ name: 'Read', input: { file_path: '/a.ts' }, result: { output: 'x', isError: false } });
    expect(facts.action).toBe('read');
    expect(facts.diff).toBeNull();
    expect(facts.command).toBeNull();
    expect(facts.paths).toEqual(['/a.ts']);
  });
});

describe('toolAnchorId', () => {
  it('produces a DOM-safe id', () => {
    expect(toolAnchorId('toolu_01:a/b')).toBe('verse-tool-toolu_01ab');
  });
});
