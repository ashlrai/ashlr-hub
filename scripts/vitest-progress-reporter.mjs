const MAX_MODULE_ID = 512;

function moduleId(testModule) {
  const id = testModule?.relativeModuleId || testModule?.moduleId || 'unknown-module';
  return String(id).slice(-MAX_MODULE_ID);
}

export default class AshlrProgressReporter {
  onTestRunStart(specifications) {
    console.error(`[test-ci-progress] collected ${specifications.length} module(s)`);
  }

  onTestModuleStart(testModule) {
    console.error(`[test-ci-progress] start ${moduleId(testModule)}`);
  }

  onTestModuleEnd(testModule) {
    console.error(`[test-ci-progress] end ${testModule.state()} ${moduleId(testModule)}`);
  }
}
