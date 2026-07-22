import { spawnSync } from 'node:child_process';
import { chmodSync, linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  auditExternalSkillPack,
  canonicalExternalSkillAuditReportBytes,
  EXTERNAL_SKILL_AUDIT_POLICY_DIGEST,
  formatExternalSkillAudit,
} from '../src/core/fleet/external-skill-audit.js';
import { cmdSkills } from '../src/cli/skills.js';

const roots: string[] = [];

function packRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-external-skills-'));
  roots.push(root);
  mkdirSync(join(root, 'skills'), { recursive: true });
  mkdirSync(join(root, 'evals', 'cases'), { recursive: true });
  mkdirSync(join(root, 'evals', 'fixtures'), { recursive: true });
  return root;
}

function writeSkill(
  root: string,
  name: string,
  description: string,
  otherSkill: string,
  promptWord: string,
): void {
  const skillDir = join(root, 'skills', name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    `# ${name}`,
    '',
    '## When to Use',
    `Use for ${promptWord}.`,
    '',
    '## Workflow',
    'Follow a bounded process.',
    '',
    '## Common Rationalizations',
    'Do not skip proof.',
    '',
    '## Red Flags',
    'Unsupported claims.',
    '',
    '## Verification',
    'Provide deterministic evidence.',
  ].join('\n'));

  const fixture = join(root, 'evals', 'fixtures', name);
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, 'input.txt'), promptWord);
  writeFileSync(join(root, 'evals', 'cases', `${name}.json`), JSON.stringify({
    skill_name: name,
    trigger: {
      positive: [
        { prompt: `${promptWord} ${promptWord} workflow`, top_k: 1 },
        { prompt: `perform ${promptWord} carefully`, top_k: 1 },
        { prompt: `need ${promptWord} evidence`, top_k: 1 },
      ],
      negative: [
        { prompt: `${otherSkill.replaceAll('-', ' ')} workflow`, owner: otherSkill },
        { prompt: `perform ${otherSkill.replaceAll('-', ' ')}`, owner: otherSkill },
      ],
    },
    evals: [{
      id: 1,
      kind: 'execution',
      prompt: `Complete ${promptWord}`,
      expected_output: 'Evidence-backed result',
      files: [name],
      expectations: ['The result includes evidence'],
    }],
  }));
}

