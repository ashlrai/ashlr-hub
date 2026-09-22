/** Capture a host-only veto without invoking accessors. Never serialized as policy. */
export function captureResourceExecutionVeto(options: object): () => boolean {
  const property = Object.getOwnPropertyDescriptor(options, 'isExecutionStopped');
  if (!property) {
    if ('isExecutionStopped' in options) throw new Error('Inherited execution veto is not supported');
    return () => false;
  }
  if (!Object.hasOwn(property, 'value') || typeof property.value !== 'function') throw new Error('Invalid execution veto');
  const callback = property.value as () => unknown;
  return () => {
    try {
      const result = callback();
      // A host accidentally returning an async veto cannot grant dispatch or
      // crash cleanup with an unhandled rejection. Only synchronous false permits.
      if (result instanceof Promise) void result.catch(() => {});
      return result !== false;
    } catch { return true; }
  };
}
