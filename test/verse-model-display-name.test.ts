import { describe, expect, it } from 'vitest';
import { modelDisplayName, modelDisplayText } from '../src/core/verse/model-display-name.js';
import { localSeatLabel, tagsNeedingDetail } from '../src/core/verse/seats.js';

describe('modelDisplayName — local tags as a person reads them', () => {
  it.each([
    ['gpt-oss:20b', 'gpt-oss 20B', null],
    ['gpt-oss:120b', 'gpt-oss 120B', null],
    ['gpt-oss-20b', 'gpt-oss 20B', null],
    ['qwen3.8:27b-ctx64k', 'Qwen3.8 27B (64k)', null],
    ['qwen3.8:27b-q8_0', 'Qwen3.8 27B', 'q8_0'],
    ['qwen3-coder:30b-a3b-q4_K_M', 'Qwen3-Coder 30B-A3B', 'q4_K_M'],
    ['qwen3-coder-next:ctx64k', 'Qwen3-Coder-Next (64k)', null],
    ['deepseek-coder-v2:16b', 'DeepSeek-Coder-V2 16B', null],
    ['llama3.2:latest', 'Llama3.2', null],
    ['llama3.1:8b-instruct-fp16', 'Llama3.1 8B Instruct', 'fp16'],
    ['mistral-small3.1:24b', 'Mistral-Small3.1 24B', null],
    ['gemma3:27b-it-qat', 'Gemma3 27B IT', 'qat'],
    ['lmstudio-community/Qwen3-30B-A3B-GGUF', 'Qwen3 30B-A3B', 'GGUF'],
    ['Qwen3-32B-Q4_K_M.gguf', 'Qwen3 32B', 'Q4_K_M'],
    ['Qwen3-32B', 'Qwen3 32B', null],
  ])('%s → %s', (tag, name, detail) => {
    expect(modelDisplayName(tag)).toEqual({ name, detail });
  });

  it('puts the quantization after a middle dot only when asked', () => {
    expect(modelDisplayText('qwen3.8:27b-q8_0')).toBe('Qwen3.8 27B');
    expect(modelDisplayText('qwen3.8:27b-q8_0', true)).toBe('Qwen3.8 27B · q8_0');
    expect(modelDisplayText('gpt-oss:20b', true)).toBe('gpt-oss 20B');
  });

  it('never returns an empty name', () => {
    expect(modelDisplayName('').name).toBe('');
    expect(modelDisplayName('mystery').name).toBe('Mystery');
  });
});

describe('local seat labels', () => {
  it('folds the window into one parenthetical with "local"', () => {
    expect(localSeatLabel('qwen3.8:27b-ctx64k')).toBe('Qwen3.8 27B (64k, local)');
    expect(localSeatLabel('gpt-oss:20b')).toBe('gpt-oss 20B (local)');
  });

  it('keeps two quantizations of one model apart, and leaves a unique one clean', () => {
    const tags = ['qwen3.8:27b-q8_0', 'qwen3.8:27b-q4_K_M', 'gpt-oss:20b'];
    const need = tagsNeedingDetail(tags);
    expect([...need].sort()).toEqual(['qwen3.8:27b-q4_K_M', 'qwen3.8:27b-q8_0']);
    expect(localSeatLabel('qwen3.8:27b-q8_0', need.has('qwen3.8:27b-q8_0'))).toBe('Qwen3.8 27B · q8_0 (local)');
    expect(localSeatLabel('gpt-oss:20b', need.has('gpt-oss:20b'))).toBe('gpt-oss 20B (local)');
  });
});
