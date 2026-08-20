import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface Job {
  name?: string;
  environment?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
  ['runs-on']?: string;
  ['timeout-minutes']?: number;
}

interface Workflow {
  on?: { workflow_dispatch?: { inputs?: Record<string, Record<string, unknown>> } };
  permissions?: Record<string, string>;
  concurrency?: { group?: string; ['cancel-in-progress']?: boolean };
  env?: Record<string, string>;
  jobs?: Record<string, Job>;
}

const root = fileURLToPath(new URL('..', import.meta.url));
const identityRoot = process.env.ASHLR_PROMOTION_IDENTITY_ROOT
  ? resolve(process.env.ASHLR_PROMOTION_IDENTITY_ROOT)
  : root;
const promotionText = readFileSync(join(root, '.github/workflows/promote.yml'), 'utf8');
const releaseText = readFileSync(join(identityRoot, '.github/workflows/release.yml'), 'utf8');
const packageText = readFileSync(join(identityRoot, 'package.json'), 'utf8');
const packageMetadata = JSON.parse(packageText) as { name?: string; version?: string };
const workflow = parse(promotionText) as Workflow;
const releaseWorkflow = parse(releaseText) as Workflow;
const job = workflow.jobs?.admit ?? {};
const steps = job.steps ?? [];
const admission = steps.find((step) =>
  step.name === 'Verify exact accepted candidate and protected release identity');
const upload = steps.find((step) =>
  step.name === 'Upload bounded no-npm-mutation-authority promotion receipt');

const EXPECTED_VERSION = '3.3.1';
const EXPECTED_PREVIOUS_CANDIDATE_VERSION = '3.3.0';
const EXPECTED_ROLLBACK_REVISION = '31aa0467f66af1fe4c66d1664f65e6fd3e4ba61b';
const EXPECTED_QUARANTINED_INTEGRITY =
  'sha512-mYVuJZyoXeSnnqivoLzyZggNgpJoWM8glTI7CW0oBfQ0RCHx0xueTrLwLTZBg5W+E4zPOJNbckptYeb5YsdOHw==';
const EXPECTED_QUARANTINED_TAG_SHA = 'd07f6a96eda664d865b9255f71c6f56e8cd9d7c7';
const EXPECTED_TAG = `v${EXPECTED_VERSION}`;
const EXPECTED_TARBALL = `ashlr-hub-${EXPECTED_VERSION}.tgz`;

function identityViolations(
  promotionSource: string,
  releaseSource: string,
  packageSource: string,
): string[] {
  const promotion = parse(promotionSource) as Workflow;
  const release = parse(releaseSource) as Workflow;
  const packageIdentity = JSON.parse(packageSource) as { name?: string; version?: string };
  const violations: string[] = [];
  if (packageIdentity.name !== '@ashlr/hub') violations.push('package name');
  const versions = [
    promotion.env?.PROMOTION_VERSION,
    release.env?.RELEASE_VERSION,
    packageIdentity.version,
  ];
  if (versions.some((version) => version !== EXPECTED_VERSION)) {
    violations.push('release version');
  }
  if (promotion.env?.REQUIRED_CANDIDATE_TAG !== release.env?.RELEASE_DIST_TAG) {
    violations.push('candidate dist-tag');
  }
  if (promotion.env?.BASELINE_LATEST_VERSION !== release.env?.BASELINE_LATEST_VERSION) {
    violations.push('baseline latest');
  }
  if (release.env?.PREVIOUS_CANDIDATE_VERSION !== EXPECTED_PREVIOUS_CANDIDATE_VERSION) {
    violations.push('candidate predecessor');
  }
  if (promotion.env?.REQUIRED_ROLLBACK_REVISION !== EXPECTED_ROLLBACK_REVISION
      || release.env?.REQUIRED_ROLLBACK_REVISION !== EXPECTED_ROLLBACK_REVISION) {
    violations.push('required rollback');
  }
  if (promotion.env?.QUARANTINED_VERSION !== EXPECTED_PREVIOUS_CANDIDATE_VERSION
      || promotion.env?.QUARANTINED_INTEGRITY !== EXPECTED_QUARANTINED_INTEGRITY
      || release.env?.PREVIOUS_CANDIDATE_INTEGRITY !== EXPECTED_QUARANTINED_INTEGRITY
      || promotion.env?.QUARANTINED_TAG_SHA !== EXPECTED_QUARANTINED_TAG_SHA
      || release.env?.PREVIOUS_CANDIDATE_TAG_SHA !== EXPECTED_QUARANTINED_TAG_SHA) {
    violations.push('quarantined predecessor');
  }
  if (!promotionSource.includes('tag="v${PROMOTION_VERSION}"')
      || !releaseSource.includes('"$GITHUB_REF_NAME" != "v${RELEASE_VERSION}"')) {
    violations.push('release tag');
  }
  if (!releaseSource.includes(`.files.tarball.name == "${EXPECTED_TARBALL}"`)) {
    violations.push('release tarball');
  }
  return violations;
}

