/** Worker mock compatibility only; keep this before the HOME and write guards.
 * Stay beside the original config: Vitest infers relative doUnmock paths from
 * this wrapper's stack frame, so moving directories would change resolution. */
import { vi } from 'vitest';

const spyOnCompatKey = '__ASHLR_VITEST_3_SPY_ON_COMPAT__';
const testGlobal = globalThis as typeof globalThis & { [spyOnCompatKey]?: boolean };

// Preserve the Vitest 3 mock isolation semantics expected by the existing suite.
if (process.env['VITEST_WORKER_ID'] && !testGlobal[spyOnCompatKey]) {
  const spyOn = vi.spyOn.bind(vi) as (...args: unknown[]) => unknown;
  const doUnmock = vi.doUnmock.bind(vi);
  vi.spyOn = ((...args: unknown[]) => {
    const [target, property, accessType] = args as [object, PropertyKey, 'get' | 'set' | undefined];
    const descriptor = Object.getOwnPropertyDescriptor(target, property);
    const current = accessType
      ? descriptor?.[accessType]
      : Reflect.get(target, property);

    if (vi.isMockFunction(current)) current.mockClear();
    return spyOn(...args);
  }) as typeof vi.spyOn;
  vi.doUnmock = ((path: string) => {
    const result = doUnmock(path);
    vi.resetModules();
    return result;
  }) as typeof vi.doUnmock;
  testGlobal[spyOnCompatKey] = true;
}
