import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommandOutput } from './CommandOutput.js';

const ESC = '\u001B';

describe('CommandOutput', () => {
  it('shows the command, a stated exit code, and output with escapes stripped', () => {
    render(
      <CommandOutput command={{ command: 'npm test', exitCode: 1 }}
        output={`${ESC}[31mFAIL${ESC}[0m src/a.test.ts\nExit code: 1`} isError pending={false} />,
    );
    expect(screen.getByText('npm test')).toBeInTheDocument();
    expect(screen.getByText('exit 1')).toBeInTheDocument();
    const pre = document.querySelector('pre')!;
    expect(pre.textContent).toContain('FAIL src/a.test.ts');
    expect(pre.textContent).not.toContain(ESC);
    expect(pre.textContent).not.toContain('[31m');
    expect(screen.getByText(/colour codes stripped/)).toBeInTheDocument();
  });

  it('does not invent an exit code the tool never reported', () => {
    render(<CommandOutput command={{ command: 'ls', exitCode: null }} output="a\nb" isError={false} pending={false} />);
    expect(screen.getByText('completed — no exit code reported')).toBeInTheDocument();

    render(<CommandOutput command={{ command: 'ls /nope', exitCode: null }} output="missing" isError pending={false} />);
    expect(screen.getByText('failed — no exit code reported')).toBeInTheDocument();
  });

  it('collapses a long log behind an exact count and expands it', async () => {
    const user = userEvent.setup();
    const output = Array.from({ length: 100 }, (_, i) => `log ${i}`).join('\n');
    render(<CommandOutput command={{ command: 'npm run build', exitCode: 0 }} output={output} isError={false} pending={false} />);
    expect(document.querySelector('pre')!.textContent!.split('\n')).toHaveLength(20);
    expect(screen.getByText('100 lines')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show 80 more lines' }));
    expect(document.querySelector('pre')!.textContent!.split('\n')).toHaveLength(100);
    await user.click(screen.getByRole('button', { name: 'Collapse output' }));
    expect(document.querySelector('pre')!.textContent!.split('\n')).toHaveLength(20);
  });

  it('says it is still running rather than showing an empty result', () => {
    render(<CommandOutput command={{ command: 'sleep 5', exitCode: null }} output="" isError={false} pending />);
    expect(screen.getByText('running…')).toBeInTheDocument();
    expect(screen.getByText('Waiting for the command to finish…')).toBeInTheDocument();
    expect(document.querySelector('pre')).toBeNull();
  });

  it('states plainly when a command produced nothing', () => {
    render(<CommandOutput command={{ command: 'true', exitCode: 0 }} output="" isError={false} pending={false} />);
    expect(screen.getByText('no output')).toBeInTheDocument();
  });

  it('lets a caller replace the log body while keeping the command and status', () => {
    render(
      <CommandOutput command={{ command: 'git diff', exitCode: 0 }} output="irrelevant" isError={false} pending={false}
        body={<p>diff goes here</p>} />,
    );
    expect(screen.getByText('git diff')).toBeInTheDocument();
    expect(screen.getByText('exit 0')).toBeInTheDocument();
    expect(screen.getByText('diff goes here')).toBeInTheDocument();
    expect(document.querySelector('pre')).toBeNull();
  });
});