function admissionViolations(text: string): string[] {
  const required = [
    '"$GITHUB_EVENT_NAME" != "workflow_dispatch"',
    '"$GITHUB_REF_NAME" != "master"',
    '"$ACCEPTANCE_CONFIRMED" != "true"',
    '"$ACCEPTANCE_ATTESTATION_SHA256" =~ ^[0-9a-f]{64}$',
    '"$ACCEPTANCE_OBSERVED_AT" =~ ^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$',
    '"$acceptance_canonical" != "$ACCEPTANCE_OBSERVED_AT"',
    'acceptance_epoch > admission_epoch',
    'admission_epoch - acceptance_epoch > 86400',
    'acceptance_epoch > receipt_epoch',
    'receipt_epoch - acceptance_epoch > 86400',
    '.name == "npm-production-promotion"',
    '.can_admins_bypass == false',
    '.deployment_branch_policy.protected_branches == true',
    '.deployment_branch_policy.custom_branch_policies == false',
    '($reviewerRules | length) == 1',
    '$reviewerRules[0].prevent_self_review == false',
    '($reviewerRules[0].reviewers | type == "array" and length == 1)',
    '$reviewerRules[0].reviewers[0].type == "User"',
    '$reviewerRules[0].reviewers[0].reviewer.login == $approver',
    "'.protected == true and .commit.sha == $sha'",
    '.object.type == "commit" and .object.sha == $sha',
    '.parents[0].sha == $rollback',
    'compare/${tag_sha}...${GITHUB_SHA}',
    '.path == ".github/workflows/release.yml"',
    '.status == "completed" and .conclusion == "success"',
    '.draft == false and .prerelease == true',
    '.["dist-tags"].latest == $latest',
    '.["dist-tags"][$candidate] == $version',
    '.versions[$version].dist.integrity == $integrity',
    '.versions[$quarantinedVersion].dist.integrity == $quarantinedIntegrity',
    'https://slsa.dev/provenance/v1',
    'npmMutationAuthority: false',
    'acceptanceObservedAt: $acceptanceObservedAt',
    'acceptanceMaximumAgeSeconds: 86400',
    'admissionObservedAt: $admissionObservedAt',
    'requiredPromotionApprover: $requiredPromotionApprover',
    'approvalPolicy: "single-owner"',
    'environmentProtectionVerified: true',
    'promotionExecuted: false',
  ];
  return required.filter((fragment) => !text.includes(fragment));
}

function promotionApproverViolations(source: string): string[] {
  const parsed = parse(source) as Workflow;
  const parsedAdmission = parsed.jobs?.admit?.steps?.find((step) =>
    step.name === 'Verify exact accepted candidate and protected release identity');
  const violations = admissionViolations(parsedAdmission?.run ?? '');
  if (parsed.env?.REQUIRED_PROMOTION_APPROVER !== 'masonwyatt23') {
    violations.push('required Mason approver');
  }
  return violations;
}

function environmentAdmissionQuery(text: string): string {
  const command = 'jq -e --arg approver "$REQUIRED_PROMOTION_APPROVER"';
  const commandOffset = text.indexOf(command);
  const queryStart = text.indexOf("'", commandOffset + command.length);
  const inputOffset = text.indexOf('<<<"$environment_json"', queryStart + 1);
  const queryEnd = text.lastIndexOf("'", inputOffset);
  if (commandOffset < 0 || queryStart < 0 || queryEnd < 0) return '';
  return text.slice(queryStart + 1, queryEnd);
}