function validPack(): string {
  const root = packRoot();
  writeSkill(
    root,
    'test-driven-development',
    'Guides test driven development and regression testing. Use when fixing logic with tests.',
    'documentation-writing',
    'testing',
  );
  writeSkill(
    root,
    'documentation-writing',
    'Guides documentation writing and architecture records. Use when documenting decisions.',
    'test-driven-development',
    'documentation',
  );
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('external skill-pack quarantine audit', () => {
  it('reports a structurally complete, routable pack as trial-ready but never promotable', () => {
    const report = auditExternalSkillPack(validPack());

    expect(report).toMatchObject({
      schemaVersion: 2,
      mode: 'quarantine',
      skillCount: 2,
      structural: { passed: true, errors: 0 },
      routing: { passed: true, rankOneRate: 1 },
      behavioral: { state: 'declared', declaredCases: 2 },
      trialReady: true,
      promotion: { eligible: false },
    });
    expect(report.promotion.blockers).toEqual([
      'external-content-quarantined',
      'source-provenance-required',
      'immutable-source-snapshot-required',
      'license-review-required',
      'behavioral-evidence-required',
      'verified-outcome-required',
    ]);
    expect(report.skills.every((skill) => /^[a-f0-9]{64}$/.test(skill.contentHash))).toBe(true);
    expect(JSON.stringify(report)).not.toContain('Evidence-backed result');
    expect(JSON.stringify(report)).not.toContain('Complete testing');
  });

  it('content-binds the pack digest and never returns external descriptions', () => {
    const root = validPack();
    const first = auditExternalSkillPack(root);
    const skillFile = join(root, 'skills', 'documentation-writing', 'SKILL.md');
    writeFileSync(skillFile, `${[
      '---',
      'name: documentation-writing',
      'description: Guides documentation writing and architecture records. Use when documenting decisions.',
      '---',
      '## When to Use',
      'Documentation.',
      '## Workflow',
      'A changed workflow.',
      '## Common Rationalizations',
      'No.',
      '## Red Flags',
      'No proof.',
      '## Verification',
      'Evidence.',
    ].join('\n')}\n`);
    const second = auditExternalSkillPack(root);

    expect(second.packDigest).not.toBe(first.packDigest);
    expect(second.skills[0]).not.toHaveProperty('description');
    expect(second.skills[0]).not.toHaveProperty('source');
  });

  it('emits one key-order-independent canonical report encoding', () => {
    const report = auditExternalSkillPack(validPack());
    const reordered = { skills: report.skills, ...report };

    expect(canonicalExternalSkillAuditReportBytes(reordered))
      .toEqual(canonicalExternalSkillAuditReportBytes(report));
    expect(canonicalExternalSkillAuditReportBytes({ ...report, extra: true })).toBeNull();
    expect(canonicalExternalSkillAuditReportBytes(Object.create(report))).toBeNull();
  });

  it('pins the complete routing policy manifest identity', () => {
    expect(EXTERNAL_SKILL_AUDIT_POLICY_DIGEST)
      .toBe('5d4b4af74034d3d935b7aea8b719cd771013c06ad783dc21ad9571163d29acab');
    const source = readFileSync(join(
      process.cwd(), 'src/core/fleet/external-skill-audit.ts',
    ), 'utf8');
    expect(source).toContain('stopWords: [...STOP_WORDS].sort(asciiCompare)');
    expect(source).toContain('stemSuffixes: [...STEM_SUFFIXES]');
    expect(source).toContain('for (const suffix of STEM_SUFFIXES)');
    expect(source).toContain("algorithmRevision: AUDIT_ALGORITHM_REVISION");
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(packageJson.dependencies.marked).toBe('17.0.0');
  });

  it('content-binds eval contracts and behavioral fixtures', () => {
    const root = validPack();
    const initial = auditExternalSkillPack(root).packDigest;
    const caseFile = join(root, 'evals', 'cases', 'documentation-writing.json');
    const originalCase = JSON.parse(readFileSync(caseFile, 'utf8')) as {
      trigger: { positive: Array<{ prompt: string }> };
    };
    originalCase.trigger.positive[0]!.prompt += ' changed';
    writeFileSync(caseFile, JSON.stringify(originalCase));
    const afterCase = auditExternalSkillPack(root).packDigest;
    writeFileSync(join(root, 'evals', 'fixtures', 'documentation-writing', 'input.txt'), 'changed fixture');
    const afterFixture = auditExternalSkillPack(root).packDigest;

    expect(afterCase).not.toBe(initial);
    expect(afterFixture).not.toBe(afterCase);
  });

  it('content-binds supporting and license files outside the executable eval surface', () => {
    const root = validPack();
    writeFileSync(join(root, 'LICENSE'), 'MIT v1');
    writeFileSync(join(root, 'skills', 'documentation-writing', 'supporting.md'), 'reference v1');
    const initial = auditExternalSkillPack(root).packDigest;
    writeFileSync(join(root, 'skills', 'documentation-writing', 'supporting.md'), 'reference v2');
    const afterSupport = auditExternalSkillPack(root).packDigest;
    writeFileSync(join(root, 'LICENSE'), 'MIT v2');
    const afterLicense = auditExternalSkillPack(root).packDigest;
    const portableBeforeMode = auditExternalSkillPack(root).portablePackDigest;
    chmodSync(join(root, 'LICENSE'), 0o600);
    const modeReport = auditExternalSkillPack(root);
    const afterMode = modeReport.packDigest;

    expect(afterSupport).not.toBe(initial);
    expect(afterLicense).not.toBe(afterSupport);
    expect(afterMode).not.toBe(afterLicense);
    expect(modeReport.portablePackDigest).toBe(portableBeforeMode);
  });

  it('rejects symlinked skill files instead of following content outside the pack', () => {
    const root = packRoot();
    const outside = join(packRoot(), 'outside.md');
    writeFileSync(outside, '---\nname: linked\ndescription: Use when linked.\n---\n');
    mkdirSync(join(root, 'skills', 'linked'));
    symlinkSync(outside, join(root, 'skills', 'linked', 'SKILL.md'));

    const report = auditExternalSkillPack(root);

    expect(report.trialReady).toBe(false);
    expect(report.skillCount).toBe(0);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: 'error', code: 'pack-unavailable-or-unsafe' }),
    ]));
  });

  it('content-binds a safe internal integration symlink without traversing it twice', () => {
    const root = validPack();
    mkdirSync(join(root, '.opencode'));
    symlinkSync('../skills', join(root, '.opencode', 'skills'));

    const report = auditExternalSkillPack(root);

    expect(report.trialReady).toBe(true);
    expect(report.packDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a symlink supplied as the pack root', () => {
    const root = validPack();
    const linkRoot = join(packRoot(), 'linked-pack');
    symlinkSync(root, linkRoot);

    const report = auditExternalSkillPack(linkRoot);

    expect(report).toMatchObject({
      packDigest: null,
      trialReady: false,
      issues: [{ level: 'error', code: 'invalid-pack-root' }],
    });
  });

  it('rejects symlinks into excluded git bytes and special permission bits', () => {
    const symlinkRoot = validPack();
    mkdirSync(join(symlinkRoot, '.git'));
    writeFileSync(join(symlinkRoot, '.git', 'secret.sh'), 'excluded');
    symlinkSync(
      '../../.git/secret.sh',
      join(symlinkRoot, 'skills', 'documentation-writing', 'support-link'),
    );

    const modeRoot = validPack();
    const fixture = join(modeRoot, 'evals', 'fixtures', 'documentation-writing', 'input.txt');
    chmodSync(fixture, 0o4755);

    expect(auditExternalSkillPack(symlinkRoot)).toMatchObject({ packDigest: null, trialReady: false });
    expect(auditExternalSkillPack(modeRoot)).toMatchObject({ packDigest: null, trialReady: false });
  });

  it('rejects an excluded git symlink and frontmatter-only no-op skills', () => {
    const gitRoot = validPack();
    symlinkSync('/etc', join(gitRoot, '.git'));

    const emptyRoot = validPack();
    writeFileSync(
      join(emptyRoot, 'skills', 'documentation-writing', 'SKILL.md'),
      '---\nname: documentation-writing\ndescription: Documentation workflow.\n---\n',
    );
    const emptyReport = auditExternalSkillPack(emptyRoot);

    expect(auditExternalSkillPack(gitRoot)).toMatchObject({ packDigest: null, trialReady: false });
    expect(emptyReport.trialReady).toBe(false);
    expect(emptyReport.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level: 'error',
        code: 'incomplete-workflow-sections',
        skill: 'documentation-writing',
      }),
    ]));
  });

  it('does not count fenced or commented headings as substantive workflow sections', () => {
    const root = validPack();
    writeFileSync(
      join(root, 'skills', 'documentation-writing', 'SKILL.md'),
      [
        '---',
        'name: documentation-writing',
        'description: Documentation workflow.',
        '---',
        '~~~md',
        '~~~not-a-valid-closing-fence',
        '## When to Use',
        'Hidden fenced content.',
        '## Workflow',
        'Hidden fenced content.',
        '## Verification',
        'Hidden fenced content.',
        '~~~',
        '<!--',
        '## Common Rationalizations',
        'Hidden comment content.',
        '## Red Flags',
        'Hidden comment content.',
        '-->',
      ].join('\n'),
    );

    const report = auditExternalSkillPack(root);
    const skill = report.skills.find((entry) => entry.name === 'documentation-writing');

    expect(skill?.sections).toEqual({
      whenToUse: false,
      process: false,
      rationalizations: false,
      redFlags: false,
      verification: false,
    });
    expect(report.trialReady).toBe(false);
  });

  it('does not count hidden HTML blocks or tag-only bodies as substantive sections', () => {
    const root = validPack();
    writeFileSync(
      join(root, 'skills', 'documentation-writing', 'SKILL.md'),
      [
        '---',
        'name: documentation-writing',
        'description: Documentation workflow.',
        '---',
        '<script>',
        '## When to Use',
        'Hidden script content.',
        '## Workflow',
        'Hidden script content.',
        '</script>',
        '## Verification',
        '<br>&nbsp;',
      ].join('\n'),
    );

    const report = auditExternalSkillPack(root);
    const skill = report.skills.find((entry) => entry.name === 'documentation-writing');

    expect(skill?.sections).toMatchObject({ whenToUse: false, process: false, verification: false });
    expect(report.trialReady).toBe(false);
  });

  it('does not count text inside raw HTML containers as substantive section content', () => {
    const root = validPack();
    writeFileSync(
      join(root, 'skills', 'documentation-writing', 'SKILL.md'),
      [
        '---',
        'name: documentation-writing',
        'description: Documentation workflow.',
        '---',
        '## When to Use',
        '<div hidden>',
        'Invisible use guidance.',
        '</div>',
        '## Workflow',
        '<span style="display:none">Invisible workflow.</span>',
        '## Verification',
        '<span>Raw HTML is not authoritative evidence.</span>',
      ].join('\n'),
    );

    const report = auditExternalSkillPack(root);
    const skill = report.skills.find((entry) => entry.name === 'documentation-writing');

    expect(skill?.sections).toMatchObject({ whenToUse: false, process: false, verification: false });
    expect(report.trialReady).toBe(false);
  });

  it('does not let unclosed raw HTML hide later qualifying Markdown', () => {
    const root = validPack();
    writeFileSync(
      join(root, 'skills', 'documentation-writing', 'SKILL.md'),
      [
        '---',
        'name: documentation-writing',
        'description: Documentation workflow.',
        '---',
        '<div hidden>',
        '## When to Use',
        'Hidden use guidance.',
        '## Workflow',
        'Hidden workflow.',
        '## Verification',
        'Hidden verification.',
      ].join('\n'),
    );

    const report = auditExternalSkillPack(root);
    expect(report.trialReady).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'incomplete-workflow-sections', skill: 'documentation-writing' }),
    ]));
  });

  it('finds nested inline raw HTML before trusting later Markdown sections', () => {
    const root = validPack();
    writeFileSync(
      join(root, 'skills', 'documentation-writing', 'SKILL.md'),
      [
        '---',
        'name: documentation-writing',
        'description: Documentation workflow.',
        '---',
        'prefix <b hidden>',
        '## When to Use',
        'Hidden use guidance.',
        '## Workflow',
        'Hidden workflow.',
        '## Verification',
        'Hidden verification.',
      ].join('\n'),
    );

    const report = auditExternalSkillPack(root);
    expect(report.trialReady).toBe(false);
  });

  it('content-binds safe symlink targets and stops at the directory entry cap', () => {
    const symlinkRoot = validPack();
    writeFileSync(join(symlinkRoot, 'support-a.txt'), 'a');
    writeFileSync(join(symlinkRoot, 'support-b.txt'), 'b');
    const link = join(symlinkRoot, 'support-link');
    symlinkSync('support-a.txt', link);
    const firstDigest = auditExternalSkillPack(symlinkRoot).packDigest;
    unlinkSync(link);
    symlinkSync('support-b.txt', link);
    const secondDigest = auditExternalSkillPack(symlinkRoot).packDigest;

    const cappedRoot = validPack();
    const crowded = join(cappedRoot, 'crowded');
    mkdirSync(crowded);
    for (let index = 0; index < 513; index += 1) {
      writeFileSync(join(crowded, `entry-${index}`), 'x');
    }
    const capped = auditExternalSkillPack(cappedRoot);

    expect(firstDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(secondDigest).not.toBe(firstDigest);
    expect(capped).toMatchObject({ packDigest: null, trialReady: false });
  });

  it('rejects hard-linked skill files instead of hashing another path as pack content', () => {
    const root = packRoot();
    const outside = join(packRoot(), 'outside.md');
    writeFileSync(outside, '---\nname: linked\ndescription: Use when linked.\n---\n');
    mkdirSync(join(root, 'skills', 'linked'));
    linkSync(outside, join(root, 'skills', 'linked', 'SKILL.md'));

    const report = auditExternalSkillPack(root);

    expect(report.skillCount).toBe(0);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'pack-unavailable-or-unsafe' }),
    ]));
  });

  it('fails malformed eval contracts without echoing hostile prompt text', () => {
    const root = validPack();
    writeFileSync(
      join(root, 'evals', 'cases', 'documentation-writing.json'),
      '{"skill_name":"documentation-writing","trigger":{"positive":[{"prompt":"RAW_PROMPT_SECRET"}]}}',
    );

    const report = auditExternalSkillPack(root);

    expect(report.trialReady).toBe(false);
    expect(report.behavioral.state).toBe('invalid');
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'incomplete-eval-contract', skill: 'documentation-writing' }),
    ]));
    expect(JSON.stringify(report)).not.toContain('RAW_PROMPT_SECRET');
  });

  it('rejects ambiguous frontmatter and duplicate JSON object members', () => {
    const yamlRoot = validPack();
    const skillFile = join(yamlRoot, 'skills', 'documentation-writing', 'SKILL.md');
    const skillSource = readFileSync(skillFile, 'utf8');
    writeFileSync(skillFile, skillSource.replace(
      'name: documentation-writing',
      'name: documentation-writing\nname : authority-escalation',
    ));

    const jsonRoot = validPack();
    const caseFile = join(jsonRoot, 'evals', 'cases', 'documentation-writing.json');
    const contract = readFileSync(caseFile, 'utf8');
    writeFileSync(caseFile, contract.replace(
      '"skill_name":"documentation-writing"',
      '"skill_name":"authority-escalation","skill_name":"documentation-writing"',
    ));

    expect(auditExternalSkillPack(yamlRoot).trialReady).toBe(false);
    expect(auditExternalSkillPack(jsonRoot)).toMatchObject({
      trialReady: false,
      behavioral: { state: 'invalid' },
    });
  });

  it('requires every skill to meet routing thresholds independently', () => {
    const root = packRoot();
    const names = ['alpha-work', 'bravo-work', 'charlie-work', 'delta-work', 'echo-work'];
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index]!;
      const owner = names[(index + 1) % names.length]!;
      const word = name.split('-')[0]!;
      writeSkill(root, name, `${word} workflow evidence. Use for ${word} tasks.`, owner, word);
    }
    const caseFile = join(root, 'evals', 'cases', 'echo-work.json');
    const contract = JSON.parse(readFileSync(caseFile, 'utf8')) as {
      trigger: { positive: Array<{ prompt: string; top_k: number }> };
    };
    const misroutedPrompts = [
      'alpha workflow evidence',
      'alpha workflow task',
      'alpha evidence task',
    ];
    for (const [index, positive] of contract.trigger.positive.entries()) {
      positive.prompt = misroutedPrompts[index]!;
      positive.top_k = 5;
    }
    writeFileSync(caseFile, JSON.stringify(contract));

    const report = auditExternalSkillPack(root);
    const echo = report.skills.find((skill) => skill.name === 'echo-work');

    expect(report.routing.rankOneRate).toBe(0.8);
    expect(report.routing.topKPassed).toBe(report.routing.positivePrompts);
    expect(echo?.routing).toMatchObject({ passed: false, rankOnePassed: 0 });
    expect(report.routing.passed).toBe(false);
    expect(report.trialReady).toBe(false);
  });

  it('rejects canonically duplicate prompts across skills', () => {
    const root = validPack();
    const testingFile = join(root, 'evals', 'cases', 'test-driven-development.json');
    const docsFile = join(root, 'evals', 'cases', 'documentation-writing.json');
    const testing = JSON.parse(readFileSync(testingFile, 'utf8')) as {
      trigger: { positive: Array<{ prompt: string }> };
    };
    const docs = JSON.parse(readFileSync(docsFile, 'utf8')) as {
      trigger: { positive: Array<{ prompt: string }> };
    };
    testing.trigger.positive[0]!.prompt = 'caf\u00e9 testing workflow';
    docs.trigger.positive[0]!.prompt = 'cafe\u0301 testing workflow';
    writeFileSync(testingFile, JSON.stringify(testing));
    writeFileSync(docsFile, JSON.stringify(docs));

    const report = auditExternalSkillPack(root);

    expect(report.trialReady).toBe(false);
    expect(report.issues.filter((entry) => entry.code === 'duplicate-cross-skill-trigger')).toHaveLength(2);
  });

  it('does not let alphabetical ties satisfy ownerless negative triggers', () => {
    const root = packRoot();
    writeSkill(root, 'alpha-work', 'shared workflow evidence. Use for alpha tasks.', 'bravo-work', 'alpha');
    writeSkill(root, 'bravo-work', 'shared workflow evidence. Use for bravo tasks.', 'alpha-work', 'bravo');
    const caseFile = join(root, 'evals', 'cases', 'alpha-work.json');
    const contract = JSON.parse(readFileSync(caseFile, 'utf8')) as {
      trigger: { negative: Array<{ prompt: string; owner?: string }> };
    };
    contract.trigger.negative[0] = { prompt: 'shared workflow evidence' };
    writeFileSync(caseFile, JSON.stringify(contract));

    const report = auditExternalSkillPack(root);
    const alpha = report.skills.find((skill) => skill.name === 'alpha-work');

    expect(alpha?.routing.negativePassed).toBe(1);
    expect(alpha?.routing.passed).toBe(false);
    expect(report.trialReady).toBe(false);
  });

  it('does not treat all-zero ownerless negatives or positive score ties as evidence', () => {
    const root = packRoot();
    const description = 'shared workflow evidence common process proof. Use for bounded tasks.';
    writeSkill(root, 'alpha-work', description, 'bravo-work', 'alpha');
    writeSkill(root, 'bravo-work', description, 'alpha-work', 'bravo');
    const alphaFile = join(root, 'evals', 'cases', 'alpha-work.json');
    const bravoFile = join(root, 'evals', 'cases', 'bravo-work.json');
    const alpha = JSON.parse(readFileSync(alphaFile, 'utf8')) as {
      trigger: { positive: Array<{ prompt: string }>; negative: Array<{ prompt: string; owner?: string }> };
    };
    const bravo = JSON.parse(readFileSync(bravoFile, 'utf8')) as {
      trigger: { positive: Array<{ prompt: string }> };
    };
    alpha.trigger.positive = [{ prompt: 'shared' }, { prompt: 'workflow' }, { prompt: 'evidence' }];
    bravo.trigger.positive = [{ prompt: 'common' }, { prompt: 'process' }, { prompt: 'proof' }];
    alpha.trigger.negative[0] = { prompt: 'unseen vocabulary' };
    writeFileSync(alphaFile, JSON.stringify(alpha));
    writeFileSync(bravoFile, JSON.stringify(bravo));

    const report = auditExternalSkillPack(root);
    const alphaResult = report.skills.find((skill) => skill.name === 'alpha-work');

    expect(alphaResult?.routing).toMatchObject({ rankOnePassed: 0, negativePassed: 1, passed: false });
    expect(report.routing.passed).toBe(false);
    expect(report.trialReady).toBe(false);
  });

  it('does not let an alphabetical top-k tie complete an 80 percent per-skill gate', () => {
    const root = packRoot();
    const description = 'shared one two three four common workflow evidence. Use for bounded tasks.';
    writeSkill(root, 'alpha-work', description, 'bravo-work', 'alpha');
    writeSkill(root, 'bravo-work', description, 'alpha-work', 'bravo');
    const caseFile = join(root, 'evals', 'cases', 'alpha-work.json');
    const contract = JSON.parse(readFileSync(caseFile, 'utf8')) as {
      trigger: { positive: Array<{ prompt: string; top_k: number }> };
    };
    contract.trigger.positive = [
      { prompt: 'alpha one', top_k: 1 },
      { prompt: 'alpha two', top_k: 1 },
      { prompt: 'alpha three', top_k: 1 },
      { prompt: 'alpha four', top_k: 1 },
      { prompt: 'shared', top_k: 1 },
    ];
    writeFileSync(caseFile, JSON.stringify(contract));

    const report = auditExternalSkillPack(root);
    const alpha = report.skills.find((skill) => skill.name === 'alpha-work');

    expect(alpha?.routing).toMatchObject({ rankOneRate: 0.8, topKPassed: 4, passed: false });
    expect(report.trialReady).toBe(false);
  });

  it('rejects empty behavioral oracles and duplicate fixture references', () => {
    const root = validPack();
    const caseFile = join(root, 'evals', 'cases', 'documentation-writing.json');
    const contract = JSON.parse(readFileSync(caseFile, 'utf8')) as {
      evals: Array<{ expected_output: string; files: string[] }>;
    };
    contract.evals[0]!.expected_output = '  ';
    contract.evals[0]!.files.push(contract.evals[0]!.files[0]!);
    writeFileSync(caseFile, JSON.stringify(contract));

    const report = auditExternalSkillPack(root);

    expect(report.behavioral.state).toBe('invalid');
    expect(report.trialReady).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'incomplete-eval-contract', skill: 'documentation-writing' }),
    ]));
  });

  it('rejects punctuation-padded routing duplicates and symlinked fixture trees', () => {
    const duplicateRoot = validPack();
    const duplicateFile = join(duplicateRoot, 'evals', 'cases', 'documentation-writing.json');
    const duplicateContract = JSON.parse(readFileSync(duplicateFile, 'utf8')) as {
      trigger: { positive: Array<{ prompt: string }> };
    };
    duplicateContract.trigger.positive[1]!.prompt = 'workflow workflow documentation documentation documentation documentation';
    writeFileSync(duplicateFile, JSON.stringify(duplicateContract));

    const symlinkRoot = validPack();
    mkdirSync(join(symlinkRoot, '.git'));
    writeFileSync(join(symlinkRoot, '.git', 'secret.txt'), 'excluded bytes');
    symlinkSync(
      '../../../.git/secret.txt',
      join(symlinkRoot, 'evals', 'fixtures', 'documentation-writing', 'linked-secret'),
    );
    const symlinkFile = join(symlinkRoot, 'evals', 'cases', 'documentation-writing.json');
    const symlinkContract = JSON.parse(readFileSync(symlinkFile, 'utf8')) as {
      evals: Array<{ files: string[] }>;
    };
    symlinkContract.evals[0]!.files = ['documentation-writing/linked-secret'];
    writeFileSync(symlinkFile, JSON.stringify(symlinkContract));

    expect(auditExternalSkillPack(duplicateRoot).trialReady).toBe(false);
    expect(auditExternalSkillPack(symlinkRoot)).toMatchObject({
      trialReady: false,
      packDigest: null,
    });
  });

  it('rejects invisible behavioral text and fixture references on dialogue cases', () => {
    const root = validPack();
    const caseFile = join(root, 'evals', 'cases', 'documentation-writing.json');
    const contract = JSON.parse(readFileSync(caseFile, 'utf8')) as {
      evals: Array<{ kind: string; expected_output: string; expectations: string[]; files?: string[] }>;
    };
    contract.evals[0]!.kind = 'dialogue';
    contract.evals[0]!.expected_output = '\u200b';
    contract.evals[0]!.expectations = ['\u200b'];
    contract.evals[0]!.files = ['../../../etc/passwd'];
    writeFileSync(caseFile, JSON.stringify(contract));

    const report = auditExternalSkillPack(root);

    expect(report.behavioral.state).toBe('invalid');
    expect(report.trialReady).toBe(false);
  });

  it('does not award lexical zero-score ties by alphabetical order', () => {
    const root = validPack();
    const caseFile = join(root, 'evals', 'cases', 'documentation-writing.json');
    const contract = JSON.parse(readFileSync(caseFile, 'utf8')) as {
      trigger: { positive: Array<{ prompt: string }> };
    };
    contract.trigger.positive[0]!.prompt = 'the and to';
    writeFileSync(caseFile, JSON.stringify(contract));

    const report = auditExternalSkillPack(root);

    expect(report.routing.passed).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'incomplete-eval-contract', skill: 'documentation-writing' }),
    ]));
    expect(report.trialReady).toBe(false);
  });

  it('rejects inflated top-k, duplicate prompts, duplicate behavioral ids, and orphan cases', () => {
    const root = validPack();
    const caseFile = join(root, 'evals', 'cases', 'documentation-writing.json');
    const contract = JSON.parse(readFileSync(caseFile, 'utf8')) as {
      trigger: { positive: Array<{ prompt: string; top_k: number }> };
      evals: Array<{ id: number }>;
    };
    contract.trigger.positive[0]!.top_k = 128;
    contract.trigger.positive[1]!.prompt = contract.trigger.positive[2]!.prompt;
    contract.evals.push({ ...contract.evals[0]! });
    writeFileSync(caseFile, JSON.stringify(contract));
    writeFileSync(join(root, 'evals', 'cases', 'orphan.json'), JSON.stringify({ skill_name: 'orphan' }));

    const report = auditExternalSkillPack(root);

    expect(report.trialReady).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'incomplete-eval-contract', skill: 'documentation-writing' }),
      expect.objectContaining({ code: 'orphan-eval-file', skill: 'orphan' }),
    ]));
  });

  it('does not echo hostile invalid directory or case names', () => {
    const root = validPack();
    const hostile = '\u001b[31mRAW_PROMPT_SECRET';
    mkdirSync(join(root, 'skills', hostile));
    writeFileSync(join(root, 'evals', 'cases', `${hostile}.json`), '{}');

    const report = auditExternalSkillPack(root);
    const serialized = JSON.stringify(report);

    expect(report.trialReady).toBe(false);
    expect(serialized).not.toContain(hostile);
    expect(serialized).not.toContain('RAW_PROMPT_SECRET');
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid-skill-directory' }),
      expect.objectContaining({ code: 'invalid-eval-case-name' }),
    ]));
  });

  it('returns a bounded blocked report for an unavailable pack', () => {
    const report = auditExternalSkillPack(join(tmpdir(), 'ashlr-does-not-exist'));
    expect(report).toMatchObject({
      mode: 'quarantine',
      packDigest: null,
      trialReady: false,
      promotion: { eligible: false },
      structural: { passed: false, errors: 1 },
    });
    expect(formatExternalSkillAudit(report)).toContain('Promotion: blocked');
  });
});

