import base from './vitest.config.js';
import { deriveReleaseVitestConfig } from './test/config/release-vitest-partition.js';

// Explicit opt-in only; npm test and existing gate commands retain full coverage.
export default deriveReleaseVitestConfig(base, 'ordinary');
