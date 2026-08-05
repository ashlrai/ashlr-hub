/** Killable process boundary for untrusted external skill-pack filesystem reads. */

import { auditExternalSkillPack } from '../core/fleet/external-skill-audit.js';

const packPath = process.argv[2];
if (!packPath) {
  process.exitCode = 2;
} else {
  const report = auditExternalSkillPack(packPath);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
