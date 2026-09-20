import { describe, expect, it } from 'vitest';
import { applyCarriageReturns, cleanTerminalOutput, countLines, hasAnsi, headLines, stripAnsi } from './ansi.js';

const ESC = '\u001B';

describe('stripAnsi', () => {
  it('removes SGR colour runs, leaving the text they wrapped', () => {
    const coloured = `${ESC}[0;32mPASS${ESC}[0m src/a.test.ts`;
    expect(stripAnsi(coloured)).toBe('PASS src/a.test.ts');
    expect(hasAnsi(coloured)).toBe(true);
    expect(hasAnsi('plain')).toBe(false);
  });

  it('removes cursor moves, erases and OSC title sets', () => {
    const noisy = `${ESC}[2K${ESC}[1A${ESC}]0;npm run build${ESC}\\done`;
    expect(stripAnsi(noisy)).toBe('done');
  });

  it('keeps tabs and newlines but drops other control bytes', () => {
    expect(stripAnsi('a\tb\nc\u0007d')).toBe('a\tb\ncd');
  });
});

describe('applyCarriageReturns', () => {
  it('overlays each rewrite the way a terminal does', () => {
    // A progress bar's last frame wins, but a shorter frame does not erase
    // the tail of a longer one — that is what the screen would show.
    expect(applyCarriageReturns('10%\r50%\r100%')).toBe('100%');
    // A same-or-longer frame replaces outright…
    expect(applyCarriageReturns('100%\rdone')).toBe('done');
    // …a SHORTER one leaves the tail of the longer frame on screen, exactly
    // as a real terminal would, rather than silently erasing it.
    expect(applyCarriageReturns('100%\rok')).toBe('ok0%');
  });

  it('is per line', () => {
    expect(applyCarriageReturns('a\rb\nc\rd')).toBe('b\nd');
  });

  it('leaves text without carriage returns untouched', () => {
    const text = 'line one\nline two';
    expect(applyCarriageReturns(text)).toBe(text);
  });
});

describe('cleanTerminalOutput', () => {
  it('strips escapes, applies rewrites and trims trailing blank lines', () => {
    const raw = `${ESC}[33mbuilding${ESC}[0m\r${ESC}[33mbuilt${ESC}[0m   \n\n\n`;
    expect(cleanTerminalOutput(raw)).toBe('built');
  });

  it('preserves leading indentation, which is content in a stack trace', () => {
    expect(cleanTerminalOutput('Error: boom\n    at foo (a.ts:1:1)')).toBe('Error: boom\n    at foo (a.ts:1:1)');
  });
});

describe('countLines / headLines', () => {
  it('counts an empty string as no lines', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('one')).toBe(1);
    expect(countLines('one\ntwo\n')).toBe(3);
  });

  it('reports exactly how many lines were withheld', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    const { head, hidden } = headLines(text, 4);
    expect(head.split('\n')).toHaveLength(4);
    expect(hidden).toBe(6);
    expect(headLines(text, 50)).toEqual({ head: text, hidden: 0 });
  });
});
