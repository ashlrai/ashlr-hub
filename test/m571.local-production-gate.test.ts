import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  renameSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertExternalReceiptPath,
  createIsolatedGateEnvironment,
  createPrivateLocalGateCustodyRoot,
  createPrivateLocalGateTempRoot,
  parseLocalGateArgs,
  prepareDisposableTauriSidecar,
  selectLocalGateSandboxProfile,
  validateLocalGateToolchain,
  validateLocalProductionContract,
  writeSandboxProfiles,
} from '../scripts/run-local-production-gate.mjs';
import { tarballEvidence } from '../scripts/run-local-pack-smoke.mjs';
import { parseBoundedCommandArgs, runBoundedCommand } from '../scripts/run-bounded-command.mjs';
import {
  canonicalizeLocalProductionGateReceipt,
  LOCAL_PRODUCTION_GATE_COMMANDS,
  LOCAL_PRODUCTION_GATE_CONFINEMENT,
  LOCAL_PRODUCTION_GATE_IDS,
  LOCAL_PRODUCTION_GATE_SANITIZED_HOST_IDS,
  localProductionGateConfinement,
  parseCli,
  parseLocalProductionGateReceiptBytes,
  validateLocalProductionGateReceipt,
  verifyExpectedReceiptBindings,
  verifyPersistedArtifact,
} from '../scripts/verify-local-production-gate-receipt.mjs';

const repoRoot = process.cwd();
const scratch: string[] = [];
const digest = 'a'.repeat(64);
const revision = 'b'.repeat(40);
const tree = 'c'.repeat(40);
const integrity = `sha512-${'A'.repeat(86)}==`;
const instant = '2026-09-05T00:00:00.000Z';

function validReceipt(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    kind: 'ashlr-local-production-gate-receipt-v2',
    assurance: 'local-source-verification-only',
    source: { revision, tree, cleanBefore: true, cleanAfter: true },
    toolchain: {
      nodeVersion: '24.18.0',
      npmVersion: '11.16.0',
      rustcVersion: 'rustc 1.95.0 (example)',
      cargoVersion: 'cargo 1.95.0 (example)',
      cargoAuditVersion: 'cargo-audit 0.22.2',
      executables: Object.fromEntries([
        'node', 'npmCli', 'npmRuntime', 'bash', 'git', 'rustc', 'rustdoc', 'cargo', 'cargoAudit',
        'osvScanner', 'sandboxExec',
      ].map((name) => [name, { path: `/tools/${name}`, sha256: digest }])),
    },
    bindings: {
      policy: { policyId: 'ashlr-release-successor-v1:9.8.7', version: '9.8.7', sha256: digest },
      contract: { path: 'ashlr.verify.json', sha256: 'd'.repeat(64) },
      package: {
        name: '@ashlr/hub', version: '9.8.7', tarballName: 'ashlr-hub-9.8.7.tgz',
        sha256: 'e'.repeat(64), integrity,
      },
    },
    execution: {
      startedAt: instant,
      finishedAt: instant,
      hostPlatform: 'darwin',
      confinementModel: 'closed-per-gate-v1',
      sanitizedEnvironment: 'allowlisted-disposable-home-temp-cache-and-ashlr-home',
      sandboxProfiles: {
        networkEnabledSha256: digest,
        networkDeniedSha256: digest,
      },
      externalEffects: 'evidence-writes-recorded;same-uid-output-parent-swap-and-other-effects-not-attested',
      operationalAshlrHome: 'redirected-to-disposable-root',
      disposableSidecar: 'created-exclusive-and-removed-before-receipt',
    },
    gates: LOCAL_PRODUCTION_GATE_IDS.map((id, index) => ({
      id,
      confinement: localProductionGateConfinement(id),
      commandSha256: createHash('sha256')
        .update(Buffer.from(JSON.stringify({
          argv: LOCAL_PRODUCTION_GATE_COMMANDS[index][1],
          cwd: LOCAL_PRODUCTION_GATE_COMMANDS[index][2],
        }), 'utf8')).digest('hex'),
      startedAt: instant,
      finishedAt: instant,
      durationMs: 0,
      exitCode: 0,
      stdoutSha256: digest,
      stderrSha256: digest,
    })),
    authority: {
      activate: false, dispatch: false, install: false, promote: false,
      providerEffects: false, publish: false,
    },
    verdict: 'passed',
  };
}

afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true });
});

