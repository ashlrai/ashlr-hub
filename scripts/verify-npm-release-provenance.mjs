#!/usr/bin/env node

import { lstatSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const MAX_AUDIT_BYTES = 32 * 1024 * 1024;
const SHA_RE = /^[0-9a-f]{40}$/;
const POSITIVE_INTEGER_RE = /^[1-9][0-9]*$/;

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function decodeSha512Integrity(integrity) {
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
    throw new Error('expected integrity must be canonical sha512 SRI');
  }
  const bytes = Buffer.from(integrity.slice('sha512-'.length), 'base64');
  if (bytes.length !== 64) throw new Error('expected integrity must contain 64 digest bytes');
  return bytes.toString('hex');
}

function decodeStatement(bundle) {
  const envelope = bundle?.bundle?.dsseEnvelope;
  if (envelope?.payloadType !== 'application/vnd.in-toto+json' ||
      typeof envelope.payload !== 'string' || envelope.payload.length > MAX_AUDIT_BYTES) {
    throw new Error('provenance bundle has an invalid DSSE envelope');
  }
  const bytes = Buffer.from(envelope.payload, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_AUDIT_BYTES) {
    throw new Error('provenance statement is empty or out of bounds');
  }
  return JSON.parse(bytes.toString('utf8'));
}

export function verifyNpmReleaseProvenance({
  audit,
  packageName,
  version,
  integrity,
  repository,
  workflowPath,
  ref,
  revision,
  runId,
  runAttempt,
}) {
  requireString(packageName, 'package name');
  requireString(version, 'package version');
  requireString(repository, 'repository');
  requireString(workflowPath, 'workflow path');
  requireString(ref, 'release ref');
  if (!SHA_RE.test(revision)) throw new Error('revision must be an exact lowercase Git SHA');
  if (!POSITIVE_INTEGER_RE.test(runId) || !POSITIVE_INTEGER_RE.test(runAttempt)) {
    throw new Error('run identity must contain positive decimal integers');
  }
  if (!audit || !Array.isArray(audit.invalid) || !Array.isArray(audit.missing) ||
      audit.invalid.length !== 0 || audit.missing.length !== 0 || !Array.isArray(audit.verified)) {
    throw new Error('npm signature audit is incomplete or contains failures');
  }

  const expectedDigest = decodeSha512Integrity(integrity);
  const expectedPurl = `pkg:npm/${packageName.replace(/^@/, '%40')}@${version}`;
  const expectedDependency = `git+${repository}@${ref}`;
  const expectedInvocation = `${repository}/actions/runs/${runId}/attempts/${runAttempt}`;
  const packageRecords = audit.verified.filter((item) =>
    item?.name === packageName && item?.version === version &&
    item?.location === `node_modules/${packageName}` && Array.isArray(item.attestationBundles));
  if (packageRecords.length !== 1) {
    throw new Error('npm audit did not return exactly one installed release package');
  }

  const matches = packageRecords[0].attestationBundles
    .filter((bundle) => bundle?.predicateType === 'https://slsa.dev/provenance/v1')
    .map(decodeStatement)
    .filter((statement) => {
      const subject = statement?.subject;
      const definition = statement?.predicate?.buildDefinition;
      const workflow = definition?.externalParameters?.workflow;
      const github = definition?.internalParameters?.github;
      const dependencies = definition?.resolvedDependencies;
      return statement?._type === 'https://in-toto.io/Statement/v1' &&
        statement?.predicateType === 'https://slsa.dev/provenance/v1' &&
        Array.isArray(subject) && subject.length === 1 &&
        subject[0]?.name === expectedPurl && subject[0]?.digest?.sha512 === expectedDigest &&
        definition?.buildType ===
          'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1' &&
        workflow?.repository === repository && workflow?.path === workflowPath &&
        workflow?.ref === ref && github?.event_name === 'push' &&
        Array.isArray(dependencies) && dependencies.length === 1 &&
        dependencies[0]?.uri === expectedDependency &&
        dependencies[0]?.digest?.gitCommit === revision &&
        statement?.predicate?.runDetails?.builder?.id ===
          'https://github.com/actions/runner/github-hosted' &&
        statement?.predicate?.runDetails?.metadata?.invocationId === expectedInvocation;
    });
  if (matches.length !== 1) {
    throw new Error('npm provenance does not bind exactly to the expected release identity');
  }
  return true;
}

function readBoundedJson(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_AUDIT_BYTES) {
    throw new Error('npm audit result must be a bounded regular file');
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) {
  const [auditPath, packageName, version, integrity, repository, workflowPath, ref, revision,
    runId, runAttempt] = process.argv.slice(2);
  if (process.argv.length !== 12) throw new Error('unexpected provenance verifier arguments');
  verifyNpmReleaseProvenance({
    audit: readBoundedJson(auditPath),
    packageName,
    version,
    integrity,
    repository,
    workflowPath,
    ref,
    revision,
    runId,
    runAttempt,
  });
  process.stdout.write('npm release provenance: verified\n');
}
