/** Only the gateway injects this marker into the mobile HTML it serves. */
export function isRemoteMobileMode(): boolean {
  return typeof document !== 'undefined'
    && document.head.querySelector('meta[name="ashlr-remote-gateway"][content="v1"]') !== null;
}
