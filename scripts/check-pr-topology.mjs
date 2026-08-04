#!/usr/bin/env node

/**
 * Read-only PR topology shadow observation.
 *
 * The auditor consumes a bounded GitHub API snapshot or fetches one using GET
 * requests. Sequential REST reads are not an atomic snapshot, so the result has
 * no operational authority and never authorizes a merge. It never comments,
 * labels, closes, merges, retargets, or deletes.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const SCHEMA_VERSION = 1;
const MAX_PULL_REQUESTS = 1_000;
const MAX_PAGES = 10;
const MAX_REPORT_ITEMS = 200;
const MAX_COMPARISONS = 200;
const MAX_BODY_BYTES = 100_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ALLOWED_COMPARE_STATUSES = new Set(['ahead', 'behind', 'diverged', 'identical']);
const HTML_VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);
const SOURCE_ISSUES = Object.freeze({
  'topology-snapshot-changed': 'Open pull request topology changed during inspection.',
  'topology-revalidation-incomplete': 'Open pull request topology revalidation was incomplete.',
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function boundedString(value, label, maximum) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
  if ([...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  })) {
    throw new Error(`${label} contains control characters`);
  }
  return value;
}

function repositoryName(value, label) {
  const name = boundedString(value, label, 200);
  if (!REPOSITORY_PATTERN.test(name)) {
    throw new Error(`${label} is not an owner/repository name`);
  }
  return name.toLowerCase();
}

function gitRef(value, label) {
  const ref = boundedString(value, label, 255);
  if (
    ref.startsWith('.') ||
    ref.startsWith('/') ||
    ref.endsWith('.') ||
    ref.endsWith('/') ||
    ref.endsWith('.lock') ||
    ref.includes('..') ||
    ref.includes('@{') ||
    ref.includes('//') ||
    [' ', '~', '^', ':', '?', '*', '[', '\\'].some((character) => ref.includes(character))
  ) {
    throw new Error(`${label} is not a safe Git branch ref`);
  }
  return ref;
}

function sha(value, label) {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value.toLowerCase())) {
    throw new Error(`${label} must be a full 40-character Git SHA`);
  }
  return value.toLowerCase();
}

function normalizeRepo(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return { fullName: repositoryName(value.full_name ?? value.fullName, `${label}.full_name`) };
}

function normalizeSide(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return {
    ref: gitRef(value.ref, `${label}.ref`),
    sha: sha(value.sha, `${label}.sha`),
    repo: normalizeRepo(value.repo, `${label}.repo`),
  };
}

function normalizePullRequest(value, index) {
  if (!isRecord(value)) throw new Error(`pullRequests[${index}] must be an object`);
  if (value.state !== 'open') throw new Error(`pullRequests[${index}].state must be open`);
  const body = value.body == null ? '' : String(value.body);
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    throw new Error(`pullRequests[${index}].body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  return {
    number: integer(value.number, `pullRequests[${index}].number`),
    state: 'open',
    body,
    head: normalizeSide(value.head, `pullRequests[${index}].head`),
    base: normalizeSide(value.base, `pullRequests[${index}].base`),
  };
}

function normalizeTriggerPullRequest(value, label = 'triggerPullRequest') {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  if (value.state !== 'open' && value.state !== 'closed') {
    throw new Error(`${label}.state must be open or closed`);
  }
  const body = value.body == null ? '' : String(value.body);
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    throw new Error(`${label}.body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  return {
    number: integer(value.number, `${label}.number`),
    state: value.state,
    body,
    head: normalizeSide(value.head, `${label}.head`),
    base: normalizeSide(value.base, `${label}.base`),
  };
}

function normalizeComparison(value, index) {
  if (!isRecord(value)) throw new Error(`comparisons[${index}] must be an object`);
  const status = boundedString(value.status, `comparisons[${index}].status`, 32);
  if (!ALLOWED_COMPARE_STATUSES.has(status)) {
    throw new Error(`comparisons[${index}].status is unsupported`);
  }
  return {
    baseSha: sha(value.baseSha ?? value.base_sha, `comparisons[${index}].baseSha`),
    headSha: sha(value.headSha ?? value.head_sha, `comparisons[${index}].headSha`),
    mergeBaseSha: sha(
      value.mergeBaseSha ?? value.merge_base_sha,
      `comparisons[${index}].mergeBaseSha`,
    ),
    status,
    complete: value.complete === true,
  };
}

function normalizeSnapshot(raw) {
  if (!isRecord(raw)) throw new Error('snapshot must be an object');
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`snapshot.schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (!isRecord(raw.repository)) throw new Error('snapshot.repository must be an object');
  if (!Array.isArray(raw.pullRequests)) {
    throw new Error('snapshot.pullRequests must be an array');
  }
  if (raw.pullRequests.length > MAX_PULL_REQUESTS) {
    throw new Error(`snapshot exceeds the ${MAX_PULL_REQUESTS} pull-request bound`);
  }
  const pullRequests = raw.pullRequests.map(normalizePullRequest);
  const seenNumbers = new Set();
  for (const pr of pullRequests) {
    if (seenNumbers.has(pr.number)) throw new Error(`duplicate pull request #${pr.number}`);
    seenNumbers.add(pr.number);
  }
  if (!Array.isArray(raw.comparisons)) {
    throw new Error('snapshot.comparisons must be an array');
  }
  if (raw.comparisons.length > MAX_COMPARISONS) {
    throw new Error(`snapshot exceeds the ${MAX_COMPARISONS} comparison bound`);
  }
  const comparisons = raw.comparisons.map(normalizeComparison);
  const triggerPullRequest = raw.triggerPullRequest == null
    ? null
    : normalizeTriggerPullRequest(raw.triggerPullRequest);
  const pullRequestNumber = integer(
    raw.pullRequestNumber ?? raw.pull_request_number,
    'snapshot.pullRequestNumber',
  );
  if (triggerPullRequest && triggerPullRequest.number !== pullRequestNumber) {
    throw new Error('snapshot.triggerPullRequest does not match pullRequestNumber');
  }
  const sourceIssue = raw.sourceIssue == null ? null : String(raw.sourceIssue);
  if (sourceIssue !== null && !Object.hasOwn(SOURCE_ISSUES, sourceIssue)) {
    throw new Error('snapshot.sourceIssue is unsupported');
  }
  return {
    complete: raw.complete === true && sourceIssue === null,
    repository: {
      fullName: repositoryName(
        raw.repository.full_name ?? raw.repository.fullName,
        'snapshot.repository.full_name',
      ),
      defaultBranch: gitRef(
        raw.repository.default_branch ?? raw.repository.defaultBranch,
        'snapshot.repository.default_branch',
      ),
    },
    pullRequestNumber,
    pullRequests,
    comparisons,
    triggerPullRequest,
    dependentCoverageComplete: raw.dependentCoverageComplete === true,
    sourceIssue,
  };
}

function updateHtmlAncestors(raw, ancestors) {
  let cursor = 0;
  while (cursor < raw.length) {
    const opening = raw.indexOf('<', cursor);
    if (opening === -1) break;
    if (raw.startsWith('<!--', opening)) {
      const commentEnd = raw.indexOf('-->', opening + 4);
      if (commentEnd === -1) return false;
      cursor = commentEnd + 3;
      continue;
    }

    let position = opening + 1;
    let closing = false;
    if (raw[position] === '/') {
      closing = true;
      position += 1;
    }
    const nameMatch = raw.slice(position).match(/^[A-Za-z][A-Za-z0-9-]*/);
    if (!nameMatch) {
      const declarationEnd = raw.indexOf('>', position);
      if (declarationEnd === -1) return false;
      cursor = declarationEnd + 1;
      continue;
    }

    const name = nameMatch[0].toLowerCase();
    position += nameMatch[0].length;
    let quote = null;
    let tagEnd = -1;
    for (; position < raw.length; position += 1) {
      const character = raw[position];
      if (quote !== null) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        tagEnd = position;
        break;
      }
    }
    if (tagEnd === -1 || quote !== null) return false;

    const selfClosing = /\/\s*$/.test(raw.slice(opening + 1, tagEnd));
    if (closing) {
      if (ancestors.at(-1) !== name) return false;
      ancestors.pop();
    } else if (!selfClosing && !HTML_VOID_ELEMENTS.has(name)) {
      ancestors.push(name);
    }
    cursor = tagEnd + 1;
  }
  return true;
}

