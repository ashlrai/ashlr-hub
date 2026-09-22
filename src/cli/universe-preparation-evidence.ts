import { isAbsolute, parse, resolve } from 'node:path';

export interface PreparationEvidenceOptions {
  universeId: string;
  root: string;
  captures: string[];
  sourceDigest?: string;
  calibration?: string;
  json: boolean;
}
const id = (value: string | undefined): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
const path = (value: string | undefined): value is string => typeof value === 'string' && isAbsolute(value) && resolve(value) === value && parse(value).root !== value;

/** Closed options are validated before either private-store or file access. */
export function parsePreparationEvidenceOptions(args: string[], mode: 'calibrate' | 'compare'): PreparationEvidenceOptions {
  if (args.length > 12 || args.some(arg => typeof arg !== 'string' || Buffer.byteLength(arg) > 4096 ||
    [...arg].some(character => { const code = character.charCodeAt(0); return code < 32 || code >= 127 && code <= 159; }))) throw new Error();
  const universeId = args[0];
  if (!id(universeId)) throw new Error();
  let root: string | undefined, sourceDigest: string | undefined, calibration: string | undefined, json = false;
  const captures: string[] = [];
  for (let index = 1; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--root' && root === undefined) {
      root = args[++index]; if (!path(root)) throw new Error();
    } else if (flag === '--capture') {
      const value = args[++index]; if (!id(value) || captures.includes(value)) throw new Error();
      captures.push(value);
    } else if (flag === '--expected-source-digest' && mode === 'calibrate' && sourceDigest === undefined) {
      sourceDigest = args[++index]; if (!sourceDigest || !/^[a-f0-9]{64}$/.test(sourceDigest)) throw new Error();
    } else if (flag === '--calibration' && mode === 'compare' && calibration === undefined) {
      calibration = args[++index]; if (!path(calibration)) throw new Error();
    } else if (flag === '--json' && !json) json = true;
    else throw new Error();
  }
  if (!root || captures.length !== (mode === 'calibrate' ? 3 : 1) ||
    (mode === 'calibrate' ? !sourceDigest : !calibration)) throw new Error();
  return { universeId, root, captures, sourceDigest, calibration, json };
}

export function preparationEvidenceFailure(json: boolean, command: string, error: 'INVALID_ARGUMENTS' | 'EVIDENCE_UNAVAILABLE'): number {
  if (json) console.log(JSON.stringify({ scope: 'diagnostic-only', error }));
  else console.error(`universe ${command}: ${error === 'INVALID_ARGUMENTS' ? 'invalid arguments; use --help' : 'evidence unavailable, incompatible or malformed'}`);
  return error === 'INVALID_ARGUMENTS' ? 2 : 1;
}
