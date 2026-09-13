import base from './vitest.config.js';
import { deriveReleaseVitestConfig } from './test/config/release-vitest-partition.js';

// Whole files, serial scheduling; individual test/hook deadlines are unchanged.
export default deriveReleaseVitestConfig(base, 'native');
