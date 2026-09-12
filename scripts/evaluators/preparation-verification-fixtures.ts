/** Fixed installed fixture choices. No candidate-provided modules or callbacks. */
import { preparationManagerFixture } from './preparation-verification-manager-fixture.js';
import { preparationSuccessorFixture } from './preparation-verification-successor-fixture.js';
import { withPreparationFixtureScope, type PreparationFixtureScope } from './preparation-verification-fixture-runtime.js';
import type { PreparationGitPin } from './preparation-verification-native.mjs';

export async function createPreparationWorkflowFixture(kind: 'manager' | 'successor', base: string, options: PreparationFixtureScope, gitPin?: PreparationGitPin) {
  if (kind !== 'manager' && kind !== 'successor') throw new Error('Unknown fixed preparation fixture');
  return withPreparationFixtureScope(options, async (signal, deadlineMonotonicMs) => kind === 'manager'
    ? preparationManagerFixture(base, gitPin) : preparationSuccessorFixture(base, signal, deadlineMonotonicMs, gitPin));
}
