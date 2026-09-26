/**
 * routes/verse/onboarding/OnboardingPanel.tsx — the Settings row that brings
 * the first-run tour back.
 *
 * It lives here rather than in sections/ so the whole onboarding feature is
 * one folder; SettingsSection.tsx imports it the same way it imports its own
 * panels, and reuses the same Panel/SettingRow primitives so the row keeps
 * the label-left / control-right rhythm of every other setting.
 *
 * The description states what the tour actually covers, and — because this
 * is the only place the stored answer is visible — whether it has been seen.
 */
import { Button } from '../../../components/primitives/index.js';
import { Panel, SettingRow } from '../sections/SettingRow.js';
import { relativePhrase } from '../context/context-model.js';
import { replayOnboarding } from './onboarding-store.js';
import { useOnboarding } from './useOnboarding.js';

/**
 * What the stored answer says, in the app's one relative wording ("5m ago",
 * "on Sep 19") rather than a locale-numeric "9/19/2026". `now` is injectable
 * so the phrase is testable against a fixed clock.
 */
export function describeOnboardingState(completedAt: string | null, dismissedAt: string | null, now: number = Date.now()): string {
  if (completedAt) {
    const when = relativePhrase(completedAt, now);
    return when ? `Last completed ${when}.` : 'Completed.';
  }
  if (dismissedAt) return 'Skipped. Nothing was missed — it is all reachable from the sections themselves.';
  return 'Not seen yet. Replay it to take the two-minute tour.';
}

export function OnboardingPanel() {
  const { completedAt, dismissedAt, open } = useOnboarding();

  return (
    <Panel title="Onboarding">
      <SettingRow
        label="Replay the first-run tour"
        description={`Your connected seats, whether a local runtime is available, how autonomy is turned on, and what each of the three stop controls really halts. ${describeOnboardingState(completedAt, dismissedAt)}`}
      >
        <Button variant="subtle" size="sm" onClick={replayOnboarding} disabled={open}>
          {open ? 'Showing' : 'Replay'}
        </Button>
      </SettingRow>
    </Panel>
  );
}
