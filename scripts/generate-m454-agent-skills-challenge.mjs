#!/usr/bin/env node

import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const UPSTREAM_REPOSITORY = 'addyosmani/agent-skills';
const UPSTREAM_COMMIT = 'ff2df4c07e7836a092ed28e1e9b42f4d6009280c';
const UPSTREAM_TREE = '36876efd1595ee7ff6c487d579b14d7bca68c4a3';
const UPSTREAM_SKILLS_TREE = '06cca6b1b013edccc3e4a17786796fa0e36ea06f';
const UPSTREAM_CASES_TREE = '4c20914d56f32558f66d62fee0a32f522fed48d9';
const UPSTREAM_LICENSE_OBJECT = 'd67778ada6b9cda6227e9130da182c13e73c8b2e';
const UPSTREAM_LICENSE_DIGEST = '6f202f8bd568cd730dbb2b0d1f8e243bc74c2fa1f64dbce9b2c7ea08bd5c9fd7';
const UPSTREAM_PACK_DIGEST = 'b4e5b36cc59ae906dc8b6190c5b4224b53b3c71366bbaa48544d79af37a11670';
const UPSTREAM_PORTABLE_PACK_DIGEST = 'a623e71881424201a414ddb5ade72c7c9ee680cabcd834ee26f39e72d1675523';
const EXTERNAL_AUDIT_POLICY_DIGEST = 'b1353f227d80c2d86321d629a08904294ddb7984254f47cd32ee241dc43f9ce5';
const EXPECTED_SELECTED_SOURCE_DIGEST = '150db656d5bac8ad076268d13d715e77c1b578b5f1b56bf4de95683c18eda13b';
const EXPECTED_SOURCE_CANONICAL_DIGEST = '06309cbea8afd81a24d882e91ff40f16cd8924fb93569388a9a06e5cb8c7260e';
const EXTRACTION_POLICY_VERSION = 'm454-agent-skills-upstream-v2';
const OBSERVED_AT = '2026-07-24T09:04:23.000Z';
const AS_OF = '2026-07-24T09:07:23.000Z';
const EXPECTED_SKILLS = 24;
const EXPECTED_POSITIVES = 76;
const EXPECTED_POSITIVE_TOP_K_1 = 4;
const EXPECTED_POSITIVE_TOP_K_3 = 72;
const EXPECTED_NEGATIVES = 48;
const EXPECTED_OWNERLESS_NEGATIVES = 10;
const EXPECTED_BEHAVIORAL_CASES = 29;
const EXPECTED_SELECTED_FILES = 48;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_AGGREGATE_BYTES = 8 * 1024 * 1024;
const MAX_PROMPT_BYTES = 8 * 1024;
const MAX_DESCRIPTION_BYTES = 16 * 1024;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TREE_ENTRY_RE = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/;
const SKILL_PATH_RE = /^skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/;
const CASE_PATH_RE = /^evals\/cases\/([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/;
const SNAPSHOT_FILE = 'agent-skills-ff2df4c.snapshot.json';
const PROVENANCE_FILE = 'agent-skills-ff2df4c.provenance.json';
const IMPLEMENTATION_FILES = [
  ['src/core/fleet/skill-routing-calibration.ts', '1c9c81bf135b691c404b98d83520f6e60cd113244533ebd286b00acdc7d7578c'],
  ['src/core/fleet/skill-routing-calibration-snapshot.ts', 'fd891a327b7cbc55f1d4c0e3efc09935e134ba6ed978c8444ef9bdfa697a95b2'],
  ['dist/core/fleet/skill-routing-calibration.js', 'cccc98227e8ad95ec78c1ab848cfa0d3b919de03816f0148f9bff41c4b654192'],
  ['dist/core/fleet/skill-routing-calibration-snapshot.js', '093aea3bbaca6da4742a0a18e73e4c0ed9386c577cae91afebc620f383c6ea4f'],
];

const SOURCE_KEYS = [
  'schemaVersion', 'sourceRevision', 'routerPolicyVersion', 'sourceState',
  'complete', 'invalidRows', 'duplicateRows', 'conflictingRows', 'limitExceeded',
  'skills', 'cases', 'sourceId', 'kind', 'ownerSkillSourceId',
  'excludedSkillSourceId', 'observedAt', 'textParts',
];

function fail(message) {
  throw new Error(`M454 fixture generation failed: ${message}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalTextBytes(bytes) {
  return Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

function boundedString(value, maximum, label) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maximum) {
    fail(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function directDirectory(path, label) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a direct directory`);
}

function verifiedGitExecutable(input) {
  if (!isAbsolute(input)) fail('Git executable must be an absolute path');
  const lexicalPath = resolve(input);
  const lexicalStat = lstatSync(lexicalPath);
  if (!lexicalStat.isFile() || lexicalStat.isSymbolicLink()) {
    fail('Git executable must be a direct regular file');
  }
  if (realpathSync(lexicalPath) !== lexicalPath) fail('Git executable path must be canonical');
  if (process.platform !== 'win32') {
    if ((lexicalStat.mode & 0o111) === 0) fail('Git executable is not executable');
    if ((lexicalStat.mode & 0o022) !== 0) fail('Git executable must not be group or world writable');
    const currentUid = process.getuid?.();
    if (currentUid !== undefined && lexicalStat.uid !== 0 && lexicalStat.uid !== currentUid) {
      fail('Git executable must be owned by root or the invoking user');
    }
  }
  return {
    path: lexicalPath,
    digest: sha256(readFileSync(lexicalPath)),
  };
}

function gitEnvironment() {
  return {
    SYSTEMROOT: process.env['SYSTEMROOT'] ?? '',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
  };
}

function git(executable, root, args, encoding = 'buffer') {
  return execFileSync(executable, ['--no-replace-objects', '-C', root, ...args], {
    encoding,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    windowsHide: true,
    env: gitEnvironment(),
  });
}

function gitText(executable, root, args) {
  return git(executable, root, args, 'utf8').trim();
}

function optionalGitText(executable, root, args) {
  const result = spawnSync(executable, ['--no-replace-objects', '-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    windowsHide: true,
    env: gitEnvironment(),
  });
  if (result.status === 1) return '';
  if (result.status !== 0) fail(`Git inspection failed: ${result.stderr.trim() || 'unknown error'}`);
  return result.stdout.trim();
}

function verifyRepositoryIsolation(executable, root) {
  const partialClone = optionalGitText(executable, root, [
    'config', '--get-regexp', '^(extensions\\.partialClone|remote\\..*\\.promisor)$',
  ]);
  if (partialClone.length > 0) fail('partial/promisor repositories are unsupported');
  for (const name of ['objects/info/alternates', 'objects/info/http-alternates']) {
    const candidate = gitText(executable, root, ['rev-parse', '--git-path', name]);
    const path = isAbsolute(candidate) ? candidate : resolve(root, candidate);
    if (existsSync(path)) fail(`object alternates are unsupported: ${name}`);
  }
}

function verifyPinnedObjects(executable, root) {
  const checks = [
    [['rev-parse', '--verify', `${UPSTREAM_COMMIT}^{commit}`], UPSTREAM_COMMIT, 'commit'],
    [['rev-parse', '--verify', `${UPSTREAM_COMMIT}^{tree}`], UPSTREAM_TREE, 'root tree'],
    [['rev-parse', '--verify', `${UPSTREAM_COMMIT}:skills`], UPSTREAM_SKILLS_TREE, 'skills tree'],
    [['rev-parse', '--verify', `${UPSTREAM_COMMIT}:evals/cases`], UPSTREAM_CASES_TREE, 'cases tree'],
    [['rev-parse', '--verify', `${UPSTREAM_COMMIT}:LICENSE`], UPSTREAM_LICENSE_OBJECT, 'license object'],
  ];
  for (const [args, expected, label] of checks) {
    const actual = gitText(executable, root, args);
    if (actual !== expected) fail(`expected ${label} ${expected}, received ${actual}`);
  }
  const licenseBytes = git(executable, root, ['cat-file', 'blob', UPSTREAM_LICENSE_OBJECT]);
  if (sha256(licenseBytes) !== UPSTREAM_LICENSE_DIGEST) fail('license bytes do not match the pinned digest');
}

function selectedTreeEntries(executable, root) {
  const output = git(executable, root, [
    'ls-tree', '-r', '-z', '--full-tree', UPSTREAM_COMMIT, '--', 'skills', 'evals/cases',
  ]);
  const records = output.toString('utf8').split('\0').filter(Boolean);
  const selected = [];
  for (const record of records) {
    const match = record.match(TREE_ENTRY_RE);
    if (!match) fail('selected tree contains an unsupported entry');
    const path = match[3];
    if (SKILL_PATH_RE.test(path) || CASE_PATH_RE.test(path)) {
      selected.push({ mode: match[1], objectId: match[2], path });
    }
  }
  selected.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  if (selected.length !== EXPECTED_SELECTED_FILES) {
    fail(`expected ${EXPECTED_SELECTED_FILES} selected files, received ${selected.length}`);
  }
  return selected;
}

function readSelectedSource(executable, root) {
  const entries = selectedTreeEntries(executable, root);
  const blobs = new Map();
  const selectedFiles = [];
  let aggregateBytes = 0;
  for (const entry of entries) {
    const blob = git(executable, root, ['cat-file', 'blob', entry.objectId]);
    if (blob.byteLength > MAX_FILE_BYTES) fail(`${entry.path} exceeds the file bound`);
    aggregateBytes += blob.byteLength;
    if (aggregateBytes > MAX_AGGREGATE_BYTES) fail('aggregate input limit exceeded');
    selectedFiles.push([entry.path, blob.byteLength, sha256(blob)]);
    blobs.set(entry.path, blob.toString('utf8'));
  }
  return {
    entries,
    blobs,
    selectedSourceDigest: sha256(Buffer.from(JSON.stringify([
      'ashlr.m454.addyosmani-agent-skills-source.v1',
      UPSTREAM_COMMIT,
      UPSTREAM_TREE,
      selectedFiles,
    ]), 'utf8')),
  };
}

function verifyImplementation(repoRoot) {
  const digestInput = ['ashlr.m454.projection-implementation.v1'];
  const compiledModules = new Map();
  for (const [relativePath, expectedDigest] of IMPLEMENTATION_FILES) {
    const bytes = readFileSync(join(repoRoot, relativePath));
    const canonicalBytes = canonicalTextBytes(bytes);
    const actualDigest = sha256(canonicalBytes);
    if (actualDigest !== expectedDigest) {
      fail(`${relativePath} does not match the reviewed implementation`);
    }
    digestInput.push([relativePath, actualDigest]);
    if (relativePath.startsWith('dist/')) compiledModules.set(relativePath, canonicalBytes);
  }
  return {
    digest: sha256(Buffer.from(JSON.stringify(digestInput), 'utf8')),
    compiledModules,
  };
}

async function loadVerifiedProjectionModules(compiledModules) {
  const directory = mkdtempSync(join(tmpdir(), 'ashlr-m454-projection-'));
  try {
    const calibrationPath = join(directory, 'skill-routing-calibration.js');
    const snapshotPath = join(directory, 'skill-routing-calibration-snapshot.js');
    const calibrationBytes = compiledModules.get('dist/core/fleet/skill-routing-calibration.js');
    const snapshotBytes = compiledModules.get('dist/core/fleet/skill-routing-calibration-snapshot.js');
    if (!calibrationBytes || !snapshotBytes) fail('verified compiled projection modules are incomplete');
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}\n', { flag: 'wx', mode: 0o600 });
    writeFileSync(calibrationPath, calibrationBytes, { flag: 'wx', mode: 0o600 });
    writeFileSync(snapshotPath, snapshotBytes, { flag: 'wx', mode: 0o600 });
    const calibrationModule = await import(pathToFileURL(calibrationPath).href);
    const projectionModule = await import(pathToFileURL(snapshotPath).href);
    return { calibrationModule, projectionModule };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function frontmatterField(source, name, label) {
  const match = source.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) fail(`${label} has no bounded frontmatter`);
  const field = match[1].match(new RegExp(`^${name}:\\s*(.+)$`, 'm'));
  return boundedString(field?.[1]?.trim(), MAX_DESCRIPTION_BYTES, `${label}.${name}`);
}

function buildSource(selected, routerPolicyVersion) {
  const skillEntries = selected.entries.filter((entry) => SKILL_PATH_RE.test(entry.path));
  const caseEntries = selected.entries.filter((entry) => CASE_PATH_RE.test(entry.path));
  if (skillEntries.length !== EXPECTED_SKILLS || caseEntries.length !== EXPECTED_SKILLS) {
    fail('selected source does not contain the expected skill/case split');
  }

  const skills = skillEntries.map((entry) => {
    const directory = entry.path.match(SKILL_PATH_RE)?.[1];
    if (!directory || !NAME_RE.test(directory)) fail(`invalid skill path ${entry.path}`);
    const source = selected.blobs.get(entry.path);
    if (source === undefined) fail(`missing selected blob ${entry.path}`);
    const name = frontmatterField(source, 'name', entry.path);
    const description = frontmatterField(source, 'description', entry.path);
    if (name !== directory) fail(`skill name does not match path ${entry.path}`);
    return { name, description };
  });
  const skillNames = new Set(skills.map((skill) => skill.name));
  if (skillNames.size !== EXPECTED_SKILLS) fail('duplicate skill names');

  const cases = [];
  let positiveCases = 0;
  let positiveTopK1Cases = 0;
  let positiveTopK3Cases = 0;
  let allNegativeCases = 0;
  let ownerlessNegativeCases = 0;
  let behavioralCases = 0;
  for (const entry of caseEntries) {
    const fileSkill = entry.path.match(CASE_PATH_RE)?.[1];
    const source = selected.blobs.get(entry.path);
    if (!fileSkill || source === undefined) fail(`invalid case path ${entry.path}`);
    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch {
      fail(`case file ${entry.path} is not valid JSON`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      fail(`case file ${entry.path} must be an object`);
    }
    const skillName = boundedString(parsed.skill_name, 128, `${entry.path}.skill_name`);
    if (skillName !== fileSkill || !skillNames.has(skillName)) fail(`case ownership mismatch: ${entry.path}`);
    const trigger = parsed.trigger;
    if (typeof trigger !== 'object' || trigger === null || Array.isArray(trigger) ||
      !Array.isArray(trigger.positive) || !Array.isArray(trigger.negative)) {
      fail(`case file ${entry.path} has invalid triggers`);
    }
    if (!Array.isArray(parsed.evals)) fail(`case file ${entry.path} has invalid behavioral cases`);
    behavioralCases += parsed.evals.length;

    for (const [index, raw] of trigger.positive.entries()) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        fail(`${entry.path} positive ${index} is invalid`);
      }
      const prompt = boundedString(raw.prompt, MAX_PROMPT_BYTES, `${entry.path} positive ${index} prompt`);
      if (raw.top_k === 1) positiveTopK1Cases += 1;
      else if (raw.top_k === 3) positiveTopK3Cases += 1;
      else fail(`${entry.path} positive ${index} has an unsupported top_k`);
      cases.push({
        sourceId: `positive:${skillName}:${index}`,
        kind: 'positive-owner',
        ownerSkillSourceId: skillName,
        excludedSkillSourceId: null,
        observedAt: OBSERVED_AT,
        textParts: [prompt],
      });
      positiveCases += 1;
    }

    for (const [index, raw] of trigger.negative.entries()) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        fail(`${entry.path} negative ${index} is invalid`);
      }
      const prompt = boundedString(raw.prompt, MAX_PROMPT_BYTES, `${entry.path} negative ${index} prompt`);
      allNegativeCases += 1;
      if (raw.owner === undefined) {
        ownerlessNegativeCases += 1;
        continue;
      }
      const owner = boundedString(raw.owner, 128, `${entry.path} negative ${index} owner`);
      if (!skillNames.has(owner) || owner === skillName) fail(`${entry.path} negative ${index} has invalid owner`);
      cases.push({
        sourceId: `negative:${skillName}:${index}`,
        kind: 'negative-owner',
        ownerSkillSourceId: owner,
        excludedSkillSourceId: skillName,
        observedAt: OBSERVED_AT,
        textParts: [prompt],
      });
    }
  }
  if (positiveCases !== EXPECTED_POSITIVES ||
    positiveTopK1Cases !== EXPECTED_POSITIVE_TOP_K_1 ||
    positiveTopK3Cases !== EXPECTED_POSITIVE_TOP_K_3 ||
    allNegativeCases !== EXPECTED_NEGATIVES ||
    ownerlessNegativeCases !== EXPECTED_OWNERLESS_NEGATIVES ||
    behavioralCases !== EXPECTED_BEHAVIORAL_CASES) {
    fail('upstream coverage changed');
  }

  return {
    source: {
      schemaVersion: 1,
      sourceRevision: `agent-skills-${UPSTREAM_COMMIT}`,
      routerPolicyVersion,
      sourceState: 'healthy',
      complete: true,
      invalidRows: 0,
      duplicateRows: 0,
      conflictingRows: 0,
      limitExceeded: false,
      skills: skills.map((skill) => ({
        sourceId: skill.name,
        textParts: [skill.name, skill.name, skill.description],
      })),
      cases,
    },
    coverage: {
      skills: EXPECTED_SKILLS,
      selectedFiles: EXPECTED_SELECTED_FILES,
      positiveCases,
      positiveTopK1Cases,
      positiveTopK3Cases,
      allNegativeCases,
      includedOwnerQualifiedNegativeCases: allNegativeCases - ownerlessNegativeCases,
      ownerlessNegativeCases,
      behavioralCasesExcluded: behavioralCases,
    },
  };
}

