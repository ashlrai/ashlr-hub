/** Contract stub helper: every unimplemented function throws this until its unit lands. */
export function notImplemented(name: string): never {
  throw new Error(`cloud lane: ${name} is not implemented yet`);
}
