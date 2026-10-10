/** Shipped review records only. This module contains no companion binaries or installation effects. */
import type { CompanionArtifactManifest } from './companion-provisioning.js';

export type CompanionCatalogId = 'secrets-native' | 'lexicon-mcp';

export interface CompanionCatalogEntry {
  id: CompanionCatalogId;
  component: string;
  manifest: CompanionArtifactManifest;
  /** Authored review record, suitable for explicit materialization; no file is written by this module. */
  manifestText: string;
  /** Pins the exact reviewed expanded manifest bytes, including formatting and final newline. */
  manifestSha256: string;
  archive: {
    url: string;
    sha256: string;
    bytes: number;
    releaseImmutable: boolean;
    npm?: { name: string; version: string; tarball: string; integrity: string };
  };
  qualification: {
    scope: 'disposable-local-installation-and-interface-tests';
    accepted: string[];
    uninspected: string[];
  };
  expandedMapping: Array<{ archivePath: string; expandedPath: string; bytesEdited: false }>;
  evidence: {
    testedAtUTC: string;
    scope: 'disposable-macos-arm64-installation-and-interface-tests';
    credentialsCreatedOrRead: false;
    providerInference: false;
    toolCalls: 0;
    productionAcceptance: false;
    officialSignedBuildProvenanceVerified: false;
  };
  bundled: false;
  artifactBinariesBundled: false;
}

const CATALOG: Array<Omit<CompanionCatalogEntry, 'manifestText'>> = [
  {
    id: 'secrets-native',
    component: 'Two native Secrets binaries; no vault or MCP commissioning',
    manifest: {
      schemaVersion: 1,
      tool: 'secrets',
      version: '0.7.9',
      sourceCommit: '7a51ce512ec4aee12cc29ff859036af63fbe93db',
      releaseUrl: 'https://github.com/ashlrai/phantom-secrets/releases/tag/v0.7.9',
      platform: 'darwin-arm64',
      format: 'expanded-file-set',
      qualification: 'qualified',
      entrypoint: 'bin/phantom',
      files: [
        { path: 'bin/phantom', sha256: 'd55d59c89bd8d20f306d319a28edbdf0b19c658a01e4ec4c6a4b1d69bcbe3bbf', bytes: 23267248, mode: 0o755 },
        { path: 'bin/phantom-mcp', sha256: 'cf3ceb390e46f2da8f1eb5be52b9a5fb702db99ab30f4f898cd818b30d1a51e6', bytes: 12550912, mode: 0o755 },
      ],
    },
    manifestSha256: '77d1de8c724b0953bb9cef68c96c0d9adafd1665022e6f378633db3c9118bc57',
    archive: {
      url: 'https://github.com/ashlrai/phantom-secrets/releases/download/v0.7.9/phantom-aarch64-apple-darwin.tar.gz',
      sha256: '0c30d0404f3cb809ad95d2e8bfbe346348929e54e40e4574153107c5e7cad38a',
      bytes: 14473215,
      releaseImmutable: true,
    },
    qualification: {
      scope: 'disposable-local-installation-and-interface-tests',
      accepted: ['Public archive and sidecar integrity', 'Disposable two-file installation and repeat refusal', 'Scrubbed --version/--help CLI identity'],
      uninspected: ['Signed build provenance', 'Vault and credential access', 'Secrets MCP commissioning', 'Provider acceptance', 'Production readiness'],
    },
    expandedMapping: [
      { archivePath: 'phantom', expandedPath: 'bin/phantom', bytesEdited: false },
      { archivePath: 'phantom-mcp', expandedPath: 'bin/phantom-mcp', bytesEdited: false },
    ],
    evidence: {
      testedAtUTC: '2026-10-09T21:54:22.662Z',
      scope: 'disposable-macos-arm64-installation-and-interface-tests',
      credentialsCreatedOrRead: false, providerInference: false, toolCalls: 0,
      productionAcceptance: false, officialSignedBuildProvenanceVerified: false,
    },
    bundled: false,
    artifactBinariesBundled: false,
  },
  {
    id: 'lexicon-mcp',
    component: 'Public bundled MCP server only; full Lexicon CLI and native app excluded',
    manifest: {
      schemaVersion: 1,
      tool: 'lexicon',
      version: '0.5.4',
      sourceCommit: '6ebc0721e33de2dafafbb54d89a6af50a362046a',
      releaseUrl: 'https://github.com/ashlrai/lexicon/releases/tag/v0.5.4',
      platform: 'darwin-arm64',
      format: 'expanded-file-set',
      qualification: 'qualified',
      entrypoint: 'bin/lexicon-mcp',
      files: [
        { path: 'bin/lexicon-mcp', sha256: '881ebb21364fafb9c237ee429d9f8a1d03dce105c0805e3db281c7cab99d28ec', bytes: 2110142, mode: 0o755 },
        { path: 'package.json', sha256: '9c6912ed751216d448e9f4e0f8c150e284b251a6541015c0f0d3db7b78d4f8ed', bytes: 2773, mode: 0o644 },
        { path: 'LICENSE', sha256: 'c75e08fd8911e55c69693f97a4d5734ced6ef60d47b8a6a226639f110b2ec66c', bytes: 1065, mode: 0o644 },
      ],
    },
    manifestSha256: 'fe721ab714729ef741662544b83c96aca18b49773b212450780189112e5bae2b',
    archive: {
      url: 'https://github.com/ashlrai/lexicon/releases/download/v0.5.4/ashlr-lexicon-0.5.4.tgz',
      sha256: 'bea5b2d3fbc8db620805ebdbd0c1f24021965c7dd96ae7f0bf921de69ee69d46',
      bytes: 1068412,
      releaseImmutable: false,
      npm: {
        name: '@ashlr/lexicon',
        version: '0.5.4',
        tarball: 'https://registry.npmjs.org/@ashlr/lexicon/-/lexicon-0.5.4.tgz',
        integrity: 'sha512-AeLC+rUYk5Buj1xPYrwV67hLsgpche+msXc9arv/FSvAbiEvCJIYP0gbxwXrh0EC8VALmkXrKN/SV25CkPamUw==',
      },
    },
    qualification: {
      scope: 'disposable-local-installation-and-interface-tests',
      accepted: ['Public archive, checksum and npm integrity', 'Unedited bundled-server component mapping', 'Disposable three-file installation and repeat refusal', 'Two isolated client scopes: 19 standalone MCP tools and 19 gateway-namespaced tools discovered; zero tool calls'],
      uninspected: ['Signed build provenance', 'Full Lexicon CLI installation', 'Native app and Node runtime installation', 'Every tool implementation', 'Vocabulary and project trust', 'Provider acceptance', 'Production readiness'],
    },
    expandedMapping: [
      { archivePath: 'package/plugin/mcp-server.mjs', expandedPath: 'bin/lexicon-mcp', bytesEdited: false },
      { archivePath: 'package/package.json', expandedPath: 'package.json', bytesEdited: false },
      { archivePath: 'package/LICENSE', expandedPath: 'LICENSE', bytesEdited: false },
    ],
    evidence: {
      testedAtUTC: '2026-10-09T21:54:22.662Z',
      scope: 'disposable-macos-arm64-installation-and-interface-tests',
      credentialsCreatedOrRead: false, providerInference: false, toolCalls: 0,
      productionAcceptance: false, officialSignedBuildProvenanceVerified: false,
    },
    bundled: false,
    artifactBinariesBundled: false,
  },
];

