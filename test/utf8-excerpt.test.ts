import { describe, expect, it } from 'vitest';
import { decodeUtf8Excerpt } from '../src/core/util/utf8-excerpt.js';

describe('bounded UTF-8 evidence excerpts', () => {
  it.each(['', 'plain\r\ntext', '\ufeffBOM\r\n', 'é € 💡'])('preserves complete source bytes: %j', text => {
    const bytes = Buffer.from(text);
    const result = decodeUtf8Excerpt(bytes, Math.max(1, bytes.length));
    expect(result).toEqual({ text, truncated: false });
    expect(Buffer.from(result.text)).toEqual(bytes);
  });

  it.each([[0xc2], [0xe2, 0x82], [0xf0, 0x9f, 0x92]].map(trailer => ({ trailer })))('rejects incomplete actual EOF $trailer even below the cap', ({ trailer }) => {
    const bytes = Buffer.from([0x61, ...trailer]);
    expect(() => decodeUtf8Excerpt(bytes, bytes.length)).toThrow(TypeError);
    expect(() => decodeUtf8Excerpt(bytes, 1600)).toThrow(TypeError);
  });

  it.each(['é', '€', '💡'])('omits only an unfinished code point at a real cutoff: %s', character => {
    const bytes = Buffer.from(`a${character}tail`);
    for (let limit = 2; limit < 1 + Buffer.byteLength(character); limit++) {
      expect(decodeUtf8Excerpt(bytes, limit)).toEqual({ text: 'a', truncated: true });
    }
    expect(decodeUtf8Excerpt(bytes, 1 + Buffer.byteLength(character))).toEqual({ text: `a${character}`, truncated: true });
  });

  it.each([[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xe2, 0x41]].map(invalid => ({ invalid })))('rejects malformed available bytes $invalid even with a later omitted suffix', ({ invalid }) => {
    const bytes = Buffer.from([0x61, ...invalid, 0x62]);
    expect(() => decodeUtf8Excerpt(bytes, bytes.length)).toThrow(TypeError);
    expect(() => decodeUtf8Excerpt(bytes, bytes.length - 1)).toThrow(TypeError);
  });

  it('does not claim to validate omitted bytes or impose a binary-file policy', () => {
    expect(decodeUtf8Excerpt(Buffer.from([0x61, 0xff]), 1)).toEqual({ text: 'a', truncated: true });
    expect(decodeUtf8Excerpt(Buffer.from([0]), 1)).toEqual({ text: '\0', truncated: false });
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid cap %s', cap => {
    expect(() => decodeUtf8Excerpt(Buffer.from('source'), cap)).toThrow(RangeError);
  });
});