describe('skills CLI', () => {
  it('emits machine-readable quarantine evidence and returns success only for candidate readiness', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await cmdSkills(['audit', validPack(), '--json']);
    const output = write.mock.calls.map((call) => String(call[0])).join('');

    expect(code).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      mode: 'quarantine',
      trialReady: true,
      promotion: { eligible: false },
    });
  });

  it('uses exit code 2 for invalid usage', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(cmdSkills(['audit'])).resolves.toBe(2);
    await expect(cmdSkills(['audit', validPack(), '--execute'])).resolves.toBe(2);
    expect(log).toHaveBeenCalled();
  });

  it('keeps invalid machine usage machine-readable and reserves success for trial readiness', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const jsonCode = await cmdSkills(['audit', '--json']);
    const output = write.mock.calls.map((call) => String(call[0])).join('');

    expect(jsonCode).toBe(2);
    expect(JSON.parse(output)).toMatchObject({
      schemaVersion: 1,
      error: { code: 'invalid-usage' },
    });
    await expect(cmdSkills(['audit', validPack(), '--help'])).resolves.toBe(2);
  });

  it('preserves dispatcher JSON and process exit semantics', () => {
    const root = validPack();
    const cli = resolve('src/cli/index.ts');
    const success = spawnSync(
      process.execPath,
      ['--import', 'tsx', cli, 'skills', 'audit', root, '--json'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    const invalid = spawnSync(
      process.execPath,
      ['--import', 'tsx', cli, 'skills', 'audit', '--json'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(success.status).toBe(0);
    expect(JSON.parse(success.stdout)).toMatchObject({ mode: 'quarantine', trialReady: true });
    expect(invalid.status).toBe(2);
    expect(JSON.parse(invalid.stdout)).toMatchObject({ error: { code: 'invalid-usage' } });
  });
});