describe('M571 local production gate v1', () => {
  it('pins the complete ordered local-only gate without replacing merge shards', () => {
    const contract = JSON.parse(readFileSync(join(repoRoot, 'ashlr.verify.json'), 'utf8'));
    const local = validateLocalProductionContract(contract);
    expect(local.gates.map((gate) => gate.id)).toEqual(LOCAL_PRODUCTION_GATE_IDS);
    expect(local.receiptSchemaVersion).toBe(2);
    expect(local.gates.filter((gate) => (
      gate.confinement === LOCAL_PRODUCTION_GATE_CONFINEMENT.sanitizedHost
    )).map((gate) => gate.id)).toEqual(LOCAL_PRODUCTION_GATE_SANITIZED_HOST_IDS);
    expect(contract.commands.map((gate: { id: string }) => gate.id)).toEqual([
      'typecheck', 'lint', 'build', 'test-ci-1-of-3', 'test-ci-2-of-3', 'test-ci-3-of-3',
    ]);
    expect(local.gates.find((gate) => gate.id === 'native-clippy')?.cmd).toEqual([
      'cargo', 'clippy', '--locked', '--offline', '--all-targets', '--', '-D', 'warnings',
    ]);
    expect(local.gates.find((gate) => gate.id === 'native-audit')?.cmd).toContain('RUSTSEC-2024-0429');
    const drifted = structuredClone(contract);
    drifted.localProductionGate.gates[0].cmd = ['true'];
    expect(() => validateLocalProductionContract(drifted)).toThrow(/closed v1 command/u);
    const confinementDrift = structuredClone(contract);
    confinementDrift.localProductionGate.gates[5].confinement =
      LOCAL_PRODUCTION_GATE_CONFINEMENT.networkDeniedSandbox;
    expect(() => validateLocalProductionContract(confinementDrift)).toThrow(/closed v1 command/u);
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.scripts['verify:local-production']).toBe('node scripts/run-local-production-gate.mjs');
  });

  it('accepts only canonical complete passing receipts and binds caller pins', () => {
    const receipt = validReceipt();
    validateLocalProductionGateReceipt(receipt);
    const bytes = Buffer.from(`${canonicalizeLocalProductionGateReceipt(receipt)}\n`, 'utf8');
    const parsed = parseLocalProductionGateReceiptBytes(bytes);
    expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(() => verifyExpectedReceiptBindings(parsed, {
      revision,
      tree,
      policySha256: digest,
      contractSha256: 'd'.repeat(64),
      integrity,
      receiptSha256: parsed.sha256,
    })).not.toThrow();
    expect(() => parseLocalProductionGateReceiptBytes(Buffer.from(JSON.stringify(receipt)))).toThrow(/canonical/u);
  });

  it('runs only exact-source test stages without an outer sandbox', () => {
    const profiles = { networkEnabled: { name: 'enabled' }, networkDenied: { name: 'denied' } };
    const contract = validateLocalProductionContract(
      JSON.parse(readFileSync(join(repoRoot, 'ashlr.verify.json'), 'utf8')),
    );
    expect(contract.gates.map((gate) => [
      gate.id,
      selectLocalGateSandboxProfile(gate, profiles)?.name ?? 'host',
    ])).toEqual([
      ['install-root', 'enabled'], ['install-raycast', 'enabled'],
      ['typecheck', 'denied'], ['lint', 'denied'], ['build', 'denied'],
      ['test-ci-1-of-3', 'host'], ['test-ci-2-of-3', 'host'],
      ['test-ci-3-of-3', 'host'], ['test-web', 'denied'],
      ['audit-root-full', 'enabled'], ['audit-root-production', 'enabled'],
      ['audit-raycast-full', 'enabled'], ['audit-raycast-production', 'enabled'],
      ['pack-smoke', 'denied'], ['native-fetch', 'enabled'], ['native-fmt', 'denied'],
      ['native-check', 'denied'], ['native-clippy', 'denied'], ['native-test', 'denied'],
      ['native-audit', 'enabled'],
    ]);
  });

  it('rejects failed, reordered, incomplete, or authority-bearing evidence', () => {
    const failed = validReceipt();
    (failed.gates as Array<Record<string, unknown>>)[0].exitCode = 1;
    expect(() => validateLocalProductionGateReceipt(failed)).toThrow(/successful/u);
    const reordered = validReceipt();
    (reordered.gates as Array<Record<string, unknown>>).reverse();
    expect(() => validateLocalProductionGateReceipt(reordered)).toThrow(/out of order/u);
    const incomplete = validReceipt();
    (incomplete.gates as Array<Record<string, unknown>>).pop();
    expect(() => validateLocalProductionGateReceipt(incomplete)).toThrow(/complete ordered/u);
    const authority = validReceipt();
    (authority.authority as Record<string, unknown>).publish = true;
    expect(() => validateLocalProductionGateReceipt(authority)).toThrow(/every effect false/u);
    const confinement = validReceipt();
    (confinement.gates as Array<Record<string, unknown>>)[5].confinement =
      LOCAL_PRODUCTION_GATE_CONFINEMENT.networkDeniedSandbox;
    expect(() => validateLocalProductionGateReceipt(confinement)).toThrow(/per-gate model/u);
  });

  it('requires Node 24+, npm 11+, and exact policy toolchain identity', () => {
    const policy = { toolchain: { nodeVersion: '24.18.0', npmVersion: '11.16.0' } };
    expect(validateLocalGateToolchain({ nodeVersion: 'v24.18.0', npmVersion: '11.16.0', policy }))
      .toEqual({ nodeVersion: '24.18.0', npmVersion: '11.16.0' });
    expect(() => validateLocalGateToolchain({ nodeVersion: '22.22.3', npmVersion: '11.16.0', policy }))
      .toThrow(/Node/u);
    expect(() => validateLocalGateToolchain({ nodeVersion: '24.18.0', npmVersion: '11.15.0', policy }))
      .toThrow(/exactly match/u);
  });

  it('requires a pinned commit, tracked policy argument, and absolute external receipt', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-m571-args-'));
    scratch.push(root);
    const receipt = join(root, 'receipt.json');
    const artifact = join(root, 'ashlr-hub-9.8.7.tgz');
    expect(parseLocalGateArgs([
      '--expected-sha', revision, '--policy', '.github/release-policies/v9.8.7.json',
      '--artifact', artifact, '--receipt', receipt,
    ])).toMatchObject({ expectedSha: revision, artifactPath: artifact, receiptPath: receipt });
    expect(() => parseLocalGateArgs([
      '--expected-sha', revision, '--policy', 'policy.json', '--artifact', artifact,
      '--receipt', 'relative.json',
    ])).toThrow(/absolute/u);
    expect(assertExternalReceiptPath(repoRoot, receipt).path)
      .toMatch(/\/ashlr-m571-args-[^/]+\/receipt\.json$/u);
    expect(() => assertExternalReceiptPath(repoRoot, join(repoRoot, 'receipt.json'))).toThrow(/outside/u);
  });

  it.runIf(process.platform === 'darwin')('creates one inert sidecar exclusively and removes only its own file', () => {
    const fakeRepo = mkdtempSync(join(tmpdir(), 'ashlr-m571-sidecar-'));
    scratch.push(fakeRepo);
    const binaries = join(fakeRepo, 'desktop', 'src-tauri', 'binaries');
    mkdirSync(binaries, { recursive: true });
    const rustc = 'rustc 1.95.0\nhost: aarch64-apple-darwin\n';
    const sidecar = prepareDisposableTauriSidecar(fakeRepo, rustc);
    expect(existsSync(sidecar.path)).toBe(true);
    expect(readFileSync(sidecar.path, 'utf8')).toBe('#!/bin/sh\nexit 64\n');
    expect(() => prepareDisposableTauriSidecar(fakeRepo, rustc)).toThrow(/already exists/u);
    sidecar.cleanup();
    expect(existsSync(sidecar.path)).toBe(false);
  });

  it.runIf(process.platform === 'darwin')('keeps private nested Unix sockets inside the Darwin path budget', () => {
    const tempDirectory = (() => {
      const inheritedTmpdir = process.env.TMPDIR;
      process.env.TMPDIR = `/private/tmp/${'inherited-path-component-'.repeat(8)}`;
      try {
        return createPrivateLocalGateTempRoot();
      } finally {
        if (inheritedTmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = inheritedTmpdir;
      }
    })();
    const root = tempDirectory.path;
    scratch.push(root);
    const identity = lstatSync(root);
    expect(realpathSync(root)).toBe(root);
    expect(root).toMatch(/^\/private\/tmp\/alg-[A-Za-z0-9]{6}$/u);
    expect(identity.isDirectory()).toBe(true);
    expect(identity.isSymbolicLink()).toBe(false);
    expect(identity.uid).toBe(process.getuid());
    expect(identity.mode & 0o777).toBe(0o700);

    const childTmp = join(root, 'tmp');
    mkdirSync(childTmp, { mode: 0o700 });
    const fixture = mkdtempSync(join(childTmp, 'ashlr-m567-docker-'));
    const socketPath = join(fixture, 'engine.sock');
    expect(Buffer.byteLength(socketPath, 'utf8')).toBeLessThanOrEqual(103);
    const probe = spawnSync(process.execPath, ['-e', [
      'const net=require("node:net");',
      'const server=net.createServer();',
      'server.once("error",()=>process.exit(42));',
      'server.listen(process.argv[1],()=>server.close(()=>process.exit(0)));',
    ].join(''), socketPath], { timeout: 5_000 });
    expect(probe.status).toBe(0);
    tempDirectory.cleanup();
    expect(existsSync(root)).toBe(false);
    expect(() => tempDirectory.cleanup()).not.toThrow();
  });

  it.runIf(process.platform === 'darwin')('separates short scratch paths from private HOME custody', () => {
    const inheritedTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = `/private/tmp/${'untrusted-inherited-path-'.repeat(8)}`;
    const [tempDirectory, custodyDirectory] = (() => {
      try {
        const temp = createPrivateLocalGateTempRoot();
        try {
          return [temp, createPrivateLocalGateCustodyRoot()] as const;
        } catch (error) {
          temp.cleanup();
          throw error;
        }
      } finally {
        if (inheritedTmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = inheritedTmpdir;
      }
    })();
    const darwinTemp = realpathSync(spawnSync(
      '/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' },
    ).stdout.trim());
    expect(tempDirectory.path).toMatch(/^\/private\/tmp\/alg-[A-Za-z0-9]{6}$/u);
    expect(dirname(custodyDirectory.path)).toBe(darwinTemp);
    expect(basename(custodyDirectory.path)).toMatch(/^agc-[A-Za-z0-9]{6}$/u);
    expect(lstatSync(custodyDirectory.path).mode & 0o7777).toBe(0o700);

    const env = createIsolatedGateEnvironment({
      repoRoot,
      tempRoot: tempDirectory.path,
      custodyRoot: custodyDirectory.path,
      tools: {
        paths: {
          node: process.execPath,
          npmCli: join(repoRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
          cargoAudit: '/usr/bin/true',
          osvScanner: '/usr/bin/true',
          git: '/usr/bin/git',
          rustc: '/usr/bin/true',
          rustdoc: '/usr/bin/true',
        },
      },
    });
    expect(env.TMPDIR).toBe(join(tempDirectory.path, 'tmp'));
    expect(env.HOME).toBe(join(custodyDirectory.path, 'home'));
    expect(env.USERPROFILE).toBe(env.HOME);
    expect(env.ASHLR_HOME).toBe(join(env.HOME, '.ashlr'));
    expect(env.ASHLR_VITEST_HOME_PARENT).toBe(join(custodyDirectory.path, 'vitest-homes'));
    expect(lstatSync(env.ASHLR_VITEST_HOME_PARENT).mode & 0o7777).toBe(0o700);
    tempDirectory.cleanup();
    custodyDirectory.cleanup();
  });

  it.runIf(process.platform === 'darwin')('refuses to clean a replaced private temp root', () => {
    const tempDirectory = createPrivateLocalGateTempRoot();
    const root = tempDirectory.path;
    const movedRoot = `${root}.owned`;
    const victim = mkdtempSync('/private/tmp/alg-victim-');
    scratch.push(root, movedRoot, victim);
    writeFileSync(join(victim, 'keep.txt'), 'keep', 'utf8');
    renameSync(root, movedRoot);
    symlinkSync(victim, root);
    expect(() => tempDirectory.cleanup()).toThrow(/identity changed/u);
    expect(readFileSync(join(victim, 'keep.txt'), 'utf8')).toBe('keep');
    rmSync(root);
    renameSync(movedRoot, root);
    tempDirectory.cleanup();
    expect(existsSync(root)).toBe(false);
  });

  it.runIf(process.platform === 'darwin')('refuses to clean a replaced private custody root', () => {
    const custodyDirectory = createPrivateLocalGateCustodyRoot();
    const root = custodyDirectory.path;
    const movedRoot = `${root}.owned`;
    const victim = mkdtempSync(join(dirname(root), 'agc-victim-'));
    scratch.push(root, movedRoot, victim);
    writeFileSync(join(victim, 'keep.txt'), 'keep', 'utf8');
    renameSync(root, movedRoot);
    symlinkSync(victim, root);
    expect(() => custodyDirectory.cleanup()).toThrow(/identity changed/u);
    expect(readFileSync(join(victim, 'keep.txt'), 'utf8')).toBe('keep');
    rmSync(root);
    renameSync(movedRoot, root);
    custodyDirectory.cleanup();
    expect(existsSync(root)).toBe(false);
  });

  it.runIf(process.platform === 'darwin')('enforces the private write root and deny-network sandbox', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-m571-sandbox-'));
    const profileRoot = mkdtempSync(join(tmpdir(), 'ashlr-m571-profiles-'));
    const custodyDirectory = createPrivateLocalGateCustodyRoot();
    scratch.push(root, profileRoot, custodyDirectory.path);
    mkdirSync(join(root, 'tmp'));
    mkdirSync(join(custodyDirectory.path, 'home'));
    const profiles = writeSandboxProfiles({
      verificationRoot: repoRoot, tempRoot: root,
      custodyRoot: custodyDirectory.path, profileRoot,
    });
    const allowed = join(root, 'tmp', 'allowed.txt');
    expect(spawnSync('/usr/bin/sandbox-exec', [
      '-f', profiles.networkDenied.path, process.execPath, '-e',
      'require("node:fs").writeFileSync(process.argv[1], "ok")', allowed,
    ]).status).toBe(0);
    expect(readFileSync(allowed, 'utf8')).toBe('ok');

    const allowedHome = join(custodyDirectory.path, 'home', 'allowed.txt');
    expect(spawnSync('/usr/bin/sandbox-exec', [
      '-f', profiles.networkDenied.path, process.execPath, '-e',
      'require("node:fs").writeFileSync(process.argv[1], "ok")', allowedHome,
    ]).status).toBe(0);
    expect(readFileSync(allowedHome, 'utf8')).toBe('ok');

    const denied = join(homedir(), '.ashlr-m571-sandbox-denied');
    expect(existsSync(denied)).toBe(false);

    expect(spawnSync('/usr/bin/sandbox-exec', [
      '-f', profiles.networkDenied.path, process.execPath, '-e',
      'require("node:fs").writeFileSync(process.argv[1], "escape")', profiles.networkDenied.path,
    ]).status).not.toBe(0);
    expect(spawnSync('/usr/bin/sandbox-exec', [
      '-f', profiles.networkDenied.path, process.execPath, '-e',
      'require("node:fs").writeFileSync(process.argv[1], "no")', denied,
    ]).status).not.toBe(0);
    expect(existsSync(denied)).toBe(false);

    const network = spawnSync('/usr/bin/sandbox-exec', [
      '-f', profiles.networkDenied.path, process.execPath, '-e',
      'const net=require("node:net");const s=net.connect(443,"1.1.1.1");s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(42));',
    ]);
    expect(network.status).toBe(42);

    const loopback = spawnSync('/usr/bin/sandbox-exec', [
      '-f', profiles.networkDenied.path, process.execPath, '-e',
      'const http=require("node:http");const h=http.createServer((_,r)=>r.end("ok"));h.listen(0,"127.0.0.1",()=>{const port=h.address().port;http.get(`http://127.0.0.1:${port}`,r=>{let b="";r.on("data",c=>b+=c);r.on("end",()=>h.close(()=>process.exit(b==="ok"?0:43)));}).on("error",()=>process.exit(42));});h.on("error",()=>process.exit(42));',
    ]);
    expect(loopback.status).toBe(0);

    const socket = join(root, 'tmp', 'fixture.sock');
    const localIpc = spawnSync('/usr/bin/sandbox-exec', [
      '-f', profiles.networkDenied.path, process.execPath, '-e',
      'const n=require("node:net");const h=n.createServer();h.listen(process.argv[1],()=>h.close(()=>process.exit(0)));h.on("error",()=>process.exit(42));',
      socket,
    ]);
    expect(localIpc.status).toBe(0);

    const git = spawnSync('/usr/bin/xcrun', ['-f', 'git'], { encoding: 'utf8' }).stdout.trim();
    const gitStatus = spawnSync('/usr/bin/sandbox-exec', [
      '-f', profiles.networkDenied.path, git, 'status', '--porcelain=v1',
    ], {
      cwd: repoRoot,
      env: {
        PATH: `${git.slice(0, git.lastIndexOf('/'))}:/usr/bin:/bin`,
        HOME: join(custodyDirectory.path, 'home'),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
      },
    });
    expect(gitStatus.status).toBe(0);
  });

  it('recomputes both tarball SHA-256 and npm-compatible sha512 SRI', () => {
    expect(tarballEvidence(Buffer.from('ashlr', 'utf8'))).toEqual({
      sha256: '7be78d718b02239002e56900741a42d7f4ce6953c69a092d41fe5163236d11ae',
      integrity: 'sha512-0QPHexANJE3e13GBIZZy0RjoNQOazVvzeaUCU/omHM1XkplC2TigkMRSei6L9CS+FUlxYdoITNvFki03plBwkw==',
      size: 5,
    });
  });

  it('requires complete caller pins and verifies the persisted tarball bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-m571-artifact-'));
    scratch.push(root);
    const artifact = join(root, 'ashlr-hub-9.8.7.tgz');
    const bytes = Buffer.from('verified artifact', 'utf8');
    const evidence = tarballEvidence(bytes);
    const receipt = validReceipt();
    Object.assign((receipt.bindings as Record<string, Record<string, unknown>>).package, {
      sha256: evidence.sha256,
      integrity: evidence.integrity,
    });
    const parsed = parseLocalProductionGateReceiptBytes(
      Buffer.from(`${canonicalizeLocalProductionGateReceipt(receipt)}\n`, 'utf8'),
    );
    writeFileSync(artifact, bytes);
    expect(() => verifyPersistedArtifact(parsed, artifact)).not.toThrow();
    expect(() => parseCli([artifact])).toThrow(/binding pins/u);
  });

  it('provides the exact bounded timeout interface used by local macOS audits', () => {
    expect(parseBoundedCommandArgs([
      '--signal=TERM', '--kill-after=5s', '40s', 'npm', 'audit', '--json',
    ])).toEqual({
      timeoutMs: 40_000,
      killAfterMs: 5_000,
      command: 'npm',
      args: ['audit', '--json'],
    });
    expect(() => parseBoundedCommandArgs(['40s', 'npm'])).toThrow(/expected/u);
  });

  it.runIf(process.platform !== 'win32')('kills timeout descendants before returning', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-m571-process-group-'));
    scratch.push(root);
    const marker = join(root, 'escaped.txt');
    const program = [
      'const {spawn}=require("node:child_process");',
      'const child=spawn(process.execPath,["-e",',
      '  `setTimeout(()=>require("node:fs").writeFileSync(process.argv[1],"escaped"),500)`,',
      '  process.argv[1]],{stdio:"ignore"});',
      'child.unref();setInterval(()=>{},1000);',
    ].join('');
    await expect(runBoundedCommand({
      command: process.execPath,
      args: ['-e', program, marker],
      timeoutMs: 100,
      killAfterMs: 100,
    })).resolves.toBe(124);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 700));
    expect(existsSync(marker)).toBe(false);

    const normalMarker = join(root, 'normal-escaped.txt');
    const backgroundProgram = [
      'const {spawn}=require("node:child_process");',
      'const child=spawn(process.execPath,["-e",',
      '  `setTimeout(()=>require("node:fs").writeFileSync(process.argv[1],"escaped"),500)`,',
      '  process.argv[1]],{stdio:"ignore"});child.unref();',
    ].join('');
    await expect(runBoundedCommand({
      command: process.execPath,
      args: ['-e', backgroundProgram, normalMarker],
      timeoutMs: 5_000,
      killAfterMs: 100,
    })).resolves.toBe(0);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 700));
    expect(existsSync(normalMarker)).toBe(false);
  });

  it('documents local execution without claiming release or runtime authority', () => {
    const contract = readFileSync(join(repoRoot, 'docs', 'contracts', 'CONTRACT-M571.md'), 'utf8');
    const runner = readFileSync(join(repoRoot, 'scripts', 'run-local-production-gate.mjs'), 'utf8');
    expect(contract).toContain('does not publish, promote, install a production runtime');
    expect(contract).toContain('host account\'s filesystem');
    expect(contract).toContain('IPC, and network authority');
    expect(runner).toContain("GIT_CONFIG_GLOBAL: '/dev/null'");
    expect(runner).not.toContain('...process.env');
    expect(runner).toContain("ASHLR_RUN_NATIVE_LAUNCHD_TEST: '0'");
    expect(runner).not.toMatch(/execSync\(['"]gh|spawn\(['"]gh/u);
  });
});
