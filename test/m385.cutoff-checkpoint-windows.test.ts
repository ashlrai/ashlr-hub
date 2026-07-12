import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  readCutoffCaptureSchedulerState,
  scheduleCutoffCheckpointCapture,
} from '../src/core/daemon/cutoff-checkpoint-scheduler.js';

describe('M385 Windows cutoff capture portability', () => {
  it('fails closed before reservation or process-group operations', () => {
    const reserve = vi.fn();
    const spawn = vi.fn();
    const processKill = vi.fn();
    expect(scheduleCutoffCheckpointCapture({
      platform: 'win32',
      deps: { reserve, spawn, processKill },
    })).toMatchObject({ disposition: 'unsupported', reason: 'platform-unsupported' });
    expect(readCutoffCaptureSchedulerState('win32')).toMatchObject({
      sourceState: 'unsupported', state: null,
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(processKill).not.toHaveBeenCalled();
  });

  it('recognizes packaged Node hidden entrypoints and rejects invalid tokens silently', () => {
    const cli = resolve('dist/cli/index.js');
    for (const flag of ['--_cutoff-checkpoint-supervisor', '--_cutoff-checkpoint-worker']) {
      const result = spawnSync(process.execPath, [cli, flag, 'invalid', 'invalid'], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    }
  });
});