function stageFile(directory, name, content) {
  const suffix = randomBytes(12).toString('hex');
  const path = join(directory, `.${name}.${process.pid}.${suffix}.tmp`);
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
  const descriptor = openSync(path, flags, 0o600);
  try {
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return path;
}

function publishFiles(directory, files) {
  directDirectory(directory, 'output directory');
  const staged = [];
  try {
    for (const [name, content] of files) {
      staged.push({ name, path: stageFile(directory, name, content) });
    }
    for (const item of staged) {
      renameSync(item.path, join(directory, item.name));
      item.path = '';
      const directoryDescriptor = openSync(directory, constants.O_RDONLY);
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    }
  } finally {
    for (const item of staged) {
      if (item.path) {
        try {
          unlinkSync(item.path);
        } catch {
          // Best-effort cleanup of a private, exclusively created temp file.
        }
      }
    }
  }
}

async function main() {
  if (process.argv.length !== 4) {
    fail('usage: node scripts/generate-m454-agent-skills-challenge.mjs <absolute-git-executable> <git-root>');
  }
  const extractorPath = fileURLToPath(import.meta.url);
  const extractorDigest = sha256(readFileSync(extractorPath));
  const repoRoot = realpathSync(resolve(fileURLToPath(new URL('.', import.meta.url)), '..'));
  const outputSegments = ['test', 'fixtures', 'm454'];
  let outputPath = repoRoot;
  for (const segment of outputSegments) {
    outputPath = join(outputPath, segment);
    directDirectory(outputPath, `output path ${segment}`);
  }
  const outputDirectory = realpathSync(outputPath);
  if (relative(repoRoot, outputDirectory) !== join(...outputSegments)) {
    fail('output directory must remain inside the repository');
  }
  const gitExecutable = verifiedGitExecutable(process.argv[2]);
  const gitRootInput = resolve(process.argv[3]);
  directDirectory(gitRootInput, 'Git root input');
  const gitRoot = realpathSync(gitRootInput);
  directDirectory(gitRoot, 'Git root');
  verifyRepositoryIsolation(gitExecutable.path, gitRoot);
  verifyPinnedObjects(gitExecutable.path, gitRoot);

  const implementation = verifyImplementation(repoRoot);
  const { projectionModule, calibrationModule } = await loadVerifiedProjectionModules(
    implementation.compiledModules,
  );

  const firstRead = readSelectedSource(gitExecutable.path, gitRoot);
  const secondRead = readSelectedSource(gitExecutable.path, gitRoot);
  if (firstRead.selectedSourceDigest !== secondRead.selectedSourceDigest) {
    fail('selected source changed between reads');
  }
  if (firstRead.selectedSourceDigest !== EXPECTED_SELECTED_SOURCE_DIGEST) {
    fail('selected source does not match the reviewed extraction scope');
  }
  const first = buildSource(firstRead, calibrationModule.SKILL_ROUTING_CALIBRATION_POLICY_VERSION);
  const second = buildSource(secondRead, calibrationModule.SKILL_ROUTING_CALIBRATION_POLICY_VERSION);
  const firstBytes = Buffer.from(JSON.stringify(first.source, SOURCE_KEYS), 'utf8');
  const secondBytes = Buffer.from(JSON.stringify(second.source, SOURCE_KEYS), 'utf8');
  if (firstBytes.byteLength !== secondBytes.byteLength || !timingSafeEqual(firstBytes, secondBytes)) {
    firstBytes.fill(0);
    secondBytes.fill(0);
    fail('canonical source changed between reads');
  }
  const sourceCanonicalDigest = sha256(firstBytes);
  if (sourceCanonicalDigest !== EXPECTED_SOURCE_CANONICAL_DIGEST) {
    firstBytes.fill(0);
    secondBytes.fill(0);
    fail('canonical source does not match the reviewed extraction policy');
  }
  const key = randomBytes(32);
  let firstProjection;
  let secondProjection;
  try {
    firstProjection = projectionModule.projectSkillRoutingCalibrationSnapshot(firstBytes, key);
    secondProjection = projectionModule.projectSkillRoutingCalibrationSnapshot(secondBytes, key);
  } finally {
    key.fill(0);
    firstBytes.fill(0);
    secondBytes.fill(0);
  }
  if (firstProjection.state !== 'projected' || secondProjection.state !== 'projected') {
    fail(`M453 projection withheld: ${firstProjection.reason}/${secondProjection.reason}`);
  }
  if (JSON.stringify(firstProjection.snapshot) !== JSON.stringify(secondProjection.snapshot)) {
    fail('projected snapshots changed between reads');
  }

  const snapshotContent = `${JSON.stringify(firstProjection.snapshot, null, 2)}\n`;
  const snapshotDigest = sha256(Buffer.from(snapshotContent, 'utf8'));
  const provenance = {
    schemaVersion: 1,
    fixtureId: 'm454-agent-skills-ff2df4c',
    state: 'challenge-only',
    authority: 'observation-only',
    metadataOnly: true,
    rawTextIncluded: false,
    provenanceState: 'review-pinned-unverified',
    repository: UPSTREAM_REPOSITORY,
    commit: UPSTREAM_COMMIT,
    commitTree: UPSTREAM_TREE,
    skillsTree: UPSTREAM_SKILLS_TREE,
    casesTree: UPSTREAM_CASES_TREE,
    license: 'MIT',
    licenseDigest: UPSTREAM_LICENSE_DIGEST,
    declaredPackDigest: UPSTREAM_PACK_DIGEST,
    declaredPortablePackDigest: UPSTREAM_PORTABLE_PACK_DIGEST,
    declaredExternalAuditPolicyDigest: EXTERNAL_AUDIT_POLICY_DIGEST,
    externalAuditTrialReady: false,
    selectedSourceDigest: firstRead.selectedSourceDigest,
    sourceCanonicalDigest,
    snapshotDigest,
    implementationDigest: implementation.digest,
    extractorDigest,
    gitExecutableDigest: gitExecutable.digest,
    extractionPolicyVersion: EXTRACTION_POLICY_VERSION,
    projectionPolicyVersion: firstProjection.snapshot.projectionPolicyVersion,
    routerPolicyVersion: firstProjection.snapshot.routerPolicyVersion,
    keyHandling: 'ephemeral-random-32-byte-buffer-zeroized-best-effort',
    keyHandlingVerified: false,
    keyPublished: false,
    keyCommitmentPublished: false,
    exactRegeneration: 'unsupported-without-original-key',
    semanticRegeneration: 'fresh-key-aggregate-equivalent',
    sourceReadCount: 2,
    sourceReadsMatched: true,
    projectedSnapshotsMatched: true,
    independentReadsVerified: false,
    authenticatedAcquisition: false,
    authenticatedCustody: false,
    independentReadCustodyAuthenticated: false,
    publicationOrder: 'snapshot-then-provenance-commit-marker',
    pairAtomic: false,
    coverage: first.coverage,
    observedAt: OBSERVED_AT,
    asOf: AS_OF,
    timeSemantics: 'evaluator-fixture-only',
    routingAuthority: false,
    learningAuthority: false,
    policyAuthority: false,
    promotionAuthority: false,
    proposalAuthority: false,
    verificationAuthority: false,
    mergeAuthority: false,
    releaseAuthority: false,
    deploymentAuthority: false,
  };
  const provenanceContent = `${JSON.stringify(provenance, null, 2)}\n`;
  publishFiles(outputDirectory, [
    [SNAPSHOT_FILE, snapshotContent],
    [PROVENANCE_FILE, provenanceContent],
  ]);
  process.stdout.write(JSON.stringify({
    snapshotFile: SNAPSHOT_FILE,
    provenanceFile: PROVENANCE_FILE,
    snapshotDigest,
    selectedSourceDigest: provenance.selectedSourceDigest,
    sourceCanonicalDigest,
    coverage: provenance.coverage,
  }, null, 2) + '\n');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'unknown failure'}\n`);
  process.exitCode = 1;
});
