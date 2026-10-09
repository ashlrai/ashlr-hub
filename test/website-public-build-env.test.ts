import { describe, expect, it, vi } from 'vitest';
import { readWebsitePublicBuildEnv } from '../src/core/website/host-adapter.js';

function fixture(role = 'anon', ref = 'publicproject') {
  const token = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role, ref })).toString('base64url')}.c2lnbmF0dXJl`;
  const rows = [
    { id: 'url', key: 'NEXT_PUBLIC_SUPABASE_URL', type: 'encrypted', target: ['production'], value: 'https://publicproject.supabase.co' },
    { id: 'anon', key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', type: 'encrypted', target: ['production'], value: token },
    { id: 'private', key: 'SUPABASE_SERVICE_ROLE_KEY', type: 'encrypted', target: ['production'], value: 'private-must-never-be-read' },
  ];
  const api = vi.fn(async (path: string): Promise<Record<string, unknown>> => path.includes('?decrypt=false')
    ? { envs: rows.map(({ value: _value, ...metadata }) => metadata) }
    : rows.find((row) => path.endsWith(`/${row.id}`))!);
  return { rows, api, token };
}

describe('credential-free website public configuration', () => {
  it('reads only source-needed public production settings and preserves their real values', async () => {
    const f = fixture();
    expect(await readWebsitePublicBuildEnv(f.api)).toEqual({ NEXT_PUBLIC_PHANTOM_SITE_URL: 'https://phm.dev',
      NEXT_PUBLIC_SUPABASE_URL: 'https://publicproject.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: f.token });
    expect(f.api.mock.calls.map(([path]) => path.split('/').at(-1))).toEqual(['env?decrypt=false', 'url', 'anon']);
  });
  it('holds unknown production settings without fetching unrelated credentials', async () => {
    const api = vi.fn(async () => ({ envs: [] }));
    await expect(readWebsitePublicBuildEnv(api)).rejects.toThrow('before commissioning');
    expect(api).toHaveBeenCalledOnce();
  });
  it.each([['service_role', 'publicproject'], ['anon', 'otherproject']])('rejects %s / %s key claims', async (role, ref) => {
    await expect(readWebsitePublicBuildEnv(fixture(role, ref).api)).rejects.toThrow('matching public anon key');
  });
  it('does not read sensitive settings, ambiguous records or preview-only keys', async () => {
    const f = fixture(); f.rows[0]!.type = 'sensitive';
    await expect(readWebsitePublicBuildEnv(f.api)).rejects.toThrow('public Config');
    expect(f.api).toHaveBeenCalledOnce();
    const duplicate = fixture(); duplicate.rows.push({ ...duplicate.rows[0]! });
    await expect(readWebsitePublicBuildEnv(duplicate.api)).rejects.toThrow('ambiguous');
    expect(duplicate.api).toHaveBeenCalledOnce();
    const preview = fixture(); preview.rows[0]!.target = ['preview'];
    await expect(readWebsitePublicBuildEnv(preview.api)).rejects.toThrow('before commissioning');
    expect(preview.api.mock.calls.some(([path]) => path.endsWith('/url'))).toBe(false);
  });
  it('rejects changed identity and arbitrary public analytics destinations', async () => {
    const f = fixture(); const old = f.api.getMockImplementation()!;
    f.api.mockImplementation(async (path) => path.endsWith('/anon') ? { ...(await old(path)), key: 'SUPABASE_SERVICE_ROLE_KEY' } : old(path));
    await expect(readWebsitePublicBuildEnv(f.api)).rejects.toThrow('identity changed');
    const analytics = fixture(); analytics.rows.push({ id: 'host', key: 'NEXT_PUBLIC_POSTHOG_HOST', type: 'encrypted', target: ['production'], value: 'https://unrelated.example' });
    await expect(readWebsitePublicBuildEnv(analytics.api)).rejects.toThrow('analytics host');
  });
  it('supports the official scalar production target while rejecting a target changed during read', async () => {
    const f = fixture(); const original = f.api.getMockImplementation()!;
    f.api.mockImplementation(async (path) => {
      const value = await original(path);
      return path.includes('?decrypt=false') ? value : { ...value, target: 'production', id: undefined };
    });
    expect((await readWebsitePublicBuildEnv(f.api))['NEXT_PUBLIC_SUPABASE_ANON_KEY']).toBe(f.token);
    f.api.mockImplementation(async (path) => path.endsWith('/anon') ? { ...(await original(path)), target: ['preview'] } : original(path));
    await expect(readWebsitePublicBuildEnv(f.api)).rejects.toThrow('identity changed');
  });
});
