/** Host-local, explicitly installed candidate; not a signed production release. */
export interface LocalRuntimeInstallation {
  id: string;
  sha256: string;
  integrity: string;
  size: number;
  revision: string;
  version: string;
  installedAt: string;
  manifestDigest: string;
  nodePath: string;
  nodeVersion: string;
  nodeSha256: string;
  packageRoot: string;
  binPath: string;
}

export interface LocalRuntimeStatus {
  schemaVersion: 1;
  authority: 'local-candidate';
  store: string;
  sourceState: 'missing' | 'healthy' | 'degraded';
  current: LocalRuntimeInstallation | null;
  previous: LocalRuntimeInstallation | null;
  reasons: string[];
}

export type LocalRuntimeResolution = LocalRuntimeInstallation;

export interface InstallLocalRuntimeOptions {
  store: string;
  artifactPath: string;
  sha256: string;
  revision: string;
  version: string;
}