function environmentPolicyAccepted(environment: unknown): boolean {
  const query = environmentAdmissionQuery(admission?.run ?? '');
  if (!query) return false;
  const result = spawnSync('jq', ['-e', '--arg', 'approver', 'masonwyatt23', query], {
    input: JSON.stringify(environment),
    encoding: 'utf8',
  });
  return result.status === 0;
}

function mutationAuthorityViolations(text: string): string[] {
  const violations: string[] = [];
  const executableText = text
    .replace(/(--arg promotionCommand\s+)"[^"\n]*"/gu, '$1"<redacted>"')
    .replace(/\\\r?\n[ \t]*/gu, ' ');
  const commandPrefix = '(?:^|[\\n;{}]|&&|\\|\\|)\\s*'
    + '(?:(?:command|builtin|exec)\\s+'
    + '|env(?:\\s+[A-Za-z_][A-Za-z0-9_]*=[^\\s;]+)*(?:\\s+--)?\\s+)*';
  const npmExecutable = new RegExp(
    `${commandPrefix}(?:corepack\\s+)?(?:"?\\/[^\\s;"']*\\/npm"?|npm)(?=\\s|$)`,
    'mu',
  );
  if (npmExecutable.test(executableText)) {
    violations.push('npm executable command');
  }
  const npmCliExecutable = new RegExp(
    `${commandPrefix}node\\s+["']?(?:\\$(?:\\{)?[A-Za-z_][A-Za-z0-9_]*(?:\\})?`
      + `|[^\\s;"']*\\/npm(?:-cli)?\\.js)["']?(?=\\s|$)`,
    'mu',
  );
  if (npmCliExecutable.test(executableText)) {
    violations.push('npm CLI executable command');
  }
  const curlWrite = /(?:^|\n)\s*(?:(?:command|builtin|exec)\s+|env(?:\s+[A-Za-z_][A-Za-z0-9_]*=[^\s;]+)*(?:\s+--)?\s+)*(?:"?\/[^\s;"']*\/curl"?|curl)\b[^\n]*(?:(?:\s-X(?:=|\s*)|--request(?:=|\s+))(?:POST|PUT|PATCH|DELETE)\b|\s-[dFT](?:\S|\s)|--data(?:-ascii|-binary|-raw|-urlencode)?(?:=|\s)|--form(?:-string)?(?:=|\s)|--upload-file(?:=|\s)|--json(?:=|\s))/imu;
  if (curlWrite.test(executableText)) {
    violations.push('registry-capable curl mutation');
  }
  const githubWrite = /(?:^|\n)\s*(?:(?:command|builtin|exec)\s+|env(?:\s+[A-Za-z_][A-Za-z0-9_]*=[^\s;]+)*(?:\s+--)?\s+)*(?:"?\/[^\s;"']*\/gh"?|gh)\s+api\b[^\n]*(?:(?:-X(?:=|\s*)|--method(?:=|\s+))(?:POST|PUT|PATCH|DELETE)\b|--input(?:=|\s)|(?:-f|-F)(?:\s|[A-Za-z_])|--(?:raw-)?field(?:=|\s))/imu;
  if (githubWrite.test(executableText)) {
    violations.push('GitHub API mutation');
  }
  if (/(?:^|\n)\s*(?:(?:function\s+)?[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)\s*\{|alias\s+)|(?:^|[\n;{}]|&&|\|\|)\s*(?:eval\b|(?:\/?(?:bin\/)?(?:ba|z)?sh)\s+-c\b|source\s+|\.\s+[^\s])/mu.test(executableText)) {
    violations.push('dynamic shell or function wrapper');
  }
  return violations;
}

describe('M522 — production-promotion admission has no npm mutation authority', () => {
  it('binds the promotion, release workflow, and package to the exact 3.3.1 identity', () => {
    expect(identityViolations(promotionText, releaseText, packageText)).toEqual([]);
    expect([
      workflow.env?.PROMOTION_VERSION,
      releaseWorkflow.env?.RELEASE_VERSION,
      packageMetadata.version,
    ]).toEqual([EXPECTED_VERSION, EXPECTED_VERSION, EXPECTED_VERSION]);
    expect(packageMetadata.name).toBe('@ashlr/hub');
    expect(releaseWorkflow.env).toMatchObject({
      RELEASE_VERSION: EXPECTED_VERSION,
      RELEASE_DIST_TAG: 'candidate',
      BASELINE_LATEST_VERSION: '3.0.1',
      PREVIOUS_CANDIDATE_VERSION: EXPECTED_PREVIOUS_CANDIDATE_VERSION,
    });
    expect(workflow.on?.workflow_dispatch?.inputs?.release_run_id?.description)
      .toContain(`v${EXPECTED_VERSION}`);
    expect(workflow.on?.workflow_dispatch?.inputs?.candidate_integrity?.description)
      .toContain(`@ashlr/hub@${EXPECTED_VERSION}`);
    expect(admission?.run).toContain(
      `--arg promotionCommand "npm dist-tag add @ashlr/hub@${EXPECTED_VERSION} latest"`,
    );
    expect(admission?.run).toContain('tag="v${PROMOTION_VERSION}"');
    expect(releaseText).toContain(`.files.tarball.name == "${EXPECTED_TARBALL}"`);
    expect(EXPECTED_TAG).toBe('v3.3.1');
  });

  it.each([
    [
      'promotion workflow version',
      promotionText.replace('PROMOTION_VERSION: "3.3.1"', 'PROMOTION_VERSION: "3.3.2"'),
      releaseText,
      packageText,
    ],
    [
      'release workflow version',
      promotionText,
      releaseText.replace('RELEASE_VERSION: "3.3.1"', 'RELEASE_VERSION: "3.3.2"'),
      packageText,
    ],
    [
      'package version',
      promotionText,
      releaseText,
      JSON.stringify({ ...packageMetadata, version: '3.3.2' }),
    ],
    [
      'candidate dist-tag',
      promotionText.replace('REQUIRED_CANDIDATE_TAG: candidate', 'REQUIRED_CANDIDATE_TAG: next'),
      releaseText,
      packageText,
    ],
    [
      'baseline latest',
      promotionText,
      releaseText.replace('BASELINE_LATEST_VERSION: "3.0.1"', 'BASELINE_LATEST_VERSION: "3.0.0"'),
      packageText,
    ],
    [
      'candidate predecessor',
      promotionText,
      releaseText.replace('PREVIOUS_CANDIDATE_VERSION: "3.3.0"', 'PREVIOUS_CANDIDATE_VERSION: "3.2.7"'),
      packageText,
    ],
    [
      'required rollback revision',
      promotionText.replace(EXPECTED_ROLLBACK_REVISION, '1'.repeat(40)),
      releaseText,
      packageText,
    ],
    [
      'quarantined candidate integrity',
      promotionText.replace(EXPECTED_QUARANTINED_INTEGRITY, 'sha512-' + 'A'.repeat(86) + '=='),
      releaseText,
      packageText,
    ],
    [
      'quarantined tag identity',
      promotionText.replace(EXPECTED_QUARANTINED_TAG_SHA, '2'.repeat(40)),
      releaseText,
      packageText,
    ],
    [
      'exact release tag',
      promotionText.replace('tag="v${PROMOTION_VERSION}"', 'tag="release-${PROMOTION_VERSION}"'),
      releaseText,
      packageText,
    ],
    [
      'exact release tarball',
      promotionText,
      releaseText.replace('ashlr-hub-3.3.1.tgz', 'ashlr-hub-next.tgz'),
      packageText,
    ],
  ])('rejects hostile cross-release identity drift in %s', (_label, promotion, release, pkg) => {
    expect(identityViolations(promotion, release, pkg)).not.toEqual([]);
  });

  it('is a separate, manually dispatched, environment-approved observation lane', () => {
    expect(promotionApproverViolations(promotionText)).toEqual([]);
    expect(Object.keys(workflow.on ?? {})).toEqual(['workflow_dispatch']);
    expect(workflow.permissions).toEqual({});
    expect(workflow.concurrency).toEqual({
      group: 'npm-production-promotion-admission',
      'cancel-in-progress': false,
    });
    expect(workflow.env).toEqual({
      PROMOTION_VERSION: '3.3.1',
      PROMOTION_TAG: 'latest',
      REQUIRED_CANDIDATE_TAG: 'candidate',
      BASELINE_LATEST_VERSION: '3.0.1',
      REQUIRED_ROLLBACK_REVISION: EXPECTED_ROLLBACK_REVISION,
      QUARANTINED_VERSION: '3.3.0',
      QUARANTINED_INTEGRITY: EXPECTED_QUARANTINED_INTEGRITY,
      QUARANTINED_TAG_SHA: EXPECTED_QUARANTINED_TAG_SHA,
      REQUIRED_PROMOTION_APPROVER: 'masonwyatt23',
    });
    expect(Object.keys(workflow.jobs ?? {})).toEqual(['admit']);
    expect(job.environment).toBe('npm-production-promotion');
    expect(job.permissions).toEqual({ actions: 'read', contents: 'read' });
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job['timeout-minutes']).toBe(10);
  });

  it('requires explicit candidate, release-run, and acceptance evidence', () => {
    const inputs = workflow.on?.workflow_dispatch?.inputs ?? {};
    expect(Object.keys(inputs)).toEqual([
      'release_run_id',
      'candidate_integrity',
      'acceptance_attestation_sha256',
      'acceptance_observed_at',
      'acceptance_confirmed',
    ]);
    expect(inputs.acceptance_confirmed).toMatchObject({
      required: true,
      default: false,
      type: 'boolean',
    });
    expect(inputs.acceptance_observed_at).toMatchObject({
      required: true,
      type: 'string',
    });
    expect(admissionViolations(admission?.run ?? '')).toEqual([]);
    expect(admission?.run).toContain(
      'repos/${GITHUB_REPOSITORY}/environments/npm-production-promotion',
    );
  });

  it('cannot authenticate, publish, retag, install, launch, or activate', () => {
    expect(promotionText).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|\$\{\{\s*secrets\./u);
    expect(promotionText).not.toMatch(/id-token\s*:/u);
    expect(promotionText).not.toMatch(/^\s*(?:npm|node\s+"\$[^\n]*npm[^\n]*")\s+(?:publish|dist-tag|unpublish|deprecate)\b/mu);
    expect(promotionText).not.toMatch(/npm\s+(?:install|ci|run|pack)\b/u);
    expect(promotionText).not.toMatch(/launchctl|systemctl|runtime activate|daemon start/u);
    expect(mutationAuthorityViolations(promotionText)).toEqual([]);
    expect(releaseText).not.toMatch(/npm\s+(?:dist-tag|unpublish|deprecate)\b/u);
    expect(releaseText.match(/npm publish "\$TARBALL"/g)).toHaveLength(1);
    expect(releaseText).toContain('--tag "$RELEASE_DIST_TAG"');
  });

  it('uploads only the bounded receipt and digest with an immutable action', () => {
    const refs = steps.flatMap((step) => step.uses ? [step.uses] : []);
    expect(refs).toEqual([
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    ]);
    expect(upload?.with).toEqual({
      name: 'npm-production-promotion-admission-${{ github.run_id }}-${{ github.run_attempt }}',
      path: '${{ steps.admission.outputs.receipt }}\n${{ steps.admission.outputs.receipt_digest }}\n',
      'if-no-files-found': 'error',
      'retention-days': 7,
      'compression-level': 9,
      overwrite: false,
      'include-hidden-files': false,
    });
    expect(admission?.run).toContain('receipt_bytes > 16384');
    expect(admission?.run).toContain('sha256sum "$receipt"');
    expect(admission?.run).toContain('--arg promotionCommand "npm dist-tag add @ashlr/hub@3.3.1 latest"');
    expect(admission?.run).toContain('npmCredentialsPresent: false');
    expect(admission?.run).toContain('oidcAuthority: false');
    expect(admission?.run).toContain('acceptanceObservedAt: $acceptanceObservedAt');
    expect(admission?.run).toContain('acceptanceMaximumAgeSeconds: 86400');
    expect(admission?.run).toContain('admissionObservedAt: $admissionObservedAt');
  });

  it.each([
    ['acceptance confirmation', '"$ACCEPTANCE_CONFIRMED" != "true"'],
    [
      'acceptance timestamp shape',
      '"$ACCEPTANCE_OBSERVED_AT" =~ ^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$',
    ],
    ['acceptance timestamp canonicalization', '"$acceptance_canonical" != "$ACCEPTANCE_OBSERVED_AT"'],
    ['future acceptance at admission', 'acceptance_epoch > admission_epoch'],
    ['acceptance freshness at admission', 'admission_epoch - acceptance_epoch > 86400'],
    ['future acceptance at receipt', 'acceptance_epoch > receipt_epoch'],
    ['acceptance freshness at receipt', 'receipt_epoch - acceptance_epoch > 86400'],
    ['custom branch policies disabled', '.deployment_branch_policy.custom_branch_policies == false'],
    ['exactly one reviewer rule', '($reviewerRules | length) == 1'],
    ['Mason self-approval policy', '$reviewerRules[0].prevent_self_review == false'],
    ['exactly one reviewer', '($reviewerRules[0].reviewers | type == "array" and length == 1)'],
    ['user reviewer type', '$reviewerRules[0].reviewers[0].type == "User"'],
    ['Mason reviewer identity', '$reviewerRules[0].reviewers[0].reviewer.login == $approver'],
    ['administrator bypass disabled', '.can_admins_bypass == false'],
    ['protected master', "'.protected == true and .commit.sha == $sha'"],
    ['release workflow success', '.status == "completed" and .conclusion == "success"'],
    ['candidate dist-tag', '.["dist-tags"][$candidate] == $version'],
    ['candidate integrity', '.versions[$version].dist.integrity == $integrity'],
    ['fixed safe first parent', '.parents[0].sha == $rollback'],
    ['quarantined candidate integrity', '.versions[$quarantinedVersion].dist.integrity == $quarantinedIntegrity'],
    ['no npm mutation authority receipt', 'npmMutationAuthority: false'],
  ])('hostile mutation removing %s fails policy', (_label, fragment) => {
    expect(admission?.run).toContain(fragment);
    const mutated = (admission?.run ?? '').replace(fragment, 'true');
    expect(admissionViolations(mutated)).not.toEqual([]);
  });

  it('rejects a hostile environment mutation that enables administrator bypass', () => {
    const fragment = '.can_admins_bypass == false';
    expect(admission?.run).toContain(fragment);
    const mutated = (admission?.run ?? '').replace(fragment, '.can_admins_bypass == true');
    expect(admissionViolations(mutated)).toContain(fragment);
  });

  it('rejects a hostile policy that changes the sole required approver', () => {
    const mutated = promotionText.replace(
      'REQUIRED_PROMOTION_APPROVER: masonwyatt23',
      'REQUIRED_PROMOTION_APPROVER: someone-else',
    );
    expect(mutated).not.toBe(promotionText);
    expect(promotionApproverViolations(mutated)).toContain('required Mason approver');
  });

  it('executes the exact environment predicate and rejects duplicate reviewer rules', () => {
    const masonRule = {
      type: 'required_reviewers',
      prevent_self_review: false,
      reviewers: [{ type: 'User', reviewer: { login: 'masonwyatt23' } }],
    };
    const exactEnvironment = {
      name: 'npm-production-promotion',
      can_admins_bypass: false,
      deployment_branch_policy: {
        protected_branches: true,
        custom_branch_policies: false,
      },
      protection_rules: [masonRule],
    };
    expect(environmentPolicyAccepted(exactEnvironment)).toBe(true);
    expect(environmentPolicyAccepted({
      ...exactEnvironment,
      protection_rules: [
        masonRule,
        {
          type: 'required_reviewers',
          prevent_self_review: false,
          reviewers: [{ type: 'User', reviewer: { login: 'someone-else' } }],
        },
      ],
    })).toBe(false);
  });

  it.each([
    [
      'self-review prevention',
      '$reviewerRules[0].prevent_self_review == false',
      '$reviewerRules[0].prevent_self_review == true',
    ],
    [
      'an additional reviewer',
      '($reviewerRules[0].reviewers | type == "array" and length == 1)',
      '($reviewerRules[0].reviewers | type == "array" and length >= 1)',
    ],
    [
      'a group reviewer',
      '$reviewerRules[0].reviewers[0].type == "User"',
      '$reviewerRules[0].reviewers[0].type == "Team"',
    ],
  ])('rejects a hostile environment policy allowing %s', (_label, fragment, replacement) => {
    expect(admission?.run).toContain(fragment);
    const mutated = (admission?.run ?? '').replace(fragment, replacement);
    expect(admissionViolations(mutated)).not.toEqual([]);
  });

  it.each([
    ['command prefix', '\ncommand npm dist-tag add @ashlr/hub@3.3.1 latest'],
    ['env prefix', '\nenv npm dist-tag add @ashlr/hub@3.3.1 latest'],
    ['env option separator', '\nenv -- npm dist-tag add @ashlr/hub@3.3.1 latest'],
    ['absolute npm path', '\n/usr/bin/npm dist-tag add @ashlr/hub@3.3.1 latest'],
    ['npm registry option', '\nnpm --registry https://registry.npmjs.org dist-tag add @ashlr/hub@3.3.1 latest'],
    ['exec wrapper', '\nexec /usr/bin/npm dist-tag add @ashlr/hub@3.3.1 latest'],
    ['npm executable variable', '\nnode "$PROMOTION_NPM_CLI" dist-tag add @ashlr/hub@3.3.1 latest'],
    ['npm CLI path', '\nnode /opt/npm/lib/node_modules/npm/bin/npm-cli.js dist-tag add @ashlr/hub@3.3.1 latest'],
    ['corepack npm wrapper', '\ncorepack npm dist-tag add @ashlr/hub@3.3.1 latest'],
    ['npm line continuation', '\nnpm \\\n  dist-tag add @ashlr/hub@3.3.1 latest'],
    ['curl write', '\ncurl --request PUT https://registry.npmjs.org/example'],
    ['curl implicit data write', '\n/usr/bin/curl --data payload https://registry.npmjs.org/example'],
    ['curl short data write', '\ncurl -d@payload.json https://registry.npmjs.org/example'],
    ['curl form write', '\ncurl --form package=@archive.tgz https://registry.npmjs.org/example'],
    ['curl JSON write', '\ncurl --json @payload.json https://registry.npmjs.org/example'],
    ['GitHub API method write', '\ngh api --method PATCH repos/example/project'],
    ['GitHub API compact method write', '\ngh api -XPOST repos/example/project'],
    ['GitHub API input write', '\ngh api repos/example/project --input payload.json'],
    ['GitHub API short field write', '\ngh api repos/example/project -f state=closed'],
    ['GitHub API long field write', '\ngh api repos/example/project --raw-field state=closed'],
    ['shell command wrapper', "\nbash -c 'npm dist-tag add @ashlr/hub@3.3.1 latest'"],
    ['function wrapper', '\npromote() { "$@"; }\npromote npm dist-tag add @ashlr/hub@3.3.1 latest'],
  ])('detects hidden authority via %s', (_label, payload) => {
    expect(mutationAuthorityViolations(`${promotionText}${payload}`)).not.toEqual([]);
  });

  it('does not let executable text hide beside the redacted receipt command', () => {
    const needle = '--arg promotionCommand "npm dist-tag add @ashlr/hub@3.3.1 latest"';
    const mutated = promotionText.replace(
      needle,
      `${needle}; npm dist-tag add @ashlr/hub@3.3.1 latest`,
    );
    expect(mutated).not.toBe(promotionText);
    expect(mutationAuthorityViolations(mutated)).toContain('npm executable command');
  });

  it('keeps the final OTP effect outside the observation-only workflow', () => {
    expect(promotionText).toContain(
      'performs the one interactive OTP-protected promotion effect',
    );
    expect(promotionText).toContain(
      'a maintainer must revalidate live state and enter a fresh OTP interactively',
    );
    expect(promotionText).not.toMatch(/--otp(?:=|\s)/u);
  });
});
