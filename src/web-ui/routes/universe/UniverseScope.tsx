import { createContext, useCallback, useContext } from 'react';

/** Absent in the ordinary dashboard; scoped consoles obtain this after auth. */
export const UniverseRootContext = createContext<string | null>(null);

export function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function withUniverseRoot(command: string, root: string | null): string {
  if (root === null) return command;
  return command.split('\n').map((line) => `${line} --root ${quoteShellArgument(root)}`).join('\n');
}

/** Commands are display-only. No browser action invokes a process. */
export function useUniverseCommand(): (command: string) => string {
  const root = useContext(UniverseRootContext);
  return useCallback((command: string) => withUniverseRoot(command, root), [root]);
}
