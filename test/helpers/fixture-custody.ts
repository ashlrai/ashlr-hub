/** Test cleanup authority only. A later successful invocation cannot discharge
 * another invocation's missing or failed settlement proof. No process effects. */
export function createFixtureCustody() {
  let pending = 0;
  let held = false;
  return {
    canCleanup: () => pending === 0 && !held,
    reserve() {
      pending++;
      let state: 'pending' | 'settled' | 'held' = 'pending';
      return {
        confirmSettled(verify: () => true): void {
          if (state === 'settled') return;
          if (state === 'held') throw new Error('Fixture custody proof previously failed');
          try {
            // Async or missing proof must not release before its actual checks.
            if (verify() !== true) throw new Error('Fixture custody proof was not confirmed');
          } catch (error) {
            state = 'held'; held = true;
            throw error;
          }
          state = 'settled'; pending--;
        },
      };
    },
  };
}
