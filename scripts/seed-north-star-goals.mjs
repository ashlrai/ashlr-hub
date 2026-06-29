/**
 * M232 — Seed 6 ambitious North-Star goals (2 per pillar) into the goal store.
 * Run once: node scripts/seed-north-star-goals.mjs
 */
import { createGoal, listGoals } from '../dist/core/goals/store.js';

const ASHLR_HUB   = '/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub';
const PULSE       = '/Users/masonwyatt/Desktop/github/dev-tools/ashlr-pulse';
const PHANTOM     = '/Users/masonwyatt/Desktop/github/dev-tools/phantom-secrets';
const BINSHIELD   = '/Users/masonwyatt/Desktop/github/dev-tools/binshield';

const goals = [
  // ── Pillar 1: Recursive Self-Improvement ────────────────────────────────
  {
    pillar: 1,
    objective:
      'Build a fleet-intelligence layer that records every merge/reject decision ' +
      'with its context vectors, trains a lightweight routing model from that history, ' +
      'and automatically biases engine + model selection toward the highest-success ' +
      'pairing for each task class — making every fleet cycle measurably smarter than the last.',
    project: ASHLR_HUB,
  },
  {
    pillar: 1,
    objective:
      'Make the invent-engine score and rank its own generated ideas by expected value ' +
      '(impact × confidence × effort⁻¹) before queueing them, so the fleet always works ' +
      'on its highest-leverage invention first and the idea backlog self-prunes over time.',
    project: ASHLR_HUB,
  },

  // ── Pillar 2: Ecosystem Products ────────────────────────────────────────
  {
    pillar: 2,
    objective:
      'Ship phantom team-vault sharing to best-in-class: E2E-encrypted secret rotation ' +
      'with per-member key derivation, time-limited access grants, audit trail, and a ' +
      'CLI+web UX that makes it the default choice for small engineering teams sharing ' +
      'secrets across repos.',
    project: PHANTOM,
  },
  {
    pillar: 2,
    objective:
      'Add real-time PyPI + npm advisory cross-referencing to the binshield scanner so ' +
      'every dependency surface emits severity-ranked CVE alerts with EPSS scores, ' +
      'auto-suggested safe-upgrade paths, and a GitHub check that blocks PRs introducing ' +
      'high/critical vulnerabilities.',
    project: BINSHIELD,
  },

  // ── Pillar 3: Composition Flywheel ──────────────────────────────────────
  {
    pillar: 3,
    objective:
      'Wire binshield as a mandatory gate on every fleet dependency-bump proposal: ' +
      'before any package-version change reaches the merge queue the fleet scans it ' +
      'through binshield, attaches the advisory report to the proposal, and hard-blocks ' +
      'merges that introduce high/critical CVEs — making the fleet self-defending by default.',
    project: ASHLR_HUB,
  },
  {
    pillar: 3,
    objective:
      'Make the fleet consume its own ashlr-pulse OTLP telemetry to self-tune cadence: ' +
      'read live cycle-latency, queue depth, and error-rate metrics from Pulse, then ' +
      'dynamically adjust swarm concurrency, retry budgets, and loop tick intervals so ' +
      'the fleet operates at its optimal throughput without human tuning.',
    project: PULSE,
  },
];

console.log('Seeding 6 North-Star goals…\n');
const seeded = [];
for (const g of goals) {
  const goal = createGoal(g.objective, { project: g.project });
  seeded.push({ pillar: g.pillar, id: goal.id, project: g.project, status: goal.status });
  console.log(`  [P${g.pillar}] ${goal.id}`);
  console.log(`         project: ${g.project}`);
  console.log(`         status:  ${goal.status}`);
  console.log();
}

console.log('─'.repeat(72));
console.log('Listing all goals from store (title + project):');
const all = listGoals();
for (const g of all) {
  const short = g.objective.slice(0, 80).replace(/\n/g, ' ');
  console.log(`  [${g.status.padEnd(8)}] ${short}…`);
  console.log(`             → ${g.project ?? '(no project)'}`);
}
console.log(`\nTotal in store: ${all.length}`);
