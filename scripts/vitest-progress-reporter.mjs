import { performance } from 'node:perf_hooks';

const MAX_MODULE_ID = 512;
const CASE_PROGRESS_INTERVAL_MS = 30_000;

function moduleId(testModule) {
  const id = testModule?.relativeModuleId || testModule?.moduleId || 'unknown-module';
  return String(id).slice(-MAX_MODULE_ID);
}

function moduleFilename(testModule) {
  return moduleId(testModule).replaceAll('\\', '/').split('/').pop().replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown-module';
}

export default class AshlrProgressReporter {
  #moduleProgress = new WeakMap();
  #completedCases = new WeakSet();
  onTestRunStart(specifications) {
    this.#moduleProgress = new WeakMap();
    this.#completedCases = new WeakSet();
    console.error(`[test-ci-progress] collected ${specifications.length} module(s)`);
  }

  onTestModuleStart(testModule) {
    this.#moduleProgress.set(testModule, { completed: 0, reportedAt: performance.now() });
    console.error(`[test-ci-progress] start ${moduleId(testModule)}`);
  }

  // Output only accompanies an actual completed case. A silent or still-running
  // case cannot keep the watchdog alive, and no title/error/fixture data is read.
  onTestCaseResult(testCase) {
    const state = testCase.result().state;
    const progress = this.#moduleProgress.get(testCase.module);
    if (!progress || !['passed', 'failed', 'skipped'].includes(state) || this.#completedCases.has(testCase)) return;
    this.#completedCases.add(testCase);
    progress.completed += 1;
    const now = performance.now();
    if (now - progress.reportedAt < CASE_PROGRESS_INTERVAL_MS) return;
    progress.reportedAt = now;
    console.error(`[test-ci-progress] case-completed state=${state} ${moduleFilename(testCase.module)} completed=${progress.completed}`);
  }

  onTestModuleEnd(testModule) {
    this.#moduleProgress.delete(testModule);
    console.error(`[test-ci-progress] end ${testModule.state()} ${moduleId(testModule)}`);
  }
}
