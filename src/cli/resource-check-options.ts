import { isAbsolute, parse, resolve } from 'node:path';

/** Strict commissioning CLI options: never echo untrusted values in errors. */
export class ResourceCheckUsageError extends Error {}
export function resourceCheckOptions(args: string[], names: string[]): { values: Map<string, string>; json: boolean; help: boolean } {
  if (args.length > 20 || args.some((arg) => typeof arg !== 'string' || Buffer.byteLength(arg) > 4096 ||
    [...arg].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159))) {
    throw new ResourceCheckUsageError('Invalid check arguments');
  }
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) return { values: new Map(), json: false, help: true };
  if (args[0] !== 'check') throw new ResourceCheckUsageError('Expected check subcommand');
  const values = new Map<string, string>(); let json = false;
  for (let index = 1; index < args.length; index++) {
    const key = args[index]!;
    if (key === '--json') {
      if (json) throw new ResourceCheckUsageError('Duplicate check option');
      json = true; continue;
    }
    if (!names.includes(key) || values.has(key)) throw new ResourceCheckUsageError('Unknown or duplicate check option');
    const value = args[++index];
    if (!value || value.startsWith('-')) throw new ResourceCheckUsageError('Check option requires a value');
    values.set(key, value);
  }
  return { values, json, help: false };
}
export function resourceCheckPath(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value || !isAbsolute(value) || resolve(value) !== value || parse(value).root === value) {
    throw new ResourceCheckUsageError(`${key} requires a canonical absolute non-root path`);
  }
  return value;
}