export function parseSupersedes(body) {
  const declarations = [];
  const htmlAncestors = [];
  for (const token of marked.lexer(String(body ?? ''))) {
    if (token.type === 'html') {
      if (!updateHtmlAncestors(token.raw, htmlAncestors)) return [];
      continue;
    }
    if (
      htmlAncestors.length !== 0
      || token.type !== 'paragraph'
      || token.tokens?.length !== 1
      || token.tokens[0]?.type !== 'text'
    ) {
      continue;
    }
    const declaration = token.tokens[0].text.match(/^Supersedes[ \t]*:[ \t]*([^\r\n]*)$/i);
    if (declaration !== null) declarations.push(declaration);
  }
  if (htmlAncestors.length !== 0) return [];
  if (declarations.length !== 1) return [];

  const value = declarations[0][1].trim();
  if (!/^#[1-9][0-9]*(?:[ \t]*,[ \t]*#[1-9][0-9]*)*$/.test(value)) return [];

  const declared = [];
  const seen = new Set();
  for (const token of value.split(',')) {
    const number = Number(token.trim().slice(1));
    if (!Number.isSafeInteger(number) || number <= 0 || seen.has(number)) return [];
    seen.add(number);
    declared.push(number);
  }
  return declared.sort((left, right) => left - right);
}

function branchKey(repo, ref) {
  return `${repo.toLowerCase()}\u0000${ref}`;
}

function comparisonKey(baseSha, headSha) {
  return `${baseSha}\u0000${headSha}`;
}

function failureResult(code, message) {
  return {
    schemaVersion: SCHEMA_VERSION,
    mode: 'shadow-observation',
    operationalAuthority: false,
    snapshotAtomic: false,
    verdict: 'shadow-blocked',
    complete: false,
    repository: null,
    candidate: null,
    counts: {
      openPullRequests: 0,
      stackedPullRequests: 0,
      roots: 0,
      containedRoots: 0,
      dependentConvergences: 0,
      diagnostics: 1,
      emittedDiagnostics: 1,
    },
    relations: [],
    containedRoots: [],
    dependentConvergences: [],
    supersedes: { declared: [], required: [], missing: [], unverified: [] },
    diagnostics: [{ severity: 'error', code, message }],
    truncated: false,
  };
}

export function evaluateTopology(raw) {
  let snapshot;
  try {
    snapshot = normalizeSnapshot(raw);
  } catch (error) {
    return failureResult('invalid-input', error instanceof Error ? error.message : 'invalid input');
  }

  const diagnostics = [];
  let complete = snapshot.complete;
  if (!snapshot.complete) {
    diagnostics.push({
      severity: 'error',
      code: 'incomplete-input',
      message: 'The pull-request snapshot is incomplete.',
    });
  }
  if (snapshot.sourceIssue) {
    diagnostics.push({
      severity: 'error',
      code: snapshot.sourceIssue,
      message: SOURCE_ISSUES[snapshot.sourceIssue],
    });
  }

  const candidate = snapshot.pullRequests.find((pr) => pr.number === snapshot.pullRequestNumber);
  const triggerCandidate = snapshot.triggerPullRequest?.number === snapshot.pullRequestNumber
    ? snapshot.triggerPullRequest
    : null;
  if (!candidate && triggerCandidate?.state !== 'closed') {
    diagnostics.push({
      severity: 'error',
      code: 'candidate-missing',
      message: `Open pull request #${snapshot.pullRequestNumber} is absent from the snapshot.`,
    });
    complete = false;
  }

  const headsByBranch = new Map();
  for (const pr of snapshot.pullRequests) {
    const key = branchKey(pr.head.repo.fullName, pr.head.ref);
    const entries = headsByBranch.get(key) ?? [];
    entries.push(pr);
    headsByBranch.set(key, entries);
  }

  const parentByChild = new Map();
  const relations = [];
  const roots = [];
  for (const pr of snapshot.pullRequests) {
    const targetsDefault =
      pr.base.repo.fullName === snapshot.repository.fullName &&
      pr.base.ref === snapshot.repository.defaultBranch;
    if (targetsDefault) {
      roots.push(pr);
      relations.push({
        pullRequest: pr.number,
        kind: 'default-branch-root',
        parentPullRequest: null,
        headRef: pr.head.ref,
        headSha: pr.head.sha,
        baseRef: pr.base.ref,
        baseSha: pr.base.sha,
        parentHeadSha: null,
        baseHeadMatches: null,
      });
      continue;
    }

    const parents = headsByBranch.get(branchKey(pr.base.repo.fullName, pr.base.ref)) ?? [];
    if (parents.length === 0) {
      diagnostics.push({
        severity: 'error',
        code: 'orphan-base',
        pullRequest: pr.number,
        message: `Pull request #${pr.number} targets branch ${pr.base.ref} with no open parent pull request.`,
      });
    } else if (parents.length > 1) {
      diagnostics.push({
        severity: 'error',
        code: 'ambiguous-base',
        pullRequest: pr.number,
        message: `Pull request #${pr.number} targets branch ${pr.base.ref} with ${parents.length} open parent pull requests.`,
      });
    } else {
      const parent = parents[0];
      parentByChild.set(pr.number, parent.number);
      if (pr.base.sha !== parent.head.sha) {
        diagnostics.push({
          severity: 'error',
          code: 'stale-parent-head',
          pullRequest: pr.number,
          message: `Pull request #${pr.number} base SHA does not match parent pull request #${parent.number} head SHA.`,
        });
      }
      relations.push({
        pullRequest: pr.number,
        kind: 'stacked',
        parentPullRequest: parent.number,
        headRef: pr.head.ref,
        headSha: pr.head.sha,
        baseRef: pr.base.ref,
        baseSha: pr.base.sha,
        parentHeadSha: parent.head.sha,
        baseHeadMatches: pr.base.sha === parent.head.sha,
      });
    }
  }

  for (const start of parentByChild.keys()) {
    const visited = new Set();
    let cursor = start;
    while (parentByChild.has(cursor)) {
      if (visited.has(cursor)) {
        diagnostics.push({
          severity: 'error',
          code: 'stack-cycle',
          pullRequest: start,
          message: `Pull request #${start} participates in a parent cycle.`,
        });
        break;
      }
      visited.add(cursor);
      cursor = parentByChild.get(cursor);
    }
  }

  const comparisonByPair = new Map(
    snapshot.comparisons.map((comparison) => [
      comparisonKey(comparison.baseSha, comparison.headSha),
      comparison,
    ]),
  );
  const containedRoots = [];
  if (
    candidate &&
    candidate.base.repo.fullName === snapshot.repository.fullName &&
    candidate.base.ref === snapshot.repository.defaultBranch
  ) {
    for (const root of roots) {
      if (root.number === candidate.number) continue;
      const comparison = comparisonByPair.get(comparisonKey(root.head.sha, candidate.head.sha));
      if (!comparison || !comparison.complete) {
        complete = false;
        diagnostics.push({
          severity: 'error',
          code: 'comparison-incomplete',
          pullRequest: root.number,
          message: `Exact ancestry from pull request #${root.number} to #${candidate.number} is unavailable.`,
        });
        continue;
      }
      if (
        (comparison.status === 'ahead' || comparison.status === 'identical') &&
        comparison.mergeBaseSha === root.head.sha
      ) {
        containedRoots.push({
          pullRequest: root.number,
          headRef: root.head.ref,
          headSha: root.head.sha,
          convergencePullRequest: candidate.number,
          convergenceHeadSha: candidate.head.sha,
          comparisonStatus: comparison.status,
          mergeBaseSha: comparison.mergeBaseSha,
        });
      }
    }
  }

  const dependentConvergences = [];
  const candidateIsDefaultRoot = candidate && roots.some((root) => root.number === candidate.number);
  const requiresDependentCoverage = candidateIsDefaultRoot && roots.length > 1;
  if (requiresDependentCoverage && !snapshot.dependentCoverageComplete) {
    complete = false;
    diagnostics.push({
      severity: 'error',
      code: 'dependent-coverage-incomplete',
      pullRequest: candidate.number,
      message: `Reverse dependent coverage for default-root pull request #${candidate.number} is incomplete.`,
    });
  }
  if (candidateIsDefaultRoot && snapshot.dependentCoverageComplete) {
    for (const target of roots) {
      if (target.number === candidate.number) continue;
      const comparison = comparisonByPair.get(comparisonKey(candidate.head.sha, target.head.sha));
      if (!comparison || !comparison.complete) {
        complete = false;
        diagnostics.push({
          severity: 'error',
          code: 'dependent-comparison-incomplete',
          pullRequest: target.number,
          message: `Dependent convergence ancestry from pull request #${candidate.number} to #${target.number} is unavailable.`,
        });
        continue;
      }
      if (
        (comparison.status === 'ahead' || comparison.status === 'identical') &&
        comparison.mergeBaseSha === candidate.head.sha
      ) {
        const targetDeclarations = parseSupersedes(target.body);
        const declarationPresent = targetDeclarations.includes(candidate.number);
        dependentConvergences.push({
          pullRequest: target.number,
          headRef: target.head.ref,
          headSha: target.head.sha,
          containedRootPullRequest: candidate.number,
          containedRootHeadSha: candidate.head.sha,
          comparisonStatus: comparison.status,
          mergeBaseSha: comparison.mergeBaseSha,
          declarationPresent,
        });
        if (!declarationPresent) {
          diagnostics.push({
            severity: 'error',
            code: 'dependent-supersedes-missing',
            pullRequest: target.number,
            message: `Dependent convergence pull request #${target.number} contains root #${candidate.number} without an explicit Supersedes declaration.`,
          });
        }
      }
    }
  }

  const declared = candidate ? parseSupersedes(candidate.body) : [];
  const required = containedRoots.map((entry) => entry.pullRequest).sort((a, b) => a - b);
  const requiredSet = new Set(required);
  const declaredSet = new Set(declared);
  const missing = required.filter((number) => !declaredSet.has(number));
  const unverified = declared.filter((number) => !requiredSet.has(number));
  for (const number of missing) {
    diagnostics.push({
      severity: 'error',
      code: 'supersedes-missing',
      pullRequest: number,
      message: `Contained root pull request #${number} is missing from an explicit Supersedes declaration.`,
    });
  }
  for (const number of unverified) {
    diagnostics.push({
      severity: 'warning',
      code: 'supersedes-unverified',
      pullRequest: number,
      message: `Declared pull request #${number} is not a contained open default-branch root in this snapshot.`,
    });
  }

  let truncated = false;
  if (
    relations.length > MAX_REPORT_ITEMS ||
    containedRoots.length > MAX_REPORT_ITEMS ||
    dependentConvergences.length > MAX_REPORT_ITEMS ||
    diagnostics.length > MAX_REPORT_ITEMS ||
    declared.length > MAX_REPORT_ITEMS ||
    required.length > MAX_REPORT_ITEMS ||
    missing.length > MAX_REPORT_ITEMS ||
    unverified.length > MAX_REPORT_ITEMS
  ) {
    truncated = true;
    complete = false;
    diagnostics.unshift({
      severity: 'error',
      code: 'report-bound-exceeded',
      message: `The report exceeded the ${MAX_REPORT_ITEMS}-item emission bound.`,
    });
  }

  const emittedDiagnostics = diagnostics.slice(0, MAX_REPORT_ITEMS);
  const hasErrors = diagnostics.some((entry) => entry.severity === 'error');
  const reportCandidate = candidate ?? triggerCandidate;
  return {
    schemaVersion: SCHEMA_VERSION,
    mode: 'shadow-observation',
    operationalAuthority: false,
    snapshotAtomic: false,
    verdict: complete && !hasErrors ? 'shadow-clear' : 'shadow-blocked',
    complete,
    repository: {
      fullName: snapshot.repository.fullName,
      defaultBranch: snapshot.repository.defaultBranch,
    },
    candidate: reportCandidate
      ? {
          pullRequest: reportCandidate.number,
          state: reportCandidate.state,
          headRef: reportCandidate.head.ref,
          headSha: reportCandidate.head.sha,
          baseRef: reportCandidate.base.ref,
          baseSha: reportCandidate.base.sha,
        }
      : null,
    counts: {
      openPullRequests: snapshot.pullRequests.length,
      stackedPullRequests: snapshot.pullRequests.length - roots.length,
      roots: roots.length,
      containedRoots: containedRoots.length,
      dependentConvergences: dependentConvergences.length,
      diagnostics: diagnostics.length,
      emittedDiagnostics: emittedDiagnostics.length,
    },
    relations: relations.slice(0, MAX_REPORT_ITEMS),
    containedRoots: containedRoots.slice(0, MAX_REPORT_ITEMS),
    dependentConvergences: dependentConvergences.slice(0, MAX_REPORT_ITEMS),
    supersedes: {
      declared: declared.slice(0, MAX_REPORT_ITEMS),
      required: required.slice(0, MAX_REPORT_ITEMS),
      missing: missing.slice(0, MAX_REPORT_ITEMS),
      unverified: unverified.slice(0, MAX_REPORT_ITEMS),
    },
    diagnostics: emittedDiagnostics,
    truncated,
  };
}

function markdownCode(value) {
  return [...String(value)]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`/g, '&#96;')
    .replace(/\|/g, '&#124;')
    .slice(0, 300);
}

export function renderMarkdown(report) {
  const lines = [
    '# PR Topology Shadow Observation V1',
    '',
    `**Shadow verdict:** ${report.verdict === 'shadow-clear' ? 'SHADOW CLEAR' : 'SHADOW BLOCKED'}`,
    '',
    '**Operational authority:** NONE',
    '',
    '**Atomic snapshot:** NO',
    '',
    'This bounded observation uses sequential REST reads. It is non-atomic, non-authoritative, and must never authorize a merge.',
    '',
  ];
  if (report.repository) {
    lines.push(
      `Repository: \`${markdownCode(report.repository.fullName)}\``,
      `Default branch: \`${markdownCode(report.repository.defaultBranch)}\``,
    );
  }
  if (report.candidate) {
    lines.push(
      `Candidate: #${report.candidate.pullRequest} \`${markdownCode(report.candidate.headSha)}\``,
      `Base: \`${markdownCode(report.candidate.baseRef)}\` at \`${markdownCode(report.candidate.baseSha)}\``,
    );
  }
  lines.push(
    '',
    `Open PRs: ${report.counts.openPullRequests}; stacked: ${report.counts.stackedPullRequests}; roots: ${report.counts.roots}; contained roots: ${report.counts.containedRoots}; dependent convergences: ${report.counts.dependentConvergences}.`,
    '',
    '## Stack Relations',
    '',
    '| PR | Kind | Parent | Head SHA | Base ref | Base SHA | Parent head SHA |',
    '|---:|---|---:|---|---|---|---|',
  );
  for (const relation of report.relations) {
    lines.push(
      `| #${relation.pullRequest} | ${markdownCode(relation.kind)} | ${relation.parentPullRequest == null ? '-' : `#${relation.parentPullRequest}`} | \`${markdownCode(relation.headSha)}\` | \`${markdownCode(relation.baseRef)}\` | \`${markdownCode(relation.baseSha)}\` | ${relation.parentHeadSha == null ? '-' : `\`${markdownCode(relation.parentHeadSha)}\``} |`,
    );
  }
  if (report.relations.length === 0) lines.push('| - | - | - | - | - | - | - |');

  lines.push('', '## Contained Roots', '');
  if (report.containedRoots.length === 0) {
    lines.push('No contained open default-branch roots were proven.');
  } else {
    for (const root of report.containedRoots) {
      lines.push(
        `- #${root.pullRequest}: \`${markdownCode(root.headSha)}\` is contained by \`${markdownCode(root.convergenceHeadSha)}\` (${markdownCode(root.comparisonStatus)}; merge base \`${markdownCode(root.mergeBaseSha)}\`).`,
      );
    }
  }
  lines.push('', '## Dependent Convergences', '');
  if (report.dependentConvergences.length === 0) {
    lines.push('No downstream convergence PRs were proven to contain the triggering root.');
  } else {
    for (const dependent of report.dependentConvergences) {
      lines.push(
        `- #${dependent.pullRequest}: \`${markdownCode(dependent.headSha)}\` contains root #${dependent.containedRootPullRequest} at \`${markdownCode(dependent.containedRootHeadSha)}\`; Supersedes declaration ${dependent.declarationPresent ? 'present' : 'missing'}.`,
      );
    }
  }
  lines.push('', '## Supersedes', '');
  lines.push(
    `Required: ${report.supersedes.required.length ? report.supersedes.required.map((n) => `#${n}`).join(', ') : 'none'}`,
    `Declared: ${report.supersedes.declared.length ? report.supersedes.declared.map((n) => `#${n}`).join(', ') : 'none'}`,
    `Missing: ${report.supersedes.missing.length ? report.supersedes.missing.map((n) => `#${n}`).join(', ') : 'none'}`,
    '',
    '## Diagnostics',
    '',
  );
  if (report.diagnostics.length === 0) {
    lines.push('- None.');
  } else {
    for (const diagnostic of report.diagnostics) {
      lines.push(
        `- **${diagnostic.severity.toUpperCase()} ${markdownCode(diagnostic.code)}:** ${markdownCode(diagnostic.message)}`,
      );
    }
  }
  if (report.truncated) lines.push('', '**Report output was truncated and is non-authoritative.**');
  return `${lines.join('\n')}\n`;
}

function nextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/);
    if (match?.[2] === 'next') return match[1];
  }
  return null;
}

async function githubGet(url, token, fetchImpl) {
  const parsed = new globalThis.URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.github.com') {
    throw new Error('refused non-GitHub API URL');
  }
  const response = await fetchImpl(parsed, {
    method: 'GET',
    redirect: 'error',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ashlr-pr-topology-shadow-observation-v1',
    },
  });
  if (!response.ok) throw new Error(`GitHub API GET failed with status ${response.status}`);
  return { body: await response.json(), next: nextLink(response.headers.get('link')) };
}

function normalizeRepositoryResponse(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return {
    fullName: repositoryName(value.full_name, `${label}.full_name`),
    defaultBranch: gitRef(value.default_branch, `${label}.default_branch`),
  };
}

async function fetchOpenPullRequestPopulation({ fullName, token, fetchImpl }) {
  let url = `https://api.github.com/repos/${fullName}/pulls?state=open&per_page=100&page=1`;
  const pullRequests = [];
  const pageSizes = [];
  let pages = 0;
  while (url) {
    pages += 1;
    if (pages > MAX_PAGES) throw new Error(`pull-request pagination exceeds ${MAX_PAGES} pages`);
    const response = await githubGet(url, token, fetchImpl);
    if (!Array.isArray(response.body)) throw new Error('GitHub pull-request response is not an array');
    pageSizes.push(response.body.length);
    pullRequests.push(...response.body);
    if (pullRequests.length > MAX_PULL_REQUESTS) {
      throw new Error(`GitHub returned more than ${MAX_PULL_REQUESTS} open pull requests`);
    }
    url = response.next;
  }
  return { pullRequests, pageSizes };
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function populationFingerprint(population) {
  const seenNumbers = new Set();
  const pullRequests = population.pullRequests.map((value, index) => {
    const pullRequest = normalizePullRequest(value, index);
    if (seenNumbers.has(pullRequest.number)) {
      throw new Error(`duplicate pull request #${pullRequest.number}`);
    }
    seenNumbers.add(pullRequest.number);
    const supersedes = parseSupersedes(pullRequest.body);
    return {
      number: pullRequest.number,
      state: pullRequest.state,
      head: pullRequest.head,
      base: pullRequest.base,
      bodySha256: digest(pullRequest.body),
      supersedesSha256: digest(JSON.stringify(supersedes)),
    };
  });
  return digest(JSON.stringify({ pageSizes: population.pageSizes, pullRequests }));
}

function incompleteSnapshot(snapshot, sourceIssue) {
  return {
    ...snapshot,
    complete: false,
    sourceIssue,
  };
}

function normalizeExpectedEventIdentity({ expectedHeadSha, expectedBaseSha, expectedState }) {
  const values = [expectedHeadSha, expectedBaseSha, expectedState].map((value) =>
    value == null || value === '' ? null : value,
  );
  if (values.every((value) => value === null)) return null;
  if (values.some((value) => value === null)) {
    throw new Error('expected event head SHA, base SHA, and state must be provided together');
  }
  if (values[2] !== 'open' && values[2] !== 'closed') {
    throw new Error('expected event state must be open or closed');
  }
  return {
    headSha: sha(values[0], 'expected event head SHA'),
    baseSha: sha(values[1], 'expected event base SHA'),
    state: values[2],
  };
}

function assertExpectedEventIdentity(candidate, expected, phase) {
  if (!expected) return;
  if (
    candidate.head.sha !== expected.headSha ||
    candidate.base.sha !== expected.baseSha ||
    candidate.state !== expected.state
  ) {
    throw new Error(`${phase} candidate identity does not match the pull_request_target event`);
  }
}

function assertSameCandidateIdentity(candidate, expected, phase) {
  if (
    candidate.number !== expected.number ||
    candidate.state !== expected.state ||
    candidate.body !== expected.body ||
    candidate.head.sha !== expected.head.sha ||
    candidate.head.ref !== expected.head.ref ||
    candidate.head.repo.fullName !== expected.head.repo.fullName ||
    candidate.base.sha !== expected.base.sha ||
    candidate.base.ref !== expected.base.ref ||
    candidate.base.repo.fullName !== expected.base.repo.fullName
  ) {
    throw new Error(`${phase} candidate API identity changed during topology inspection`);
  }
}

export async function fetchGithubSnapshot({
  repository,
  pullRequestNumber,
  token,
  expectedHeadSha,
  expectedBaseSha,
  expectedState,
  fetchImpl = globalThis.fetch,
}) {
  const fullName = repositoryName(repository, 'repository');
  const number = integer(Number(pullRequestNumber), 'pullRequestNumber');
  const expectedIdentity = normalizeExpectedEventIdentity({
    expectedHeadSha,
    expectedBaseSha,
    expectedState,
  });
  if (typeof token !== 'string' || token.length < 1 || token.length > 1_000) {
    throw new Error('a bounded GitHub token is required');
  }

  const repoResponse = await githubGet(
    `https://api.github.com/repos/${fullName}`,
    token,
    fetchImpl,
  );
  const initialRepository = normalizeRepositoryResponse(
    repoResponse.body,
    'initial repository API response',
  );
  if (initialRepository.fullName !== fullName) {
    throw new Error('initial repository API response has the wrong repository identity');
  }
  const initialCandidateResponse = await githubGet(
    `https://api.github.com/repos/${fullName}/pulls/${number}`,
    token,
    fetchImpl,
  );
  const initialCandidate = normalizeTriggerPullRequest(
    initialCandidateResponse.body,
    'initial candidate API response',
  );
  if (initialCandidate.number !== number) {
    throw new Error('initial candidate API response has the wrong pull request number');
  }
  assertExpectedEventIdentity(initialCandidate, expectedIdentity, 'initial');

  const initialPopulation = await fetchOpenPullRequestPopulation({ fullName, token, fetchImpl });
  const pullRequests = initialPopulation.pullRequests;
  const initialPopulationFingerprint = populationFingerprint(initialPopulation);

  const candidate = pullRequests.find((pr) => pr?.number === number);
  if (initialCandidate.state === 'open') {
    if (!candidate) throw new Error(`open pull request #${number} is absent from GitHub pagination`);
    const listedCandidate = normalizeTriggerPullRequest(candidate, 'paginated candidate API response');
    assertSameCandidateIdentity(listedCandidate, initialCandidate, 'pre-comparison');
    assertExpectedEventIdentity(listedCandidate, expectedIdentity, 'pre-comparison');
  } else if (candidate) {
    throw new Error(`closed pull request #${number} appeared in open GitHub pagination`);
  }
  const defaultBranch = initialRepository.defaultBranch;
  const comparisons = [];
  let dependentCoverageComplete = false;
  if (candidate?.base?.ref === defaultBranch && candidate.base?.repo?.full_name === fullName) {
    const roots = pullRequests.filter(
      (pr) =>
        pr.number !== number &&
        pr.base?.ref === defaultBranch &&
        pr.base?.repo?.full_name === fullName,
    );
    const comparisonPairs = [
      ...roots.map((root) => ({ base: root, head: candidate })),
      ...roots.map((root) => ({ base: candidate, head: root })),
    ];
    if (comparisonPairs.length > MAX_COMPARISONS) {
      throw new Error(`dependent comparison plan exceeds the ${MAX_COMPARISONS} comparison bound`);
    }
    const seenPairs = new Set();
    for (const pair of comparisonPairs) {
      const baseSha = sha(pair.base.head?.sha, `pull request #${pair.base.number} head SHA`);
      const headSha = sha(pair.head.head?.sha, `pull request #${pair.head.number} head SHA`);
      const pairKey = comparisonKey(baseSha, headSha);
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      const response = await githubGet(
        `https://api.github.com/repos/${fullName}/compare/${baseSha}...${headSha}`,
        token,
        fetchImpl,
      );
      comparisons.push({
        baseSha,
        headSha,
        mergeBaseSha: response.body?.merge_base_commit?.sha,
        status: response.body?.status,
        complete: true,
      });
    }
    dependentCoverageComplete = true;
  }
  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    complete: true,
    repository: repoResponse.body,
    pullRequestNumber: number,
    pullRequests,
    comparisons,
    triggerPullRequest: initialCandidateResponse.body,
    dependentCoverageComplete,
  };

  let finalRepositoryResponse;
  let finalPopulation;
  try {
    finalRepositoryResponse = await githubGet(
      `https://api.github.com/repos/${fullName}`,
      token,
      fetchImpl,
    );
    finalPopulation = await fetchOpenPullRequestPopulation({ fullName, token, fetchImpl });
  } catch {
    return incompleteSnapshot(snapshot, 'topology-revalidation-incomplete');
  }

  let finalRepository;
  let finalPopulationFingerprint;
  try {
    finalRepository = normalizeRepositoryResponse(
      finalRepositoryResponse.body,
      'final repository API response',
    );
    finalPopulationFingerprint = populationFingerprint(finalPopulation);
  } catch {
    return incompleteSnapshot(snapshot, 'topology-revalidation-incomplete');
  }
  if (
    finalRepository.fullName !== initialRepository.fullName ||
    finalRepository.defaultBranch !== initialRepository.defaultBranch ||
    finalPopulationFingerprint !== initialPopulationFingerprint
  ) {
    return incompleteSnapshot(snapshot, 'topology-snapshot-changed');
  }

  let finalCandidateResponse;
  try {
    finalCandidateResponse = await githubGet(
      `https://api.github.com/repos/${fullName}/pulls/${number}`,
      token,
      fetchImpl,
    );
  } catch {
    return incompleteSnapshot(snapshot, 'topology-revalidation-incomplete');
  }
  try {
    const finalCandidate = normalizeTriggerPullRequest(
      finalCandidateResponse.body,
      'final candidate API response',
    );
    assertSameCandidateIdentity(finalCandidate, initialCandidate, 'post-comparison');
    assertExpectedEventIdentity(finalCandidate, expectedIdentity, 'post-comparison');
  } catch {
    return incompleteSnapshot(snapshot, 'topology-snapshot-changed');
  }

  return snapshot;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`unexpected argument: ${argument}`);
    const key = argument.slice(2);
    if (!['input', 'repository', 'pull-request', 'json-out', 'markdown-out'].includes(key)) {
      throw new Error(`unknown option: --${key}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

export async function runCli(argv, env = process.env) {
  let report;
  let options = {};
  try {
    options = parseArguments(argv);
    if (
      !options.input &&
      env.GITHUB_EVENT_NAME === 'pull_request_target' &&
      (!env.EXPECTED_HEAD_SHA || !env.EXPECTED_BASE_SHA || !env.EXPECTED_PR_STATE)
    ) {
      throw new Error('pull_request_target identity is incomplete');
    }
    const raw = options.input
      ? JSON.parse(await readFile(resolve(options.input), 'utf8'))
      : await fetchGithubSnapshot({
          repository: options.repository ?? env.GITHUB_REPOSITORY,
          pullRequestNumber: options['pull-request'] ?? env.PR_NUMBER,
          token: env.GH_TOKEN ?? env.GITHUB_TOKEN,
          expectedHeadSha: env.EXPECTED_HEAD_SHA,
          expectedBaseSha: env.EXPECTED_BASE_SHA,
          expectedState: env.EXPECTED_PR_STATE,
        });
    report = evaluateTopology(raw);
  } catch (error) {
    report = failureResult(
      'source-unavailable',
      error instanceof Error ? error.message : 'topology source unavailable',
    );
  }

  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = renderMarkdown(report);
  if (options['json-out']) await writeFile(resolve(options['json-out']), json, 'utf8');
  if (options['markdown-out']) await writeFile(resolve(options['markdown-out']), markdown, 'utf8');
  process.stdout.write(json);
  return report.verdict === 'shadow-clear' ? 0 : 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
