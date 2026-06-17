/**
 * M50 — compileArgv: pure + injection-safe declarative argv compilation.
 *
 * Hermetic; no spawn, no network. Proves placeholders are substituted only as
 * WHOLE argv elements and that optModel segments appear iff a non-empty model is
 * given.
 */

import { describe, it, expect } from 'vitest';
import { compileArgv } from '../src/core/run/engine-registry.js';
import type { ArgvSeg } from '../src/core/types.js';

describe('M50 compileArgv — substitution', () => {
  const tpl: ArgvSeg[] = ['-p', '$GOAL', { optModel: ['--model', '$MODEL'] }, '--cd', '$CWD'];

  it('substitutes $GOAL/$CWD as whole elements and includes optModel when model present', () => {
    expect(compileArgv(tpl, { goal: 'fix bug', cwd: '/tmp/wt', model: 'opus' })).toEqual([
      '-p',
      'fix bug',
      '--model',
      'opus',
      '--cd',
      '/tmp/wt',
    ]);
  });

  it('omits the optModel segment when model is absent', () => {
    expect(compileArgv(tpl, { goal: 'fix bug', cwd: '/tmp/wt' })).toEqual([
      '-p',
      'fix bug',
      '--cd',
      '/tmp/wt',
    ]);
  });

  it('omits the optModel segment when model is empty / whitespace', () => {
    expect(compileArgv(tpl, { goal: 'g', cwd: '/c', model: '   ' })).not.toContain('--model');
  });

  it('appends autonomousArgv only when autonomous is true', () => {
    const auto: ArgvSeg[] = ['--yolo', '--add-dir', '$CWD'];
    expect(compileArgv(['-z', '$GOAL'], { goal: 'g', cwd: '/c' }, auto)).toEqual(['-z', 'g']);
    expect(compileArgv(['-z', '$GOAL'], { goal: 'g', cwd: '/c', autonomous: true }, auto)).toEqual([
      '-z',
      'g',
      '--yolo',
      '--add-dir',
      '/c',
    ]);
  });
});

describe('M50 compileArgv — injection safety', () => {
  it('passes a goal that LOOKS like a placeholder or shell as a single literal element', () => {
    const args = compileArgv(['-p', '$GOAL'], {
      goal: '$CWD; rm -rf / `whoami` && echo $MODEL',
      cwd: '/safe',
      model: 'm',
    });
    // The dangerous goal is exactly one element; never expanded to $CWD/$MODEL.
    expect(args).toEqual(['-p', '$CWD; rm -rf / `whoami` && echo $MODEL']);
    expect(args).toHaveLength(2);
  });

  it('only substitutes EXACT token segments, not substrings', () => {
    // A literal that merely contains the token text is emitted verbatim.
    expect(compileArgv(['prefix-$GOAL-suffix', '$GOAL'], { goal: 'X', cwd: '/c' })).toEqual([
      'prefix-$GOAL-suffix',
      'X',
    ]);
  });
});
