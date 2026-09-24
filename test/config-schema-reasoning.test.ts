/**
 * V3.10 — schema/config.schema.json declares `reasoning`.
 *
 * The root schema is `additionalProperties: false`, so an editor validating
 * ~/.ashlr/config.json against it would flag the new
 * `AshlrConfig.reasoning.codexDesktop` opt-in (src/core/types.ts) as unknown.
 * Nothing in src/ enforces the schema at runtime (see
 * test/m340b.foundry-schema-typing.test.ts), so this is a structural check,
 * not an ajv run.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AshlrConfig } from '../src/core/types.js';

const SCHEMA_PATH = join(import.meta.dirname, '..', 'schema', 'config.schema.json');

type Json = Record<string, unknown>;

describe('schema/config.schema.json — reasoning block (V3.10)', () => {
  it('declares an optional, closed reasoning object with a boolean codexDesktop', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Json;
    expect(schema['additionalProperties']).toBe(false);
    const properties = schema['properties'] as Json;
    const reasoning = properties['reasoning'] as Json;
    expect(reasoning).toBeTruthy();
    expect(reasoning['type']).toBe('object');
    expect(reasoning['additionalProperties']).toBe(false);
    expect((reasoning['properties'] as Json)['codexDesktop']).toMatchObject({ type: 'boolean' });
    // Optional at both levels: an existing config without it stays valid.
    expect((schema['required'] as string[] | undefined) ?? []).not.toContain('reasoning');
    expect(reasoning['required']).toBeUndefined();
  });

  it('matches the AshlrConfig type key for key', () => {
    // Compile-time: if `reasoning` or `codexDesktop` is renamed in types.ts,
    // this literal stops typechecking.
    const typed: Required<NonNullable<AshlrConfig['reasoning']>> = { codexDesktop: true };
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Json;
    const declared = ((schema['properties'] as Json)['reasoning'] as Json)['properties'] as Json;
    expect(Object.keys(declared).sort()).toEqual(Object.keys(typed).sort());
  });
});
