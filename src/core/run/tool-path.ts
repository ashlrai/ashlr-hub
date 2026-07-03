import { delimiter, join } from 'node:path';

export function commonToolBinPaths(home = process.env.HOME ?? process.env.USERPROFILE ?? ''): string[] {
  return [
    ...(home ? [
      join(home, '.local', 'bin'),
      join(home, '.cargo', 'bin'),
      join(home, '.bun', 'bin'),
    ] : []),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
}

export function buildToolPath(opts?: {
  prepend?: string[];
  home?: string;
  basePath?: string;
  separator?: string;
}): string {
  const separator = opts?.separator ?? delimiter;
  const basePath = opts?.basePath ?? process.env.PATH ?? '';
  const entries = [
    ...(opts?.prepend ?? []),
    ...commonToolBinPaths(opts?.home),
    ...basePath.split(separator),
  ].filter((entry) => entry.length > 0);
  return [...new Set(entries)].join(separator);
}
