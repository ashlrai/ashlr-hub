/** Caller-relative resolution witness outside the setup directory. */
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';

export async function mockAndRestoreIdentity() {
  const first = await import('./setup/fixtures/mock-compat-module.js');
  const mockIdentity = {};
  vi.doMock(fileURLToPath(new URL('./setup/fixtures/mock-compat-module.js', import.meta.url)), () => ({ identity: mockIdentity }));
  const mocked = await import('./setup/fixtures/mock-compat-module.js');
  // Preserve the original wrapper's root-relative resolution, without a resolver change.
  vi.doUnmock('./test/setup/fixtures/mock-compat-module.js');
  const restored = await import('./setup/fixtures/mock-compat-module.js');
  return { first: first.identity, mockIdentity, mocked: mocked.identity, restored: restored.identity };
}
