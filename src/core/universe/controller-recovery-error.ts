const diagnostics = {
  'controller-execution-ownership-unavailable': {
    message: 'Controller execution ownership unavailable for record-lock recovery',
    nextStep: 'Inspect controller ownership before retrying the exact manifest. Do not remove locks manually.',
  },
  'controller-publication-recovery-required': {
    message: 'Controller publication requires explicit recovery',
    nextStep: 'Preserve staged records and inspect the incomplete publication. Automatic restart will not discard staging.',
  },
  'controller-record-writer-busy': {
    message: 'Controller record writer is busy',
    nextStep: 'Wait for the existing writer to finish, then retry the exact manifest within the original deadline.',
  },
  'controller-record-ownership-unavailable': {
    message: 'Controller record ownership unavailable',
    nextStep: 'Inspect writer ownership and private storage before retrying. Unknown ownership does not authorize lock removal.',
  },
  'controller-record-storage-changed': {
    message: 'Controller record storage changed during ownership recovery',
    nextStep: 'Preserve the ledger and inspect the storage change before retrying. Do not recreate or replace ledger directories.',
  },
  'controller-record-release-failed': {
    message: 'Controller record ownership release failed',
    nextStep: 'Inspect writer ownership and private storage before retrying. Recovery did not confirm that its writer lock was released.',
  },
} as const;

export type ControllerRecoveryErrorCode = keyof typeof diagnostics;

/** Internal startup diagnosis only; it grants no retry or cleanup authority. */
export class ControllerRecoveryError extends Error {
  readonly code: ControllerRecoveryErrorCode;
  readonly nextStep: string;

  constructor(code: ControllerRecoveryErrorCode) {
    super(diagnostics[code].message);
    this.name = 'ControllerRecoveryError';
    this.code = code;
    this.nextStep = diagnostics[code].nextStep;
  }
}

/** Output only allowlisted text, never an error's mutable message, cause or prose. */
export function readControllerRecoveryDiagnostic(error: unknown): { code: ControllerRecoveryErrorCode; message: string; nextStep: string } | null {
  try {
    if (!(error instanceof ControllerRecoveryError)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' ||
        !Object.hasOwn(diagnostics, descriptor.value)) return null;
    const code = descriptor.value as ControllerRecoveryErrorCode;
    return { code, ...diagnostics[code] };
  } catch { return null; }
}