export type CompanionCatalogSelection =
  | { status: 'selected'; entry: CompanionCatalogEntry }
  | { status: 'blocked'; blockers: string[] };

/** A selection pins supplied artifact bytes; it neither creates a manifest nor discovers installations. */
export function resolveCompanionCatalog(id: string, platform = `${process.platform}-${process.arch}`): CompanionCatalogSelection {
  const entry = CATALOG.find(record => record.id === id);
  if (!entry) return { status: 'blocked', blockers: ['unknown-catalog-id'] };
  if (entry.manifest.platform !== platform) return { status: 'blocked', blockers: ['catalog-platform-unavailable'] };
  return { status: 'selected', entry: { ...structuredClone(entry), manifestText: JSON.stringify(entry.manifest, null, 2) + '\n' } };
}

/** Metadata inspection is independent of local files, executables, credentials and client configuration. */
export function inspectCompanionCatalog(platform = `${process.platform}-${process.arch}`) {
  return {
    schemaVersion: 1 as const,
    platform,
    effects: [] as string[],
    installed: false as const,
    runtimeCapability: 'not-inspected' as const,
    bundled: false as const,
    artifactBinariesBundled: false as const,
    entries: CATALOG.map(entry => ({ ...structuredClone(entry), manifestText: JSON.stringify(entry.manifest, null, 2) + '\n',
      availability: entry.manifest.platform === platform ? 'available' as const : 'unsupported-platform' as const })),
    unavailable: [{ tool: 'locus' as const, version: '0.5.0', status: 'unqualified' as const,
      reason: 'No reviewed artifact manifest or installed-process acceptance in this shipped catalog.' }],
    qualificationBoundary: 'Local test evidence for the listed component and platform only; no payloads bundled, signed provenance or live installation/readiness claim.',
  };
}
